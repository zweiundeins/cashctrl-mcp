import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CashCtrlClient } from "../client.ts";
import { renderList, type Row, stripHtml } from "../format.ts";
import { defineTool, text } from "./util.ts";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** Observed on a live organisation; the API documents none of them. */
const TYPES = [
  "ORDER",
  "BOOK_ENTRY",
  "COLLECTIVE_ENTRY",
  "SALARY_STATEMENT",
  "SALARY_CERTIFICATE",
  "JOURNAL_IMPORT",
  "PERSON",
  "PERSON_CATEGORY",
  "PERSON_TITLE",
  "ACCOUNT",
  "BANK_ACCOUNT",
  "TAX_RATE",
  "FISCAL_PERIOD",
  "FILE",
  "FILE_CATEGORY",
  "INVENTORY_ARTICLE",
  "INVENTORY_ARTICLE_CATEGORY",
  "INVENTORY_UNIT",
  "LOCATION",
  "TEXT_TEMPLATE",
  "ORDER_LAYOUT",
  "REPORT_ELEMENT",
  "REPORT_COLLECTION",
  "SEQUENCE_NUMBER",
  "CUSTOM_FIELD",
];

const CHANGE_TYPES = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "STATUS",
  "IMPORTED",
  "DOWNLOAD",
  "SEND",
];

interface HistoryRow extends Row {
  id: number;
  created?: string;
  createdBy?: string;
  type?: string;
  changeType?: string;
  message?: string;
  orderId?: number | null;
  personId?: number | null;
  statementId?: number | null;
}

export function registerHistoryTools(
  server: McpServer,
  client: CashCtrlClient,
): void {
  defineTool(server, "get_history", {
    title: "Read the change history",
    description:
      "CashCtrl's activity log: who created, changed, deleted, re-statused, " +
      "imported, downloaded or sent what, and when. Good for reconstructing " +
      "what a past close or correction actually involved.\n\n" +
      "It is an activity log, not a diff: an UPDATE says a record changed, " +
      "not which field or from what value.\n\n" +
      `Types: ${TYPES.join(", ")}.\n` +
      `Change types: ${CHANGE_TYPES.join(", ")}.`,
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      fromDate: DATE.optional(),
      toDate: DATE.optional(),
      type: z.string().optional().describe("Entity type, e.g. BOOK_ENTRY."),
      changeType: z.string().optional().describe("e.g. DELETE or STATUS."),
      createdBy: z.string().optional().describe(
        'User, or "SYSTEM" for automatic changes. API keys appear as "API:xxxx".',
      ),
      orderId: z.number().int().optional(),
      personId: z.number().int().optional(),
      statementId: z.number().int().optional(),
      query: z.string().optional().describe("Fulltext over the message."),
      limit: z.number().int().min(1).max(500).default(100),
      start: z.number().int().min(0).default(0),
    },
  }, async (args) => {
    const filter = [
      // `created` carries a timestamp, and the bounds include their own day.
      ...(args.fromDate
        ? [{ field: "created", comparison: "gt", value: args.fromDate }]
        : []),
      ...(args.toDate
        ? [{ field: "created", comparison: "lt", value: args.toDate }]
        : []),
      ...(args.type
        ? [{ field: "type", comparison: "eq", value: args.type }]
        : []),
      ...(args.changeType
        ? [{ field: "changeType", comparison: "eq", value: args.changeType }]
        : []),
      ...(args.createdBy
        ? [{ field: "createdBy", comparison: "eq", value: args.createdBy }]
        : []),
    ];

    const { data, total } = await client.listWithTotal<HistoryRow>(
      "/api/v1/history/list.json",
      {
        filter: filter.length ? filter : undefined,
        orderId: args.orderId,
        personId: args.personId,
        statementId: args.statementId,
        query: args.query,
        limit: args.limit,
        start: args.start,
        dir: "ASC",
      },
    );

    const byType: Record<string, number> = {};
    const byChange: Record<string, number> = {};
    const byUser: Record<string, number> = {};
    const rows = data.map((entry) => {
      byType[entry.type ?? "?"] = (byType[entry.type ?? "?"] ?? 0) + 1;
      byChange[entry.changeType ?? "?"] =
        (byChange[entry.changeType ?? "?"] ?? 0) + 1;
      byUser[entry.createdBy ?? "?"] = (byUser[entry.createdBy ?? "?"] ?? 0) +
        1;
      return {
        at: entry.created?.slice(0, 16),
        by: entry.createdBy,
        type: entry.type,
        change: entry.changeType,
        what: entry.message ? stripHtml(entry.message) : undefined,
        orderId: entry.orderId ?? undefined,
        personId: entry.personId ?? undefined,
        statementId: entry.statementId ?? undefined,
      };
    });

    return text(renderList({
      resource: "history",
      total,
      start: args.start,
      rows,
      notes: [
        `By type: ${JSON.stringify(byType)}`,
        `By change: ${JSON.stringify(byChange)}`,
        `By user: ${JSON.stringify(byUser)}`,
      ],
    }));
  });
}
