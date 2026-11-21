import "server-only";
import pg from "pg";
import { db } from "@/lib/db/client";
import { databaseNow } from "@/features/time/clock";
import { localDate, dateKey, dateValue, addDays } from "@/features/time/dates";
import { documentParentVisible } from "@/features/people-operations/access";
import { activePeriod } from "./scope";
import { notify } from "./notifications";

type SweepWindow = { cutoff: Date; businessDate: string };
type SweepProgress = (counts: { scannedCount: number; publishedCount: number }, tx: Parameters<typeof notify>[0]) => Promise<unknown>;

export async function withDueNotificationLock<T>(run: () => Promise<T>) {
  const lock = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  await lock.connect();
  // Closing the session always releases its advisory lock, even on an interrupted run.
  try {
    if (!(await lock.query("SELECT pg_try_advisory_lock(73102303) AS locked")).rows[0].locked) return null;
    return await run();
  } finally { await lock.end(); }
}

export async function sweepDueNotifications(window?: SweepWindow, progress?: SweepProgress) {
  const effective = window ?? await db.$transaction(async tx => {
    const cutoff = await databaseNow(tx);
    const { timezone } = await tx.organizationSettings.findUniqueOrThrow({ where: { id: 1 }, select: { timezone: true } });
    return { cutoff, businessDate: localDate(cutoff, timezone) };
  });
  const { cutoff, businessDate } = effective;
  const counts = { scannedCount: 0, publishedCount: 0 };
  for (const kind of ["documents", "attendance", "overtime"] as const) {
    let cursor: string | undefined;
    for (;;) {
      const batch = await db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(73102301)`;
        const paging = { orderBy: { id: "asc" as const }, take: 100 };
        const after = cursor ? { id: { gt: cursor } } : {};
        const rows = kind === "documents"
          ? await tx.employeeDocument.findMany({ ...paging, where: { ...after, deletedAt: null, expiresOn: { lte: dateValue(addDays(businessDate, 30)) } }, select: { id: true, employeeId: true, expiresOn: true, employeeVisible: true } })
          : kind === "attendance"
          ? await tx.attendanceSession.findMany({ ...paging, where: { ...after, voidedAt: null, checkoutAt: null, scheduledEndAt: { lt: cutoff } }, select: { id: true, employeeId: true, revision: true } })
          : await tx.overtimeReview.findMany({ ...paging, where: { ...after, status: "PENDING" }, select: { id: true, employeeId: true, revision: true } });
        let published = 0;
        for (const row of rows) {
          const canReceiveOwn = async () => !!await tx.employee.findFirst({
            where: { id: row.employeeId, user: { isActive: true, accountStatus: { not: "SUSPENDED" } }, employmentPeriods: { some: activePeriod(dateValue(businessDate)) } },
            select: { id: true },
          });
          if ("expiresOn" in row && row.expiresOn) {
            const expiry = dateKey(row.expiresOn), expired = expiry <= businessDate;
            const event = expired ? "DOCUMENT_EXPIRED" : "DOCUMENT_EXPIRING";
            const key = `document-expiry:${row.id}:${expiry}:${expired ? "expired" : "30"}`;
            published += await notify(tx, row.employeeId, `STAFF_${event}`, "employee_documents", row.id, key, expired ? "An employee document has reached its expiry date." : "An employee document is due to expire within 30 days.", true);
            if (row.employeeVisible && await canReceiveOwn() && await documentParentVisible(tx, row.employeeId, row.id)) {
              published += await notify(tx, row.employeeId, event, "employee_documents", row.id, `own-${key}`, expired ? "Your released employee document has reached its expiry date." : "Your released employee document is due to expire within 30 days.");
            }
          } else if ("revision" in row) {
            const attendance = kind === "attendance";
            const event = attendance ? "MISSING_CHECKOUT" : "OVERTIME_PENDING";
            const key = `${attendance ? "missing-checkout" : "overtime-pending"}:${row.id}:${row.revision}`;
            const source = attendance ? "attendance_sessions" : "overtime_reviews";
            published += await notify(tx, row.employeeId, `STAFF_${event}`, source, row.id, key, attendance ? "A scheduled attendance session is missing checkout." : "A completed weekly overtime calculation needs review.", true);
            if (attendance && await canReceiveOwn()) published += await notify(tx, row.employeeId, event, source, row.id, `own-${key}`, "Your scheduled period ended and checkout is missing. Check out or request a correction.");
          }
        }
        const next = { scannedCount: counts.scannedCount + rows.length, publishedCount: counts.publishedCount + published };
        if (rows.length) await progress?.(next, tx);
        return { last: rows.at(-1)?.id, size: rows.length, next };
      }, { timeout: 30000 });
      Object.assign(counts, batch.next);
      if (batch.size < 100) break;
      cursor = batch.last;
    }
  }
  return counts;
}

export async function processDueNotifications() {
  const result = await withDueNotificationLock(() => sweepDueNotifications());
  return { skipped: !result, processed: result?.scannedCount ?? 0 };
}
