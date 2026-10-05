-- Legacy credentials require local reprovisioning; legacy sessions are revoked.
ALTER TABLE administrator RENAME TO administrator_legacy;
--> statement-breakpoint
CREATE TABLE administrator (
  id INTEGER PRIMARY KEY NOT NULL,
  username TEXT NOT NULL,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  hash_version TEXT NOT NULL DEFAULT 'legacy-disabled',
  CONSTRAINT single_administrator CHECK (id = 1)
);
--> statement-breakpoint
INSERT INTO administrator (id, username, salt, hash)
SELECT id, username, salt, hash FROM administrator_legacy WHERE id = 1;
--> statement-breakpoint
DROP TABLE administrator_legacy;
--> statement-breakpoint
DROP TABLE sessions;
--> statement-breakpoint
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  credential_version TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_sessions_expires ON sessions (expires);
--> statement-breakpoint
CREATE UNIQUE INDEX sessions_session_id_unique ON sessions (session_id);
--> statement-breakpoint
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  session_id TEXT,
  detail TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_audit_at ON audit_log (at);
--> statement-breakpoint
CREATE TABLE content_backups (
  revision INTEGER PRIMARY KEY NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  action TEXT NOT NULL
);
