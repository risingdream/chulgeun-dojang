# 데이터베이스 전략

## 결론

출근도장의 기본 저장소는 **Cloudflare D1**이 맞다. 구글시트 연동은 제외하고, 사장님은 CSV 파일로 기록을 내려받는다.

## 왜 D1인가

- Workers와 같은 Cloudflare 안에서 바로 붙어서 배포와 운영이 단순하다.
- SQLite 기반이라 소규모 사업장 근태 기록에는 충분하다.
- `qr_consumptions.qr_nonce_hash` 같은 유일 제약으로 큐알 재사용을 데이터베이스 수준에서 막을 수 있다.
- 출퇴근 기록을 append-only 이벤트 로그로 쌓고, 정정은 별도 이벤트로 남기기 좋다.
- 무료/저가 구간에서 시작하기 쉽고, 나중에 Postgres로 옮기기도 쉽다.

## 구글시트를 제외하는 이유

- 동시성 제어와 유일 제약이 약해서 큐알 전역 1회 소비 같은 보안 규칙을 맡기기 어렵다.
- 시트 권한, 열 구조 변경, 수식, 사람이 직접 수정하는 문제 때문에 감사 로그 신뢰도가 떨어진다.
- API 쿼터와 응답 속도가 근태 기록의 핵심 경로에 들어가면 불안정하다.
- 개인정보가 섞일 수 있어 권한 관리가 까다롭다.

## 추천 구조

### P0 테스트

- Cloudflare Workers
- Durable Objects 또는 메모리 대체 저장소로 데모 동작 확인
- 실제 서비스 저장소는 D1로 고정

### P1 실제 베타

- Cloudflare D1: 원장 데이터
- 관리자 보호 CSV 다운로드: 즉시 내려받기
- Cloudflare R2: 월별 CSV 백업 파일 후보

### P2 사업장 확장

- D1 유지가 가능하면 계속 사용
- 사업장 수와 조회량이 커지면 Neon/Supabase Postgres를 분석계 또는 주 저장소 후보로 검토
- 원장 이벤트는 D1/Postgres에 두고, 다운로드 파일은 CSV 또는 엑셀로 제공

## 현재 구현 상태

- `schema.sql`과 `migrations/0001_initial.sql`에 D1 스키마를 둔다.
- 원격 D1 생성은 Cloudflare 인증이 필요하다.
- 인증 전 테스트 배포는 `wrangler.temp.jsonc`의 Durable Object 저장소로 동작한다.
- `/admin/demo/export.csv`는 `ADMIN_EXPORT_TOKEN`이 있어야 CSV를 내려준다.

## 운영 명령

```bash
export PATH="/home/risingdream/.bun/bin:$PATH"

# Cloudflare 로그인 또는 CLOUDFLARE_API_TOKEN 설정 후 실행
bunx wrangler d1 create chulgeun-dojang --location apac
# 출력된 database_id를 wrangler.jsonc에 넣기
bunx wrangler d1 execute chulgeun-dojang --remote --file migrations/0001_initial.sql
bunx wrangler secret put QR_SECRET
bunx wrangler secret put ADMIN_EXPORT_TOKEN
bunx wrangler deploy
```
