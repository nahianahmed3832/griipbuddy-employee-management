import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import pg from "pg";
import { testPostgres } from "../postgres";
import type { PrismaClient } from "@/generated/prisma/client";

let database: Awaited<ReturnType<typeof testPostgres>>;
let db: PrismaClient;
let now = new Date("2030-01-15T18:10:00Z");
let employeeUserId: string, employeeId: string, adminId: string, suspendedId: string;

beforeAll(async () => {
  database = await testPostgres();
  process.env.DATABASE_URL = database.runtimeUrl;
  db = (await import("@/lib/db/client")).db;
  vi.spyOn(await import("@/features/time/clock"), "databaseNow").mockImplementation(async () => now);
  adminId = (await db.user.create({ data: { email: "admin@example.test", role: "ADMIN", passwordHash: "synthetic", mustChangePassword: false } })).id;
  suspendedId = (await db.user.create({ data: { email: "suspended@example.test", role: "HR_MANAGER", accountStatus: "SUSPENDED", passwordHash: "synthetic", mustChangePassword: false } })).id;
  employeeUserId = (await db.user.create({ data: { email: "employee@example.test", role: "EMPLOYEE", passwordHash: "synthetic", mustChangePassword: false } })).id;
  employeeId = (await db.employee.create({ data: {
    userId: employeeUserId, legalName: "Synthetic employee", employeeNumber: "E100", createdBy: adminId,
    employmentPeriods: { create: { startDate: new Date("2025-01-01"), departmentLabel: "Test", positionLabel: "Test", createdBy: adminId } },
  } })).id;
  await db.organizationSettings.create({ data: { companyName: "Synthetic test", timezone: "Asia/Dhaka", changedBy: adminId, overtimePolicyVersions: [] } });
});

afterAll(async () => { await db?.$disconnect(); await database?.stop(); });

it("persists partially committed delivery, backs off and rechecks records without duplicating in-app effects", async () => {
  const job = await import("@/features/review/notification-runs");
  const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  await db.employeeDocument.createMany({ data: ids.map((id, index) => ({
    id, employeeId, type: "OTHER" as const, displayName: "Synthetic document", storageKey: randomUUID() + ".bin",
    mimeType: "image/png", fileSize: 4, sha256: "a".repeat(64), expiresOn: new Date("2030-01-16"),
    uploadedBy: adminId, employeeVisible: index !== 0,
  })) });
  await database.owner.query(`
    CREATE FUNCTION interrupt_synthetic_notification() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
     IF NEW.source_id = '${ids[100]}' THEN RAISE EXCEPTION 'synthetic failure'; END IF;
     RETURN NEW;
    END; $$;
    CREATE TRIGGER interrupt_synthetic_notification BEFORE INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION interrupt_synthetic_notification();`);
  try {
    expect(await job.processScheduledNotifications()).toMatchObject({
      attempt: 1, status: "FAILED", scannedCount: 100, publishedCount: 199, failureCode: "SWEEP_FAILED",
      scheduledFor: new Date("2030-01-15T18:10:00Z"), businessDate: new Date("2030-01-16"),
      timezone: "Asia/Dhaka", nextRetryAt: new Date("2030-01-15T18:15:00Z"),
    });
    expect(await job.processScheduledNotifications()).toMatchObject({ status: "WAITING" });
  } finally { await database.owner.query("DROP TRIGGER interrupt_synthetic_notification ON notifications; DROP FUNCTION interrupt_synthetic_notification();"); }

  now = new Date("2030-01-15T18:15:00Z");
  expect(await job.processScheduledNotifications()).toMatchObject({ attempt: 2, status: "SUCCEEDED", scannedCount: 101, publishedCount: 2, nextRetryAt: null });
  expect(await job.processScheduledNotifications()).toMatchObject({ status: "ALREADY_SUCCEEDED" });
  expect(await job.processScheduledNotifications("2030-01-15")).toMatchObject({ status: "NOT_RETRYABLE" });
  expect(await db.notification.count()).toBe(201);
  expect(await db.notification.count({ where: { recipientUserId: suspendedId } })).toBe(0);
  expect(await db.notification.count({ where: { recipientUserId: employeeUserId, sourceId: ids[0] } })).toBe(0);
  expect(await db.notification.count({ where: { eventType: { endsWith: "_EXPIRING" } } })).toBe(0);
  expect((await job.notificationRunStatus()).map(x => x.status)).toEqual(["SUCCEEDED", "FAILED"]);
});

it("classifies interrupted runs and permits an explicit retry only for an existing incomplete slot", async () => {
  const job = await import("@/features/review/notification-runs");
  now = new Date("2030-01-16T18:10:00Z");
  await db.employeeNotificationAttempt.create({ data: { scheduledFor: now, attempt: 1, businessDate: new Date("2030-01-17"), timezone: "Asia/Dhaka", status: "RUNNING", startedAt: now } });
  expect(await job.processScheduledNotifications()).toMatchObject({ status: "INTERRUPTED", attempt: 1 });
  const lock = new pg.Client({ connectionString: database.runtimeUrl });
  await lock.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(73102303)");
    expect(await job.processScheduledNotifications("2030-01-16")).toEqual({ status: "IN_PROGRESS" });
  } finally { await lock.end(); }
  expect(await job.processScheduledNotifications("2030-01-16")).toMatchObject({ status: "SUCCEEDED", attempt: 2, publishedCount: 0 });
  expect(await job.processScheduledNotifications("2030-01-14")).toMatchObject({ status: "NOT_RETRYABLE" });
  expect(await job.processScheduledNotifications("2030-01-17")).toMatchObject({ status: "NOT_RETRYABLE" });
});
