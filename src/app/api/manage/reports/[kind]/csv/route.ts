import { apiError,requestIdentity } from "@/lib/http";
import { reportData } from "@/features/insights/reports";
import { reportCsv } from "@/features/insights/csv";
export async function GET(request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const data = await reportData(await requestIdentity(), (await context.params).kind, query, true);
    // Keep the existing exclusive end-date convention and describe the effective filter.
    const filename = `${data.kind}-${data.from ?? "all"}-to-${data.until ?? "all"}.csv`;
    return new Response(reportCsv(data.columns, data.records), { headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return apiError(error); }
}
