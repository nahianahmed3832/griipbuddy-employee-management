import "server-only";
import { createHash } from "node:crypto";
import type { Identity } from "@/types/auth";

export function sessionFingerprint(identity: Identity) {
  // Existing JWTs only have the signed issuance tuple. They retain a consistent identity on refresh.
  const sessionReference = identity.sessionId ? ["session", identity.sessionId] : ["legacy", identity.issuedAt];
  return createHash("sha256").update(JSON.stringify([identity.userId, identity.sessionVersion, ...sessionReference])).digest("hex");
}
