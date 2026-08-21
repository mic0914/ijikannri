CREATE TABLE IF NOT EXISTS visitor_revocations (
  url_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (url_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_visitor_revocations_revoked_at
  ON visitor_revocations(revoked_at DESC);
