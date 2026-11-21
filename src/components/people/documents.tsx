import { Download, Eye, FileText, Upload } from "lucide-react";
import { ActionForm } from "@/components/ui/action-form";
import { Field, CheckboxField } from "@/components/ui/field";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { TableContainer, Cell2 } from "@/components/ui/table";
import { deleteDocumentAction, documentVisibilityAction } from "@/features/people/actions";
import { DocumentUpload } from "./document-upload";
import type { listDocuments } from "@/features/people/documents";
import { optionItems, optionLabels } from "@/features/settings/config";
const day = (date: Date | null) => date?.toISOString().slice(0, 10);
export async function UploadDocumentButton({ employeeId }: { employeeId: string }) {
  const types = (await optionItems("DOCUMENT_TYPE")).map(t => ({ code: t.code, label: t.label }));
  return <Dialog variant="default" trigger={<><Upload size={16} aria-hidden="true" />Upload document</>} title="Upload a private document" description="Documents are stored privately and released to the employee only when you choose."><DocumentUpload employeeId={employeeId} types={types} /></Dialog>;
}
export async function Documents({ documents, employeeId, staff }: { documents: Awaited<ReturnType<typeof listDocuments>>; employeeId: string; staff: boolean }) {
  const labels = await optionLabels("DOCUMENT_TYPE");
  if (!documents.length) return <EmptyState icon={FileText} title="No documents yet" description={staff ? "Upload contracts, identification and other records. They stay private until released." : "Documents released to you by HR will appear here."} />;
  return <TableContainer label="Documents"><table className="data-table min-w-[320px] md:min-w-[720px]"><thead><tr><th>Document</th><th className="hidden md:table-cell">Uploaded</th><th className="hidden md:table-cell">Validity</th>{staff && <th className="hidden md:table-cell">Access</th>}<th className="text-right">Actions</th></tr></thead><tbody>{documents.map(document => {
    const url = staff ? `/api/employees/${employeeId}/documents/${document.id}` : `/api/me/documents/${document.id}`, expired = document.expiresOn && document.expiresOn < new Date();
    const uploader = document.uploader.employee?.legalName ?? document.uploader.displayName ?? "Staff";
    const validity = document.expiresOn ? <StatusBadge status={expired ? "EXPIRED" : "VALID"} label={`${expired ? "Expired" : "Expires"} ${day(document.expiresOn)}`} /> : <span className="text-muted-foreground">{document.issuedOn ? `Issued ${day(document.issuedOn)}` : "No expiry"}</span>;
    const access = staff && <StatusBadge status={document.employeeVisible ? "PUBLISHED" : "DRAFT"} label={document.employeeVisible ? "Released" : "Staff only"} />;
    return <tr key={document.id}>
      <td>
        <Cell2 primary={<span className="wrap-anywhere">{document.displayName}</span>} secondary={`${labels[document.type] ?? document.type.replaceAll("_", " ").toLowerCase().replace(/^./, c => c.toUpperCase())} · ${Math.ceil(document.fileSize / 1024)} KiB · ${document.mimeType === "application/pdf" ? "PDF" : "Image"}`} />
        <div className="mt-2 space-y-1 text-xs md:hidden">
          <div className="text-muted-foreground">Uploaded {day(document.createdAt)} by {uploader}</div>
          <div className="flex flex-wrap items-center gap-1">{validity}{access}</div>
        </div>
      </td>
      <td className="hidden md:table-cell"><Cell2 primary={day(document.createdAt)} secondary={uploader} /></td>
      <td className="hidden whitespace-nowrap md:table-cell">{validity}</td>
      {staff && <td className="hidden md:table-cell">{access}</td>}
      <td><div className="flex flex-wrap justify-end gap-1 md:flex-nowrap"><a href={url} aria-label={`Download ${document.displayName}`} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-primary hover:bg-primary-soft"><Download size={14} aria-hidden="true" />Download</a>{document.mimeType !== "application/pdf" && <a href={`${url}?view=1`} aria-label={`View ${document.displayName} in a new tab`} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-primary hover:bg-primary-soft"><Eye size={14} aria-hidden="true" />View</a>}
        {staff && <Dialog triggerSize="sm" variant="ghost" trigger="Access" triggerLabel={`Access settings for ${document.displayName}`} title="Change employee access" description={document.displayName}><ActionForm action={documentVisibilityAction} submitLabel="Save access"><input type="hidden" name="employeeId" value={employeeId} /><input type="hidden" name="documentId" value={document.id} /><CheckboxField name="employeeVisible" defaultChecked={document.employeeVisible} label="Employee may view and download" /><Field label="Reason for the change" name="reason" required maxLength={500} /></ActionForm></Dialog>}
        {staff && <Dialog triggerSize="sm" variant="ghost" triggerClassName="text-danger hover:bg-danger-soft hover:text-danger" trigger="Remove" triggerLabel={`Remove ${document.displayName}`} title="Remove document access" description="The file and its metadata are retained for audit; it is removed from all document lists."><ActionForm action={deleteDocumentAction} submitLabel="Remove document" confirmation={{ title: "Remove this document?", description: "It will no longer be accessible to staff or the employee. The stored file is retained for audit.", label: "Remove", destructive: true }}><input type="hidden" name="employeeId" value={employeeId} /><input type="hidden" name="documentId" value={document.id} /><Field label="Removal reason" name="reason" required maxLength={500} /></ActionForm></Dialog>}</div></td>
    </tr>;
  })}</tbody></table></TableContainer>;
}
