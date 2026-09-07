import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseSync } from "node:sqlite";
import type { CashCtrlClient } from "../client.ts";
import { PolicyError } from "../policy.ts";
import { renderValue, type Row } from "../format.ts";
import { canonical, openDatabase, sha256 } from "../backup/db.ts";
import { defineTool, text } from "./util.ts";

/** Resources that exist once, independent of the fiscal period. */
const GLOBAL: Record<string, string> = {
  persons: "/api/v1/person/list.json",
  person_categories: "/api/v1/person/category/list.json",
  person_titles: "/api/v1/person/title/list.json",
  articles: "/api/v1/inventory/article/list.json",
  article_categories: "/api/v1/inventory/article/category/list.json",
  units: "/api/v1/inventory/unit/list.json",
  asset_categories: "/api/v1/inventory/asset/category/list.json",
  files: "/api/v1/file/list.json",
  file_categories: "/api/v1/file/category/list.json",
  taxes: "/api/v1/tax/list.json",
  currencies: "/api/v1/currency/list.json",
  locations: "/api/v1/location/list.json",
  texts: "/api/v1/text/list.json",
  roundings: "/api/v1/rounding/list.json",
  sequence_numbers: "/api/v1/sequencenumber/list.json",
  account_categories: "/api/v1/account/category/list.json",
  order_categories: "/api/v1/order/category/list.json",
  order_layouts: "/api/v1/order/layout/list.json",
  fiscal_periods: "/api/v1/fiscalperiod/list.json",
  history: "/api/v1/history/list.json",
  salary_types: "/api/v1/salary/type/list.json",
  salary_settings: "/api/v1/salary/setting/list.json",
};

/** Resources whose contents depend on the fiscal period. */
const PER_PERIOD: Record<string, string> = {
  accounts: "/api/v1/account/list.json",
  cost_centers: "/api/v1/account/costcenter/list.json",
  journal: "/api/v1/journal/list.json",
  orders: "/api/v1/order/list.json",
  assets: "/api/v1/inventory/asset/list.json",
  imports: "/api/v1/journal/import/list.json",
  salary_statements: "/api/v1/salary/statement/list.json",
};

const CUSTOM_FIELD_TYPES = [
  "JOURNAL",
  "ACCOUNT",
  "INVENTORY_ARTICLE",
  "INVENTORY_ASSET",
  "ORDER",
  "PERSON",
  "FILE",
  "SALARY_STATEMENT",
];

interface Tally {
  seen: number;
  created: number;
  changed: number;
  gone: number;
}

/**
 * Writes one resource's rows as versions, closing the previous version only
 * where the content hash moved. Ids that vanished are marked gone, which is the
 * only way a deletion becomes visible — no `lastUpdated` filter can show one.
 */
async function syncResource(
  db: DatabaseSync,
  resource: string,
  periodId: number,
  rows: Row[],
  now: string,
  tally: Tally,
): Promise<Set<number>> {
  const current = new Map<number, { rowid: number; hash: string }>();
  for (
    const row of db.prepare(
      `SELECT rowid, entity_id, hash FROM entity
        WHERE resource = ? AND period_id = ? AND gone_at IS NULL`,
    ).all(resource, periodId) as Row[]
  ) {
    current.set(Number(row.entity_id), {
      rowid: Number(row.rowid),
      hash: String(row.hash),
    });
  }

  const close = db.prepare("UPDATE entity SET gone_at = ? WHERE rowid = ?");
  const insert = db.prepare(
    `INSERT INTO entity
       (resource, entity_id, period_id, hash, doc, first_seen)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const changedIds = new Set<number>();
  const seenIds = new Set<number>();

  for (const row of rows) {
    const id = Number(row.id ?? 0);
    if (!id) continue;
    seenIds.add(id);
    tally.seen += 1;
    const doc = canonical(row);
    const hash = await sha256(doc);
    const existing = current.get(id);
    // An unchanged row is left alone entirely: rewriting it every run is what
    // makes the file grow without anything having happened.
    if (!existing) {
      insert.run(resource, id, periodId, hash, doc, now);
      tally.created += 1;
      changedIds.add(id);
    } else if (existing.hash !== hash) {
      close.run(now, existing.rowid);
      insert.run(resource, id, periodId, hash, doc, now);
      tally.changed += 1;
      changedIds.add(id);
    }
  }

  for (const [id, existing] of current) {
    if (!seenIds.has(id)) {
      close.run(now, existing.rowid);
      tally.gone += 1;
    }
  }
  return changedIds;
}

export function registerBackupTools(
  server: McpServer,
  client: CashCtrlClient,
): void {
  const defaultDb = () =>
    `${
      client.config.downloadDir.replace(/\/+$/, "")
    }/cashctrl-${client.config.organisation}.db`;

  defineTool(server, "create_backup", {
    title: "Back up the organisation incrementally",
    description:
      "Syncs every readable entity into a SQLite database, writing a new " +
      "version of a record only when its contents actually change. Re-runs " +
      "are cheap: unchanged files are not downloaded again.\n\n" +
      "The version history this builds up is the record-level history the " +
      "CashCtrl API does not keep — query it with `backup_changes`.\n\n" +
      "This is an archive for reading and auditing, not a restore point: ids " +
      "do not round-trip, creates consume sequence numbers, and closed " +
      "periods reject writes. Generated invoice PDFs are excluded, because " +
      "fetching one appends a DOWNLOAD entry to the history log; reading file " +
      "contents does not.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      dbPath: z.string().optional().describe(
        "Defaults to <CASHCTRL_DOWNLOAD_DIR>/cashctrl-<org>.db.",
      ),
      fiscalPeriodIds: z.array(z.number().int()).optional(),
      includeFiles: z.boolean().default(true),
      throttleMs: z.number().int().min(0).max(5000).default(200),
    },
  }, async (args) => {
    const path = args.dbPath ?? defaultDb();
    // `dirname`, not a lastIndexOf slice: "backup.db" would otherwise
    // create a directory called "backup.d".
    await mkdir(dirname(path), { recursive: true });
    const db = openDatabase(path);
    const now = new Date().toISOString();
    const tally: Tally = { seen: 0, created: 0, changed: 0, gone: 0 };
    const skipped: Row[] = [];
    let filesFetched = 0;
    let bytesFetched = 0;

    const pause = () =>
      args.throttleMs
        ? new Promise((r) => setTimeout(r, args.throttleMs))
        : Promise.resolve();

    db.prepare(
      "INSERT INTO run (organisation, started_at) VALUES (?, ?)",
    ).run(client.config.organisation, now);
    const runId = Number(
      (db.prepare("SELECT last_insert_rowid() AS id").get() as Row).id,
    );

    const fetchList = async (
      name: string,
      path: string,
      params: Row,
    ): Promise<Row[] | undefined> => {
      try {
        const { data } = await client.listWithTotal<Row>(path, {
          limit: 2000,
          ...params,
        });
        return data;
      } catch (err) {
        skipped.push({
          resource: name,
          reason: err instanceof PolicyError
            ? "not permitted in this configuration"
            : err instanceof Error
            ? err.message
            : String(err),
        });
        return undefined;
      } finally {
        await pause();
      }
    };

    try {
      for (const [name, endpoint] of Object.entries(GLOBAL)) {
        const rows = await fetchList(name, endpoint, {});
        if (rows) await syncResource(db, name, 0, rows, now, tally);
      }

      const customFields: Row[] = [];
      for (const type of CUSTOM_FIELD_TYPES) {
        try {
          const { data } = await client.listWithTotal<Row>(
            "/api/v1/customfield/list.json",
            { type },
          );
          customFields.push(...data.map((f) => ({ ...f, type })));
        } catch { /* a type with no fields is not an error */ }
        await pause();
      }
      await syncResource(db, "custom_fields", 0, customFields, now, tally);

      const periods = await client.fiscalPeriods();
      for (const id of args.fiscalPeriodIds ?? periods.map((p) => p.id)) {
        for (const [name, endpoint] of Object.entries(PER_PERIOD)) {
          const rows = await fetchList(name, endpoint, { fiscalPeriodId: id });
          if (!rows) continue;
          const changed = await syncResource(db, name, id, rows, now, tally);

          // Line items live only on `read`, so fetch them for the orders whose
          // list row actually moved rather than for all of them.
          if (name === "orders" && changed.size) {
            const details: Row[] = [];
            for (const orderId of changed) {
              try {
                details.push(
                  await client.read<Row>("/api/v1/order/read.json", {
                    id: orderId,
                  }),
                );
              } catch { /* absence is recorded by the missing version */ }
              await pause();
            }
            await syncResource(db, "orders_detail", id, details, now, tally);
          }
          if (name === "imports") {
            const entries: Row[] = [];
            for (const record of rows) {
              try {
                const { data } = await client.listWithTotal<Row>(
                  "/api/v1/journal/import/entry/list.json",
                  { importId: record.id as number, limit: 2000 },
                );
                entries.push(...data);
              } catch { /* same */ }
              await pause();
            }
            await syncResource(db, "import_entries", id, entries, now, tally);
          }
        }
      }

      if (args.includeFiles) {
        const files = await fetchList("files", "/api/v1/file/list.json", {}) ??
          [];
        const currentFiles = new Map<number, { rowid: number; hash: string }>();
        for (
          const row of db.prepare(
            "SELECT rowid, file_id, hash FROM file_version WHERE gone_at IS NULL",
          ).all() as Row[]
        ) {
          currentFiles.set(Number(row.file_id), {
            rowid: Number(row.rowid),
            hash: String(row.hash),
          });
        }
        const seen = new Set<number>();

        for (const file of files) {
          const id = Number(file.id ?? 0);
          if (!id) continue;
          seen.add(id);
          // The list row changes whenever the file does, so an unchanged row
          // means the bytes are already stored and need no second download.
          const metaHash = await sha256(
            canonical({
              size: file.size,
              name: file.name,
              lastUpdated: file.lastUpdated,
              mimeType: file.mimeType,
            }),
          );
          const existing = currentFiles.get(id);
          if (existing && existing.hash === metaHash) {
            db.prepare("UPDATE file_version SET last_seen = ? WHERE rowid = ?")
              .run(now, existing.rowid);
            continue;
          }
          try {
            const response = await client.raw("/api/v1/file/get", { id });
            const bytes = new Uint8Array(await response.arrayBuffer());
            const blobHash = await sha256(bytes);
            db.prepare(
              "INSERT OR IGNORE INTO blob (hash, size, mime, bytes) VALUES (?, ?, ?, ?)",
            ).run(
              blobHash,
              bytes.length,
              response.headers.get("content-type") ?? null,
              bytes,
            );
            if (existing) {
              db.prepare("UPDATE file_version SET gone_at = ? WHERE rowid = ?")
                .run(now, existing.rowid);
            }
            db.prepare(
              `INSERT INTO file_version (file_id, hash, name, first_seen, last_seen)
               VALUES (?, ?, ?, ?, ?)`,
            ).run(id, metaHash, String(file.name ?? ""), now, now);
            filesFetched += 1;
            bytesFetched += bytes.length;
          } catch (err) {
            skipped.push({
              resource: `file ${id}`,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
          await pause();
        }

        for (const [id, existing] of currentFiles) {
          if (!seen.has(id)) {
            db.prepare("UPDATE file_version SET gone_at = ? WHERE rowid = ?")
              .run(now, existing.rowid);
          }
        }
      }

      db.prepare(
        `UPDATE run SET finished_at = ?, seen = ?, created = ?, changed = ?,
           gone = ?, files_fetched = ?, bytes_fetched = ?, skipped = ?
         WHERE id = ?`,
      ).run(
        new Date().toISOString(),
        tally.seen,
        tally.created,
        tally.changed,
        tally.gone,
        filesFetched,
        bytesFetched,
        JSON.stringify(skipped),
        runId,
      );

      const size = (await stat(path)).size;
      const runs = Number(
        (db.prepare("SELECT COUNT(*) AS n FROM run").get() as Row).n,
      );
      return text(renderValue({
        database: path,
        run: runId,
        totalRuns: runs,
        entities: tally,
        files: { fetched: filesFetched, bytes: bytesFetched },
        databaseBytes: size,
        skipped,
      }));
    } finally {
      db.close();
    }
  });

  defineTool(server, "backup_changes", {
    title: "What changed between backups",
    description:
      "Queries the backup database for records that were created, changed or " +
      "removed, with each field's previous and new value. This is the only " +
      "way to see what a booking looked like before it was edited, since " +
      "CashCtrl keeps no record-level history of its own.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      dbPath: z.string().optional(),
      since: z.string().optional().describe(
        "ISO timestamp or date; defaults to the previous run.",
      ),
      until: z.string().optional(),
      resource: z.string().optional().describe("e.g. `journal` or `orders`."),
      entityId: z.number().int().optional().describe(
        "Full version history of one record.",
      ),
      limit: z.number().int().min(1).max(500).default(100),
    },
  }, (args) => {
    const path = args.dbPath ?? defaultDb();
    const db = openDatabase(path);
    try {
      if (args.entityId !== undefined) {
        const versions = db.prepare(
          `SELECT resource, period_id, first_seen, gone_at, doc FROM entity
            WHERE entity_id = ? ${args.resource ? "AND resource = ?" : ""}
            ORDER BY first_seen`,
        ).all(
          ...(args.resource ? [args.entityId, args.resource] : [args.entityId]),
        ) as Row[];
        return Promise.resolve(text(renderValue({
          entityId: args.entityId,
          versions: versions.map((v) => ({
            resource: v.resource,
            from: v.first_seen,
            to: v.gone_at ?? "current",
            doc: JSON.parse(String(v.doc)),
          })),
        })));
      }

      const since = args.since ??
        String(
          (db.prepare(
            "SELECT started_at FROM run WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1 OFFSET 1",
          ).get() as Row | undefined)?.started_at ?? "0000",
        );
      const until = args.until ?? "9999";
      const clause = args.resource ? "AND resource = ?" : "";
      const bind = (extra: string[]): string[] =>
        args.resource ? [...extra, args.resource] : extra;

      const appeared = db.prepare(
        `SELECT resource, entity_id, period_id, first_seen, doc FROM entity
          WHERE first_seen > ? AND first_seen <= ? ${clause}
          ORDER BY first_seen LIMIT ?`,
      ).all(...bind([since, until]), args.limit) as Row[];

      const closed = db.prepare(
        `SELECT resource, entity_id, period_id, gone_at, doc FROM entity
          WHERE gone_at > ? AND gone_at <= ? ${clause}
          ORDER BY gone_at LIMIT ?`,
      ).all(...bind([since, until]), args.limit) as Row[];

      const priorOf = new Map<string, Row>();
      for (const row of closed) {
        priorOf.set(`${row.resource}|${row.entity_id}|${row.period_id}`, row);
      }

      const changes: Row[] = [];
      for (const row of appeared) {
        const key = `${row.resource}|${row.entity_id}|${row.period_id}`;
        const prior = priorOf.get(key);
        const doc = JSON.parse(String(row.doc)) as Row;
        if (!prior) {
          changes.push({
            resource: row.resource,
            id: row.entity_id,
            change: "created",
            at: row.first_seen,
          });
          continue;
        }
        priorOf.delete(key);
        const before = JSON.parse(String(prior.doc)) as Row;
        const fields: Row = {};
        for (
          const field of new Set([...Object.keys(before), ...Object.keys(doc)])
        ) {
          // lastUpdated moves whenever anything else does, so on its own it is
          // noise rather than a change worth reporting.
          if (field === "lastUpdated" || field === "lastUpdatedBy") continue;
          if (JSON.stringify(before[field]) !== JSON.stringify(doc[field])) {
            fields[field] = { from: before[field], to: doc[field] };
          }
        }
        changes.push({
          resource: row.resource,
          id: row.entity_id,
          change: "changed",
          at: row.first_seen,
          fields,
        });
      }
      for (const [, row] of priorOf) {
        changes.push({
          resource: row.resource,
          id: row.entity_id,
          change: "removed",
          at: row.gone_at,
          was: JSON.parse(String(row.doc)),
        });
      }

      return Promise.resolve(text(renderValue({
        database: path,
        since,
        until,
        changes,
      })));
    } finally {
      db.close();
    }
  });
}
