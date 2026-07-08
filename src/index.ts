import { Hono } from "hono";

const app = new Hono();

app.get("/healthz", (context) => {
  return context.json({ ok: true, service: "chulgeun-dojang" });
});

app.get("/", (context) => {
  return context.html(`<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>출근도장</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0f172a;
        color: #e2e8f0;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
      }
      main {
        width: min(680px, calc(100vw - 40px));
        padding: 56px 0;
      }
      .eyebrow {
        color: #93c5fd;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        margin: 16px 0;
        font-size: clamp(42px, 8vw, 72px);
        line-height: 1;
      }
      p {
        color: #cbd5e1;
        font-size: 20px;
        line-height: 1.7;
      }
      ul {
        display: grid;
        gap: 10px;
        padding-left: 20px;
        color: #dbeafe;
        font-size: 17px;
        line-height: 1.6;
      }
      .card {
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 24px;
        padding: 28px;
        background: rgba(15, 23, 42, 0.72);
        box-shadow: 0 24px 80px rgba(15, 23, 42, 0.35);
      }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <div class="eyebrow">Open-source attendance</div>
        <h1>출근도장</h1>
        <p>소규모 사업장을 위한 무료 오픈소스 큐알 근태 기록기. 앱 설치 없이 웹에서 출퇴근을 기록하고, 패스키와 위치 확인으로 조작 가능성을 낮춥니다.</p>
        <ul>
          <li>직원 앱 설치 없음</li>
          <li>현장 큐알과 패스키 기반 출퇴근</li>
          <li>수정 대신 정정 이벤트를 남기는 기록 구조</li>
          <li>Cloudflare Workers와 D1 기반 서버리스 운영</li>
        </ul>
      </div>
    </main>
  </body>
</html>`);
});

export default app;
