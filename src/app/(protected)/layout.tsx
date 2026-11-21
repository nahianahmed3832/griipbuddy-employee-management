import { pageActor, getIdentity } from "@/lib/auth/request";
import { unreadNotifications } from "@/features/review/notifications";
import { AppShell } from "@/components/layout/shell";
import { shellSettings } from "@/features/settings/config";
import { disabledPaths } from "@/features/settings/options";
import { hasDirectReports } from "@/features/review/scope";
export const dynamic = "force-dynamic";
export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const actor = await pageActor();
  const identity=await getIdentity();
  // One settings read for the shell; pageActor above already enforced the session and account state.
  const [unread, shell, teamReviewer] = await Promise.all([unreadNotifications(identity), shellSettings(), hasDirectReports(actor)]);
  return <AppShell actor={actor} teamReviewer={teamReviewer} companyName={shell.companyName} logo={`/brand/logo?v=${shell.logoRevision}`} disabled={disabledPaths(shell.modules)} unread={unread}>{children}</AppShell>;
}
