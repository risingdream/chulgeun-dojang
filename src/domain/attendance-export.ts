export type AttendanceExportEventType = "clock_in" | "clock_out" | "break_start" | "break_end";

export type AttendanceExportRow = {
  id: string;
  workspaceName: string;
  employeeName: string;
  kioskName: string;
  eventType: AttendanceExportEventType;
  occurredAt: string;
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  riskFlags: string[];
};

const CSV_HEADERS = [
  "기록시각",
  "사업장",
  "직원",
  "유형",
  "키오스크",
  "위험표시",
  "위도",
  "경도",
  "정확도미터",
  "이벤트아이디"
] as const;

const EVENT_TYPE_LABELS: Record<AttendanceExportEventType, string> = {
  clock_in: "출근",
  clock_out: "퇴근",
  break_start: "휴게시작",
  break_end: "휴게종료"
};

const RISK_FLAG_LABELS: Record<string, string> = {
  location_missing: "위치없음"
};

export function buildAttendanceCsv(rows: AttendanceExportRow[]): string {
  const lines = [CSV_HEADERS.join(",")];

  for (const row of rows) {
    lines.push([
      formatKstTimestamp(row.occurredAt),
      row.workspaceName,
      row.employeeName,
      EVENT_TYPE_LABELS[row.eventType],
      row.kioskName,
      formatRiskFlags(row.riskFlags),
      formatOptionalNumber(row.latitude),
      formatOptionalNumber(row.longitude),
      formatOptionalNumber(row.accuracyMeters),
      row.id
    ].map(csvCell).join(","));
  }

  return `\uFEFF${lines.join("\n")}\n`;
}

function csvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function formatRiskFlags(flags: string[]): string {
  if (flags.length === 0) return "정상";
  return flags.map((flag) => RISK_FLAG_LABELS[flag] ?? flag).join(";");
}

function formatOptionalNumber(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "";
  return String(value);
}

function formatKstTimestamp(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}
