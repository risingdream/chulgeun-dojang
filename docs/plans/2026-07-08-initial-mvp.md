# 출근도장 Initial MVP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 무료 오픈소스 큐알 근태 기록기의 첫 서버리스 뼈대를 만든다.

**Architecture:** Cloudflare Workers 위에서 Hono 앱을 실행하고, D1에 추가 전용 이벤트를 저장한다. 큐알은 DB에 원문 저장하지 않고 서명 검증하며, 중복 사용은 이벤트 유일값으로 막는다.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, Cloudflare D1, Vitest, WebAuthn.

---

### Task 1: 프로젝트 뼈대 생성

**Objective:** Bun, TypeScript, Vitest, Wrangler 설정을 만든다.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `wrangler.jsonc`

**Verification:**

```bash
bun install
bun test
bun run typecheck
```

### Task 2: 큐알 서명 도메인 작성

**Objective:** 큐알 토큰 생성, 검증, 해시 생성 로직을 만든다.

**Files:**
- Test: `src/domain/qr-token.test.ts`
- Create: `src/domain/qr-token.ts`

**Expected behavior:**
- 유효한 토큰은 검증된다.
- 만료 토큰은 거절된다.
- 조작된 토큰은 거절된다.
- 저장용 큐알 해시는 원문 토큰을 드러내지 않는다.

### Task 3: D1 스키마 작성

**Objective:** 사업장, 직원, 패스키, 키오스크, 근태 이벤트 테이블을 만든다.

**Files:**
- Create: `schema.sql`

**Verification:**

```bash
wrangler d1 execute chulgeun-dojang --local --file=./schema.sql
```

### Task 4: 기본 Worker 라우트 작성

**Objective:** 상태 확인과 제품 소개 화면을 띄운다.

**Files:**
- Create: `src/index.ts`

**Routes:**
- `GET /` 소개 화면
- `GET /healthz` 상태 확인

### Task 5: 직원 등록 흐름 설계 추가

**Objective:** 패스키 등록용 서버 라우트를 붙이기 전 문서와 타입을 정리한다.

**Files:**
- Modify: `docs/security-model.md`
- Create: `src/domain/webauthn-types.ts`

### Task 6: 첫 배포 준비

**Objective:** 레포를 공개하고 기본 명령을 통과시킨다.

**Verification:**

```bash
bun test
bun run typecheck
git status --short
gh repo view risingdream/chulgeun-dojang
```
