-- 사업자 setup에서 설정한 사장님 PIN 해시를 워크스페이스에 저장한다.
ALTER TABLE workspaces ADD COLUMN owner_pin_hash TEXT;
