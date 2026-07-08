# 데이터 설계

## 원칙

- 큐알 토큰 자체는 저장하지 않는다.
- 원문 휴대폰 번호는 저장하지 않는다.
- 출퇴근 기록은 덮어쓰지 않는다.
- 정정도 이벤트로 남긴다.

## 최소 테이블

```sql
workspaces(id, name, latitude, longitude, radius_meters, owner_email_hash, created_at)
employees(id, workspace_id, name, employee_code_hash, phone_hash, status, created_at, registered_at)
employee_credentials(id, employee_id, credential_id, public_key, device_name, user_agent_hash, created_at, revoked_at, last_seen_at)
kiosks(id, workspace_id, name, public_key, status, created_at, last_seen_at)
attendance_events(id, workspace_id, employee_id, kiosk_id, event_type, occurred_at, latitude, longitude, accuracy_meters, qr_nonce_hash, risk_flags_json, prev_hash, event_hash)
correction_events(id, attendance_event_id, actor_id, reason, patch_json, created_at)
```

## 중복 방지

```sql
CREATE UNIQUE INDEX attendance_employee_qr_once
ON attendance_events(employee_id, event_type, qr_nonce_hash);
```

전역 1회 큐알 모드를 쓰면 아래 테이블을 추가한다.

```sql
CREATE TABLE qr_consumptions(
  qr_nonce_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kiosk_id TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  employee_id TEXT NOT NULL
);
```
