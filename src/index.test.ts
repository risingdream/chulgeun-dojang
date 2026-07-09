import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    expect(html).not.toContain("cdn.jsdelivr.net");
  });

  it("redirects the kiosk to setup when the D1 workspace is not configured", async () => {
    const response = await app.request("/kiosk", {}, { DB: d1WithoutOwnerSetup() });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/setup");
  });

  it("redirects the kiosk to setup when this browser has no local workspace token", async () => {
    const response = await app.request("/kiosk", {}, { DB: fakeD1({ ownerPinHash: "configured-pin-hash", workspaceName: "심플랩스" }) });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/setup");
  });

  it("renders setup controls for address search, map, radius, and kiosk name", async () => {
    const response = await app.request("/setup");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("data-location-picker");
    expect(html).toContain("data-address-search-input");
    expect(html).toContain("주소 검색");
    expect(html).toContain("지도");
    expect(html).toContain("현재 위치로 설정");
    expect(html).toContain('name="latitude"');
    expect(html).toContain('name="longitude"');
    expect(html).toContain('name="radiusMeters"');
    expect(html).toContain('name="kioskName"');
  });

  it("searches Korean addresses through the location search API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        display_name: "서울특별시 강남구 테헤란로 123",
        lat: "37.501274",
        lon: "127.039585",
        type: "office"
      }
    ]), { headers: { "content-type": "application/json" } }));

    const response = await app.request("/api/location/search?q=" + encodeURIComponent("서울 강남구 테헤란로 123"));
    const json = await response.json() as { results: Array<{ name: string; latitude: number; longitude: number }> };

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("nominatim.openstreetmap.org/search");
    expect(json.results[0]).toMatchObject({
      name: "서울특별시 강남구 테헤란로 123",
      latitude: 37.501274,
      longitude: 127.039585
    });
  });

  it("falls back to a second geocoder when address search returns no Nominatim results", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        features: [
          {
            properties: { name: "서울특별시청", city: "서울", osm_value: "townhall" },
            geometry: { coordinates: [126.97842, 37.566789] }
          }
        ]
      }), { headers: { "content-type": "application/json" } }));

    const response = await app.request("/api/location/search?q=" + encodeURIComponent("서울특별시청"));
    const json = await response.json() as { results: Array<{ name: string; latitude: number; longitude: number }> };

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get("q")).toBe("서울특별시청 대한민국");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("photon.komoot.io/api");
    expect(json.results[0]).toMatchObject({
      name: "서울특별시청 · 서울",
      latitude: 37.566789,
      longitude: 126.97842
    });
  });

  it("retries Korean address searches with a Korea suffix before external fallback", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          display_name: "서울특별시청, 110, 세종대로, 서울특별시, 대한민국",
          lat: "37.5667893",
          lon: "126.9784204",
          type: "townhall"
        }
      ]), { headers: { "content-type": "application/json" } }));

    const response = await app.request("/api/location/search?q=" + encodeURIComponent("서울특별시청"));
    const json = await response.json() as { results: Array<{ name: string; latitude: number; longitude: number }> };

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get("q")).toBe("서울특별시청 대한민국");
    expect(json.results[0]).toMatchObject({
      name: "서울특별시청, 110, 세종대로, 서울특별시, 대한민국",
      latitude: 37.5667893,
      longitude: 126.9784204
    });
  });

  it("does not run default D1 seed writes on every kiosk request", async () => {
    let batchCalls = 0;
    const db = withBatchCounter(
      fakeD1({ ownerPinHash: "configured-pin-hash", workspaceName: "심플랩스" }),
      () => { batchCalls += 1; }
    );

    const response = await app.request("/kiosk", {}, { DB: db });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/setup");
    expect(batchCalls).toBe(0);
  });

  it("binds a local workspace token through setup, then requires kiosk login before showing the kiosk", async () => {
    const db = fakeD1();
    const env = { DB: db };

    const setup = await app.request("/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: setupParams()
    }, env);
    const workspaceCookie = setup.headers.get("set-cookie") ?? "";

    expect(setup.status).toBe(302);
    expect(setup.headers.get("location")).toBe("/kiosk/login");
    expect(workspaceCookie).toContain("workspaceToken=");
    expect(workspaceCookie).toContain("HttpOnly");

    const kioskWithoutLogin = await app.request("/kiosk", { headers: { cookie: workspaceCookie } }, env);
    expect(kioskWithoutLogin.status).toBe(302);
    expect(kioskWithoutLogin.headers.get("location")).toBe("/kiosk/login");

    const loginPage = await app.request("/kiosk/login", { headers: { cookie: workspaceCookie } }, env);
    const loginHtml = await loginPage.text();

    expect(loginPage.status).toBe(200);
    expect(loginHtml).toContain('data-screen-label="K1 키오스크 로그인 PIN"');
    expect(loginHtml).not.toContain('data-screen-label="A5 키오스크 로그인 PIN"');
    expect(loginHtml).toContain('method="post" action="/kiosk/login"');
    expect(loginHtml).toContain("심플랩스");

    const wrongLogin = await app.request("/kiosk/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: workspaceCookie },
      body: new URLSearchParams({ pin: "0000" })
    }, env);
    const wrongLoginHtml = await wrongLogin.text();

    expect(wrongLogin.status).toBe(401);
    expect(wrongLoginHtml).toContain("PIN이 맞지 않습니다");
    expect(wrongLogin.headers.get("set-cookie") ?? "").not.toContain("kioskSession=");

    const login = await app.request("/kiosk/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: workspaceCookie },
      body: new URLSearchParams({ pin: "1234" })
    }, env);
    const kioskCookie = login.headers.get("set-cookie") ?? "";

    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/kiosk");
    expect(kioskCookie).toContain("kioskSession=");
    expect(kioskCookie).toContain("HttpOnly");

    const kiosk = await app.request("/kiosk", { headers: { cookie: `${workspaceCookie}; ${kioskCookie}` } }, env);
    const kioskHtml = await kiosk.text();

    expect(kiosk.status).toBe(200);
    expect(kioskHtml).toContain('data-screen-label="A1 키오스크 태블릿 정상"');
    expect(kioskHtml).toContain("심플랩스");
  });

  it("renders the kiosk from the provided A1 screen, with a scan link but no public recent records", async () => {
    await recordClockEvent();

    const response = await app.request("/kiosk");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-screen-label="A1 키오스크 태블릿 정상"');
    expect(html).toContain("/scan?token=");
    expect(html).not.toContain("api.qrserver.com");
    expect(html).not.toContain('<img src="https://');
    expect(html).toContain("새 큐알까지 60초");
    expect(html).toContain("사업장");
    expect(html).not.toContain("카페 소소");
    expect(html).toContain("화면을 두 번 탭하면 전체 화면으로 전환됩니다");
    expect(html).toContain("width:100vw");
    expect(html).toContain("height:100dvh");
    expect(html).toContain("min-height:100vh");
    expect(html).toContain("main { min-height: 100vh; width: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; padding: 0; }");
    expect(html).toContain("requestFullscreen");
    expect(html).toContain("document.addEventListener('dblclick', enterFullscreen)");
    expect(html).toContain("data-admin-view-link");
    expect(html).toContain('href="/admin/today"');
    expect(html).toContain("사장님 열람");
    expect(html).not.toContain("3초 길게");
    expect(html).not.toContain("data-admin-hold-link");
    expect(html).not.toContain("const adminHoldMs");
    expect(html).not.toContain("event.preventDefault()");
    expect(html).not.toContain("phone-device");
    expect(html).not.toContain("background:#101216");
    expect(html).not.toContain("width:960px;height:620px");
    expect(html).not.toContain("width:min(1120px,100%)");
    expect(html).not.toContain("border-radius:22px");
    expect(html).not.toContain("최근 기록");
    expect(html).not.toContain("김민지</strong>");
    expect(html).not.toContain("상태 안내");
  });

  it("renders kiosk state screens A2, A3, A4, and A5 from the provided HTML plan", async () => {
    const offline = await app.request("/kiosk?state=offline");
    const offlineHtml = await offline.text();
    expect(offline.status).toBe(200);
    expect(offlineHtml).toContain('data-screen-label="A2 키오스크 태블릿 오프라인"');
    expect(offlineHtml).toContain("네트워크 연결이 끊겼습니다");
    expect(offlineHtml).toContain("큐알 사용 중지");
    expect(offlineHtml).toContain("이미 저장된 기록은 사라지지 않습니다");
    expect(offlineHtml).toContain("width:100vw");
    expect(offlineHtml).not.toContain("background:#101216");

    const failed = await app.request("/kiosk?state=qr-failed");
    const failedHtml = await failed.text();
    expect(failed.status).toBe(200);
    expect(failedHtml).toContain('data-screen-label="A3 키오스크 태블릿 큐알 갱신 실패"');
    expect(failedHtml).toContain("새 큐알을 만들지 못했습니다");
    expect(failedHtml).toContain("만료됨 — 스캔해도 기록되지 않습니다");
    expect(failedHtml).toContain("5초 후 자동 재시도");

    const phone = await app.request("/kiosk?device=phone");
    const phoneHtml = await phone.text();
    expect(phone.status).toBe(200);
    expect(phoneHtml).toContain('data-screen-label="A4 키오스크 폰 정상"');
    expect(phoneHtml).toContain("카메라로 찍고 → 이름 선택 → 출근/퇴근");
    expect(phoneHtml).toContain("새 큐알까지 60초");

    const phoneOffline = await app.request("/kiosk?device=phone&state=offline");
    const phoneOfflineHtml = await phoneOffline.text();
    expect(phoneOffline.status).toBe(200);
    expect(phoneOfflineHtml).toContain('data-screen-label="A5 키오스크 폰 오프라인"');
    expect(phoneOfflineHtml).toContain("네트워크 끊김 — 연결되면 자동 복구됩니다");
    expect(phoneOfflineHtml).toContain("사장님 열람 — 키오스크에서");
  });

  it("renders first-time scan using the provided B1, B2, 2a option, and B3 screens", async () => {
    const token = await createToken(`first-device-${crypto.randomUUID()}`);
    const response = await app.request(`/scan?token=${encodeURIComponent(token)}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-screen-label="B1 직원 이름 선택"');
    expect(html).toContain('data-screen-label="B2 출근/퇴근 선택"');
    expect(html).toContain('data-flow-label="2a 기기 기억 첫 1회"');
    expect(html).toContain('data-screen-label="B3 위치 권한 안내"');
    expect(html).not.toContain("phone-device");
    expect(html).not.toContain("width:402px");
    expect(html).toContain("이름을 선택해주세요 · 카운터 태블릿");
    expect(html).toContain("이 폰 기억하기");
    expect(html).toContain("기록하는 순간의 위치 1회만 저장");
    expect(html).toContain("이동 경로는 수집하지 않습니다");
    expect(html).toContain("김민지");
    expect(html).toContain("출근");
    expect(html).toContain("퇴근");
  });

  it("renders scan full-bleed with registered D1 employees instead of fixture employees", async () => {
    const token = await createToken(`d1-employees-${crypto.randomUUID()}`);
    const response = await app.request(`/scan?token=${encodeURIComponent(token)}`, {}, {
      DB: fakeD1({ employees: [{ id: "employee-real-1", name: "강태오", codeHash: "real-1-code" }] })
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("강태오");
    expect(html).toContain('name="employeeId" value="employee-real-1"');
    expect(html).not.toContain("김민지");
    expect(html).toContain(".staff-screen { width: 100vw; min-height: 100dvh; height: 100dvh; border-radius: 0; background: #FDFBF6; overflow: auto; position: relative; box-shadow: none; border: 0;");
    expect(html).toContain("main:has(.staff-screen) { align-items: stretch; justify-content: stretch; padding: 0; background: #FDFBF6; }");
    expect(html).not.toContain("width: min(430px, 100%)");
    expect(html).not.toContain("min-height: min(760px, calc(100vh - 24px))");
  });

  it("skips employee selection when the device remembered a valid employee", async () => {
    const token = await createToken(`remembered-device-${crypto.randomUUID()}`);
    const response = await app.request(`/scan?token=${encodeURIComponent(token)}`, {
      headers: { cookie: "rememberedEmployeeId=employee-b" }
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-screen-label="B2 출근/퇴근 선택"');
    expect(html).toContain('data-flow-label="2a 기기 기억 매일"');
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
    const forgetHtml = await forget.text();
    expect(forget.status).toBe(200);
    expect(forget.headers.get("set-cookie")).toContain("rememberedEmployeeId=;");
    expect(forgetHtml).toContain("기기 기억을 해제했습니다");
    expect(forgetHtml).toContain("이 화면은 닫아도 됩니다");
    expect(forgetHtml).not.toContain('href="/kiosk"');
  });

  it("records attendance for a registered D1 employee and never falls back to fixture employees", async () => {
    const token = await createToken(`d1-clock-${crypto.randomUUID()}`);
    const env = { DB: fakeD1({ employees: [{ id: "employee-real-2", name: "문소리", codeHash: "real-2-code" }] }) };
    const scan = await app.request(`/scan?token=${encodeURIComponent(token)}`, {}, env);
    const scanHtml = await scan.text();
    const attemptId = scanHtml.match(/name="attemptId" value="([^"]+)"/)?.[1];

    expect(scanHtml).toContain("문소리");
    expect(attemptId).toBeTruthy();

    const response = await app.request("/api/clock", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        attemptId: attemptId ?? "",
        employeeId: "employee-real-2",
        eventType: "clock_in",
        locationConsent: "skipped"
      })
    }, env);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("문소리");
    expect(html).not.toContain("김민지");
    expect(html).not.toContain('href="/kiosk"');
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

  it("renders B5 when a granted location is outside the workspace radius", async () => {
    const { html } = await recordClockEvent({
      locationConsent: "granted",
      latitude: "37.5233",
      longitude: "127.1102",
      accuracyMeters: "15"
    });

    expect(html).toContain('data-screen-label="B5 기록 완료 위치 벗어남"');
    expect(html).toContain("사업장 반경 밖");
    expect(html).toContain("기록이 저장되었습니다. 이 창은 닫으셔도 됩니다.");

    const response = await app.request(
      "/admin/export.csv",
      { headers: { authorization: "Bearer export-token" } },
      { ADMIN_EXPORT_TOKEN: "export-token" }
    );
    const csv = await response.text();
    expect(csv).toContain("반경밖");
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
    expect(html).toContain('href="/admin/employees"');
    expect(html).toContain("직원 관리");
  });

  it("lets the owner open employee registration directly from an empty today screen", async () => {
    const env = {
      ADMIN_EXPORT_TOKEN: "export-token",
      DB: fakeD1({
        workspaceName: "심플랩스",
        ownerPinHash: "configured-pin-hash",
        employees: []
      })
    };

    const response = await app.request(
      "/admin/today",
      { headers: { authorization: "Bearer export-token" } },
      env
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("등록된 직원이 없습니다");
    expect(html).toContain('href="/admin/employees/new"');
    expect(html).toContain("직원 등록");
  });

  it("renders D1, D2, and D3 employee management screens and creates employees from owner flow", async () => {
    const env = {
      ADMIN_EXPORT_TOKEN: "export-token",
      DB: fakeD1({
        workspaceName: "심플랩스",
        ownerPinHash: "configured-pin-hash",
        employees: [
          { id: "employee-active", name: "강태오", status: "registered" },
          { id: "employee-inactive", name: "문소리", status: "inactive" },
          { id: "employee-a", name: "김민지", status: "fixture_removed" }
        ]
      })
    };
    const auth = { authorization: "Bearer export-token" };

    const list = await app.request("/admin/employees", { headers: auth }, env);
    const listHtml = await list.text();
    expect(list.status).toBe(200);
    expect(listHtml).toContain('data-screen-label="D1 직원 관리 목록"');
    expect(listHtml).toContain("직원 관리");
    expect(listHtml).toContain("심플랩스 · 활동 1명 · 비활성 1명");
    expect(listHtml).toContain("+ 직원 추가");
    expect(listHtml).toContain("삭제 대신 비활성화");
    expect(listHtml).toContain("강태오");
    expect(listHtml).toContain("문소리");
    expect(listHtml).not.toContain("김민지");

    const removedFixtureDetail = await app.request("/admin/employees/employee-a", { headers: auth }, env);
    expect(removedFixtureDetail.status).toBe(404);

    const newPage = await app.request("/admin/employees/new", { headers: auth }, env);
    const newHtml = await newPage.text();
    expect(newPage.status).toBe(200);
    expect(newHtml).toContain('data-screen-label="D2 직원 추가"');
    expect(newHtml).toContain("이름만 있으면 됩니다. 전화번호·주민번호는 받지 않습니다.");
    expect(newHtml).toContain("추가하고 계속");
    expect(newHtml).toContain("완료");

    const create = await app.request("/admin/employees", {
      method: "POST",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "최유나" })
    }, env);
    expect(create.status).toBe(302);
    expect(create.headers.get("location")).toBe("/admin/employees/new?added=%EC%B5%9C%EC%9C%A0%EB%82%98");

    const afterCreate = await app.request("/admin/employees", { headers: auth }, env);
    expect(await afterCreate.text()).toContain("최유나");

    const detail = await app.request("/admin/employees/employee-active", { headers: auth }, env);
    const detailHtml = await detail.text();
    expect(detail.status).toBe(200);
    expect(detailHtml).toContain('data-screen-label="D3 직원 상세 시트"');
    expect(detailHtml).toContain("등록 링크 복사");
    expect(detailHtml).toContain("이름 수정");
    expect(detailHtml).toContain("비활성화");
    expect(detailHtml).toContain("닫기");

    const deactivate = await app.request("/admin/employees/employee-active", {
      method: "POST",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "deactivate" })
    }, env);
    expect(deactivate.status).toBe(302);
    expect(deactivate.headers.get("location")).toBe("/admin/employees");

    const scanToken = await createToken(`after-deactivate-${crypto.randomUUID()}`);
    const scan = await app.request(`/scan?token=${encodeURIComponent(scanToken)}`, {}, env);
    const scanHtml = await scan.text();
    expect(scanHtml).not.toContain("강태오");
  });

  it("sets the owner PIN during business setup and uses it for the owner session", async () => {
    await recordClockEvent();

    const setupPage = await app.request("/setup");
    const setupHtml = await setupPage.text();

    expect(setupPage.status).toBe(200);
    expect(setupHtml).toContain('data-screen-label="A0 사업자 setup"');
    expect(setupHtml).toContain('name="ownerPin"');
    expect(setupHtml).not.toContain("ADMIN_PIN");

    const setup = await app.request("/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: setupParams()
    });

    expect(setup.status).toBe(302);
    expect(setup.headers.get("location")).toBe("/kiosk/login");
    expect(setup.headers.get("set-cookie")).toContain("workspaceToken=");

    const unlockKiosk = await app.request("/kiosk/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: setup.headers.get("set-cookie") ?? "" },
      body: new URLSearchParams({ pin: "1234" })
    });

    expect(unlockKiosk.status).toBe(302);
    expect(unlockKiosk.headers.get("location")).toBe("/kiosk");

    const kioskAfterSetup = await app.request("/kiosk", {
      headers: { cookie: `${setup.headers.get("set-cookie") ?? ""}; ${unlockKiosk.headers.get("set-cookie") ?? ""}` }
    });
    const kioskAfterSetupHtml = await kioskAfterSetup.text();

    expect(kioskAfterSetup.status).toBe(200);
    expect(kioskAfterSetupHtml).toContain("심플랩스");
    expect(kioskAfterSetupHtml).not.toContain("카페 소소");

    const env = { ADMIN_PIN: "0000", ADMIN_EXPORT_TOKEN: "export-token" };
    const locked = await app.request("/admin/today", {}, env);
    const lockedHtml = await locked.text();

    expect(locked.status).toBe(401);
    expect(lockedHtml).toContain('data-screen-label="A6 사장님 확인 PIN"');
    expect(lockedHtml).toContain('method="post" action="/admin/unlock"');
    expect(lockedHtml).toContain('name="pin"');
    expect(lockedHtml).toContain("data-pin-key");
    expect(lockedHtml).not.toContain("ADMIN_PIN");

    const envPinMustBeIgnored = await app.request("/admin/unlock", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pin: "0000" })
    }, env);
    const wrongHtml = await envPinMustBeIgnored.text();

    expect(envPinMustBeIgnored.status).toBe(401);
    expect(wrongHtml).toContain("PIN이 맞지 않습니다");
    expect(envPinMustBeIgnored.headers.get("set-cookie") ?? "").not.toContain("adminSession=");

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
    expect(unlockedHtml).not.toContain(">QR<");
    expect(unlockedHtml).not.toContain("큐알 유지 중");
    expect(unlockedHtml).not.toContain("60초 후 자동 잠금");

    const csv = await app.request("/admin/export.csv", { headers: { cookie } }, env);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
  });

  it("persists setup location and lets the owner update it from workspace settings", async () => {
    const db = fakeD1();
    const env = { DB: db };

    const setup = await app.request("/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: setupParams({ kioskName: "2층 키오스크", latitude: "37.501274", longitude: "127.039585", radiusMeters: "150" })
    }, env);
    const workspaceCookie = setup.headers.get("set-cookie") ?? "";
    expect(setup.status).toBe(302);

    const kioskLogin = await app.request("/kiosk/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: workspaceCookie },
      body: new URLSearchParams({ pin: "1234" })
    }, env);
    const kiosk = await app.request("/kiosk", {
      headers: { cookie: `${workspaceCookie}; ${kioskLogin.headers.get("set-cookie") ?? ""}` }
    }, env);
    const kioskHtml = await kiosk.text();
    expect(kioskHtml).toContain("2층 키오스크");

    const unlock = await app.request("/admin/unlock", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pin: "1234" })
    }, env);
    const adminCookie = unlock.headers.get("set-cookie") ?? "";

    const settings = await app.request("/admin/workspace", { headers: { cookie: adminCookie } }, env);
    const settingsHtml = await settings.text();
    expect(settings.status).toBe(200);
    expect(settingsHtml).toContain('data-screen-label="B1 사업장 설정"');
    expect(settingsHtml).toContain('name="kioskName"');
    expect(settingsHtml).toContain('value="2층 키오스크"');
    expect(settingsHtml).toContain('value="37.501274"');
    expect(settingsHtml).toContain('value="127.039585"');

    const save = await app.request("/admin/workspace", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: adminCookie },
      body: setupParams({ businessName: "심플랩스 본점", kioskName: "입구 태블릿", latitude: "37.502", longitude: "127.04", radiusMeters: "100" })
    }, env);
    expect(save.status).toBe(302);
    expect(save.headers.get("location")).toBe("/admin/workspace?saved=1");

    const updated = await app.request("/admin/workspace", { headers: { cookie: adminCookie } }, env);
    const updatedHtml = await updated.text();
    expect(updatedHtml).toContain("심플랩스 본점");
    expect(updatedHtml).toContain('value="입구 태블릿"');
    expect(updatedHtml).toContain('value="37.502"');
    expect(updatedHtml).toContain('value="127.04"');
    expect(updatedHtml).toContain('value="100" selected');
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

function setupParams(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    businessName: "심플랩스",
    ownerPin: "1234",
    kioskName: "입구 키오스크",
    latitude: "37.4979",
    longitude: "127.0276",
    radiusMeters: "80",
    ...overrides
  });
}

function d1WithoutOwnerSetup(): D1Database {
  return {
    batch: async () => [],
    prepare: (query: string) => ({
      bind: () => ({
        first: async () => query.includes("owner_pin_hash")
          ? { owner_pin_hash: null, workspace_name: "운영 사업장", kiosk_name: "입구 키오스크" }
          : null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true })
      })
    })
  } as unknown as D1Database;
}

function withBatchCounter(db: D1Database, onBatch: () => void): D1Database {
  return {
    ...db,
    batch: async (statements: D1PreparedStatement[]) => {
      onBatch();
      return db.batch(statements);
    }
  } as D1Database;
}

function fakeD1(initial: {
  workspaceName?: string;
  ownerPinHash?: string | null;
  kioskName?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
  employees?: Array<{ id: string; name: string; codeHash?: string; status?: string }>;
} = {}): D1Database {
  const state = {
    workspaceName: initial.workspaceName ?? "운영 사업장",
    ownerPinHash: initial.ownerPinHash ?? null,
    kioskName: initial.kioskName ?? "입구 키오스크",
    latitude: initial.latitude ?? 37.5133,
    longitude: initial.longitude ?? 127.1002,
    radiusMeters: initial.radiusMeters ?? 80,
    employees: initial.employees ?? [],
    consumptions: new Map<string, { attemptId: string; completedEmployeeId?: string }>()
  };

  return {
    batch: async () => [],
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (query.includes("SELECT owner_pin_hash FROM workspaces")) {
            return { owner_pin_hash: state.ownerPinHash };
          }
          if (query.includes("SELECT w.name AS workspace_name")) {
            return {
              workspace_name: state.workspaceName,
              owner_pin_hash: state.ownerPinHash,
              kiosk_name: state.kioskName,
              latitude: state.latitude,
              longitude: state.longitude,
              radius_meters: state.radiusMeters
            };
          }
          if (query.includes("FROM employees")) {
            const employee = state.employees.find((item) => item.id === args[1]);
            if (!employee) return null;
            if (query.includes("status = ?") && (employee.status ?? "registered") !== args[2]) return null;
            return {
              id: employee.id,
              name: employee.name,
              employee_code_hash: employee.codeHash ?? `${employee.id}-code`,
              status: employee.status ?? "registered"
            };
          }
          if (query.includes("FROM qr_consumptions")) {
            const record = state.consumptions.get(String(args[0]));
            if (!record || record.attemptId !== args[1]) return null;
            return { completed_employee_id: record.completedEmployeeId ?? null };
          }
          if (query.includes("SELECT event_hash FROM attendance_events")) {
            return null;
          }
          return null;
        },
        all: async () => {
          if (query.includes("FROM employees")) {
            const employees = query.includes("status = ?")
              ? state.employees.filter((employee) => (employee.status ?? "registered") === args[1])
              : state.employees;
            return {
              results: employees.map((employee) => ({
                id: employee.id,
                name: employee.name,
                employee_code_hash: employee.codeHash ?? `${employee.id}-code`,
                status: employee.status ?? "registered"
              }))
            };
          }
          return { results: [] };
        },
        run: async () => {
          if (query.includes("INSERT INTO workspaces")) {
            state.workspaceName = String(args[1] ?? state.workspaceName);
            state.latitude = Number(args[2] ?? state.latitude);
            state.longitude = Number(args[3] ?? state.longitude);
            state.radiusMeters = Number(args[4] ?? state.radiusMeters);
            state.ownerPinHash = typeof args[6] === "string" ? args[6] : state.ownerPinHash;
          }
          if (query.includes("UPDATE workspaces")) {
            state.workspaceName = String(args[0] ?? state.workspaceName);
            state.latitude = Number(args[1] ?? state.latitude);
            state.longitude = Number(args[2] ?? state.longitude);
            state.radiusMeters = Number(args[3] ?? state.radiusMeters);
          }
          if (query.includes("INSERT INTO kiosks")) {
            state.kioskName = String(args[2] ?? state.kioskName);
          }
          if (query.includes("INSERT INTO qr_consumptions")) {
            state.consumptions.set(String(args[0]), { attemptId: String(args[3]) });
          }
          if (query.includes("INSERT INTO employees")) {
            state.employees.push({
              id: String(args[0]),
              name: String(args[2]),
              codeHash: String(args[3]),
              status: String(args[4] ?? "registered")
            });
          }
          if (query.includes("UPDATE employees SET status")) {
            const employee = state.employees.find((item) => item.id === args[1]);
            if (employee) employee.status = String(args[0]);
          }
          if (query.includes("UPDATE employees SET name")) {
            const employee = state.employees.find((item) => item.id === args[1]);
            if (employee) employee.name = String(args[0]);
          }
          return { success: true };
        }
      })
    })
  } as unknown as D1Database;
}
