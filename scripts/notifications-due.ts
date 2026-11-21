import "dotenv/config";
import { dateSchema } from "../src/lib/validation/schemas";
import { notificationRunStatus, processScheduledNotifications } from "../src/features/review/notification-runs";
import { db } from "../src/lib/db/client";

try {
  const [command = "scheduled", day, extra] = process.argv.slice(2);
  if (command === "status" && day === undefined) {
    console.log(JSON.stringify(await notificationRunStatus()));
  } else if (command === "scheduled" && day === undefined || command === "retry" && !extra && dateSchema.safeParse(day).success) {
    const result = await processScheduledNotifications(day);
    if (!["WAITING", "ALREADY_SUCCEEDED", "IN_PROGRESS"].includes(result.status)) console.log(JSON.stringify(result));
    if (["FAILED", "INTERRUPTED", "NOT_RETRYABLE"].includes(result.status)) process.exitCode = 1;
  } else {
    console.error("Use scheduled, status, or retry YYYY-MM-DD (UTC schedule date).");
    process.exitCode = 2;
  }
} catch {
  // Database and transport diagnostics can contain credentials or private source data.
  console.error(JSON.stringify({ status: "UNAVAILABLE", failureCode: "WORKER_UNAVAILABLE" }));
  process.exitCode = 1;
} finally { await db.$disconnect(); }
