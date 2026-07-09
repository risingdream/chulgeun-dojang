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
    expect(html).toContain("앱 설치 없는");
    expect(html).toContain("/start");
    expect(html).toContain("/kiosk");
  });

  it("renders the kiosk from the provided A1 screen, with a scan link but no public recent records", async () => {
    await recordClockEvent();

    const response = await app.request("/kiosk");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-screen-label="A1 키오스크 태블릿 정상"');
    expect(html).toContain("/scan?token=");
    expect(html).toContain("새 큐알까지 60초");
    expect(html).toContain("화면을 두 번 탭하면 전체 화면으로 전환됩니다");
    expect(html).toContain("width:100vw");
    expect(html).toContain("height:100dvh");
    expect(html).toContain("min-height:100vh");
    expect(html).toContain("main { min-height: 100vh; width: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; padding: 0; }");
    expect(html).toContain("requestFullscreen");
    expect(html).toContain("document.addEventListener('dblclick', enterFullscreen)");
    expect(html).toContain("data-admin-hold-link");
    expect(html).toContain("const adminHoldMs = 3000");
    expect(html).toContain("window.location.href = '/admin/today'");
    expect(html).not.toContain("phone-device");
    expect(html).not.toContain("background:#101216");
    expect(html).not.toContain("width:960px;height:620px");
    expect(html).not.toContain("width:min(1120px,100%)");
    expect(html).not.toContain("border-radius:22px");
    expect(html).not.toContain("최근 기록");
    expect(html).not.toContain("김민지</strong>");
    expect(html).not.toContain("상태 안내");
  });

  it("renders first-time scan using the provided 2a and B3 screens", async () => {
    const token = await createToken(`first-device-${crypto.randomUUID()}`);
    const response = await app.request(`/scan?token=${encodeURIComponent(token)}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-screen-label="2a 기기 기억 첫 1회"');
    expect(html).toContain('data-screen-label="B3 위치 권한 안내"');
    expect(html).not.toContain("phone-device");
    expect(html).not.toContain("width:402px");
    expect(html).toContain("처음이시네요. 이름을 한 번만 선택해주세요.");
    expect(html).toContain("이 폰 기억하기");
    expect(html).toContain("기록하는 순간의 위치 1회만 저장");
    expect(html).toContain("이동 경로는 수집하지 않습니다");
    expect(html).toContain("김민지");
    expect(html).toContain("출근");
    expect(html).toContain("퇴근");
  });

  it("skips employee selection when the device remembered a valid employee", async () => {
    const token = await createToken(`remembered-device-${crypto.randomUUID()}`);
    const response = await app.request(`/scan?token=${encodeURIComponent(token)}`, {
      headers: { cookie: "rememberedEmployeeId=employee-b" }
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-screen-label="2a 기기 기억 매일"');
    expect(html).toContain("박서준 님, 안녕하세요");
    expect(html).toContain('name="employeeId" value="employee-b"');
    expect(html).toContain("내가 아니에요 — 이름 선택으로");
    expect(html).not.toContain("이 폰 기억하기");
    expect(html).not.toContain("김민지</span>");
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
    expect(secondHtml).toContain('data-screen-label="B7 큐알 재사용 차단"');
    expect(secondHtml).toContain("이미 사용된 큐알입니다");
  });

  it("sets remembered-device cookie and allows clearing it", async () => {
    const { html, headers } = await recordClockEvent({ rememberEmployee: "true" });

    expect(html).toContain('data-screen-label="B4 기록 완료"');
    expect(html).toContain("이 화면은 닫아도 됩니다");
    expect(html).toContain("기억 해제");
    expect(html).not.toContain("키오스크로 돌아가기");
    expect(html).not.toContain('href="/kiosk"');
    expect(html).not.toContain("phone-device");
    expect(headers.get("set-cookie")).toContain("rememberedEmployeeId=employee-a");

    const forget = await app.request("/forget-device");
    expect(forget.status).toBe(200);
    expect(forget.headers.get("set-cookie")).toContain("rememberedEmployeeId=;");
    expect(await forget.text()).toContain("기기 기억을 해제했습니다");
  });

  it("records skipped location as an explicit risk flag", async () => {
    const { html } = await recordClockEvent({ locationConsent: "skipped" });

    expect(html).toContain("위치 없음");
    expect(html).toContain("위치 건너뜀");

    const response = await app.request(
      "/admin/export.csv",
      { headers: { authorization: "Bearer export-token" } },
      { ADMIN_EXPORT_TOKEN: "export-token" }
    );
    const csv = await response.text();

    expect(csv).toContain("위치없음;위치건너뜀");
  });

  it("protects today admin view and shows records when authorized", async () => {
    await recordClockEvent();

    const unauthorized = await app.request("/admin/today");
    expect(unauthorized.status).toBe(401);

    const authorized = await app.request(
      "/admin/today",
      { headers: { authorization: "Bearer export-token" } },
      { ADMIN_EXPORT_TOKEN: "export-token" }
    );
    const html = await authorized.text();

    expect(authorized.status).toBe(200);
    expect(html).toContain("오늘 기록");
    expect(html).toContain("김민지");
  });

  it("unlocks the owner screen with a PIN session cookie", async () => {
    await recordClockEvent();

    const env = { ADMIN_PIN: "1234", ADMIN_EXPORT_TOKEN: "export-token" };
    const locked = await app.request("/admin/today", {}, env);
    const lockedHtml = await locked.text();

    expect(locked.status).toBe(401);
    expect(lockedHtml).toContain('data-screen-label="A6 사장님 확인 PIN"');
    expect(lockedHtml).toContain('method="post" action="/admin/unlock"');
    expect(lockedHtml).toContain('name="pin"');
    expect(lockedHtml).toContain("data-pin-key");

    const wrong = await app.request("/admin/unlock", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pin: "9999" })
    }, env);
    const wrongHtml = await wrong.text();

    expect(wrong.status).toBe(401);
    expect(wrongHtml).toContain("PIN이 맞지 않습니다");
    expect(wrong.headers.get("set-cookie") ?? "").not.toContain("adminSession=");

    const unlock = await app.request("/admin/unlock", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pin: "1234" })
    }, env);
    const cookie = unlock.headers.get("set-cookie") ?? "";

    expect(unlock.status).toBe(302);
    expect(unlock.headers.get("location")).toBe("/admin/today");
    expect(cookie).toContain("adminSession=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Max-Age=60");

    const unlocked = await app.request("/admin/today", { headers: { cookie } }, env);
    const unlockedHtml = await unlocked.text();

    expect(unlocked.status).toBe(200);
    expect(unlockedHtml).toContain("오늘 기록");
    expect(unlockedHtml).toContain("CSV 내려받기");
    expect(unlockedHtml).toContain("김민지");

    const csv = await app.request("/admin/export.csv", { headers: { cookie } }, env);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
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
    expect(csv).toContain("김민지");
    expect(csv).toContain("출근");
    expect(csv).not.toContain("qr_nonce_hash");
  });
});

async function recordClockEvent(options: Record<string, string> = {}): Promise<{ html: string; headers: Headers }> {
  const token = await createToken(`clock-${crypto.randomUUID()}`);
  const scan = await app.request(`/scan?token=${encodeURIComponent(token)}`);
  const html = await scan.text();
  const attemptId = html.match(/name="attemptId" value="([^"]+)"/)?.[1];

  expect(attemptId).toBeTruthy();

  const form = new URLSearchParams({
    token,
    attemptId: attemptId ?? "",
    employeeId: "employee-a",
    eventType: "clock_in",
    ...options
  });
  const response = await app.request("/api/clock", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form
  });

  expect(response.status).toBe(200);
  return { html: await response.text(), headers: response.headers };
}
