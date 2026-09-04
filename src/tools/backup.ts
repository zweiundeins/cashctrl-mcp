import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CashCtrlClient } from "../client.ts";
import { PolicyError } from "../policy.ts";
import { renderValue, type Row } from "../format.ts";
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

/** Stable key order, so two snapshots diff cleanly in git or by eye. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

function byId(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
}

function safeName(name: string, fallback: string): string {
  const cleaned = (name.split(/[\\/]/).pop() ?? "")
    .replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").trim();
  return cleaned.length ? cleaned.slice(0, 120) : fallback;
}

export function registerBackupTools(
  server: McpServer,
  client: CashCtrlClient,
): void {
  defineTool(server, "create_backup", {
    title: "Back up the organisation",
    description:
      "Writes every readable entity to a timestamped directory as JSON, " +
      "optionally with the file manager's contents — which includes the " +
      "original bank statement files imports were made from.\n\n" +
      "This is an archive for reading, auditing and diffing, not a restore " +
      "point: ids do not round-trip, creates consume sequence numbers, and " +
      "closed periods reject writes. Nothing here can be pushed back.\n\n" +
      "Generated invoice PDFs are deliberately excluded, because fetching one " +
      "appends a DOWNLOAD entry to the history log. Reading file contents " +
      "does not.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      outputDir: z.string().optional().describe(
        "Defaults to <CASHCTRL_DOWNLOAD_DIR>/backup.",
      ),
      fiscalPeriodIds: z.array(z.number().int()).optional().describe(
        "Defaults to every fiscal period.",
      ),
      includeFiles: z.boolean().default(true),
      throttleMs: z.number().int().min(0).max(5000).default(200).describe(
        "Pause between requests. CashCtrl publishes no rate limit.",
      ),
    },
  }, async (args) => {
    const started = new Date();
    const stamp = started.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const root = `${
      (args.outputDir ?? `${client.config.downloadDir}/backup`)
        .replace(/\/+$/, "")
    }/${client.config.organisation}/${stamp}`;

    const counts: Record<string, number> = {};
    const skipped: Row[] = [];
    const pause = () =>
      args.throttleMs
        ? new Promise((r) => setTimeout(r, args.throttleMs))
        : Promise.resolve();

    const write = async (relative: string, body: unknown) => {
      const path = `${root}/${relative}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(
        path,
        JSON.stringify(stable(body), null, 1) + "\n",
      );
    };

    /** A denied or failing resource is recorded, never fatal to the run. */
    const collect = async (
      name: string,
      path: string,
      params: Row,
      relative: string,
    ): Promise<Row[]> => {
      try {
        const { data } = await client.listWithTotal<Row>(path, {
          limit: 2000,
          ...params,
        });
        await write(relative, byId(data));
        counts[name] = (counts[name] ?? 0) + data.length;
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
        return [];
      } finally {
        await pause();
      }
    };

    for (const [name, path] of Object.entries(GLOBAL)) {
      await collect(name, path, {}, `master/${name}.json`);
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
    await write("master/custom_fields.json", byId(customFields));
    counts.custom_fields = customFields.length;

    const periods = await client.fiscalPeriods();
    const wanted = args.fiscalPeriodIds ?? periods.map((p) => p.id);

    for (const id of wanted) {
      for (const [name, path] of Object.entries(PER_PERIOD)) {
        const rows = await collect(
          name,
          path,
          { fiscalPeriodId: id },
          `period-${id}/${name}.json`,
        );

        // Order line items only exist on `read`, and staged entries only on
        // the import they belong to; both are the point of the backup.
        if (name === "orders") {
          const details: Row[] = [];
          for (const order of rows) {
            try {
              details.push(
                await client.read<Row>("/api/v1/order/read.json", {
                  id: order.id as number,
                }),
              );
            } catch { /* recorded by its absence from the detail file */ }
            await pause();
          }
          await write(`period-${id}/orders_detail.json`, byId(details));
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
          await write(`period-${id}/import_entries.json`, byId(entries));
          counts.import_entries = (counts.import_entries ?? 0) + entries.length;
        }
      }
    }

    let fileBytes = 0;
    let fileCount = 0;
    if (args.includeFiles) {
      const { data } = await client.listWithTotal<Row>(
        "/api/v1/file/list.json",
        {
          limit: 2000,
        },
      );
      await pause();
      await Deno.mkdir(`${root}/files`, { recursive: true });
      for (const file of data) {
        try {
          const response = await client.raw("/api/v1/file/get", {
            id: file.id,
          });
          const bytes = new Uint8Array(await response.arrayBuffer());
          const name = safeName(String(file.name ?? ""), `file-${file.id}`);
          await Deno.writeFile(`${root}/files/${file.id}-${name}`, bytes);
          fileBytes += bytes.length;
          fileCount += 1;
        } catch (err) {
          skipped.push({
            resource: `file ${file.id}`,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
        await pause();
      }
    }

    const manifest = {
      organisation: client.config.organisation,
      generatedAt: started.toISOString(),
      finishedAt: new Date().toISOString(),
      language: client.config.lang,
      fiscalPeriods: periods.map((p) => ({
        id: p.id,
        name: p.name,
        start: String(p.start).slice(0, 10),
        end: String(p.end).slice(0, 10),
        isClosed: p.isClosed,
      })),
      periodsBackedUp: wanted,
      counts,
      files: {
        included: args.includeFiles,
        count: fileCount,
        bytes: fileBytes,
      },
      skipped,
      notes: [
        "Archive only: this cannot be restored into CashCtrl.",
        "Generated invoice PDFs are excluded; fetching them would append " +
        "DOWNLOAD entries to the history log.",
        "Record-level history is not available from the API, so diffing two " +
        "snapshots is the only way to see what changed.",
      ],
    };
    await write("manifest.json", manifest);

    return text(renderValue({
      path: root,
      entities: Object.values(counts).reduce((a, b) => a + b, 0),
      counts,
      files: manifest.files,
      skipped,
    }));
  });

  defineTool(server, "diff_backups", {
    title: "Compare two backups",
    description:
      "Compares two backup directories and reports what was added, removed " +
      "or changed per resource, field by field. CashCtrl keeps no record-level " +
      "history, so this is the only way to see what a value used to be.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      from: z.string().describe("Path to the older backup directory."),
      to: z.string().describe("Path to the newer backup directory."),
      resource: z.string().optional().describe(
        "Limit to one file, e.g. `period-2/journal`.",
      ),
      limit: z.number().int().min(1).max(500).default(100),
    },
  }, async (args) => {
    const load = async (dir: string): Promise<Map<string, Row[]>> => {
      const out = new Map<string, Row[]>();
      const walk = async (path: string, prefix: string) => {
        for await (const entry of Deno.readDir(path)) {
          const full = `${path}/${entry.name}`;
          const key = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory) {
            if (entry.name !== "files") await walk(full, key);
          } else if (
            entry.name.endsWith(".json") && entry.name !== "manifest.json"
          ) {
            const body = JSON.parse(await Deno.readTextFile(full));
            if (Array.isArray(body)) out.set(key.replace(/\.json$/, ""), body);
          }
        }
      };
      await walk(dir.replace(/\/+$/, ""), "");
      return out;
    };

    const [before, after] = await Promise.all([load(args.from), load(args.to)]);
    const names = [...new Set([...before.keys(), ...after.keys()])]
      .filter((n) => !args.resource || n === args.resource)
      .sort();

    const report: Row[] = [];
    let added = 0, removed = 0, changed = 0;

    for (const name of names) {
      const oldRows = new Map(
        (before.get(name) ?? []).map((r) => [String(r.id), r]),
      );
      const newRows = new Map(
        (after.get(name) ?? []).map((r) => [String(r.id), r]),
      );
      const entries: Row[] = [];

      for (const [id, row] of newRows) {
        const previous = oldRows.get(id);
        if (!previous) {
          added += 1;
          entries.push({ id: row.id, change: "added" });
          continue;
        }
        const fields: Row = {};
        for (
          const key of new Set([...Object.keys(previous), ...Object.keys(row)])
        ) {
          // lastUpdated moves whenever anything else does; it is noise on its own.
          if (key === "lastUpdated" || key === "lastUpdatedBy") continue;
          if (JSON.stringify(previous[key]) !== JSON.stringify(row[key])) {
            fields[key] = { from: previous[key], to: row[key] };
          }
        }
        if (Object.keys(fields).length) {
          changed += 1;
          entries.push({ id: row.id, change: "changed", fields });
        }
      }
      for (const [id, row] of oldRows) {
        if (!newRows.has(id)) {
          removed += 1;
          entries.push({ id: row.id, change: "removed", was: row });
        }
      }

      if (entries.length) {
        report.push({ resource: name, changes: entries.slice(0, args.limit) });
      }
    }

    return text(renderValue({
      from: args.from,
      to: args.to,
      summary: { added, changed, removed },
      resources: report,
    }));
  });
}
