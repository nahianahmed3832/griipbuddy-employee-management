import "server-only";
import type {Actor} from "@/types/auth";
import type {Database} from "@/lib/db/audit";
import {assertRole} from "@/lib/authorization/policy";
import {AppError} from "@/lib/utils/errors";
export function peopleStaff(actor:Actor){assertRole(actor,["ADMIN","HR_MANAGER"]);}
export function publisher(actor:Actor,employeeId:string){peopleStaff(actor);if(actor.role==="HR_MANAGER"&&actor.employeeId===employeeId)throw new AppError(403,"SELF_PUBLICATION","An administrator must publish or correct your own official review or warning.");}
export const publishedWarning={publishedAt:{not:null},employeeVisible:true,revokedAt:null};
export async function documentsHiddenByParent(tx: Database, employeeId: string, documentIds: string[]) {
  if (!documentIds.length) return new Set<string>();
  const incidents = await tx.incidentRecord.findMany({
    where: { employeeId, evidenceDocumentId: { in: documentIds }, employeeVisible: false },
    select: { evidenceDocumentId: true },
  });
  const warnings = await tx.disciplinaryRecord.findMany({
    where: { employeeId, attachmentDocumentId: { in: documentIds }, OR: [{ publishedAt: null }, { employeeVisible: false }, { revokedAt: { not: null } }] },
    select: { attachmentDocumentId: true },
  });
  return new Set([
    ...incidents.map(record => record.evidenceDocumentId),
    ...warnings.map(record => record.attachmentDocumentId),
  ].filter((id): id is string => id !== null));
}
export async function documentParentVisible(tx: Database, employeeId: string, documentId: string) {
  return !(await documentsHiddenByParent(tx, employeeId, [documentId])).has(documentId);
}
