import { TabNav } from "@/components/ui/tabs";

export function ReviewNav({ lead = false }: { lead?: boolean }) {
  const corrections = { label: "Corrections", href: "/manage/corrections" };
  const leave = { label: lead ? "Leave requests" : "Leave & holidays", href: "/manage/leave" };
  const items = lead ? [corrections, leave] : [
    { label: "Attendance", href: "/manage/attendance" },
    { label: "Work time", href: "/manage/work-time" },
    corrections,
    { label: "Overtime", href: "/manage/overtime" },
    leave,
  ];
  return <TabNav label={lead ? "Team review" : "Attendance review"} items={items} />;
}
