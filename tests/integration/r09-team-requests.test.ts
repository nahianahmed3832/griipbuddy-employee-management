import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient, Role } from "@/generated/prisma/client";
import type { Identity } from "@/types/auth";
import { testPostgres } from "../postgres";

type Person = { identity: Identity; employeeId: string; periodId: string };
let database: Awaited<ReturnType<typeof testPostgres>>;
let db: PrismaClient;
let admin: Identity;
let lead: Person, otherLead: Person, report: Person, outsider: Person, hr: Person;
let leave: typeof import("@/features/review/absence");
let corrections: typeof import("@/features/review/corrections");
let notes: typeof import("@/features/review/notifications");
let timeline: typeof import("@/features/people/timeline");

function identity(userId: string): Identity {
  const issuedAt = Date.now();
  return { userId, issuedAt, absoluteExpiresAt: issuedAt + 43_200_000, sessionVersion: 1 };
}

async function person(label: string, role: Role, managerEmployeeId?: string): Promise<Person> {
  const user = await db.user.create({ data: {
    email: `${label.toLowerCase()}-r09@example.test`, role, mustChangePassword: false, passwordHash: "synthetic",
  } });
  const employee = await db.employee.create({ data: { userId: user.id, employeeNumber: `R09-${label}`, legalName: `Synthetic ${label}`, createdBy: admin.userId } });
  const period = await db.employmentPeriod.create({ data: {
    employeeId: employee.id, startDate: new Date("2018-01-01"), departmentLabel: "Synthetic operations",
    positionLabel: "Synthetic role", managerEmployeeId, createdBy: admin.userId,
  } });
  return { identity: identity(user.id), employeeId: employee.id, periodId: period.id };
}

const leaveProposal = (day: string) => ({ startDate: day, endDate: day, category: "OTHER", type: "UNPAID",
  reason: "Synthetic leave request", operationKey: randomUUID() });
const correction = (day: string, start: string, end: string) => ({
  type: "ADD", workDate: day, checkinAt: `${day}T${start}:00Z`, checkoutAt: `${day}T${end}:00Z`,
  reason: "Synthetic missed attendance evidence", operationKey: randomUUID(),
});

beforeAll(async () => {
  database = await testPostgres();
  process.env.DATABASE_URL = database.runtimeUrl;
  db = (await import("@/lib/db/client")).db;
  leave = await import("@/features/review/absence");
  corrections = await import("@/features/review/corrections");
  notes = await import("@/features/review/notifications");
  timeline = await import("@/features/people/timeline");
  const owner = await db.user.create({ data: { email: "owner-r09@example.test", role: "ADMIN", mustChangePassword: false, passwordHash: "synthetic" } });
  admin = identity(owner.id);
  await db.organizationSettings.create({ data: { companyName: "Synthetic R09", timezone: "Asia/Dhaka", changedBy: owner.id,
    overtimePolicyVersions: [{ effectiveFrom: "2000-01-03", thresholdSeconds: 172800, ruleVersion: 1 }],
  } });
  lead = await person("Lead", "EMPLOYEE");
  otherLead = await person("OtherLead", "EMPLOYEE");
  report = await person("Report", "EMPLOYEE", lead.employeeId);
  outsider = await person("Outsider", "EMPLOYEE", otherLead.employeeId);
  hr = await person("HR", "HR_MANAGER");
  await db.employmentPeriod.create({ data: {
    employeeId: report.employeeId, startDate: new Date("2000-01-01"), endDate: new Date("2018-01-01"),
    departmentLabel: "Former synthetic team", positionLabel: "Former synthetic role", createdBy: owner.id,
  } });
  // An additional stint uses the existing session rotation trigger.
  report.identity.sessionVersion = (await db.user.findUniqueOrThrow({ where: { id: report.identity.userId }, select: { sessionVersion: true } })).sessionVersion;
});

afterAll(async () => {
  await db?.$disconnect();
  await database?.stop();
});

describe("R09 current direct-report review, decisions and journals", () => {
  let leaveId: string, foreignLeaveId: string, correctionId: string, notificationId: string;

  it("stores dated leave in the organization timezone and replays one operation without a second request or journal entry", async () => {
    const proposal = leaveProposal("2025-05-12");
    leaveId = await leave.requestDatedLeave(report.identity, proposal);
    expect(await leave.requestDatedLeave(report.identity, proposal)).toBe(leaveId);
    const saved = await db.leaveRequest.findUniqueOrThrow({ where: { id: leaveId } });
    expect(saved.startAt.toISOString()).toBe("2025-05-11T18:00:00.000Z");
    expect(saved.endAt.toISOString()).toBe("2025-05-12T18:00:00.000Z");
    expect(saved.requestedBy).toBe(report.identity.userId);
    expect(await db.employeeActivity.count({ where: { employeeId: report.employeeId, sourceId: leaveId } })).toBe(1);
    await expect(leave.requestDatedLeave(report.identity, { ...proposal, operationKey: randomUUID() })).rejects.toMatchObject({ code: "DUPLICATE_LEAVE" });
    const approved = { id: leaveId, revision: 1, decision: "APPROVED", comment: "Synthetic cover confirmed" };
    await expect(leave.decideLeave(report.identity, approved)).rejects.toMatchObject({ status: 403 });
    await expect(leave.decideLeave(otherLead.identity, approved)).rejects.toMatchObject({ status: 404 });
  });

  it("limits lead queues, linked details and in-app notices to their current direct-report period", async () => {
    foreignLeaveId = await leave.requestDatedLeave(outsider.identity, leaveProposal("2025-05-12"));
    const historical = await leave.requestDatedLeave(report.identity, leaveProposal("2017-05-12"));
    const result = await leave.absenceData(lead.identity, true);
    expect(result.reviewMode).toBe("lead");
    expect(result.records.map(r => r.id)).toEqual([leaveId]);
    expect(result.leadEmployees?.map(e => e.id)).toEqual([report.employeeId]);
    await expect(leave.absenceData(lead.identity, true, 1, historical)).rejects.toMatchObject({ status: 404 });
    await expect(leave.absenceData(lead.identity, true, 1, foreignLeaveId)).rejects.toMatchObject({ status: 404 });
    await expect(leave.absenceData(report.identity, false, 1, foreignLeaveId)).rejects.toMatchObject({ status: 404 });
    const decision = { status: "REJECTED", reviewedBy: lead.identity.userId, reviewedAt: new Date(),
      reviewComment: "Synthetic raw trigger attempt", revision: { increment: 1 } };
    await expect(db.leaveRequest.update({ where: { id: leaveId }, data: decision }))
      .rejects.toThrow("An authorized non-self reviewer is required");
    await expect(db.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.actor_user_id', ${lead.identity.userId}, true)`;
      await tx.leaveRequest.update({ where: { id: foreignLeaveId }, data: decision });
    })).rejects.toThrow("An authorized non-self reviewer is required");

    const inbox = await notes.notificationPage(lead.identity);
    expect(inbox.records.map(n => n.sourceId)).toEqual([leaveId]);
    expect(inbox.unread).toBe(1);
    notificationId = inbox.records[0].id;
    expect(inbox.records[0].href).toBe(`/manage/leave?id=${leaveId}`);
    await notes.readNotification(lead.identity, notificationId);
    expect(await notes.unreadNotifications(lead.identity)).toBe(0);
  });

  it("requires a lead review reason, preserves HR self-review and administrative cancellation authority, and rejects repeat decisions", async () => {
    const approved = { id: leaveId, revision: 1, decision: "APPROVED", comment: "Synthetic cover confirmed" };
    await expect(leave.decideLeave(lead.identity, { ...approved, comment: "" })).rejects.toMatchObject({ status: 400 });
    await Promise.allSettled([leave.decideLeave(lead.identity, approved), leave.decideLeave(lead.identity, approved)]).then(results => {
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    });
    await expect(leave.decideLeave(lead.identity, { ...approved, revision: 2, decision: "CANCELLED" })).rejects.toMatchObject({ status: 403 });
    expect(await db.auditLog.count({ where: { action: "LEAVE_APPROVED", entityId: leaveId, actorUserId: lead.identity.userId } })).toBe(1);
    expect((await leave.absenceData(report.identity)).records.find(r => r.id === leaveId)?.reviewHistory[0])
      .toMatchObject({ decision: "APPROVED", comment: approved.comment });

    const hrLeave = await leave.requestDatedLeave(hr.identity, leaveProposal("2025-05-15"));
    const rejection = { id: hrLeave, revision: 1, decision: "REJECTED", comment: "Synthetic administrative decision" };
    await expect(leave.decideLeave(hr.identity, rejection)).rejects.toMatchObject({ code: "SELF_REVIEW" });
    await leave.decideLeave(admin, rejection);
    expect((await db.leaveRequest.findUniqueOrThrow({ where: { id: hrLeave } })).status).toBe("REJECTED");
    expect((await leave.absenceData(hr.identity, true, 1, foreignLeaveId)).records[0].id).toBe(foreignLeaveId);
  });

  it("applies one approved correction, preserves request and withdrawal journals, and hides foreign attendance", async () => {
    const proposal = correction("2025-05-13", "03:00", "05:00");
    correctionId = await corrections.submitCorrection(report.identity, proposal);
    expect(await corrections.submitCorrection(report.identity, proposal)).toBe(correctionId);
    await expect(corrections.submitCorrection(report.identity, { ...proposal, operationKey: randomUUID() })).rejects.toMatchObject({ code: "REQUEST_PENDING" });
    const other = await corrections.submitCorrection(outsider.identity, proposal);
    const pending = await corrections.submitCorrection(report.identity, correction("2025-05-14", "03:00", "05:00"));
    await corrections.withdrawCorrection(report.identity, { id: pending });
    await expect(corrections.withdrawCorrection(report.identity, { id: pending })).rejects.toMatchObject({ status: 409 });
    const approval = { id: correctionId, decision: "APPROVED", comment: "Synthetic work log verified" };
    const rejection = { id: other, decision: "REJECTED", comment: "Synthetic unrelated team request" };
    await expect(corrections.decideCorrection(lead.identity, rejection)).rejects.toMatchObject({ status: 404 });
    await expect(corrections.correctionOptions(lead.identity, report.employeeId)).rejects.toMatchObject({ status: 403 });
    await corrections.decideCorrection(lead.identity, approval);
    await expect(corrections.decideCorrection(lead.identity, approval)).rejects.toMatchObject({ status: 409 });
    expect(await db.attendanceSession.count({ where: { employeeId: report.employeeId, source: "CORRECTION" } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "CORRECTION_APPROVED", entityId: correctionId, actorUserId: lead.identity.userId } })).toBe(1);
    const owned = await timeline.ownTimeline(report.identity);
    expect(owned.filter(r => r.sourceId === correctionId).map(r => r.type).sort()).toEqual(["CORRECTION_APPROVED", "CORRECTION_SUBMITTED"]);
    expect(owned.filter(r => r.sourceId === pending && r.type === "CORRECTION_WITHDRAWN")).toHaveLength(1);
    expect((await timeline.ownTimeline(outsider.identity)).some(row => row.sourceId === correctionId)).toBe(false);
    await expect(timeline.employeeTimeline(lead.identity, report.employeeId)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects held-lead writes and removes the stale queue and notices on the next request after reassignment", async () => {
    const pending = await leave.requestDatedLeave(report.identity, leaveProposal("2025-05-16"));
    const decision = { id: pending, revision: 1, decision: "REJECTED", comment: "Synthetic decision" };
    await db.user.update({ where: { id: lead.identity.userId }, data: { accountStatus: "ON_HOLD" } });
    expect((await leave.absenceData(lead.identity, true, 1, pending)).records[0].canDecide).toBe(false);
    await expect(leave.decideLeave(lead.identity, decision)).rejects.toMatchObject({ code: "ACCOUNT_ON_HOLD" });
    await db.user.update({ where: { id: lead.identity.userId }, data: { accountStatus: "ACTIVE" } });
    await db.employmentPeriod.update({ where: { id: report.periodId }, data: { managerEmployeeId: otherLead.employeeId } });
    await expect(leave.absenceData(lead.identity, true)).rejects.toMatchObject({ status: 403 });
    await expect(corrections.correctionList(lead.identity, {}, true)).rejects.toMatchObject({ status: 403 });
    await expect(leave.decideLeave(lead.identity, decision)).rejects.toMatchObject({ status: 403 });
    expect(await notes.unreadNotifications(lead.identity)).toBe(0);
    expect((await notes.notificationPage(lead.identity)).total).toBe(0);
    expect(await notes.readAllNotifications(lead.identity)).toEqual({ count: 0 });
    await expect(notes.readNotification(lead.identity, notificationId)).rejects.toMatchObject({ status: 404 });
    await leave.decideLeave(otherLead.identity, decision);
  });
});
