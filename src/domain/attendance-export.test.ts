import { describe, expect, it } from "vitest";
import { buildAttendanceCsv, type AttendanceExportRow } from "./attendance-export";

const rows: AttendanceExportRow[] = [
  {
    id: "evt_1",
    workspaceName: "문정점",
    employeeName: "직원 A",
    kioskName: "입구, 태블릿",
    eventType: "clock_in",
    occurredAt: "2026-07-08T00:12:34.000Z",
    latitude: 37.5133,
    longitude: 127.1002,
    accuracyMeters: 24.7,
    riskFlags: []
  },
  {
    id: "evt_2",
    workspaceName: "문정점",
    employeeName: '직원 "B"',
    kioskName: "입구\n태블릿",
    eventType: "clock_out",
    occurredAt: "2026-07-08T09:01:02.000Z",
    riskFlags: ["location_missing"]
  }
];

describe("attendance csv export", () => {
  it("builds an excel-friendly korean csv without raw qr hashes", () => {
    const csv = buildAttendanceCsv(rows);

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("기록시각,사업장,직원,유형,키오스크,위험표시,위도,경도,정확도미터,이벤트아이디");
    expect(csv).toContain("2026-07-08 09:12:34,문정점,직원 A,출근");
    expect(csv).toContain('"입구, 태블릿"');
    expect(csv).toContain('"직원 ""B"""');
    expect(csv).toContain('"입구\n태블릿"');
    expect(csv).toContain("위치없음");
    expect(csv).not.toContain("qr_nonce_hash");
    expect(csv).not.toContain("qrNonceHash");
  });

  it("returns only the header when there are no events", () => {
    const csv = buildAttendanceCsv([]);

    expect(csv).toBe("\uFEFF기록시각,사업장,직원,유형,키오스크,위험표시,위도,경도,정확도미터,이벤트아이디\n");
  });
});
