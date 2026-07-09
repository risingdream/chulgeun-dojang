# 출근도장

소규모 사업장을 위한 무료 오픈소스 큐알 근태 기록기입니다. 앱 설치 없이 웹에서 출퇴근을 기록하고, 패스키와 위치 확인으로 조작 가능성을 낮춥니다.

## 목표

- 직원 앱 설치 없음
- 사장님만 계정 보유
- 직원은 일회용 등록 링크로 패스키 등록
- 현장 큐알, 패스키, 위치 확인으로 출퇴근 검증
- 기록은 수정하지 않고 정정 이벤트만 추가
- Cloudflare Workers와 D1 기반 서버리스 운영

## 큐알 정책

출근도장의 큐알은 짧게 살아있는 서명 토큰입니다.

- 키오스크 화면은 20~30초마다 큐알을 자동 갱신합니다.
- 큐알 하나는 전역 1회만 사용할 수 있습니다. 한 직원이 먼저 스캔하면 같은 큐알은 다른 직원도 다시 쓸 수 없습니다.
- 큐알이 스캔되거나 사용 실패가 발생하면 키오스크는 즉시 새 큐알을 받아 표시합니다.
- 여러 직원이 동시에 출근할 때는 같은 큐알을 나눠 쓰지 않고, 키오스크가 빠르게 다음 큐알을 보여주는 방식으로 처리합니다.

## 문서

- [제품 명세](docs/product-spec.md)
- [보안 모델](docs/security-model.md)
- [데이터 모델](docs/data-model.md)
- [데이터베이스 전략](docs/database-strategy.md)
- [편의성 스윗스팟 리서치](docs/attendance-sweet-spot-research.md)

## 개발

```bash
bun install
bun test
bun run typecheck
bun run dev
```

## 운영 주소

- Production: https://chulgeun-dojang.risingdream.workers.dev
- 키오스크: https://chulgeun-dojang.risingdream.workers.dev/kiosk
- 최근 기록: https://chulgeun-dojang.risingdream.workers.dev/events

## 기록 내려받기

사장님 화면에서 3초 길게 누른 뒤 PIN을 입력하면 오늘 기록을 보고 CSV를 내려받을 수 있습니다. 서버 자동화나 운영 점검은 관리자 토큰으로도 CSV를 받을 수 있습니다.

```bash
curl -H "Authorization: Bearer $ADMIN_EXPORT_TOKEN" \
  https://chulgeun-dojang.risingdream.workers.dev/admin/export.csv \
  -o attendance.csv
```

## 배포

```bash
export PATH="/home/risingdream/.bun/bin:$PATH"

# 실제 운영 배포: Cloudflare 로그인 또는 CLOUDFLARE_API_TOKEN 필요
bunx wrangler d1 create chulgeun-dojang --location apac
bunx wrangler d1 execute chulgeun-dojang --remote --file migrations/0001_initial.sql
bunx wrangler d1 execute chulgeun-dojang --remote --file migrations/0002_workspace_owner_pin.sql
bunx wrangler secret put QR_SECRET
bunx wrangler secret put ADMIN_EXPORT_TOKEN
bun run deploy

# 인증 전 임시 테스트 배포
bunx wrangler deploy --temporary --config wrangler.temp.jsonc
```

## 라이선스

AGPL-3.0-or-later
