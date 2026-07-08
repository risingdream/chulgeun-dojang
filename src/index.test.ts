import { describe, expect, it } from "vitest";
import app from "./index";
import { createQrToken } from "./domain/qr-token";

const DEMO_SECRET = "local-dev-secret";

async function createDemoToken(nonce: string): Promise<string> {
  return createQrToken(
    {
      workspaceId: "demo-workspace",
      kioskId: "demo-kiosk",
      purpose: "clock",
      issuedAt: Math.floor(Date.now() / 1000),
      ttlSeconds: 60,
      nonce
    },
    DEMO_SECRET
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
    expect(html).toContain("/demo");
  });

  it("renders a demo kiosk with a scan link", async () => {
    const response = await app.request("/kiosk/demo");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("테스트 키오스크");
    expect(html).toContain("/scan?token=");
  });

  it("consumes a qr token on first scan and rejects replay scans", async () => {
    const token = await createDemoToken(`replay-${crypto.randomUUID()}`);
    const first = await app.request(`/scan?token=${encodeURIComponent(token)}`);
    const firstHtml = await first.text();

    expect(first.status).toBe(200);
    expect(firstHtml).toContain('name="attemptId"');

    const second = await app.request(`/scan?token=${encodeURIComponent(token)}`);
    const secondHtml = await second.text();

    expect(second.status).toBe(409);
    expect(secondHtml).toContain("이미 갱신된 큐알");
  });

  it("records a demo clock event after a consumed scan", async () => {
    const responseHtml = await recordDemoClockEvent();

    expect(responseHtml).toContain("출근 기록 완료");
    expect(responseHtml).toContain("직원 A");
  });

  it("rejects csv export without the admin token", async () => {
    const response = await app.request("/admin/demo/export.csv");

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("관리자 인증이 필요합니다");
  });

  it("exports attendance records as a protected csv download", async () => {
    await recordDemoClockEvent();

    const response = await app.request(
      "/admin/demo/export.csv",
      { headers: { authorization: "Bearer export-token" } },
      { ADMIN_EXPORT_TOKEN: "export-token" }
    );
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("attendance-demo-workspace");
    expect(csv).toContain("기록시각,사업장,직원,유형,키오스크,위험표시");
    expect(csv).toContain("직원 A");
    expect(csv).toContain("출근");
    expect(csv).not.toContain("qr_nonce_hash");
  });
});

async function recordDemoClockEvent(): Promise<string> {
  const token = await createDemoToken(`clock-${crypto.randomUUID()}`);
  const scan = await app.request(`/scan?token=${encodeURIComponent(token)}`);
  const html = await scan.text();
  const attemptId = html.match(/name="attemptId" value="([^"]+)"/)?.[1];

  expect(attemptId).toBeTruthy();

  const form = new URLSearchParams({
    token,
    attemptId: attemptId ?? "",
    employeeId: "demo-a",
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
