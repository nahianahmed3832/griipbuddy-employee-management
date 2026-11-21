import "server-only";
import { db } from "@/lib/db/client";
import { databaseNow } from "@/features/time/clock";
import { addDays, dateKey, dateValue, localDate } from "@/features/time/dates";
import { sweepDueNotifications, withDueNotificationLock } from "./due-notifications";

const retryMinutes = [5, 15, 45, 120];
const retryAfter = (attempt: number, at: Date) =>
  attempt <= retryMinutes.length ? new Date(at.getTime() + retryMinutes[attempt - 1] * 60000) : null;

function slotFor(day: string) {
  // Preserve the existing Hostinger daily 18:10 UTC trigger.
  return new Date(`${day}T18:10:00.000Z`);
}

export async function notificationRunStatus() {
  return db.employeeNotificationAttempt.findMany({ orderBy: [{ scheduledFor: "desc" }, { attempt: "desc" }], take: 20 });
}

export async function processScheduledNotifications(retryDay?: string) {
  const result = await withDueNotificationLock(async () => {
    const now = await databaseNow(db);
    const today = dateKey(now), todaySlot = slotFor(today);
    const scheduledFor = retryDay ? slotFor(retryDay) : now >= todaySlot ? todaySlot : slotFor(addDays(today, -1));
    if (retryDay && scheduledFor > now) return { status: "NOT_RETRYABLE", scheduledFor };

    let previous = await db.employeeNotificationAttempt.findFirst({ where: { scheduledFor }, orderBy: { attempt: "desc" } });
    if (previous?.status === "SUCCEEDED") return { status: retryDay ? "NOT_RETRYABLE" : "ALREADY_SUCCEEDED", scheduledFor };
    if (!previous && retryDay) return { status: "NOT_RETRYABLE", scheduledFor };
    if (previous?.status === "RUNNING") {
      // Holding the same advisory lock proves the previous process can no longer write.
      previous = await db.employeeNotificationAttempt.update({
        where: { scheduledFor_attempt: { scheduledFor, attempt: previous.attempt } },
        data: { status: "INTERRUPTED", failureCode: "PROCESS_INTERRUPTED", finishedAt: now, nextRetryAt: retryAfter(previous.attempt, now) },
      });
      if (!retryDay) return { status: "INTERRUPTED", scheduledFor, attempt: previous.attempt, nextRetryAt: previous.nextRetryAt };
    }
    if (previous && !retryDay && (!previous.nextRetryAt || previous.nextRetryAt > now)) {
      return { status: "WAITING", scheduledFor, nextRetryAt: previous.nextRetryAt };
    }

    const attempt = (previous?.attempt ?? 0) + 1, where = { scheduledFor_attempt: { scheduledFor, attempt } };
    const { timezone } = previous ?? await db.organizationSettings.findUniqueOrThrow({ where: { id: 1 }, select: { timezone: true } });
    const businessDate = previous?.businessDate ?? dateValue(localDate(scheduledFor, timezone));
    await db.employeeNotificationAttempt.create({ data: { scheduledFor, attempt, businessDate, timezone, startedAt: now, status: "RUNNING" } });
    try {
      const counts = await sweepDueNotifications({ cutoff: scheduledFor, businessDate: dateKey(businessDate) },
        (data, tx) => tx.employeeNotificationAttempt.update({ where, data }));
      const finishedAt = await databaseNow(db);
      return await db.employeeNotificationAttempt.update({ where, data: { status: "SUCCEEDED", finishedAt, ...counts } });
    } catch {
      const finishedAt = await databaseNow(db);
      return db.employeeNotificationAttempt.update({
        where, data: { status: "FAILED", failureCode: "SWEEP_FAILED", finishedAt, nextRetryAt: retryAfter(attempt, finishedAt) },
      });
    }
  });
  return result ?? { status: "IN_PROGRESS" };
}
