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
const QR_TTL_SECONDS = 30;
const LOCAL_SECRET = "local-dev-secret";
const REMEMBERED_EMPLOYEE_COOKIE = "rememberedEmployeeId";
const REMEMBERED_EMPLOYEE_MAX_AGE = 60 * 60 * 24 * 365;
const seedEmployees = [
  { id: "employee-a", name: "직원 A", codeHash: "employee-a-code" },
  { id: "employee-b", name: "직원 B", codeHash: "employee-b-code" },
  { id: "employee-c", name: "직원 C", codeHash: "employee-c-code" }
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
    refreshSeconds: 25,
    body: `
      <section class="kiosk-screen">
        <div class="kiosk-top">
          ${brandMark()}
          <div class="kiosk-meta">
            <strong>${DEFAULT_WORKSPACE_DISPLAY_NAME}</strong>
            <span>${DEFAULT_KIOSK_DISPLAY_NAME}</span>
          </div>
          <span class="status-pill">정상 연결</span>
        </div>
        <div class="clock-face">
          <strong data-now-clock>12:00:42</strong>
          <span>7월 9일 목요일</span>
        </div>
        <div class="kiosk-instructions">
          <div><strong>1</strong><span>내 폰 카메라로 큐알을 찍어주세요</span></div>
          <div><strong>2</strong><span>처음이면 이름을 한 번만 선택해주세요</span></div>
          <div><strong>3</strong><span>출근 또는 퇴근을 눌러주세요</span></div>
        </div>
        <div class="qr-stage">
          <div class="qr-wrap">
            <img alt="출근도장 큐알" src="https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(scanUrl)}" />
          </div>
          <div class="timer-badge">${QR_TTL_SECONDS}</div>
        </div>
        <p class="timer-copy">새 큐알까지 ${QR_TTL_SECONDS}초</p>
        <p class="small">만료된 큐알은 기록되지 않습니다</p>
        <p><a class="scan-link" href="${escapeHtml(scanUrl)}">${escapeHtml(scanUrl)}</a></p>
        <div class="actions kiosk-actions">
          <a class="button" href="/kiosk">새 큐알 받기</a>
          <a class="button ghost" href="/admin/today">사장님 확인</a>
        </div>
        <p class="owner-hint">사장님 열람: 여기를 3초 길게 누르세요</p>
      </section>
      <section class="notice-card surface-card">
        <h2>상태 안내</h2>
        <p class="small">오프라인이면 큐알을 만들 수 없습니다. 연결되면 자동으로 새 큐알을 만듭니다.</p>
        <p class="small">공용 화면에는 직원 이름과 출퇴근 내역을 표시하지 않습니다.</p>
      </section>
    `
  }));
});

app.get("/scan", async (context) => {
  await ensureDefaultSeed(context.env);

  const token = context.req.query("token") ?? "";
  const verified = await verifyQrToken(token, getQrSecret(context.env), Math.floor(Date.now() / 1000));
  if (!verified.ok) {
    return context.html(messagePage("큐알을 사용할 수 없습니다", reasonToKorean(verified.reason), "/kiosk"), 400);
  }

  const qrNonceHash = await hashQrNonce({
    workspaceId: verified.claims.workspaceId,
    kioskId: verified.claims.kioskId,
    nonce: verified.claims.nonce
  });
  const consumed = await consumeQrOnScan(context.env, verified.claims, qrNonceHash);
  if (!consumed.ok) {
    return context.html(
      messagePage("이미 갱신된 큐알입니다", "화면의 새 큐알을 다시 찍어주세요.", "/kiosk"),
      409
    );
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
    return context.text("관리자 인증이 필요합니다", 401);
  }

  const events = await listRecentEvents(context.env);
  const clockIns = events.filter((event) => event.eventType === "clock_in").length;
  const clockOuts = events.filter((event) => event.eventType === "clock_out").length;
  const flagged = events.filter((event) => event.riskFlags.length > 0).length;

  return context.html(layout({
    title: "오늘 기록",
    body: `
      <section class="hero-card owner-card">
        <div class="brand-row">${brandMark()}<span class="pill green">사장님 화면</span></div>
        <h1>오늘 기록</h1>
        <p>키오스크 공용 화면에는 보이지 않는 사장님 확인 화면입니다.</p>
        <div class="summary-grid">
          <div><strong>${clockIns}</strong><span>출근</span></div>
          <div><strong>${clockOuts}</strong><span>퇴근</span></div>
          <div><strong>${flagged}</strong><span>확인 필요</span></div>
        </div>
        <div class="actions"><a class="button primary" href="/kiosk">키오스크로 돌아가기</a></div>
      </section>
      ${renderEventList(events, "오늘 기록")}
    `
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
        `INSERT OR IGNORE INTO employees (id, workspace_id, name, employee_code_hash, status, registered_at)
         VALUES (?, ?, ?, ?, ?, ?)`
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

function renderScanPage(input: {
  token: string;
  attemptId: string;
  rememberedEmployee?: (typeof seedEmployees)[number];
}): string {
  const employeeChoice = input.rememberedEmployee
    ? `
        <input type="hidden" name="employeeId" value="${escapeHtml(input.rememberedEmployee.id)}" />
        <div class="remembered-card">
          <div class="phone-status">이 폰 기억됨</div>
          <h1>${escapeHtml(input.rememberedEmployee.name)} 님, 안녕하세요</h1>
          <p>${DEFAULT_WORKSPACE_DISPLAY_NAME} · 지금 시각으로 기록합니다</p>
          <a class="subtle-link" href="/forget-device">내가 아니에요 — 이름 선택으로</a>
        </div>
      `
    : `
        <h1>처음이시네요.<br />이름을 한 번만 선택해주세요.</h1>
        <div class="employee-grid" role="radiogroup" aria-label="직원 선택">
          ${seedEmployees.map((employee, index) => `
            <label class="employee-choice">
              <input type="radio" name="employeeId" value="${escapeHtml(employee.id)}" ${index === 0 ? "checked" : ""} />
              <span>${escapeHtml(employee.name)}</span>
            </label>
          `).join("")}
        </div>
        <label class="remember-toggle">
          <input type="checkbox" name="rememberEmployee" value="true" checked />
          <span><strong>이 폰 기억하기</strong><small>다음부터 이름 선택 없이 바로 기록합니다</small></span>
        </label>
      `;

  return `
    <section class="phone-screen">
      <div class="phone-top">${brandMark()}<span class="phone-status">큐알 확인됨</span></div>
      <form method="post" action="/api/clock" class="form-card" data-clock-form>
        <input type="hidden" name="token" value="${escapeHtml(input.token)}" />
        <input type="hidden" name="attemptId" value="${escapeHtml(input.attemptId)}" />
        ${employeeChoice}
        <section class="notice-card location-card">
          <h2>위치를 확인할까요?</h2>
          <p>기록하는 순간의 위치 1회만 저장합니다.<br />이동 경로는 수집하지 않습니다.</p>
          <input type="hidden" name="latitude" data-location="lat" />
          <input type="hidden" name="longitude" data-location="lng" />
          <input type="hidden" name="accuracyMeters" data-location="accuracy" />
          <input type="hidden" name="locationConsent" value="unavailable" data-location="consent" />
          <p class="small" data-location-status>위치 권한은 선택입니다. 허용하지 않아도 기록은 남습니다.</p>
          <button class="button ghost" type="button" data-skip-location>위치 없이 기록</button>
        </section>
        <div class="clock-buttons">
          <button class="clock-action in" type="submit" name="eventType" value="clock_in"><strong>출근</strong><span>지금 시각으로 기록합니다</span></button>
          <button class="clock-action out" type="submit" name="eventType" value="clock_out"><strong>퇴근</strong><span>지금 시각으로 기록합니다</span></button>
        </div>
      </form>
    </section>
    <script>
      const consent = document.querySelector('[data-location="consent"]');
      const status = document.querySelector('[data-location-status]');
      document.querySelector('[data-skip-location]')?.addEventListener('click', () => {
        consent.value = 'skipped';
        status.textContent = '위치 없이 기록합니다. 위치 없음 표시가 남습니다.';
      });
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((position) => {
          document.querySelector('[data-location="lat"]').value = position.coords.latitude;
          document.querySelector('[data-location="lng"]').value = position.coords.longitude;
          document.querySelector('[data-location="accuracy"]').value = position.coords.accuracy;
          consent.value = 'granted';
          status.textContent = '위치 정보가 함께 기록됩니다.';
        }, () => {
          consent.value = consent.value === 'skipped' ? 'skipped' : 'unavailable';
          status.textContent = '위치 없이 기록할 수 있습니다. 위치 없음 표시가 남습니다.';
        }, { enableHighAccuracy: false, timeout: 2500, maximumAge: 30000 });
      }
    </script>
  `;
}

function renderSuccessPage(input: { employeeName: string; eventType: ClockEventType; riskFlags: string[] }): string {
  const actionLabel = input.eventType === "clock_in" ? "출근" : "퇴근";
  return `
    <section class="phone-screen success-screen">
      <div class="phone-top">${brandMark()}<span class="phone-status green">저장 완료</span></div>
      <div class="success-symbol">✓</div>
      <h1>${actionLabel} 기록 완료</h1>
      <p><strong>${escapeHtml(input.employeeName)}</strong>의 ${actionLabel} 기록이 저장됐습니다.</p>
      <div class="risk-summary ${input.riskFlags.length ? "warning" : ""}">${escapeHtml(formatRiskSummary(input.riskFlags))}</div>
      <div class="actions stacked-actions">
        <a class="button primary" href="/kiosk">키오스크로 돌아가기</a>
        <a class="button ghost" href="/forget-device">기억 해제</a>
      </div>
      <p class="small">다음 버전에서는 여기서 패스키 등록으로 더 강하게 확인합니다.</p>
    </section>
  `;
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
    <style>
      :root { color-scheme: light; font-family: Pretendard, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #F3EFE7; color: #22262B; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top left, rgba(193,58,42,.12), transparent 26rem), linear-gradient(180deg, #FDFBF6 0%, #F3EFE7 100%); }
      main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: clamp(24px, 4vw, 48px) 0; display: grid; gap: 22px; justify-items: center; }
      h1 { margin: 18px 0 0; font-size: clamp(34px, 7vw, 78px); line-height: .98; letter-spacing: -0.055em; color: #171717; }
      h2 { margin: 0 0 10px; color: #22262B; font-size: 24px; }
      p, li { color: #6E6A61; font-size: 17px; line-height: 1.65; }
      ul, ol { display: grid; gap: 8px; padding-left: 22px; }
      .eyebrow { margin: 0; color: #C13A2A; font-size: 12px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
      .brand-mark, .brand-row, .phone-top, .kiosk-top { display: flex; align-items: center; gap: 8px; }
      .brand-mark span { width: 26px; height: 26px; border-radius: 7px; background: #C13A2A; color: white; display: grid; place-items: center; font-size: 12px; font-weight: 900; }
      .brand-mark strong { font-size: 15px; color: #22262B; }
      .brand-row { width: 100%; justify-content: space-between; }
      .pill, .status-pill, .phone-status { background: #F3E7D8; color: #9F2E22; font-size: 12px; font-weight: 800; padding: 7px 12px; border-radius: 999px; white-space: nowrap; }
      .pill.green, .status-pill, .phone-status.green { background: #E8F3EC; color: #217A4B; }
      .hero-card, .list-card, .landing-shell, .kiosk-screen, .phone-screen, .surface-card { border: 1px solid #E8E1D3; border-radius: 28px; background: rgba(255,255,255,.84); box-shadow: 0 18px 50px rgba(93, 70, 41, .11); }
      .hero-card, .list-card, .landing-shell, .surface-card { width: min(920px, 100%); padding: clamp(24px, 5vw, 46px); }
      .landing-shell { min-height: 520px; display: grid; align-content: center; gap: 28px; }
      .landing-copy p { max-width: 640px; }
      .flow-strip, .step-list { display: grid; gap: 10px; }
      .flow-strip { grid-template-columns: repeat(4, 1fr); }
      .flow-strip span, .step-list div { background: #FFF8ED; border: 1px solid #E8E1D3; border-radius: 18px; padding: 16px; color: #3C424A; font-weight: 800; }
      .step-list div { display: flex; align-items: center; gap: 14px; }
      .step-list strong { width: 34px; height: 34px; border-radius: 50%; background: #C13A2A; color: white; display: grid; place-items: center; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
      .button, button { display: inline-flex; align-items: center; justify-content: center; min-height: 50px; padding: 0 18px; border: 1px solid #D8CDBB; border-radius: 15px; color: #3C424A; background: #FFFFFF; text-decoration: none; font-weight: 900; cursor: pointer; }
      .button.primary, button.primary { background: #C13A2A; border-color: #C13A2A; color: white; }
      .button.ghost, button.ghost { background: #FDFBF6; color: #6E6A61; }
      .kiosk-screen { width: min(900px, 100%); padding: clamp(26px, 5vw, 46px); display: grid; gap: 18px; text-align: center; }
      .kiosk-top { justify-content: space-between; text-align: left; }
      .kiosk-meta { display: grid; gap: 2px; margin-right: auto; }
      .kiosk-meta strong { font-size: 17px; }
      .kiosk-meta span, .clock-face span, .owner-hint, .small { color: #8A8478; font-size: 13px; }
      .clock-face { display: grid; gap: 4px; justify-items: center; }
      .clock-face strong { font-size: clamp(54px, 10vw, 86px); line-height: 1; letter-spacing: -.05em; color: #171717; }
      .kiosk-instructions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
      .kiosk-instructions div { background: #FFF8ED; border: 1px solid #E8E1D3; border-radius: 18px; padding: 14px; display: grid; gap: 6px; }
      .kiosk-instructions strong { width: 28px; height: 28px; margin: 0 auto; border-radius: 50%; background: #C13A2A; color: white; display: grid; place-items: center; }
      .qr-stage { position: relative; width: fit-content; margin: 8px auto 0; }
      .qr-wrap { display: inline-grid; padding: 18px; border-radius: 30px; background: white; border: 1px solid #E8E1D3; box-shadow: 0 16px 38px rgba(58, 39, 19, .12); }
      .qr-wrap img { display: block; width: min(360px, 72vw); height: min(360px, 72vw); }
      .timer-badge { position: absolute; right: -14px; top: -14px; width: 58px; height: 58px; border-radius: 50%; background: #C13A2A; color: white; display: grid; place-items: center; font-size: 22px; font-weight: 900; border: 5px solid #FDFBF6; }
      .timer-copy { margin: 0; color: #3C424A; font-weight: 900; }
      .scan-link { color: #9F2E22; word-break: break-all; font-size: 12px; }
      .kiosk-actions { justify-content: center; margin-top: 8px; }
      .phone-screen { width: min(402px, 100%); min-height: 780px; padding: 58px 22px 36px; display: flex; flex-direction: column; gap: 18px; }
      .phone-top { justify-content: space-between; }
      .phone-screen h1 { font-size: 28px; line-height: 1.16; letter-spacing: -.03em; }
      .form-card { display: grid; gap: 16px; margin-top: 2px; }
      .employee-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .employee-choice, .remember-toggle, .notice-card { border: 1px solid #E8E1D3; border-radius: 18px; padding: 15px; background: #FFFFFF; color: #22262B; }
      .employee-choice { display: flex; align-items: center; gap: 9px; min-height: 56px; font-weight: 800; }
      .remember-toggle { display: flex; align-items: center; gap: 12px; }
      .remember-toggle span { display: grid; gap: 4px; }
      .remember-toggle small { color: #8A8478; font-weight: 600; }
      .remembered-card { display: grid; gap: 10px; }
      .subtle-link { color: #8A8478; font-size: 13px; font-weight: 800; text-decoration: none; }
      .location-card { background: #FFF8ED; }
      .location-card p { margin: 0; font-size: 14px; }
      .clock-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 4px; }
      .clock-action { min-height: 112px; border-radius: 22px; border: 0; display: grid; gap: 7px; padding: 18px; color: white; }
      .clock-action strong { font-size: 30px; }
      .clock-action span { font-size: 12px; color: rgba(255,255,255,.86); }
      .clock-action.in { background: #C13A2A; }
      .clock-action.out { background: #22262B; }
      .success-screen { text-align: center; justify-content: center; }
      .success-symbol { width: 84px; height: 84px; margin: 0 auto; border-radius: 50%; background: #E8F3EC; color: #217A4B; display: grid; place-items: center; font-size: 46px; font-weight: 900; }
      .risk-summary { border-radius: 16px; padding: 14px; background: #E8F3EC; color: #217A4B; font-weight: 900; }
      .risk-summary.warning { background: #FFF1DF; color: #9F2E22; }
      .stacked-actions { display: grid; }
      .owner-card { text-align: left; }
      .summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 22px; }
      .summary-grid div { border: 1px solid #E8E1D3; border-radius: 18px; padding: 18px; background: #FFF8ED; }
      .summary-grid strong { display: block; font-size: 38px; color: #171717; }
      .summary-grid span { color: #6E6A61; font-weight: 800; }
      .event-list { display: grid; gap: 10px; }
      .event-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 12px; align-items: center; padding: 14px; border-radius: 16px; background: #FFF8ED; color: #3C424A; }
      .event-row em { color: #9F2E22; font-style: normal; font-weight: 800; }
      @media (max-width: 720px) { .flow-strip, .kiosk-instructions, .summary-grid { grid-template-columns: 1fr; } .event-row { grid-template-columns: 1fr; } .phone-screen { min-height: auto; } }
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
