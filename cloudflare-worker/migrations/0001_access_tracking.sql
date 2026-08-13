
CREATE TABLE IF NOT EXISTS issued_urls (id TEXT PRIMARY KEY, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS visitors (url_id TEXT NOT NULL, device_id TEXT NOT NULL, company TEXT NOT NULL, person TEXT NOT NULL, device_type TEXT NOT NULL, first_access INTEGER NOT NULL, last_access INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (url_id, device_id));
CREATE INDEX IF NOT EXISTS idx_visitors_last_access ON visitors(last_access DESC);
