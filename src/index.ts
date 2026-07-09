import { Hono } from "hono";
import { buildAttendanceCsv, type AttendanceExportRow } from "./domain/attendance-export";
import { createQrToken, hashQrNonce, verifyQrToken, type QrClaims } from "./domain/qr-token";

type Env = {
  DB?: D1Database;
  STORE?: DurableObjectNamespace;
  APP_NAME?: string;
  QR_SECRET?: string;
  ADMIN_EXPORT_TOKEN?: string;
};

type ClockEventType = "clock_in" | "clock_out" | "break_start" | "break_end";
type LocationConsent = "granted" | "skipped" | "unavailable";

type ConsumptionRecord = {
  qrNonceHash: string;
  workspaceId: string;
  kioskId: string;
  attemptId: string;
  consumedAt: string;
  completedEmployeeId?: string;
  completedAt?: string;
};

type AttendanceEventRecord = {
  id: string;
  workspaceId: string;
  employeeId: string;
  employeeName: string;
  kioskId: string;
  eventType: ClockEventType;
  occurredAt: string;
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  riskFlags: string[];
};

const app = new Hono<{ Bindings: Env }>();

const DEFAULT_WORKSPACE_ID = "default-workspace";
const DEFAULT_KIOSK_ID = "main-kiosk";
const DEFAULT_WORKSPACE_DISPLAY_NAME = "카페 소소";
const DEFAULT_KIOSK_DISPLAY_NAME = "카운터 태블릿";
const QR_TTL_SECONDS = 60;
const LOCAL_SECRET = "local-dev-secret";
const REMEMBERED_EMPLOYEE_COOKIE = "rememberedEmployeeId";
const REMEMBERED_EMPLOYEE_MAX_AGE = 60 * 60 * 24 * 365;
const seedEmployees = [
  { id: "employee-a", name: "김민지", codeHash: "employee-a-code" },
  { id: "employee-b", name: "박서준", codeHash: "employee-b-code" },
  { id: "employee-c", name: "이하늘", codeHash: "employee-c-code" },
  { id: "employee-d", name: "최유나", codeHash: "employee-d-code" },
  { id: "employee-e", name: "정도윤", codeHash: "employee-e-code" },
  { id: "employee-f", name: "한지우", codeHash: "employee-f-code" }
] as const;

const memoryStore = {
  consumptions: new Map<string, ConsumptionRecord>(),
  events: [] as AttendanceEventRecord[]
};

app.onError((error, context) => {
  const detail = error instanceof Error ? error.message : "알 수 없는 오류입니다.";
  return context.html(messagePage("서버 오류", detail, "/kiosk"), 500);
});

app.get("/healthz", (context) => {
  return context.json({
    ok: true,
    service: "chulgeun-dojang",
    storage: context.env?.DB ? "d1" : context.env?.STORE ? "durable_object" : "memory"
  });
});

app.get("/", (context) => {
  return context.html(layout({
    title: "출근도장",
    body: `
      <section class="landing-shell">
        <div class="brand-row">${brandMark()}<span class="pill">직원 앱 설치 없음</span></div>
        <div class="landing-copy">
          <p class="eyebrow">small business attendance</p>
          <h1>앱 설치 없는<br />큐알 출퇴근 장부</h1>
          <p>남는 태블릿을 키오스크로 켜두고, 직원은 자기 폰 카메라로 찍습니다. 매일은 가볍게, 월말에는 CSV로 바로 정리합니다.</p>
        </div>
        <div class="flow-strip">
          <span>1 큐알 찍기</span><span>2 이름 확인</span><span>3 출근·퇴근</span><span>4 월말 내려받기</span>
        </div>
        <div class="actions">
          <a class="button primary" href="/kiosk">키오스크 열기</a>
          <a class="button" href="/start">운영 흐름 보기</a>
        </div>
      </section>
    `
  }));
});

app.get("/demo", (context) => context.redirect("/start", 302));

app.get("/start", (context) => {
  return context.html(layout({
    title: "출근도장 운영 시작",
    body: `
      <section class="hero-card plan-card">
        <div class="brand-row">${brandMark()}<span class="pill green">운영 시작</span></div>
        <h1>매장에는 키오스크,<br />직원은 자기 폰</h1>
        <p>키오스크의 큐알을 직원 폰으로 찍고, 첫 1회만 이름을 고릅니다. 다음부터는 이 폰 기억으로 바로 출근·퇴근합니다.</p>
        <div class="step-list">
          <div><strong>1</strong><span>키오스크 화면을 매장에 켭니다</span></div>
          <div><strong>2</strong><span>직원이 자기 폰으로 큐알을 찍습니다</span></div>
          <div><strong>3</strong><span>위치는 1회만 저장하고, 없으면 흔적을 남깁니다</span></div>
          <div><strong>4</strong><span>사장님 화면에서 오늘 기록을 확인합니다</span></div>
        </div>
        <div class="actions">
          <a class="button primary" href="/kiosk">키오스크 열기</a>
          <a class="button" href="/admin/today">사장님 확인</a>
        </div>
      </section>
    `
  }));
});

app.get("/kiosk/demo", (context) => context.redirect("/kiosk", 302));

app.get("/kiosk", async (context) => {
  await ensureDefaultSeed(context.env);

  const now = Math.floor(Date.now() / 1000);
  const token = await createQrToken(
    {
      workspaceId: DEFAULT_WORKSPACE_ID,
      kioskId: DEFAULT_KIOSK_ID,
      purpose: "clock",
      issuedAt: now,
      ttlSeconds: QR_TTL_SECONDS
    },
    getQrSecret(context.env)
  );
  const origin = new URL(context.req.url).origin;
  const scanUrl = `${origin}/scan?token=${encodeURIComponent(token)}`;

  return context.html(layout({
    title: "출근도장 키오스크",
    body: renderKioskPage({ scanUrl })
  }));
});

app.get("/scan", async (context) => {
  await ensureDefaultSeed(context.env);

  const token = context.req.query("token") ?? "";
  const verified = await verifyQrToken(token, getQrSecret(context.env), Math.floor(Date.now() / 1000));
  if (!verified.ok) {
    return context.html(layout({
      title: verified.reason === "expired" ? "큐알이 만료되었습니다" : "큐알을 사용할 수 없습니다",
      body: verified.reason === "expired"
        ? renderQrExpiredPage()
        : renderPhoneNoticePage("큐알을 사용할 수 없습니다", reasonToKorean(verified.reason), "키오스크 화면의 새 큐알을 다시 찍어주세요.")
    }), 400);
  }

  const qrNonceHash = await hashQrNonce({
    workspaceId: verified.claims.workspaceId,
    kioskId: verified.claims.kioskId,
    nonce: verified.claims.nonce
  });
  const consumed = await consumeQrOnScan(context.env, verified.claims, qrNonceHash);
  if (!consumed.ok) {
    return context.html(layout({
      title: "이미 사용된 큐알입니다",
      body: renderQrReplayPage()
    }), 409);
  }

  const rememberedEmployee = findSeedEmployee(getCookieValue(context.req.header("cookie"), REMEMBERED_EMPLOYEE_COOKIE));

  return context.html(layout({
    title: "출퇴근 기록",
    body: renderScanPage({ token, attemptId: consumed.attemptId, rememberedEmployee })
  }));
});

app.post("/api/clock", async (context) => {
  await ensureDefaultSeed(context.env);

  const body = await context.req.parseBody();
  const token = stringField(body.token);
  const attemptId = stringField(body.attemptId);
  const employeeId = stringField(body.employeeId);
  const eventType = stringField(body.eventType) as ClockEventType;
  const latitude = optionalNumber(body.latitude);
  const longitude = optionalNumber(body.longitude);
  const accuracyMeters = optionalNumber(body.accuracyMeters);
  const locationConsent = parseLocationConsent(stringField(body.locationConsent));
  const rememberEmployee = stringField(body.rememberEmployee) === "true";

  if (!attemptId || !isSeedEmployee(employeeId) || !isClockEventType(eventType)) {
    return context.html(messagePage("기록 실패", "직원 또는 출퇴근 유형이 올바르지 않습니다.", "/kiosk"), 400);
  }

  const verified = await verifyQrToken(token, getQrSecret(context.env), Math.floor(Date.now() / 1000));
  if (!verified.ok) {
    return context.html(messagePage("기록 실패", reasonToKorean(verified.reason), "/kiosk"), 400);
  }

  const qrNonceHash = await hashQrNonce({
    workspaceId: verified.claims.workspaceId,
    kioskId: verified.claims.kioskId,
    nonce: verified.claims.nonce
  });

  const result = await completeClockAttempt(context.env, {
    attemptId,
    qrNonceHash,
    claims: verified.claims,
    employeeId,
    eventType,
    latitude,
    longitude,
    accuracyMeters,
    locationConsent
  });

  if (!result.ok) {
    return context.html(messagePage("기록 실패", result.reason, "/kiosk"), 409);
  }

  if (rememberEmployee) {
    context.header("Set-Cookie", buildRememberCookie(employeeId, context.req.url));
  }

  return context.html(layout({
    title: "기록 완료",
    body: renderSuccessPage({
      employeeName: result.employeeName,
      eventType,
      riskFlags: result.riskFlags
    })
  }));
});

app.get("/forget-device", (context) => {
  context.header("Set-Cookie", clearRememberCookie(context.req.url));
  return context.html(messagePage("기기 기억을 해제했습니다", "다음 스캔부터 이름을 다시 선택합니다.", "/kiosk"));
});

app.get("/events/demo", (context) => context.redirect("/events", 302));

app.get("/events", async (context) => {
  const events = await listRecentEvents(context.env);
  return context.html(layout({
    title: "최근 기록",
    body: `
      <section class="hero-card">
        <div class="eyebrow">Events</div>
        <h1>최근 기록</h1>
        <p>운영 사업장의 최근 출퇴근 이벤트입니다.</p>
        <div class="actions"><a class="button primary" href="/kiosk">키오스크 열기</a></div>
      </section>
      ${renderEventList(events)}
    `
  }));
});

app.get("/admin/today", async (context) => {
  if (!isAdminAuthorized(context.req.header("authorization"), context.env)) {
    return context.html(layout({ title: "사장님 확인", body: renderAdminPinPage() }), 401);
  }

  const events = await listRecentEvents(context.env);
  const clockIns = events.filter((event) => event.eventType === "clock_in").length;
  const clockOuts = events.filter((event) => event.eventType === "clock_out").length;
  const flagged = events.filter((event) => event.riskFlags.length > 0).length;

  return context.html(layout({
    title: "오늘 기록",
    body: renderAdminTodayPage(events, { clockIns, clockOuts, flagged })
  }));
});

app.get("/admin/demo/export.csv", (context) => context.redirect("/admin/export.csv", 302));

app.get("/admin/export.csv", async (context) => {
  if (!isAdminAuthorized(context.req.header("authorization"), context.env)) {
    return context.text("관리자 인증이 필요합니다", 401);
  }

  const rows = await listExportRows(context.env);
  const csv = buildAttendanceCsv(rows);
  const date = new Date().toISOString().slice(0, 10);

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="attendance-default-workspace-${date}.csv"`,
      "cache-control": "no-store"
    }
  });
});

async function ensureDefaultSeed(env?: Env): Promise<void> {
  if (!env?.DB) return;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, latitude, longitude, radius_meters, owner_email_hash)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(DEFAULT_WORKSPACE_ID, "운영 사업장", 37.5133, 127.1002, 80, "owner"),
    env.DB.prepare(`INSERT OR IGNORE INTO kiosks (id, workspace_id, name, status) VALUES (?, ?, ?, ?)`)
      .bind(DEFAULT_KIOSK_ID, DEFAULT_WORKSPACE_ID, "입구 키오스크", "active"),
    ...seedEmployees.map((employee) =>
      env.DB!.prepare(
        `INSERT INTO employees (id, workspace_id, name, employee_code_hash, status, registered_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, employee_code_hash = excluded.employee_code_hash, status = excluded.status`
      ).bind(employee.id, DEFAULT_WORKSPACE_ID, employee.name, employee.codeHash, "registered", new Date().toISOString())
    )
  ]);
}

async function consumeQrOnScan(
  env: Env | undefined,
  claims: QrClaims,
  qrNonceHash: string
): Promise<{ ok: true; attemptId: string } | { ok: false }> {
  const attemptId = crypto.randomUUID();
  const consumedAt = new Date().toISOString();

  if (!env?.DB) {
    const durableStore = getDurableStore(env);
    if (durableStore) {
      const response = await durableStore.fetch("https://store/consume", {
        method: "POST",
        body: JSON.stringify({ claims, qrNonceHash, attemptId, consumedAt })
      });
      return response.json();
    }

    if (memoryStore.consumptions.has(qrNonceHash)) return { ok: false };
    memoryStore.consumptions.set(qrNonceHash, {
      qrNonceHash,
      workspaceId: claims.workspaceId,
      kioskId: claims.kioskId,
      attemptId,
      consumedAt
    });
    return { ok: true, attemptId };
  }

  try {
    await env.DB.prepare(
      `INSERT INTO qr_consumptions (qr_nonce_hash, workspace_id, kiosk_id, attempt_id, consumed_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(qrNonceHash, claims.workspaceId, claims.kioskId, attemptId, consumedAt).run();
    return { ok: true, attemptId };
  } catch {
    return { ok: false };
  }
}

async function completeClockAttempt(
  env: Env | undefined,
  input: {
    attemptId: string;
    qrNonceHash: string;
    claims: QrClaims;
    employeeId: string;
    eventType: ClockEventType;
    latitude?: number;
    longitude?: number;
    accuracyMeters?: number;
    locationConsent: LocationConsent;
  }
): Promise<{ ok: true; employeeName: string; riskFlags: string[] } | { ok: false; reason: string }> {
  const employee = seedEmployees.find((item) => item.id === input.employeeId);
  if (!employee) return { ok: false, reason: "직원을 찾을 수 없습니다." };

  const occurredAt = new Date().toISOString();
  const riskFlags = buildRiskFlags(input);

  if (!env?.DB) {
    const durableStore = getDurableStore(env);
    if (durableStore) {
      const response = await durableStore.fetch("https://store/complete", {
        method: "POST",
        body: JSON.stringify({ input, occurredAt, riskFlags })
      });
      return response.json();
    }

    const record = memoryStore.consumptions.get(input.qrNonceHash);
    if (!record || record.attemptId !== input.attemptId) {
      return { ok: false, reason: "큐알 시도를 찾을 수 없습니다." };
    }
    if (record.completedEmployeeId) {
      return { ok: false, reason: "이미 완료된 큐알입니다." };
    }
    record.completedEmployeeId = input.employeeId;
    record.completedAt = occurredAt;
    memoryStore.events.unshift({
      id: crypto.randomUUID(),
      workspaceId: input.claims.workspaceId,
      employeeId: input.employeeId,
      employeeName: employee.name,
      kioskId: input.claims.kioskId,
      eventType: input.eventType,
      occurredAt,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyMeters: input.accuracyMeters,
      riskFlags
    });
    return { ok: true, employeeName: employee.name, riskFlags };
  }

  const existing = await env.DB.prepare(
    `SELECT completed_employee_id FROM qr_consumptions WHERE qr_nonce_hash = ? AND attempt_id = ?`
  ).bind(input.qrNonceHash, input.attemptId).first<{ completed_employee_id: string | null }>();

  if (!existing) return { ok: false, reason: "큐알 시도를 찾을 수 없습니다." };
  if (existing.completed_employee_id) return { ok: false, reason: "이미 완료된 큐알입니다." };

  const previous = await env.DB.prepare(
    `SELECT event_hash FROM attendance_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(input.claims.workspaceId).first<{ event_hash: string }>();
  const eventId = crypto.randomUUID();
  const eventHash = await sha256Hex(JSON.stringify({
    eventId,
    workspaceId: input.claims.workspaceId,
    employeeId: input.employeeId,
    kioskId: input.claims.kioskId,
    eventType: input.eventType,
    occurredAt,
    qrNonceHash: input.qrNonceHash,
    prevHash: previous?.event_hash ?? null
  }));

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO attendance_events (
        id, workspace_id, employee_id, kiosk_id, event_type, occurred_at,
        latitude, longitude, accuracy_meters, qr_nonce_hash, risk_flags_json, prev_hash, event_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      eventId,
      input.claims.workspaceId,
      input.employeeId,
      input.claims.kioskId,
      input.eventType,
      occurredAt,
      input.latitude ?? null,
      input.longitude ?? null,
      input.accuracyMeters ?? null,
      input.qrNonceHash,
      JSON.stringify(riskFlags),
      previous?.event_hash ?? null,
      eventHash
    ),
    env.DB.prepare(
      `UPDATE qr_consumptions SET completed_employee_id = ?, completed_at = ?
       WHERE qr_nonce_hash = ? AND attempt_id = ? AND completed_employee_id IS NULL`
    ).bind(input.employeeId, occurredAt, input.qrNonceHash, input.attemptId)
  ]);

  return { ok: true, employeeName: employee.name, riskFlags };
}

async function listRecentEvents(env?: Env): Promise<AttendanceEventRecord[]> {
  if (!env?.DB) {
    const durableStore = getDurableStore(env);
    if (durableStore) {
      const response = await durableStore.fetch("https://store/events");
      return response.json();
    }

    return memoryStore.events.slice(0, 12);
  }

  const result = await env.DB.prepare(
    `SELECT e.id, e.workspace_id, e.employee_id, emp.name AS employee_name, e.kiosk_id, e.event_type,
            e.occurred_at, e.risk_flags_json
     FROM attendance_events e
     JOIN employees emp ON emp.id = e.employee_id
     WHERE e.workspace_id = ?
     ORDER BY e.occurred_at DESC
     LIMIT 12`
  ).bind(DEFAULT_WORKSPACE_ID).all<{
    id: string;
    workspace_id: string;
    employee_id: string;
    employee_name: string;
    kiosk_id: string;
    event_type: ClockEventType;
    occurred_at: string;
    risk_flags_json: string;
  }>();

  return result.results.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    kioskId: row.kiosk_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    riskFlags: JSON.parse(row.risk_flags_json) as string[]
  }));
}

async function listExportRows(env?: Env): Promise<AttendanceExportRow[]> {
  if (!env?.DB) {
    const events = await listRecentEvents(env);
    return events.slice().reverse().map((event) => ({
      id: event.id,
      workspaceName: "운영 사업장",
      employeeName: event.employeeName,
      kioskName: "입구 키오스크",
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      latitude: event.latitude,
      longitude: event.longitude,
      accuracyMeters: event.accuracyMeters,
      riskFlags: event.riskFlags
    }));
  }

  const result = await env.DB.prepare(
    `SELECT e.id, w.name AS workspace_name, emp.name AS employee_name, k.name AS kiosk_name,
            e.event_type, e.occurred_at, e.latitude, e.longitude, e.accuracy_meters, e.risk_flags_json
     FROM attendance_events e
     JOIN workspaces w ON w.id = e.workspace_id
     JOIN employees emp ON emp.id = e.employee_id
     JOIN kiosks k ON k.id = e.kiosk_id
     WHERE e.workspace_id = ?
     ORDER BY e.occurred_at ASC`
  ).bind(DEFAULT_WORKSPACE_ID).all<{
    id: string;
    workspace_name: string;
    employee_name: string;
    kiosk_name: string;
    event_type: ClockEventType;
    occurred_at: string;
    latitude: number | null;
    longitude: number | null;
    accuracy_meters: number | null;
    risk_flags_json: string;
  }>();

  return result.results.map((row) => ({
    id: row.id,
    workspaceName: row.workspace_name,
    employeeName: row.employee_name,
    kioskName: row.kiosk_name,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    latitude: row.latitude ?? undefined,
    longitude: row.longitude ?? undefined,
    accuracyMeters: row.accuracy_meters ?? undefined,
    riskFlags: JSON.parse(row.risk_flags_json) as string[]
  }));
}

function renderKioskPage(input: { scanUrl: string }): string {
  const nowTime = formatCurrentClockTime();
  const today = formatCurrentKoreanDate();
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=330x330&data=${encodeURIComponent(input.scanUrl)}`;

  return `
    <div data-screen-label="A1 키오스크 태블릿 정상" style="width:100vw;height:100dvh;min-height:100vh;background:#F7F3EA;border:0;border-radius:0;overflow:hidden;display:flex;flex-direction:column;box-shadow:none;scroll-margin-top:0">
          <div style="display:flex;align-items:center;gap:12px;padding:14px 28px;border-bottom:1px solid #E8E1D3;background:#FFFDF8">
            <div style="width:30px;height:30px;border-radius:8px;background:#C13A2A;color:#FFFFFF;display:grid;place-items:center;font-size:15px;font-weight:800">출</div>
            <span style="font-size:16px;font-weight:800">출근도장</span>
            <span style="width:1px;height:16px;background:#E0D8C6"></span>
            <span style="font-size:15px;font-weight:700;color:#22262B">${DEFAULT_WORKSPACE_DISPLAY_NAME}</span>
            <span style="font-size:12px;font-weight:600;color:#6E6A61;border:1px solid #E0D8C6;border-radius:999px;padding:4px 10px">${DEFAULT_KIOSK_DISPLAY_NAME}</span>
            <span style="flex:1"></span>
            <span style="background:#E8F3EC;color:#217A4B;font-size:12px;font-weight:700;padding:5px 11px;border-radius:999px">정상 연결</span>
          </div>
          <div style="flex:1;display:grid;grid-template-columns:0.9fr 1.1fr;gap:28px;padding:30px 38px 22px;align-items:center">
            <div style="display:flex;flex-direction:column;align-items:flex-start;text-align:left">
              <div data-now-clock style="font-size:78px;font-weight:800;letter-spacing:-0.055em;line-height:1;color:#17191C;font-variant-numeric:tabular-nums">${nowTime}</div>
              <div data-now-date style="font-size:18px;color:#6E6A61;margin-top:8px;font-weight:600">${today}</div>
              <div style="display:flex;flex-direction:column;gap:10px;margin-top:34px;width:100%">
                ${kioskStep("1", "내 폰 카메라로 큐알을 찍어주세요")}
                ${kioskStep("2", "이름을 선택해주세요")}
                ${kioskStep("3", "출근 또는 퇴근을 눌러주세요")}
              </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center">
              <div style="position:relative;background:#FFFFFF;border:1px solid #E8E1D3;border-radius:24px;padding:18px;box-shadow:0 14px 30px rgba(52,38,18,0.10)">
                <img src="${qrImageUrl}" alt="출근도장 큐알" style="width:330px;height:330px;display:block" />
                <svg width="58" height="58" viewBox="0 0 58 58" style="position:absolute;right:-14px;top:-14px;filter:drop-shadow(0 6px 14px rgba(0,0,0,.18))">
                  <circle cx="29" cy="29" r="23" fill="#FFFDF8" stroke="#E8E1D3" stroke-width="6"></circle>
                  <circle data-countdown-ring cx="29" cy="29" r="23" fill="none" stroke="#C13A2A" stroke-width="6" stroke-linecap="round" stroke-dasharray="144.51" stroke-dashoffset="0" transform="rotate(-90 29 29)"></circle>
                  <text data-countdown-text x="29" y="35" text-anchor="middle" style="font-size:17px;font-weight:800;fill:#17191C">${QR_TTL_SECONDS}</text>
                </svg>
              </div>
              <div data-countdown-copy style="font-size:15px;font-weight:800;color:#22262B;margin-top:16px">새 큐알까지 ${QR_TTL_SECONDS}초</div>
              <div style="font-size:12.5px;color:#8A8478;margin-top:5px">만료된 큐알은 기록되지 않습니다</div>
              <a href="${escapeHtml(input.scanUrl)}" style="display:none">${escapeHtml(input.scanUrl)}</a>
              <a href="/kiosk" style="margin-top:18px;border:1.5px solid #E0D8C6;border-radius:12px;padding:10px 18px;background:#FFFFFF;color:#3C424A;text-decoration:none;font-size:13px;font-weight:800">새 큐알 받기</a>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;gap:16px;padding:13px 28px;border-top:1px solid #E8E1D3;font-size:13px;color:#8A8478;background:#FFFDF8">
            <span>화면을 두 번 탭하면 전체 화면으로 전환됩니다</span>
            <a href="/admin/today" style="color:#8A8478;text-decoration:none">사장님 열람: 여기를 3초 길게 누르세요</a>
          </div>
      ${renderKioskScript()}
    </div>
  `;
}

function kioskStep(number: string, text: string): string {
  return `
    <div style="display:flex;align-items:center;gap:12px;background:#FFFDF8;border:1px solid #E8E1D3;border-radius:14px;padding:13px 15px">
      <span style="width:28px;height:28px;border-radius:50%;background:#17191C;color:#FFFFFF;display:grid;place-items:center;font-size:13px;font-weight:800">${number}</span>
      <span style="font-size:16px;font-weight:700;color:#22262B">${text}</span>
    </div>
  `;
}

function renderKioskScript(): string {
  return `
    <script>
      (() => {
        const ttl = ${QR_TTL_SECONDS};
        const started = Date.now();
        const text = document.querySelector('[data-countdown-text]');
        const copy = document.querySelector('[data-countdown-copy]');
        const ring = document.querySelector('[data-countdown-ring]');
        const clock = document.querySelector('[data-now-clock]');
        const date = document.querySelector('[data-now-date]');
        const ringLength = 144.51;
        const clockFormatter = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const dateFormatter = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'long' });
        function tick() {
          const elapsed = Math.floor((Date.now() - started) / 1000);
          const left = Math.max(0, ttl - elapsed);
          if (text) text.textContent = String(left);
          if (copy) copy.textContent = '새 큐알까지 ' + left + '초';
          if (ring) ring.setAttribute('stroke-dashoffset', String(ringLength * (1 - left / ttl)));
          if (clock) clock.textContent = clockFormatter.format(new Date());
          if (date) date.textContent = dateFormatter.format(new Date());
          if (left <= 0) window.location.replace('/kiosk?refresh=' + Date.now());
        }
        tick();
        setInterval(tick, 1000);

        function enterFullscreen() {
          const target = document.documentElement;
          if (!document.fullscreenElement && target.requestFullscreen) target.requestFullscreen().catch(() => {});
        }
        document.addEventListener('dblclick', enterFullscreen);
        let lastTap = 0;
        document.addEventListener('touchend', () => {
          const now = Date.now();
          if (now - lastTap < 420) enterFullscreen();
          lastTap = now;
        }, { passive: true });
      })();
    </script>
  `;
}

function renderScanPage(input: {
  token: string;
  attemptId: string;
  rememberedEmployee?: (typeof seedEmployees)[number];
}): string {
  const initialEmployee = input.rememberedEmployee ?? seedEmployees[0];
  const firstVisitPanel = input.rememberedEmployee ? "" : renderFirstVisitPanel();
  const clockPanelHidden = input.rememberedEmployee ? "" : " hidden";
  const clockStatus = input.rememberedEmployee ? "이 폰 기억됨" : "이름 확인됨";

  return `
    <div class="staff-screen">
      <form method="post" action="/api/clock" data-clock-form style="min-height:inherit;margin:0">
        <input type="hidden" name="token" value="${escapeHtml(input.token)}" />
        <input type="hidden" name="attemptId" value="${escapeHtml(input.attemptId)}" />
        <input type="hidden" name="employeeId" value="${escapeHtml(initialEmployee.id)}" data-employee-id-field />
        <input type="hidden" name="eventType" value="clock_in" data-event-type-field />
        <input type="hidden" name="latitude" data-location="lat" />
        <input type="hidden" name="longitude" data-location="lng" />
        <input type="hidden" name="accuracyMeters" data-location="accuracy" />
        <input type="hidden" name="locationConsent" value="unavailable" data-location="consent" />
        ${firstVisitPanel}
        ${renderClockPanel({ employee: initialEmployee, hiddenAttr: clockPanelHidden, status: clockStatus, remembered: Boolean(input.rememberedEmployee) })}
        ${renderLocationPanel()}
      </form>
    </div>
    ${renderScanScript()}
  `;
}

function renderFirstVisitPanel(): string {
  return `
    <section data-screen-label="2a 기기 기억 첫 1회" data-step="select" style="min-height:inherit;box-sizing:border-box;background:#FDFBF6;display:flex;flex-direction:column;padding:74px 22px 48px">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:22px;height:22px;border-radius:6px;background:#C13A2A;color:#FFFFFF;display:grid;place-items:center;font-size:11px;font-weight:800">출</div>
        <span style="font-size:13.5px;font-weight:800">출근도장</span>
        <span style="flex:1"></span>
        <span style="background:#F1EDE3;color:#6E6A61;font-size:11.5px;font-weight:700;padding:5px 10px;border-radius:999px">첫 방문</span>
      </div>
      <h1 style="margin:24px 0 0;font-size:25px;font-weight:800;line-height:1.3;color:#17191C">${DEFAULT_WORKSPACE_DISPLAY_NAME}</h1>
      <div style="font-size:15px;color:#6E6A61;margin-top:8px">처음이시네요. 이름을 한 번만 선택해주세요.</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:22px">
        ${seedEmployees.map((employee) => `
          <button type="button" data-employee-button data-employee-id="${escapeHtml(employee.id)}" data-employee-name="${escapeHtml(employee.name)}" style="border:1px solid #E8E1D3;background:#FFFFFF;border-radius:14px;height:54px;display:grid;place-items:center;font-size:15.5px;font-weight:800;color:#22262B;cursor:pointer">${escapeHtml(employee.name)}</button>
        `).join("")}
      </div>
      <label style="display:flex;align-items:center;gap:12px;background:#FFFFFF;border:1px solid #E8E1D3;border-radius:16px;padding:14px 16px;margin-top:18px;cursor:pointer">
        <input type="checkbox" name="rememberEmployee" value="true" checked style="width:20px;height:20px;accent-color:#C13A2A" />
        <span style="display:flex;flex-direction:column;gap:3px">
          <strong style="font-size:15px;color:#22262B">이 폰 기억하기</strong>
          <span style="font-size:12.5px;color:#8A8478">다음부터 이름 선택 없이 바로 기록합니다</span>
        </span>
      </label>
      <span style="flex:1"></span>
      <div style="text-align:center;font-size:12px;color:#8A8478">공용 폰이면 체크를 꺼주세요</div>
    </section>
  `;
}

function renderClockPanel(input: { employee: (typeof seedEmployees)[number]; hiddenAttr: string; status: string; remembered: boolean }): string {
  const resetControl = input.remembered
    ? `<a href="/forget-device" style="text-align:center;font-size:13.5px;font-weight:700;color:#6E6A61;text-decoration:none;padding:8px 0">내가 아니에요 — 이름 선택으로</a>`
    : `<button type="button" data-back-select style="border:0;background:transparent;text-align:center;font-size:13.5px;font-weight:700;color:#6E6A61;padding:8px 0;cursor:pointer">내가 아니에요 — 이름 선택으로</button>`;

  return `
    <section data-screen-label="2a 기기 기억 매일" data-step="clock"${input.hiddenAttr} style="min-height:inherit;box-sizing:border-box;background:#FDFBF6;display:flex;flex-direction:column;padding:74px 22px 48px">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:22px;height:22px;border-radius:6px;background:#C13A2A;color:#FFFFFF;display:grid;place-items:center;font-size:11px;font-weight:800">출</div>
        <span style="font-size:13.5px;font-weight:800">출근도장</span>
        <span style="flex:1"></span>
        <span data-clock-status style="background:#E8F3EC;color:#217A4B;font-size:11.5px;font-weight:700;padding:5px 10px;border-radius:999px">${escapeHtml(input.status)}</span>
      </div>
      <h1 data-selected-heading style="margin:24px 0 0;font-size:25px;font-weight:800;line-height:1.3;color:#17191C">${escapeHtml(input.employee.name)} 님, 안녕하세요</h1>
      <div style="font-size:14.5px;color:#6E6A61;margin-top:8px">${DEFAULT_WORKSPACE_DISPLAY_NAME} · 지금 시각 <span data-phone-clock>${formatCurrentClockTime()}</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:28px">
        <button type="button" data-event-type="clock_in" style="min-height:132px;border:0;border-radius:20px;background:#C13A2A;color:#FFFFFF;display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-end;text-align:left;padding:20px;cursor:pointer">
          <span style="font-size:30px;font-weight:900;line-height:1">출근</span>
          <span style="font-size:12.5px;color:rgba(255,255,255,.86);margin-top:8px">지금 시각으로 기록합니다</span>
        </button>
        <button type="button" data-event-type="clock_out" style="min-height:132px;border:0;border-radius:20px;background:#22262B;color:#FFFFFF;display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-end;text-align:left;padding:20px;cursor:pointer">
          <span style="font-size:30px;font-weight:900;line-height:1">퇴근</span>
          <span style="font-size:12.5px;color:rgba(255,255,255,.86);margin-top:8px">지금 시각으로 기록합니다</span>
        </button>
      </div>
      <span style="flex:1"></span>
      ${resetControl}
      <div style="text-align:center;font-size:11.5px;color:#8A8478">기억 해제는 기록 완료 화면에서 할 수 있습니다</div>
    </section>
  `;
}

function renderLocationPanel(): string {
  return `
    <section data-screen-label="B3 위치 권한 안내" data-step="location" hidden style="min-height:inherit;box-sizing:border-box;background:#FDFBF6;display:flex;flex-direction:column;padding:74px 22px 48px">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:22px;height:22px;border-radius:6px;background:#C13A2A;color:#FFFFFF;display:grid;place-items:center;font-size:11px;font-weight:800">출</div>
        <span style="font-size:13.5px;font-weight:800">출근도장</span>
        <span style="flex:1"></span>
        <span style="background:#F1EDE3;color:#6E6A61;font-size:11.5px;font-weight:700;padding:5px 10px;border-radius:999px">위치 확인</span>
      </div>
      <h1 style="margin:24px 0 0;font-size:25px;font-weight:800;line-height:1.3;color:#17191C">매장 근처인지<br>한 번만 확인할게요</h1>
      <div style="font-size:14.5px;color:#6E6A61;margin-top:10px;line-height:1.55">기록하는 순간의 위치 1회만 저장합니다.<br>이동 경로는 수집하지 않습니다.</div>
      <div style="background:#FFFFFF;border:1px solid #E8E1D3;border-radius:16px;padding:6px 18px;margin-top:24px">
        <div style="display:flex;align-items:center;gap:12px;padding:13px 0;border-bottom:1px solid #F1EBDD">
          <span style="width:22px;height:22px;border-radius:50%;background:#E8F3EC;color:#217A4B;display:grid;place-items:center;font-size:13px;font-weight:900">✓</span>
          <span style="font-size:14px;font-weight:650;color:#22262B">출근·퇴근 기록에만 붙습니다</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;padding:13px 0;border-bottom:1px solid #F1EBDD">
          <span style="width:22px;height:22px;border-radius:50%;background:#E8F3EC;color:#217A4B;display:grid;place-items:center;font-size:13px;font-weight:900">✓</span>
          <span style="font-size:14px;font-weight:650;color:#22262B">항상 켜두는 추적이 아닙니다</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;padding:13px 0">
          <span style="width:22px;height:22px;border-radius:50%;background:#F7EDD8;color:#93610F;display:grid;place-items:center;font-size:13px;font-weight:900">!</span>
          <span style="font-size:14px;font-weight:650;color:#22262B">허용하지 않아도 기록은 남고, 위치 없음 표시가 붙습니다</span>
        </div>
      </div>
      <p data-location-status style="font-size:12.5px;color:#8A8478;line-height:1.55;margin:18px 0 0">위치 권한은 선택입니다. 허용하지 않아도 기록은 남습니다.</p>
      <span style="flex:1"></span>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button type="button" data-use-location style="border:0;background:#C13A2A;color:#FFFFFF;border-radius:16px;min-height:58px;display:grid;place-items:center;font-size:17px;font-weight:800;cursor:pointer">위치 허용하고 기록</button>
        <button type="button" data-submit-without-location data-skip-location style="border:0;background:transparent;color:#6E6A61;text-align:center;font-size:13.5px;font-weight:700;padding:10px;cursor:pointer">위치 없이 기록</button>
      </div>
    </section>
  `;
}

function renderScanScript(): string {
  return `
    <script>
      (() => {
        const form = document.querySelector('[data-clock-form]');
        const employeeField = document.querySelector('[data-employee-id-field]');
        const eventField = document.querySelector('[data-event-type-field]');
        const selectedHeading = document.querySelector('[data-selected-heading]');
        const phoneClock = document.querySelector('[data-phone-clock]');
        const clockFormatter = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        function show(name) {
          document.querySelectorAll('[data-step]').forEach((step) => {
            step.hidden = step.getAttribute('data-step') !== name;
          });
        }
        function updateClock() {
          if (phoneClock) phoneClock.textContent = clockFormatter.format(new Date());
        }
        document.querySelectorAll('[data-employee-button]').forEach((button) => {
          button.addEventListener('click', () => {
            if (employeeField) employeeField.value = button.getAttribute('data-employee-id') || '';
            const employeeName = button.getAttribute('data-employee-name') || '';
            if (selectedHeading) selectedHeading.textContent = employeeName + ' 님, 안녕하세요';
            show('clock');
          });
        });
        document.querySelector('[data-back-select]')?.addEventListener('click', () => show('select'));
        document.querySelectorAll('[data-event-type]').forEach((button) => {
          button.addEventListener('click', () => {
            if (eventField) eventField.value = button.getAttribute('data-event-type') || 'clock_in';
            show('location');
          });
        });
        const consent = document.querySelector('[data-location="consent"]');
        const status = document.querySelector('[data-location-status]');
        function submit() {
          if (form?.requestSubmit) form.requestSubmit();
          else form?.submit();
        }
        document.querySelector('[data-submit-without-location]')?.addEventListener('click', () => {
          if (consent) consent.value = 'skipped';
          if (status) status.textContent = '위치 없이 기록합니다. 위치 없음 표시가 남습니다.';
          submit();
        });
        document.querySelector('[data-use-location]')?.addEventListener('click', () => {
          if (!navigator.geolocation) {
            if (consent) consent.value = 'unavailable';
            submit();
            return;
          }
          if (status) status.textContent = '위치를 확인하고 있습니다.';
          navigator.geolocation.getCurrentPosition((position) => {
            const lat = document.querySelector('[data-location="lat"]');
            const lng = document.querySelector('[data-location="lng"]');
            const acc = document.querySelector('[data-location="accuracy"]');
            if (lat) lat.value = position.coords.latitude;
            if (lng) lng.value = position.coords.longitude;
            if (acc) acc.value = position.coords.accuracy;
            if (consent) consent.value = 'granted';
            submit();
          }, () => {
            if (consent) consent.value = 'unavailable';
            if (status) status.textContent = '위치 없이 기록합니다. 위치 없음 표시가 남습니다.';
            submit();
          }, { enableHighAccuracy: false, timeout: 2500, maximumAge: 30000 });
        });
        updateClock();
        setInterval(updateClock, 1000);
      })();
    </script>
  `;
}

function renderSuccessPage(input: { employeeName: string; eventType: ClockEventType; riskFlags: string[] }): string {
  const actionLabel = input.eventType === "clock_in" ? "출근" : "퇴근";
  const riskText = formatRiskSummary(input.riskFlags);
  const hasRisk = input.riskFlags.length > 0;
  const stampColor = hasRisk ? "#93610F" : "#217A4B";
  const stampBg = hasRisk ? "#F7EDD8" : "#E8F3EC";
  const note = hasRisk
    ? "기록은 저장됐고, 사장님 화면에 확인 표시가 남습니다."
    : "매장 근처 기록으로 저장되었습니다.";

  return `
    <div class="staff-screen">
      <section data-screen-label="B4 기록 완료" style="min-height:inherit;box-sizing:border-box;background:#FDFBF6;display:flex;flex-direction:column;align-items:center;text-align:center;padding:74px 22px 48px">
        <span style="flex:1"></span>
        <div style="width:92px;height:92px;border-radius:50%;background:${stampBg};display:grid;place-items:center;color:${stampColor};font-size:38px;font-weight:900;border:6px solid #FFFFFF;box-shadow:0 12px 26px rgba(52,38,18,0.10)">도장</div>
        <h1 style="margin:22px 0 0;font-size:26px;font-weight:800;line-height:1.3;color:#17191C">${actionLabel} 기록 완료</h1>
        <div style="font-size:15px;color:#6E6A61;line-height:1.65;margin-top:10px"><strong style="color:#22262B">${escapeHtml(input.employeeName)}</strong> 님의 ${actionLabel} 기록이 저장됐습니다.<br>${escapeHtml(note)}</div>
        <div style="background:${hasRisk ? "#FCF6E8" : "#FFFFFF"};border:1px solid ${hasRisk ? "#EBDDB9" : "#E8E1D3"};border-radius:14px;padding:13px 16px;font-size:13.5px;color:${hasRisk ? "#93610F" : "#217A4B"};font-weight:800;margin-top:22px">${escapeHtml(riskText)}</div>
        <span style="flex:1"></span>
        <div style="background:#FFFFFF;border:1px solid #E8E1D3;border-radius:16px;padding:15px 18px;font-size:15px;font-weight:800;color:#22262B;width:100%">이 화면은 닫아도 됩니다</div>
        <a href="/forget-device" style="text-decoration:none;text-align:center;font-size:13.5px;font-weight:700;color:#6E6A61;padding:10px 0">기억 해제</a>
        <div style="text-align:center;font-size:11.5px;color:#8A8478;margin-top:2px">키오스크 화면은 매장 태블릿 전용입니다</div>
      </section>
    </div>
  `;
}

function renderQrExpiredPage(): string {
  return renderPhoneNoticePage(
    "큐알이 만료되었습니다",
    `큐알은 ${QR_TTL_SECONDS}초마다 새로 바뀝니다.<br>키오스크 화면의 새 큐알을 다시 찍어주세요.`,
    "키오스크로 가서 → 새 큐알 스캔 → 이름 선택",
    "B6 큐알 만료 오류",
    "clock"
  );
}

function renderQrReplayPage(): string {
  return renderPhoneNoticePage(
    "이미 사용된 큐알입니다",
    "큐알 하나로는 한 번만 기록할 수 있습니다.<br>키오스크의 새 큐알을 다시 찍어주세요.",
    "키오스크로 가서 → 새 큐알 스캔 → 이름 선택",
    "B7 큐알 재사용 차단",
    "block"
  );
}

function renderPhoneNoticePage(title: string, detail: string, hint: string, screenLabel = "B6 큐알 만료 오류", tone: "clock" | "block" = "clock"): string {
  const iconBg = tone === "block" ? "#F9E9E5" : "#F7EDD8";
  const iconColor = tone === "block" ? "#B42318" : "#93610F";
  const icon = tone === "block" ? "!" : "시";
  const footer = tone === "block" ? "반복된 재사용 시도는 흔적으로 남습니다" : "이번 시도는 기록되지 않았습니다";

  return `
    <div class="staff-screen">
      <section data-screen-label="${screenLabel}" style="min-height:inherit;box-sizing:border-box;background:#FDFBF6;display:flex;flex-direction:column;align-items:center;text-align:center;padding:74px 22px 48px">
        <span style="flex:1"></span>
        <div style="width:68px;height:68px;border-radius:50%;background:${iconBg};display:grid;place-items:center;color:${iconColor};font-size:24px;font-weight:900">${icon}</div>
        <h1 style="margin:18px 0 0;font-size:24px;font-weight:800;color:#17191C">${escapeHtml(title)}</h1>
        <div style="font-size:15px;color:#6E6A61;line-height:1.65;margin-top:12px">${detail}</div>
        <div style="background:#FFFFFF;border:1px solid #E8E1D3;border-radius:14px;padding:14px 18px;font-size:13.5px;color:#22262B;font-weight:600;margin-top:22px">${escapeHtml(hint)}</div>
        <span style="flex:1"></span>
        <div style="font-size:12px;color:#8A8478">${footer}</div>
      </section>
    </div>
  `;
}

function formatCurrentClockTime(): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
}

function formatCurrentKoreanDate(): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(new Date());
}

function renderAdminPinPage(): string {
  return `
    <div data-screen-label="A6 사장님 확인 PIN" style="width:100vw;height:100dvh;min-height:100vh;background:#F7F3EA;border:0;border-radius:0;overflow:hidden;display:flex;flex-direction:column;box-shadow:none;scroll-margin-top:0">
          <div style="display:flex;align-items:center;gap:12px;padding:14px 28px;border-bottom:1px solid #E8E1D3;background:#FFFDF8">
            <div style="width:30px;height:30px;border-radius:8px;background:#C13A2A;color:#FFFFFF;display:grid;place-items:center;font-size:15px;font-weight:800">출</div>
            <span style="font-size:16px;font-weight:800">출근도장</span>
            <span style="width:1px;height:16px;background:#E0D8C6"></span>
            <span style="font-size:15px;font-weight:700;color:#22262B">${DEFAULT_WORKSPACE_DISPLAY_NAME}</span>
            <span style="font-size:12px;font-weight:600;color:#6E6A61;border:1px solid #E0D8C6;border-radius:999px;padding:4px 10px">사장님 확인</span>
            <span style="flex:1"></span>
            <a href="/kiosk" style="border:1.5px solid #E0D8C6;border-radius:10px;padding:8px 16px;font-size:13px;font-weight:700;background:#FFFFFF;color:#22262B;text-decoration:none">닫기</a>
          </div>
          <div style="flex:1;display:grid;place-items:center">
            <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
              <div style="width:60px;height:60px;border-radius:50%;background:#F1EBDD;display:grid;place-items:center;color:#8A6D2F;font-size:28px;font-weight:900">잠</div>
              <div style="font-size:24px;font-weight:800;margin-top:6px;color:#17191C">사장님 확인</div>
              <div style="font-size:14.5px;color:#6E6A61">매장 공용 화면이라 PIN 입력이 필요합니다</div>
              <div style="display:flex;gap:14px;margin-top:10px">
                <span style="width:14px;height:14px;border-radius:50%;border:2px solid #C8C2B4;box-sizing:border-box"></span>
                <span style="width:14px;height:14px;border-radius:50%;border:2px solid #C8C2B4;box-sizing:border-box"></span>
                <span style="width:14px;height:14px;border-radius:50%;border:2px solid #C8C2B4;box-sizing:border-box"></span>
                <span style="width:14px;height:14px;border-radius:50%;border:2px solid #C8C2B4;box-sizing:border-box"></span>
              </div>
              <div style="display:grid;grid-template-columns:repeat(3,76px);gap:10px;justify-content:center;margin-top:14px">
                ${["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "←"].map((key) => key ? `<div style="background:#FFFFFF;border:1px solid #E8E1D3;border-radius:14px;height:56px;display:grid;place-items:center;font-size:${key === "←" ? "17" : "21"}px;font-weight:700;color:${key === "←" ? "#6E6A61" : "#22262B"}">${key}</div>` : `<div style="height:56px"></div>`).join("")}
              </div>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;gap:16px;padding:14px 28px;border-top:1px solid #E8E1D3;font-size:13px;color:#8A8478;background:#FFFDF8">
            <span>60초 동안 입력이 없으면 키오스크로 돌아갑니다</span>
            <span>관리자 인증이 필요합니다</span>
          </div>
    </div>
  `;
}

function renderAdminTodayPage(events: AttendanceEventRecord[], summary: { clockIns: number; clockOuts: number; flagged: number }): string {
  return `
    <div data-screen-label="A7 사장님 열람 오늘 기록" style="width:100vw;height:100dvh;min-height:100vh;background:#F7F3EA;border:0;border-radius:0;overflow:hidden;display:flex;flex-direction:column;box-shadow:none;scroll-margin-top:0">
          <div style="display:flex;align-items:center;gap:12px;padding:10px 28px;border-bottom:1px solid #E8E1D3;background:#FFFDF8">
            <div style="width:30px;height:30px;border-radius:8px;background:#C13A2A;color:#FFFFFF;display:grid;place-items:center;font-size:15px;font-weight:800">출</div>
            <span style="font-size:16px;font-weight:800">출근도장</span>
            <span style="width:1px;height:16px;background:#E0D8C6"></span>
            <span style="font-size:15px;font-weight:700;color:#22262B">${DEFAULT_WORKSPACE_DISPLAY_NAME}</span>
            <span style="background:#C13A2A;color:#FFFFFF;font-size:12px;font-weight:700;padding:5px 11px;border-radius:999px">사장님 열람 중</span>
            <span style="flex:1"></span>
            <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
              <div style="background:#FFFFFF;border:1px solid #E8E1D3;border-radius:8px;padding:3px;width:50px;height:50px;display:grid;place-items:center;color:#C13A2A;font-size:10px;font-weight:900">QR</div>
              <span style="font-size:10px;color:#8A8478">큐알 유지 중</span>
            </div>
            <span style="font-size:12.5px;font-weight:700;color:#6E6A61">60초 후 자동 잠금</span>
            <a href="/kiosk" style="border:1.5px solid #E0D8C6;border-radius:10px;padding:8px 16px;font-size:13px;font-weight:700;background:#FFFFFF;color:#22262B;text-decoration:none">닫기</a>
          </div>
          <div style="display:flex;align-items:center;gap:14px;padding:12px 28px">
            <div style="width:34px;height:34px;border-radius:50%;border:1px solid #E0D8C6;background:#FFFFFF;display:grid;place-items:center;font-size:14px;color:#6E6A61">◀</div>
            <span style="font-size:17px;font-weight:800;color:#17191C">오늘 기록 · ${formatCurrentKoreanDate()}</span>
            <div style="width:34px;height:34px;border-radius:50%;border:1px solid #E0D8C6;background:#FFFFFF;display:grid;place-items:center;font-size:14px;color:#6E6A61;opacity:0.35">▶</div>
            <span style="flex:1"></span>
            <span style="background:#F1EDE3;color:#6E6A61;font-size:12px;font-weight:700;padding:6px 11px;border-radius:999px">출근 ${summary.clockIns}</span>
            <span style="background:#F1EDE3;color:#6E6A61;font-size:12px;font-weight:700;padding:6px 11px;border-radius:999px">퇴근 ${summary.clockOuts}</span>
            <span style="background:#F7EDD8;color:#93610F;font-size:12px;font-weight:700;padding:6px 11px;border-radius:999px">위험 ${summary.flagged}</span>
          </div>
          <div style="flex:1;display:flex;flex-direction:column;gap:7px;padding:0 28px">
            <div style="display:grid;grid-template-columns:1.3fr 0.9fr 0.9fr 1.6fr;padding:0 16px;font-size:11.5px;font-weight:700;color:#8A8478">
              <span>직원</span><span>출근</span><span>퇴근</span><span style="text-align:right">표시</span>
            </div>
            ${seedEmployees.map((employee) => renderAdminEmployeeRow(employee, events.filter((event) => event.employeeId === employee.id))).join("")}
            ${summary.flagged > 0 ? `<div style="background:#FCF6E8;border:1px solid #EBDDB9;border-radius:12px;padding:11px 16px;font-size:13px;color:#93610F;font-weight:600">확인 필요 ${summary.flagged}건 — 위치 없음 또는 반경 밖 기록이 있습니다</div>` : ""}
          </div>
          <div style="display:flex;justify-content:space-between;gap:16px;padding:12px 28px;border-top:1px solid #E8E1D3;font-size:13px;color:#8A8478;background:#FFFDF8">
            <span>보기 전용 — 정정과 CSV 내려받기는 사장님 화면에서</span>
            <span>닫으면 즉시 잠깁니다</span>
          </div>
    </div>
  `;
}

function renderAdminEmployeeRow(employee: (typeof seedEmployees)[number], events: AttendanceEventRecord[]): string {
  const clockIn = events.find((event) => event.eventType === "clock_in");
  const clockOut = [...events].reverse().find((event) => event.eventType === "clock_out");
  const risks = events.flatMap((event) => event.riskFlags);
  const hasRecord = Boolean(clockIn || clockOut);
  const display = risks.length
    ? formatRiskSummary(Array.from(new Set(risks)))
    : hasRecord
      ? clockOut ? "위치 확인" : "근무 중"
      : "기록 없음";
  const risky = risks.length > 0;
  return `
    <div style="display:grid;grid-template-columns:1.3fr 0.9fr 0.9fr 1.6fr;align-items:center;background:#FFFFFF;border:1px solid ${risky ? "#EBDDB9" : "#E8E1D3"};border-radius:12px;padding:11px 16px;${hasRecord ? "" : "opacity:0.6"}">
      <div style="font-size:16px;font-weight:700;color:#22262B">${escapeHtml(employee.name)}</div>
      <div style="font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;color:${clockIn ? "#22262B" : "#B8B2A4"}">${clockIn ? formatTimeOnly(clockIn.occurredAt) : "—"}</div>
      <div style="font-size:${clockOut ? "16" : "13"}px;font-weight:700;font-variant-numeric:tabular-nums;color:${clockOut ? "#22262B" : hasRecord ? "#217A4B" : "#B8B2A4"}">${clockOut ? formatTimeOnly(clockOut.occurredAt) : hasRecord ? "근무 중" : "—"}</div>
      <div style="display:flex;gap:6px;justify-content:flex-end"><span style="background:${risky ? "#F7EDD8" : hasRecord ? "#E8F3EC" : "#F1EDE3"};color:${risky ? "#93610F" : hasRecord ? "#217A4B" : "#6E6A61"};font-size:11.5px;font-weight:700;padding:4px 9px;border-radius:999px">${escapeHtml(display)}</span></div>
    </div>
  `;
}

function formatTimeOnly(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(iso));
}

function renderEventList(events: AttendanceEventRecord[], title = "최근 기록"): string {
  if (events.length === 0) {
    return `<section class="list-card"><h2>${escapeHtml(title)}</h2><p class="small">아직 기록이 없습니다.</p></section>`;
  }

  return `
    <section class="list-card">
      <h2>${escapeHtml(title)}</h2>
      <div class="event-list">
        ${events.map((event) => `
          <article class="event-row">
            <strong>${escapeHtml(event.employeeName)}</strong>
            <span>${event.eventType === "clock_in" ? "출근" : "퇴근"}</span>
            <time>${escapeHtml(formatKoreanTime(event.occurredAt))}</time>
            ${event.riskFlags.length ? `<em>${escapeHtml(formatRiskSummary(event.riskFlags))}</em>` : `<em>정상</em>`}
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function brandMark(): string {
  return `<div class="brand-mark"><span>출</span><strong>출근도장</strong></div>`;
}

function layout(input: { title: string; body: string; refreshSeconds?: number }): string {
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)} · 출근도장</title>
    ${input.refreshSeconds ? `<meta http-equiv="refresh" content="${input.refreshSeconds}" />` : ""}
    <link rel="stylesheet" as="style" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/variable/pretendardvariable.css" />
    <style>
      :root { color-scheme: light; font-family: 'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', system-ui, sans-serif; background: #E9EAEE; color: #22262B; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: #E9EAEE; }
      main { min-height: 100vh; width: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; padding: 0; }
      button, input { font: inherit; }
      [hidden] { display: none !important; }
      a { -webkit-tap-highlight-color: transparent; }
      h1, h2, p { margin-top: 0; }
      .brand-mark, .brand-row { display: flex; align-items: center; gap: 8px; }
      .brand-mark span { width: 26px; height: 26px; border-radius: 7px; background: #C13A2A; color: #FFFFFF; display: grid; place-items: center; font-size: 12px; font-weight: 900; }
      .brand-mark strong { font-size: 15px; color: #22262B; }
      .brand-row { width: 100%; justify-content: space-between; }
      .pill { background: #F3E7D8; color: #9F2E22; font-size: 12px; font-weight: 800; padding: 7px 12px; border-radius: 999px; white-space: nowrap; }
      .pill.green { background: #E8F3EC; color: #217A4B; }
      .hero-card, .list-card, .landing-shell, .surface-card { width: min(920px, 100%); border: 1px solid #E8E1D3; border-radius: 28px; background: rgba(255,255,255,.88); box-shadow: 0 18px 50px rgba(93,70,41,.11); padding: clamp(24px,5vw,46px); }
      .landing-shell { min-height: 520px; display: grid; align-content: center; gap: 28px; }
      .landing-copy h1, .hero-card h1 { margin: 18px 0 0; font-size: clamp(34px,7vw,78px); line-height: .98; letter-spacing: -0.055em; color: #171717; }
      .landing-copy p, .hero-card p, .list-card p { color: #6E6A61; font-size: 17px; line-height: 1.65; }
      .eyebrow { margin: 0; color: #C13A2A; font-size: 12px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
      .flow-strip, .step-list { display: grid; gap: 10px; }
      .flow-strip { grid-template-columns: repeat(4,1fr); }
      .flow-strip span, .step-list div { background: #FFF8ED; border: 1px solid #E8E1D3; border-radius: 18px; padding: 16px; color: #3C424A; font-weight: 800; }
      .step-list div { display: flex; align-items: center; gap: 14px; }
      .step-list strong { width: 34px; height: 34px; border-radius: 50%; background: #C13A2A; color: #FFFFFF; display: grid; place-items: center; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
      .button { display: inline-flex; align-items: center; justify-content: center; min-height: 50px; padding: 0 18px; border: 1px solid #D8CDBB; border-radius: 15px; color: #3C424A; background: #FFFFFF; text-decoration: none; font-weight: 900; }
      .button.primary { background: #C13A2A; border-color: #C13A2A; color: #FFFFFF; }
      .button.ghost { background: #FDFBF6; color: #6E6A61; }
      .staff-screen { width: min(430px, 100%); min-height: min(760px, calc(100vh - 24px)); border-radius: 24px; background: #FDFBF6; overflow: hidden; position: relative; box-shadow: 0 18px 42px rgba(93,70,41,.12); border: 1px solid #E8E1D3; }
      .event-list { display: grid; gap: 10px; }
      .event-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 12px; align-items: center; padding: 14px; border-radius: 16px; background: #FFF8ED; color: #3C424A; }
      .event-row em { color: #9F2E22; font-style: normal; font-weight: 800; }
      .summary-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 12px; margin-top: 22px; }
      .summary-grid div { border: 1px solid #E8E1D3; border-radius: 18px; padding: 18px; background: #FFF8ED; }
      .summary-grid strong { display: block; font-size: 38px; color: #171717; }
      .summary-grid span { color: #6E6A61; font-weight: 800; }
      @media (max-width: 720px) { main { padding: 12px; justify-content: flex-start; } .flow-strip, .summary-grid { grid-template-columns: 1fr; } .event-row { grid-template-columns: 1fr; } .staff-screen { border-radius: 20px; } }
    </style>
  </head>
  <body><main>${input.body}</main></body>
</html>`;
}

function messagePage(title: string, detail: string, href: string): string {
  return layout({
    title,
    body: `
      <section class="hero-card">
        <div class="eyebrow">Notice</div>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(detail)}</p>
        <div class="actions"><a class="button primary" href="${href}">돌아가기</a></div>
      </section>
    `
  });
}

function parseLocationConsent(value: string): LocationConsent {
  if (value === "granted" || value === "skipped" || value === "unavailable") return value;
  return "unavailable";
}

function buildRiskFlags(input: { latitude?: number; longitude?: number; locationConsent: LocationConsent }): string[] {
  if (input.latitude !== undefined && input.longitude !== undefined) return [];

  const flags = ["location_missing"];
  if (input.locationConsent === "skipped") flags.push("location_skipped");
  return flags;
}

const RISK_FLAG_UI_LABELS: Record<string, string> = {
  location_missing: "위치 없음",
  location_skipped: "위치 건너뜀"
};

function formatRiskSummary(flags: string[]): string {
  if (flags.length === 0) return "위치 확인됨 · 정상 기록";
  return flags.map((flag) => RISK_FLAG_UI_LABELS[flag] ?? flag).join(" · ");
}

function getCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const prefix = `${name}=`;
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

function findSeedEmployee(employeeId: string | undefined): (typeof seedEmployees)[number] | undefined {
  if (!employeeId) return undefined;
  return seedEmployees.find((employee) => employee.id === decodeURIComponent(employeeId));
}

function buildRememberCookie(employeeId: string, requestUrl: string): string {
  return [
    `${REMEMBERED_EMPLOYEE_COOKIE}=${encodeURIComponent(employeeId)}`,
    "Path=/",
    `Max-Age=${REMEMBERED_EMPLOYEE_MAX_AGE}`,
    "SameSite=Lax",
    isHttpsUrl(requestUrl) ? "Secure" : "",
    "HttpOnly"
  ].filter(Boolean).join("; ");
}

function clearRememberCookie(requestUrl: string): string {
  return [
    `${REMEMBERED_EMPLOYEE_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
    isHttpsUrl(requestUrl) ? "Secure" : "",
    "HttpOnly"
  ].filter(Boolean).join("; ");
}

function isHttpsUrl(requestUrl: string): boolean {
  return new URL(requestUrl).protocol === "https:";
}

function getQrSecret(env?: Env): string {
  return env?.QR_SECRET || LOCAL_SECRET;
}

function isAdminAuthorized(authorization: string | undefined, env?: Env): boolean {
  const expectedToken = env?.ADMIN_EXPORT_TOKEN;
  const prefix = "Bearer ";
  if (!expectedToken || !authorization?.startsWith(prefix)) return false;

  return timingSafeEqual(authorization.slice(prefix.length), expectedToken);
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function reasonToKorean(reason: string): string {
  const messages: Record<string, string> = {
    malformed: "큐알 형식이 올바르지 않습니다.",
    invalid_signature: "큐알 서명이 맞지 않습니다.",
    expired: "큐알 유효 시간이 지났습니다.",
    not_yet_valid: "아직 사용할 수 없는 큐알입니다."
  };
  return messages[reason] ?? "큐알을 확인할 수 없습니다.";
}

function stringField(value: FormDataEntryValue | FormDataEntryValue[] | undefined): string {
  if (typeof value === "string") return value;
  return "";
}

function optionalNumber(value: FormDataEntryValue | FormDataEntryValue[] | undefined): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isSeedEmployee(employeeId: string): boolean {
  return seedEmployees.some((employee) => employee.id === employeeId);
}

function isClockEventType(eventType: string): eventType is ClockEventType {
  return eventType === "clock_in" || eventType === "clock_out";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatKoreanTime(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(iso));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getDurableStore(env?: Env): DurableObjectStub | undefined {
  if (!env?.STORE) return undefined;
  return env.STORE.get(env.STORE.idFromName(DEFAULT_WORKSPACE_ID));
}

export class AttendanceStore {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/consume" && request.method === "POST") {
      const body = await request.json<{
        claims: QrClaims;
        qrNonceHash: string;
        attemptId: string;
        consumedAt: string;
      }>();
      const key = `consumption:${body.qrNonceHash}`;
      const existing = await this.state.storage.get<ConsumptionRecord>(key);
      if (existing) return Response.json({ ok: false });

      await this.state.storage.put<ConsumptionRecord>(key, {
        qrNonceHash: body.qrNonceHash,
        workspaceId: body.claims.workspaceId,
        kioskId: body.claims.kioskId,
        attemptId: body.attemptId,
        consumedAt: body.consumedAt
      });
      return Response.json({ ok: true, attemptId: body.attemptId });
    }

    if (url.pathname === "/complete" && request.method === "POST") {
      const body = await request.json<{
        input: {
          attemptId: string;
          qrNonceHash: string;
          claims: QrClaims;
          employeeId: string;
          eventType: ClockEventType;
          latitude?: number;
          longitude?: number;
          accuracyMeters?: number;
          locationConsent: LocationConsent;
        };
        occurredAt: string;
        riskFlags: string[];
      }>();
      const employee = seedEmployees.find((item) => item.id === body.input.employeeId);
      if (!employee) return Response.json({ ok: false, reason: "직원을 찾을 수 없습니다." });

      const key = `consumption:${body.input.qrNonceHash}`;
      const record = await this.state.storage.get<ConsumptionRecord>(key);
      if (!record || record.attemptId !== body.input.attemptId) {
        return Response.json({ ok: false, reason: "큐알 시도를 찾을 수 없습니다." });
      }
      if (record.completedEmployeeId) {
        return Response.json({ ok: false, reason: "이미 완료된 큐알입니다." });
      }

      record.completedEmployeeId = body.input.employeeId;
      record.completedAt = body.occurredAt;
      const events = (await this.state.storage.get<AttendanceEventRecord[]>("events")) ?? [];
      events.unshift({
        id: crypto.randomUUID(),
        workspaceId: body.input.claims.workspaceId,
        employeeId: body.input.employeeId,
        employeeName: employee.name,
        kioskId: body.input.claims.kioskId,
        eventType: body.input.eventType,
        occurredAt: body.occurredAt,
        latitude: body.input.latitude,
        longitude: body.input.longitude,
        accuracyMeters: body.input.accuracyMeters,
        riskFlags: body.riskFlags
      });
      await this.state.storage.put({ [key]: record, events: events.slice(0, 50) });

      return Response.json({ ok: true, employeeName: employee.name, riskFlags: body.riskFlags });
    }

    if (url.pathname === "/events") {
      const events = (await this.state.storage.get<AttendanceEventRecord[]>("events")) ?? [];
      return Response.json(events.slice(0, 12));
    }

    return new Response("not found", { status: 404 });
  }
}

export default app;
