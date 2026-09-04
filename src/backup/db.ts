import { DatabaseSync } from "node:sqlite";

/**
 * Storage for incremental backups.
 *
 * Entities are kept as JSON documents with a content hash rather than typed
 * columns: CashCtrl adds and renames fields without announcing it, and a rigid
 * schema would break on the next upstream change. A new version row is written
 * only when the hash moves, so this table is the record-level history the API
 * itself does not keep.
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS run (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation  TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  seen          INTEGER NOT NULL DEFAULT 0,
  created       INTEGER NOT NULL DEFAULT 0,
  changed       INTEGER NOT NULL DEFAULT 0,
  gone          INTEGER NOT NULL DEFAULT 0,
  files_fetched INTEGER NOT NULL DEFAULT 0,
  bytes_fetched INTEGER NOT NULL DEFAULT 0,
  skipped       TEXT
);

CREATE TABLE IF NOT EXISTS entity (
  resource     TEXT NOT NULL,
  entity_id    INTEGER NOT NULL,
  period_id    INTEGER NOT NULL DEFAULT 0,
  hash         TEXT NOT NULL,
  doc          TEXT NOT NULL,
  first_seen   TEXT NOT NULL,
  gone_at      TEXT
);
CREATE INDEX IF NOT EXISTS entity_current
  ON entity (resource, entity_id, period_id, gone_at);
CREATE INDEX IF NOT EXISTS entity_seen ON entity (first_seen);

CREATE TABLE IF NOT EXISTS blob (
  hash  TEXT PRIMARY KEY,
  size  INTEGER NOT NULL,
  mime  TEXT,
  bytes BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS file_version (
  file_id    INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  name       TEXT,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  gone_at    TEXT
);
CREATE INDEX IF NOT EXISTS file_current ON file_version (file_id, gone_at);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/** Stable stringify, so an unchanged record hashes the same every run. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function sha256(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
