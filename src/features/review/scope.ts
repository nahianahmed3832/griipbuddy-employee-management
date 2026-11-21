import "server-only";
import { db } from "@/lib/db/client";
import type { Database } from "@/lib/db/audit";
import { AppError } from "@/lib/utils/errors";
import { businessDate } from "@/lib/utils/business-date";
import type { Actor } from "@/types/auth";

const periodSelect = { id: true, employeeId: true, employee: { select: { legalName: true } } } as const;
export type LeadPeriod = { id: string; employeeId: string; employee: { legalName: string } };
export type RequestReviewScope = { kind: "staff" } | { kind: "lead"; periods: LeadPeriod[] };

export function activePeriod(date: Date) {
  return { startDate: { lte: date }, OR: [{ endDate: null }, { endDate: { gt: date } }] };
}

export async function organizationDate(client: Database) {
  const { timezone } = await client.organizationSettings.findUniqueOrThrow({ where: { id: 1 }, select: { timezone: true } });
  return businessDate(timezone);
}

export async function directReportPeriods(actor: Actor, client: Database = db): Promise<LeadPeriod[]> {
  if (actor.role !== "EMPLOYEE" || !actor.employeeId || !actor.employmentActive) return [];
  return client.employmentPeriod.findMany({
    where: { ...activePeriod(await organizationDate(client)), managerEmployeeId: actor.employeeId, employeeId: { not: actor.employeeId } },
    select: periodSelect,
  });
}

export async function hasDirectReports(actor: Actor) {
  return (await directReportPeriods(actor)).length > 0;
}

export async function requestReviewScope(actor: Actor, client: Database = db): Promise<RequestReviewScope> {
  if (actor.role === "ADMIN" || actor.role === "HR_MANAGER") return { kind: "staff" };
  const periods = await directReportPeriods(actor, client);
  if (!periods.length) throw new AppError(403, "ROLE_DENIED", "You do not have access to this review queue.");
  return { kind: "lead", periods };
}

export function requestScopeWhere(scope: RequestReviewScope) {
  if (scope.kind === "staff") return {};
  return { OR: scope.periods.map(({ id, employeeId }) => ({ employmentPeriodId: id, employeeId })) };
}
