import "server-only";
import { resolveEmploymentCatalogs } from "@/features/organization/catalogs";
import { db } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import { authorizedMutation } from "@/lib/db/mutation";
import { assertRole } from "@/lib/authorization/policy";
import { securityBoundary } from "@/lib/authorization/actor";
import { loadActor } from "@/lib/authorization/actor";
import { validated, uuidSchema, createAccountSchema, accountSecuritySchema, resetPasswordSchema, changePasswordSchema } from "@/lib/validation/schemas";
import { hashPassword, verifyPassword } from "@/lib/auth/passwords";
import { AppError } from "@/lib/utils/errors";
import type { Identity } from "@/types/auth";
import { peopleEvent } from "@/features/people/service";

export async function listAccounts(identity: Identity | null) {
  return securityBoundary(identity, async actor => {
    assertRole(actor, ["ADMIN"]);
    return db.user.findMany({ orderBy: { email: "asc" }, take: 100, select: { id: true, email: true, displayName: true, role: true, isActive: true, accountStatus: true,
      mustChangePassword: true, canManageCommissions: true, employee: { select: { legalName: true, preorderCommissionEnabled: true } } } });
  });
}
export async function createAccount(identity: Identity | null, input: unknown) {
  await securityBoundary(identity, async actor => assertRole(actor, ["ADMIN"]));
  const value = validated(createAccountSchema, input);
  const passwordHash = await hashPassword(value.temporaryPassword);
  try {
    return await authorizedMutation(identity, async (actor, tx) => {
      assertRole(actor, ["ADMIN"]);
      const user = await tx.user.create({ data: { email: value.email, displayName: value.createEmployee ? null : value.displayName, role: value.role, passwordHash,
        mustChangePassword: true, temporaryPasswordExpiresAt: new Date(Date.now() + 86400000) }, select: { id: true } });
      let employeeId: string | undefined;
      if (value.createEmployee) {
        const catalogs = await resolveEmploymentCatalogs(tx, actor.userId, value);
        const employee = await tx.employee.create({ data: { userId: user.id, employeeNumber: value.employeeNumber, legalName: value.legalName, createdBy: actor.userId,
          employmentPeriods: { create: { startDate: new Date(`${value.startDate}T00:00:00.000Z`), ...catalogs, createdBy: actor.userId } } }, select: { id: true } });
        employeeId = employee.id;
        await audit({ actorUserId: actor.userId, employeeId, action: "EMPLOYEE_CREATED", entity: "employees", entityId: employeeId,
          after: { employeeNumber: value.employeeNumber, departmentLabel: value.departmentLabel, positionLabel: value.positionLabel } }, tx);
        await peopleEvent(tx, { employeeId, actorUserId: actor.userId, type: "EMPLOYEE_CREATED", title: "Employee profile created", sourceType: "employees", sourceId: employeeId });
      }
      await audit({ actorUserId: actor.userId, employeeId, action: "ACCOUNT_CREATED", entity: "users", entityId: user.id, after: { role: value.role, linkedEmployee: value.createEmployee } }, tx);
      return user.id;
    });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") throw new AppError(409, "DUPLICATE", "The email or employee number is already in use.");
    throw error;
  }
}
export async function updateAccountSecurity(identity: Identity | null, input: unknown) {
  await securityBoundary(identity, async actor => assertRole(actor, ["ADMIN"]));
  const value = validated(accountSecuritySchema, input);
  return authorizedMutation(identity, async (actor, tx) => {
    assertRole(actor, ["ADMIN"]);
    const target = await tx.user.findUnique({ where: { id: value.userId }, include: { employee: { select: { id: true, preorderCommissionEnabled: true } } } });
    if (!target) throw new AppError(404, "NOT_FOUND", "Account not found.");
    if (value.role === "EMPLOYEE" && !target.employee) throw new AppError(400, "EMPLOYEE_REQUIRED", "Link an employee profile before assigning the employee role.");
    if (value.canManageCommissions && value.role !== "HR_MANAGER") throw new AppError(400, "INVALID_GRANT", "Only HR managers use the management commission grant.");
    if (value.preorderCommissionEnabled && !target.employee) throw new AppError(400, "EMPLOYEE_REQUIRED", "This account has no employee profile.");
    if(target.id===actor.userId && !value.isActive)throw new AppError(403,"SELF_STATUS","You cannot suspend your own account.");
    if (target.role === "ADMIN" && target.isActive && target.accountStatus === "ACTIVE" && (value.role !== "ADMIN" || !value.isActive)) {
      const admins = await tx.user.count({ where: { role: "ADMIN", isActive: true, accountStatus: "ACTIVE" } });
      if (admins <= 1) throw new AppError(409, "LAST_ADMIN", "Keep at least one active administrator.");
    }
    const accountStatus = value.isActive && target.accountStatus === "SUSPENDED" ? "ACTIVE" : target.accountStatus;
    await tx.user.update({ where: { id: target.id }, data: { role: value.role, isActive: value.isActive, accountStatus,
      canManageCommissions: value.canManageCommissions, sessionVersion: { increment: 1 } } });
    if (target.employee) await tx.employee.update({ where: { id: target.employee.id }, data: { preorderCommissionEnabled: value.preorderCommissionEnabled } });
    await audit({ actorUserId: actor.userId, employeeId: target.employee?.id, action: "ACCOUNT_SECURITY_CHANGED", entity: "users", entityId: target.id,
      before: { role: target.role, isActive: target.isActive, accountStatus: target.accountStatus, canManageCommissions: target.canManageCommissions,
        preorderCommissionEnabled: target.employee?.preorderCommissionEnabled ?? false },
      after: { role: value.role, isActive: value.isActive, accountStatus, canManageCommissions: value.canManageCommissions,
        preorderCommissionEnabled: value.preorderCommissionEnabled } }, tx);
  }, value.userId);
}
export async function resetPassword(identity: Identity | null, input: unknown) {
  await securityBoundary(identity, async actor => assertRole(actor, ["ADMIN"]));
  const value = validated(resetPasswordSchema, input);
  const passwordHash = await hashPassword(value.temporaryPassword);
  await authorizedMutation(identity, async (actor, tx) => {
    assertRole(actor, ["ADMIN"]);
    if (actor.userId === value.userId) throw new AppError(403, "SELF_RESET", "Use Change password to update your own password.");
    const target = await tx.user.findUnique({ where: { id: value.userId }, select: { id: true, passwordHash: true } });
    if (!target) throw new AppError(404, "NOT_FOUND", "Account not found.");
    if (target.passwordHash.startsWith("$argon2") && await verifyPassword(target.passwordHash, value.temporaryPassword))
      throw new AppError(400, "PASSWORD_REUSED", "Choose a different temporary password.");
    await tx.user.update({ where: { id: target.id }, data: { passwordHash, mustChangePassword: true, temporaryPasswordExpiresAt: new Date(Date.now() + 86400000),
      sessionVersion: { increment: 1 }, failedLoginCount: 0, lockedUntil: null, lastFailedLoginAt: null } });
    await audit({ actorUserId: actor.userId, action: "PASSWORD_RESET", entity: "users", entityId: target.id }, tx);
  }, value.userId);
}
export async function revokeAccountSessions(identity: Identity | null, input: unknown) {
  await securityBoundary(identity, async actor => assertRole(actor, ["ADMIN"]));
  const userId = validated(uuidSchema, input);
  await authorizedMutation(identity, async (actor, tx) => {
    assertRole(actor, ["ADMIN"]);
    const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!target) throw new AppError(404, "NOT_FOUND", "Account not found.");
    await tx.user.update({ where: { id: target.id }, data: { sessionVersion: { increment: 1 } } });
    await audit({ actorUserId: actor.userId, action: "ACCOUNT_SESSIONS_REVOKED", entity: "users", entityId: target.id }, tx);
  }, userId);
}
export async function changeOwnPassword(identity: Identity | null, input: unknown) {
  // Only this operation allows a forced-change identity into a mutation.
  await loadActor(identity, undefined, true);
  const value = validated(changePasswordSchema, input);
  await authorizedMutation(identity, async (actor, tx) => {
    const account = await tx.user.findUniqueOrThrow({ where: { id: actor.userId } });
    if (!await verifyPassword(account.passwordHash, value.currentPassword)) throw new AppError(400, "PASSWORD_MISMATCH", "Current password was not accepted.");
    const passwordHash = await hashPassword(value.password);
    await tx.user.update({ where: { id: actor.userId }, data: { passwordHash, mustChangePassword: false, temporaryPasswordExpiresAt: null,
      passwordChangedAt: new Date(), sessionVersion: { increment: 1 }, failedLoginCount: 0, lockedUntil: null, lastFailedLoginAt: null } });
    await audit({ actorUserId: actor.userId, action: "PASSWORD_CHANGED", entity: "users", entityId: actor.userId }, tx);
  }, undefined, true);
}
