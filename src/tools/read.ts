import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CashCtrlClient, periodForDate } from "../client.ts";
import { RESOURCE_NAMES, RESOURCES } from "../resources.ts";
import { renderList, renderValue, type Row, shapeRow } from "../format.ts";
import { defineTool, text } from "./util.ts";

const FilterSchema = z.object({
  field: z.string().describe("Column to filter on, e.g. `nr` or `dateAdded`."),
  comparison: z.enum(["eq", "like", "gt", "lt"]).default("like"),
  value: z.string(),
});

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

async function labelsFor(
  client: CashCtrlClient,
  resource: string,
): Promise<ReadonlyMap<string, string> | undefined> {
  const type = RESOURCES[resource]?.customFieldType;
  return type ? await client.customFieldLabels(type) : undefined;
}

export function registerReadTools(
  server: McpServer,
  client: CashCtrlClient,
): void {
  const lang = client.config.lang;
  const resourceEnum = z.enum(RESOURCE_NAMES as [string, ...string[]]);
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

  defineTool(server, "list_records", {
    title: "List CashCtrl records",
    description:
      "Lists records of one resource. Returns a compact column subset by " +
      'default; pass `fields` to choose columns or `["*"]` for everything. ' +
      "Always reports `total` and, when more remain, `next_start`.\n\n" +
      "Resources:\n" +
      RESOURCE_NAMES.map((n) => `- ${n}: ${RESOURCES[n].description}`).join(
        "\n",
      ),
    annotations: readOnly,
    inputSchema: {
      resource: resourceEnum,
      query: z.string().optional().describe("Fulltext search."),
      filter: z.array(FilterSchema).optional().describe(
        "Column filters, ANDed together.",
      ),
      fields: z.array(z.string()).optional().describe(
        'Columns to return, or ["*"] for all.',
      ),
      fiscalPeriodId: z.number().int().optional().describe(
        "Period to read from. Defaults to the organisation's current period, " +
          "which may not be this year — check `fiscalperiod` first.",
      ),
      sort: z.string().optional(),
      dir: z.enum(["ASC", "DESC"]).optional(),
      limit: z.number().int().min(1).max(500).default(25),
      start: z.number().int().min(0).default(0),
    },
  }, async (args) => {
    const def = RESOURCES[args.resource];
    const params: Record<string, unknown> = {
      limit: args.limit,
      start: args.start,
      query: args.query,
      filter: args.filter?.length ? args.filter : undefined,
      sort: args.sort,
      dir: args.dir,
    };
    if (def.fiscalPeriod && args.fiscalPeriodId !== undefined) {
      params.fiscalPeriodId = args.fiscalPeriodId;
    }

    const { data, total } = await client.listWithTotal<Row>(
      `${def.base}/list.json`,
      params,
    );
    const customLabels = await labelsFor(client, args.resource);
    const fields = args.fields ?? def.defaultFields;
    return text(renderList({
      resource: args.resource,
      total,
      start: args.start,
      rows: data.map((row) => shapeRow(row, { lang, fields, customLabels })),
      notes: args.fields
        ? undefined
        : ["Default column subset. Pass `fields` for others."],
    }));
  });

  defineTool(server, "get_record", {
    title: "Read one CashCtrl record",
    description:
      "Reads a single record by id, with every field. Use `list_records` to " +
      "find the id first.",
    annotations: readOnly,
    inputSchema: {
      resource: resourceEnum,
      id: z.number().int(),
      fields: z.array(z.string()).optional(),
    },
  }, async (args) => {
    const def = RESOURCES[args.resource];
    if (def.listOnly) {
      throw new Error(
        `${args.resource} has no read endpoint; use list_records.`,
      );
    }
    const row = await client.read<Row>(`${def.base}/read.json`, {
      id: args.id,
    });
    const customLabels = await labelsFor(client, args.resource);
    return text(
      renderValue(shapeRow(row, { lang, fields: args.fields, customLabels })),
    );
  });

  const SEARCHABLE = ["person", "order", "article", "account", "journal"];

  defineTool(server, "search", {
    title: "Search across CashCtrl",
    description:
      "Runs one fulltext query against people, orders, articles, accounts and " +
      "journal entries, and returns the top hits per resource. Use it to " +
      "locate something whose resource is not yet known.",
    annotations: readOnly,
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(5).describe(
        "Hits per resource.",
      ),
    },
  }, async (args) => {
    const groups: Row = {};
    // Sequential on purpose: CashCtrl publishes no rate limit and only says
    // to put delays between requests, so a five-way fan-out stays polite.
    for (const resource of SEARCHABLE) {
      const def = RESOURCES[resource];
      const { data, total } = await client.listWithTotal<Row>(
        `${def.base}/list.json`,
        { query: args.query, limit: args.limit },
      );
      if (!total) continue;
      const customLabels = await labelsFor(client, resource);
      groups[resource] = {
        total,
        rows: data.map((row) =>
          shapeRow(row, { lang, fields: def.defaultFields, customLabels })
        ),
      };
    }
    return text(
      Object.keys(groups).length
        ? renderValue(groups)
        : `No hits for "${args.query}".`,
    );
  });

  defineTool(server, "list_open_invoices", {
    title: "List open or overdue invoices",
    description:
      "Orders that are still open, optionally only overdue ones. `open` is " +
      "the amount still unpaid.",
    annotations: readOnly,
    inputSchema: {
      type: z.enum(["SALES", "PURCHASE"]).default("SALES"),
      onlyOverdue: z.boolean().default(false),
      personId: z.number().int().optional(),
      fiscalPeriodId: z.number().int().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      start: z.number().int().min(0).default(0),
    },
  }, async (args) => {
    const { data, total } = await client.listWithTotal<Row>(
      "/api/v1/order/list.json",
      {
        type: args.type,
        onlyOpen: true,
        onlyOverdue: args.onlyOverdue || undefined,
        personId: args.personId,
        fiscalPeriodId: args.fiscalPeriodId,
        limit: args.limit,
        start: args.start,
        sort: "dateDue",
        dir: "ASC",
      },
    );
    const fields = [
      ...RESOURCES.order.defaultFields,
      "description",
    ];
    return text(renderList({
      resource: "order",
      total,
      start: args.start,
      rows: data.map((row) => shapeRow(row, { lang, fields })),
    }));
  });

  defineTool(server, "get_journal", {
    title: "Read journal entries",
    description:
      "Journal entries for a date range, optionally restricted to one account " +
      "or associate. Both dates are inclusive. The fiscal period is taken " +
      "from `fromDate` unless `fiscalPeriodId` overrides it.",
    annotations: readOnly,
    inputSchema: {
      fromDate: DATE.optional(),
      toDate: DATE.optional(),
      accountId: z.number().int().optional(),
      associateId: z.number().int().optional(),
      fiscalPeriodId: z.number().int().optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(50),
      start: z.number().int().min(0).default(0),
    },
  }, async (args) => {
    // `gt`/`lt` on a date column include the boundary day — measured against a
    // live organisation, not documented — so the bounds pass through unshifted.
    const filter = [
      ...(args.fromDate
        ? [{ field: "dateAdded", comparison: "gt", value: args.fromDate }]
        : []),
      ...(args.toDate
        ? [{ field: "dateAdded", comparison: "lt", value: args.toDate }]
        : []),
    ];

    // Without a period, this answers from whichever one a human last selected
    // in the UI, so a January 2026 range silently comes back full of 2025.
    const notes: string[] = [];
    let fiscalPeriodId = args.fiscalPeriodId;
    if (fiscalPeriodId === undefined && (args.fromDate || args.toDate)) {
      const periods = await client.fiscalPeriods();
      const from = periodForDate(periods, args.fromDate ?? args.toDate!);
      fiscalPeriodId = from.id;
      notes.push(`Read from fiscal period ${from.name} (id ${from.id}).`);
      if (args.toDate) {
        const to = periodForDate(periods, args.toDate);
        if (to.id !== from.id) {
          notes.push(
            `${args.toDate} is in period ${to.name} (id ${to.id}), so entries ` +
              `after ${from.end.slice(0, 10)} are missing. Query each period ` +
              `separately.`,
          );
        }
      }
    }

    const { data, total } = await client.listWithTotal<Row>(
      "/api/v1/journal/list.json",
      {
        accountId: args.accountId,
        associateId: args.associateId,
        fiscalPeriodId,
        query: args.query,
        filter: filter.length ? filter : undefined,
        limit: args.limit,
        start: args.start,
        sort: "dateAdded",
        dir: "ASC",
      },
    );
    const customLabels = await labelsFor(client, "journal");
    return text(renderList({
      resource: "journal",
      total,
      start: args.start,
      notes: notes.length ? notes : undefined,
      rows: data.map((row) =>
        shapeRow(row, {
          lang,
          fields: RESOURCES.journal.defaultFields,
          customLabels,
        })
      ),
    }));
  });

  defineTool(server, "get_account_balance", {
    title: "Get an account balance",
    description:
      "Balance of one account at a date. The date decides which fiscal " +
      "period is used, so historical balances need no period switch. A date " +
      "in no fiscal period is refused, because CashCtrl would answer 0.",
    annotations: readOnly,
    inputSchema: {
      accountNumber: z.string().optional().describe(
        'Account number as shown in the chart, e.g. "1020".',
      ),
      accountId: z.number().int().optional(),
      date: DATE.optional().describe(
        "Defaults to the last day of the organisation's current period.",
      ),
    },
  }, async (args) => {
    if (!args.accountId && !args.accountNumber) {
      throw new Error("Pass accountId or accountNumber.");
    }

    const notes: string[] = [];
    const periods = await client.fiscalPeriods();
    if (args.date) {
      const period = periodForDate(periods, args.date);
      notes.push(
        `Date falls in fiscal period ${period.name} (id ${period.id}).`,
      );
    } else {
      const current = periods.find((p) => p.isCurrent);
      notes.push(
        current
          ? `No date given, so this is the end of the organisation's ` +
            `current period, ${current.name} (${current.end.slice(0, 10)}).`
          : "No date given; CashCtrl used its current fiscal period.",
      );
    }

    let id = args.accountId;
    let label = `account ${id}`;
    if (!id) {
      const { data } = await client.listWithTotal<Row>(
        "/api/v1/account/list.json",
        {
          filter: [{
            field: "number",
            comparison: "eq",
            value: args.accountNumber,
          }],
          limit: 2,
        },
      );
      if (data.length !== 1) {
        throw new Error(
          `Account number ${args.accountNumber} matched ${data.length} ` +
            `accounts; pass accountId instead.`,
        );
      }
      id = data[0].id as number;
      label = `account ${args.accountNumber}`;
    }

    const balance = await client.get<number>("/api/v1/account/balance", {
      id,
      date: args.date,
    });
    return text(
      renderValue({ account: label, id, date: args.date, balance }, notes),
    );
  });
}
