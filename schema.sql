-- 출근도장 D1 schema
-- 원칙: 출퇴근 기록은 덮어쓰지 않고 이벤트로만 쌓는다.

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  radius_meters INTEGER NOT NULL DEFAULT 50,
  owner_email_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  employee_code_hash TEXT NOT NULL,
  phone_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  registered_at TEXT,
  UNIQUE (workspace_id, employee_code_hash),
  UNIQUE (workspace_id, phone_hash)
);

CREATE TABLE IF NOT EXISTS employee_credentials (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  device_name TEXT,
  user_agent_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT,
  last_seen_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_one_active_credential
ON employee_credentials(employee_id)
WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS kiosks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  public_key TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS attendance_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  kiosk_id TEXT NOT NULL REFERENCES kiosks(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('clock_in', 'clock_out', 'break_start', 'break_end')),
  occurred_at TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  accuracy_meters REAL,
  qr_nonce_hash TEXT NOT NULL,
  risk_flags_json TEXT NOT NULL DEFAULT '[]',
  prev_hash TEXT,
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (employee_id, event_type, qr_nonce_hash)
);

CREATE INDEX IF NOT EXISTS attendance_workspace_occurred_at
ON attendance_events(workspace_id, occurred_at);

CREATE TABLE IF NOT EXISTS correction_events (
  id TEXT PRIMARY KEY,
  attendance_event_id TEXT NOT NULL REFERENCES attendance_events(id),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 큐알은 기본적으로 전역 1회 사용한다.
CREATE TABLE IF NOT EXISTS qr_consumptions (
  qr_nonce_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kiosk_id TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  employee_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS qr_consumptions_workspace_consumed_at
ON qr_consumptions(workspace_id, consumed_at);
