import NextAuth, { type NextAuthConfig } from "next-auth";
import { headers } from "next/headers";
import { getToken, encode, type JWT } from "next-auth/jwt";
import { randomUUID } from "node:crypto";
import { rememberedSeconds } from "@/lib/auth/session-policy";
import Credentials from "next-auth/providers/credentials";
import { authenticateCredentials } from "@/lib/auth/credentials";
import { SESSION_SECONDS } from "@/lib/authorization/policy";
import { AppError, logUnexpected } from "@/lib/utils/errors";
import { db } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import { authorizedMutation } from "@/lib/db/mutation";
import { sessionFingerprint } from "@/lib/auth/revocation";
import type { Identity } from "@/types/auth";

const production = process.env.NODE_ENV === "production";
const secure = process.env.APP_BASE_URL?.startsWith("https://") ?? production;
if (production && !secure && process.env.ALLOW_LOCAL_HTTP !== "true") throw new Error("Production requires HTTPS; local Compose may explicitly allow loopback HTTP.");

function tokenIdentity(token: JWT | null | undefined, includeSessionId: boolean): Identity | undefined {
  if (!token?.userId || typeof token.sessionVersion !== "number" || !token.issuedAt || !token.absoluteExpiresAt) return;
  return {
    userId: token.userId, sessionVersion: token.sessionVersion, issuedAt: token.issuedAt, absoluteExpiresAt: token.absoluteExpiresAt,
    ...(includeSessionId && token.sessionId && { sessionId: token.sessionId }),
  };
}

function configuration(lifetime: number, internalSession = false): NextAuthConfig { return {
  secret: process.env.AUTH_SECRET,
  trustHost: true, // The HTTP handler below normalizes to the configured canonical origin.
  useSecureCookies: secure,
  session: { strategy: "jwt", maxAge: lifetime },
  jwt: { maxAge: lifetime, async encode(params) { const expires=params.token?.absoluteExpiresAt; return encode({...params,maxAge:typeof expires==="number"?Math.max(0,Math.floor((expires-Date.now())/1000)):lifetime}); } },
  pages: { signIn: "/login", error: "/login" },
  providers: [Credentials({ credentials: { email: {}, password: {}, remember: {} }, async authorize(credentials) {
    try { const user=await authenticateCredentials(credentials);return user?{...user,lifetime:credentials.remember==="true" || credentials.remember==="on"?rememberedSeconds():SESSION_SECONDS}:null; } catch { logUnexpected("credentials_failed"); return null; }
  } })],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const issuedAt = Date.now();
        token = { userId: user.id, sessionVersion: user.sessionVersion, sessionId: randomUUID(), issuedAt,
          absoluteExpiresAt: issuedAt + (user.lifetime ?? SESSION_SECONDS) * 1000 };
      }
      const identity = tokenIdentity(token, true);
      if (!identity || identity.absoluteExpiresAt <= Date.now()) return null;
      const [current, revoked] = await Promise.all([
        db.user.findUnique({ where: { id: identity.userId }, select: { isActive: true, accountStatus: true, sessionVersion: true, mustChangePassword: true, temporaryPasswordExpiresAt: true } }),
        db.employeeSessionRevocation.findUnique({ where: { fingerprint: sessionFingerprint(identity) }, select: { fingerprint: true } }),
      ]);
      if (revoked || !current?.isActive || current.accountStatus === "SUSPENDED" || current.sessionVersion !== identity.sessionVersion ||
        (current.mustChangePassword && (!current.temporaryPasswordExpiresAt || current.temporaryPasswordExpiresAt <= new Date()))) return null;
      return token;
    },
    session({ session, token }) {
      // No roles, grants or employee data in the browser-readable session endpoint.
      Reflect.deleteProperty(session, "user");
      const identity = tokenIdentity(token, internalSession);
      if (identity) session.identity = identity;
      Reflect.set(session, "expires", new Date(token.absoluteExpiresAt ?? 0).toISOString());
      return session;
    },
    redirect({ url }) {
      const canonical = process.env.APP_BASE_URL ?? "http://localhost:3000";
      try { const target = new URL(url, canonical); return target.origin === new URL(canonical).origin ? target.href : canonical; } catch { return canonical; }
    },
  },
  events: { async signOut(message) {
    if (!("token" in message)) return;
    const identity = tokenIdentity(message.token, true);
    if (!identity) return;
    try {
      await authorizedMutation(identity, async (actor, tx) => {
        await tx.employeeSessionRevocation.deleteMany({ where: { expiresAt: { lte: new Date() } } });
        await tx.employeeSessionRevocation.create({ data: {
          fingerprint: sessionFingerprint(identity), userId: actor.userId, expiresAt: new Date(identity.absoluteExpiresAt),
        } });
        await audit({ actorUserId: actor.userId, action: "LOGOUT", entity: "users", entityId: actor.userId }, tx);
      }, undefined, true);
    } catch (error) {
      // Logout still clears stale, expired and suspended cookies.
      if (!(error instanceof AppError && error.status === 401)) logUnexpected("logout_revocation_failed");
    }
  } },
  logger: { error() { logUnexpected("auth_failed"); }, warn(code) { if (code !== "debug-enabled") logUnexpected("auth_warning"); } },
}; }

export const { handlers, auth, signIn, signOut } = NextAuth(async request => {
 let lifetime=SESSION_SECONDS;
 const h=request?.headers ?? await headers();
 const token=await getToken({req:{headers:h},secret:process.env.AUTH_SECRET!,secureCookie:secure});
 if(typeof token?.absoluteExpiresAt==="number")lifetime=Math.max(1,Math.floor((token.absoluteExpiresAt-Date.now())/1000));
 if(request?.method==="POST" && new URL(request.url).pathname.endsWith("/callback/credentials")){
  const form=await request.clone().formData();lifetime=["true","on"].includes(String(form.get("remember")))?rememberedSeconds():SESSION_SECONDS;
 }
 return configuration(lifetime, request === undefined);
});
export async function signInWithPolicy(input:{email:string;password:string},remember:boolean){
 return NextAuth(configuration(remember?rememberedSeconds():SESSION_SECONDS)).signIn("credentials",{...input,remember:String(remember),redirect:false});
}
