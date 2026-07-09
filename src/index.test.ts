import { describe, expect, it } from "vitest";
import app from "./index";
import { createQrToken } from "./domain/qr-token";

const LOCAL_SECRET = "local-dev-secret";

async function createToken(nonce: string): Promise<string> {
  return createQrToken(
    {
      workspaceId: "default-workspace",
      kioskId: "main-kiosk",
      purpose: "clock",
      issuedAt: Math.floor(Date.now() / 1000),
      ttlSeconds: 60,
      nonce
    },
    LOCAL_SECRET
  );
}

describe("worker app", () => {
  it("returns health status", async () => {
    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, service: "chulgeun-dojang" });
  });

  it("renders the landing page", async () => {
    const response = await app.request("/");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("출근도장");
    expect(html).toContain("무료 오픈소스 큐알 근태 기록기");
    expect(html).toContain("/start");
    expect(html).toContain("/kiosk");
  });

  it("renders the production kiosk with a scan link", async () => {
    const response = await app.request("/kiosk");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("출근도장 키오스크");
    expect(html).toContain("/scan?token=");
  });

  it("consumes a qr token on first scan and rejects replay scans", async () => {
    const token = await createToken(`replay-${crypto.randomUUID()}`);
    const first = await app.request(`/scan?token=${encodeURIComponent(token)}`);
    const firstHtml = await first.text();

    expect(first.status).toBe(200);
    expect(firstHtml).toContain('name="attemptId"');

    const second = await app.request(`/scan?token=${encodeURIComponent(token)}`);
    const secondHtml = await second.text();

    expect(second.status).toBe(409);
    expect(secondHtml).toContain("이미 갱신된 큐알");
  });

  it("records a clock event after a consumed scan", async () => {
    const responseHtml = await recordClockEvent();

    expect(responseHtml).toContain("출근 기록 완료");
    expect(responseHtml).toContain("직원 A");
  });

  it("rejects csv export without the admin token", async () => {
    const response = await app.request("/admin/export.csv");

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("관리자 인증이 필요합니다");
  });

  it("exports attendance records as a protected csv download", async () => {
    await recordClockEvent();

    const response = await app.request(
      "/admin/export.csv",
      { headers: { authorization: "Bearer export-token" } },
      { ADMIN_EXPORT_TOKEN: "export-token" }
    );
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("attendance-default-workspace");
    expect(csv).toContain("기록시각,사업장,직원,유형,키오스크,위험표시");
    expect(csv).toContain("직원 A");
    expect(csv).toContain("출근");
    expect(csv).not.toContain("qr_nonce_hash");
  });
});

async function recordClockEvent(): Promise<string> {
  const token = await createToken(`clock-${crypto.randomUUID()}`);
  const scan = await app.request(`/scan?token=${encodeURIComponent(token)}`);
  const html = await scan.text();
  const attemptId = html.match(/name="attemptId" value="([^"]+)"/)?.[1];

  expect(attemptId).toBeTruthy();

  const form = new URLSearchParams({
    token,
    attemptId: attemptId ?? "",
    employeeId: "employee-a",
    eventType: "clock_in"
  });
  const response = await app.request("/api/clock", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form
  });

  expect(response.status).toBe(200);
  return response.text();
}
