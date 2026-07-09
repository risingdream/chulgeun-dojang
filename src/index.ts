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
const QR_TTL_SECONDS = 30;
const LOCAL_SECRET = "local-dev-secret";
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
      <section class="hero-card">
        <div class="eyebrow">Open-source attendance</div>
        <h1>출근도장</h1>
        <p>소규모 사업장을 위한 무료 오픈소스 큐알 근태 기록기. 앱 설치 없이 웹에서 출퇴근을 기록하고, 패스키와 위치 확인으로 조작 가능성을 낮춥니다.</p>
        <ul>
          <li>직원 앱 설치 없음</li>
          <li>현장 큐알과 패스키 기반 출퇴근</li>
          <li>수정 대신 정정 이벤트를 남기는 기록 구조</li>
          <li>Cloudflare Workers와 D1 기반 서버리스 운영</li>
        </ul>
        <div class="actions">
          <a class="button primary" href="/start">운영 시작</a>
          <a class="button" href="/kiosk">키오스크 열기</a>
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
      <section class="hero-card">
        <div class="eyebrow">Production flow</div>
        <h1>운영 시작</h1>
        <p>아래 키오스크 화면을 현장 태블릿이나 사장님 기기에서 열고, 직원폰으로 큐알을 찍어 출퇴근을 기록합니다.</p>
        <ol>
          <li>키오스크 화면을 엽니다.</li>
          <li>화면의 큐알 또는 링크를 직원폰에서 엽니다.</li>
          <li>직원과 출퇴근 유형을 선택하고 기록합니다.</li>
          <li>같은 큐알을 다시 열면 재사용이 막히는지 확인합니다.</li>
        </ol>
        <div class="actions">
          <a class="button primary" href="/kiosk">키오스크 열기</a>
          <a class="button" href="/events">최근 기록 보기</a>
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
  const events = await listRecentEvents(context.env);

  return context.html(layout({
    title: "출근도장 키오스크",
    refreshSeconds: 25,
    body: `
      <section class="hero-card kiosk">
        <div class="eyebrow">Production kiosk</div>
        <h1>출근도장 키오스크</h1>
        <p>큐알은 30초 동안만 살아있고, 첫 스캔 순간 전역 1회 소비됩니다. 스캔되면 다음 큐알을 써야 합니다.</p>
        <div class="qr-wrap">
          <img alt="출근도장 큐알" src="https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(scanUrl)}" />
        </div>
        <p class="small">카메라 스캔이 어려우면 아래 링크를 직원폰에서 열면 됩니다.</p>
        <p><a class="scan-link" href="${escapeHtml(scanUrl)}">${escapeHtml(scanUrl)}</a></p>
        <div class="actions">
          <a class="button" href="/kiosk">새 큐알 받기</a>
          <a class="button" href="/events">최근 기록 보기</a>
        </div>
      </section>
      ${renderEventList(events)}
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

  return context.html(layout({
    title: "출퇴근 기록",
    body: `
      <section class="hero-card">
        <div class="eyebrow">Clock event</div>
        <h1>출퇴근 기록</h1>
        <p>이 큐알은 지금 소비됐습니다. 같은 큐알은 다른 직원이 다시 쓸 수 없습니다.</p>
        <form method="post" action="/api/clock" class="form-card">
          <input type="hidden" name="token" value="${escapeHtml(token)}" />
          <input type="hidden" name="attemptId" value="${escapeHtml(consumed.attemptId)}" />
          <label>
            직원
            <select name="employeeId">
              ${seedEmployees.map((employee) => `<option value="${employee.id}">${employee.name}</option>`).join("")}
            </select>
          </label>
          <label>
            유형
            <select name="eventType">
              <option value="clock_in">출근</option>
              <option value="clock_out">퇴근</option>
            </select>
          </label>
          <input type="hidden" name="latitude" data-location="lat" />
          <input type="hidden" name="longitude" data-location="lng" />
          <input type="hidden" name="accuracyMeters" data-location="accuracy" />
          <button class="button primary" type="submit">기록하기</button>
          <p class="small" data-location-status>위치 권한은 선택입니다. 허용하면 위험 기록 판단에 사용합니다.</p>
        </form>
      </section>
      <script>
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition((position) => {
            document.querySelector('[data-location="lat"]').value = position.coords.latitude;
            document.querySelector('[data-location="lng"]').value = position.coords.longitude;
            document.querySelector('[data-location="accuracy"]').value = position.coords.accuracy;
            document.querySelector('[data-location-status]').textContent = '위치 정보가 함께 기록됩니다.';
          }, () => {
            document.querySelector('[data-location-status]').textContent = '위치 없이 기록합니다. 위험 플래그가 남을 수 있습니다.';
          }, { enableHighAccuracy: false, timeout: 2500, maximumAge: 30000 });
        }
      </script>
    `
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
    accuracyMeters
  });

  if (!result.ok) {
    return context.html(messagePage("기록 실패", result.reason, "/kiosk"), 409);
  }

  return context.html(layout({
    title: "기록 완료",
    body: `
      <section class="hero-card success">
        <div class="eyebrow">Saved</div>
        <h1>${eventType === "clock_in" ? "출근" : "퇴근"} 기록 완료</h1>
        <p><strong>${escapeHtml(result.employeeName)}</strong>의 기록이 저장됐습니다.</p>
        <p class="small">위치: ${latitude && longitude ? "기록됨" : "없음 · 위험 플래그 저장"}</p>
        <div class="actions">
          <a class="button primary" href="/kiosk">키오스크로 돌아가기</a>
          <a class="button" href="/events">최근 기록 보기</a>
        </div>
      </section>
    `
  }));
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
  }
): Promise<{ ok: true; employeeName: string } | { ok: false; reason: string }> {
  const employee = seedEmployees.find((item) => item.id === input.employeeId);
  if (!employee) return { ok: false, reason: "직원을 찾을 수 없습니다." };

  const occurredAt = new Date().toISOString();
  const riskFlags = input.latitude && input.longitude ? [] : ["location_missing"];

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
    return { ok: true, employeeName: employee.name };
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

  return { ok: true, employeeName: employee.name };
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

function renderEventList(events: AttendanceEventRecord[]): string {
  if (events.length === 0) {
    return `<section class="list-card"><h2>최근 기록</h2><p class="small">아직 기록이 없습니다.</p></section>`;
  }

  return `
    <section class="list-card">
      <h2>최근 기록</h2>
      <div class="event-list">
        ${events.map((event) => `
          <article class="event-row">
            <strong>${escapeHtml(event.employeeName)}</strong>
            <span>${event.eventType === "clock_in" ? "출근" : "퇴근"}</span>
            <time>${escapeHtml(formatKoreanTime(event.occurredAt))}</time>
            ${event.riskFlags.length ? `<em>${event.riskFlags.join(", ")}</em>` : `<em>정상</em>`}
          </article>
        `).join("")}
      </div>
    </section>
  `;
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
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #08111f; color: #e2e8f0; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top left, rgba(59,130,246,.28), transparent 34rem), #08111f; }
      main { width: min(880px, calc(100vw - 32px)); margin: 0 auto; padding: 48px 0; display: grid; gap: 20px; }
      .hero-card, .list-card { border: 1px solid rgba(148, 163, 184, 0.25); border-radius: 28px; padding: clamp(24px, 5vw, 42px); background: rgba(15, 23, 42, 0.78); box-shadow: 0 24px 80px rgba(2, 6, 23, 0.42); backdrop-filter: blur(16px); }
      .eyebrow { color: #93c5fd; font-size: 13px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
      h1 { margin: 14px 0; font-size: clamp(40px, 8vw, 74px); line-height: 1; letter-spacing: -0.06em; }
      h2 { margin: 0 0 16px; font-size: 24px; }
      p, li { color: #cbd5e1; font-size: 18px; line-height: 1.7; }
      ul, ol { display: grid; gap: 8px; padding-left: 22px; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 24px; }
      .button, button { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 0 18px; border: 1px solid rgba(147,197,253,.4); border-radius: 14px; color: #dbeafe; background: rgba(30,41,59,.82); text-decoration: none; font-weight: 800; cursor: pointer; }
      .button.primary, button.primary { background: #2563eb; border-color: #60a5fa; color: white; }
      .qr-wrap { display: inline-grid; padding: 16px; border-radius: 24px; background: white; margin: 18px 0; }
      .qr-wrap img { display: block; width: 280px; height: 280px; }
      .scan-link { color: #93c5fd; word-break: break-all; }
      .small { color: #94a3b8; font-size: 14px; }
      .form-card { display: grid; gap: 16px; margin-top: 24px; }
      label { display: grid; gap: 8px; color: #bfdbfe; font-weight: 700; }
      select { min-height: 48px; border-radius: 14px; border: 1px solid rgba(148,163,184,.35); padding: 0 14px; background: #0f172a; color: #e2e8f0; font-size: 16px; }
      .event-list { display: grid; gap: 10px; }
      .event-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 12px; align-items: center; padding: 14px; border-radius: 16px; background: rgba(15,23,42,.72); color: #cbd5e1; }
      .event-row em { color: #93c5fd; font-style: normal; }
      .success h1 { color: #86efac; }
      @media (max-width: 640px) { .event-row { grid-template-columns: 1fr; } .qr-wrap img { width: 220px; height: 220px; } }
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

      return Response.json({ ok: true, employeeName: employee.name });
    }

    if (url.pathname === "/events") {
      const events = (await this.state.storage.get<AttendanceEventRecord[]>("events")) ?? [];
      return Response.json(events.slice(0, 12));
    }

    return new Response("not found", { status: 404 });
  }
}

export default app;
