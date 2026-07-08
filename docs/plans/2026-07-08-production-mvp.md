# 출근도장 Production MVP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 임시 데모를 실제 베타 운영에 가까운 구조로 바꾼다.

**Architecture:** 원장 데이터는 Cloudflare D1에 둔다. 구글시트 연동은 제외하고, 사장님이 기록을 CSV로 내려받을 수 있게 한다. 1차 운영 보호는 관리자 토큰으로 막고, 이후 패스키/매직링크 관리자로 교체한다.

**Tech Stack:** Cloudflare Workers, Hono, D1, Durable Object temporary fallback, TypeScript, Vitest, Bun.

---

## 범위

### 이번 차수에서 한다

1. 출퇴근 기록 CSV 생성 도메인 함수.
2. 관리자 토큰이 있어야 CSV를 내려받을 수 있는 엔드포인트.
3. D1와 임시 저장소 양쪽에서 같은 CSV 다운로드 동작.
4. 운영 문서 갱신.

### 이번 차수에서 하지 않는다

1. 구글시트 연동.
2. 실제 메일 발송 매직링크.
3. 직원 패스키 실등록.
4. 유료 결제.

---

## Task 1: CSV export domain

**Objective:** 출퇴근 이벤트 배열을 한국어 CSV로 바꾸는 순수 함수를 만든다.

**Files:**
- Create: `src/domain/attendance-export.ts`
- Test: `src/domain/attendance-export.test.ts`

**Steps:**
1. 실패 테스트 작성: 한국어 헤더, 엑셀용 BOM, 쉼표/따옴표 이스케이프, 큐알 해시 제외.
2. `bun test src/domain/attendance-export.test.ts`로 실패 확인.
3. 최소 구현.
4. 같은 테스트 통과 확인.

## Task 2: Protected download endpoint

**Objective:** `/admin/demo/export.csv`에서 관리자 토큰 확인 후 기록 CSV를 내려준다.

**Files:**
- Modify: `src/index.ts`
- Test: `src/index.test.ts`

**Steps:**
1. 실패 테스트 작성: 토큰 없음은 401, 토큰 있음은 `text/csv`와 첨부 헤더 반환.
2. `bun test src/index.test.ts`로 실패 확인.
3. `ADMIN_EXPORT_TOKEN` 환경 변수를 확인하는 보호 로직 구현.
4. D1, Durable Object, 메모리 저장소에서 최근 이벤트를 가져와 CSV로 변환.
5. 테스트 통과 확인.

## Task 3: Documentation and deployment notes

**Objective:** 구글시트 제외, D1 원장, CSV 다운로드 전략을 문서화한다.

**Files:**
- Modify: `docs/database-strategy.md`
- Modify: `README.md`

**Steps:**
1. 문서에서 구글시트 선택 동기화 표현 제거.
2. D1 원장 + CSV 다운로드 + 필요 시 R2 월별 백업으로 정리.
3. 배포 환경 변수에 `ADMIN_EXPORT_TOKEN` 추가.

## Verification

```bash
export PATH="/home/risingdream/.bun/bin:$PATH"
bun test
bun run typecheck
python3 - <<'PY'
import sqlite3, pathlib
conn = sqlite3.connect(':memory:')
conn.executescript(pathlib.Path('migrations/0001_initial.sql').read_text())
print('migration schema ok')
PY
```
