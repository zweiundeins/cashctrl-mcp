import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CashCtrlClient, periodForDate } from "../client.ts";
import { localizeDeep, renderValue, type Row } from "../format.ts";
import { defineTool, text } from "./util.ts";

interface TreeNode extends Row {
  text?: string;
  data?: TreeNode[];
  elementId?: number | null;
  collectionId?: number | null;
  type?: string | null;
  leaf?: boolean;
}

interface Column {
  title?: string;
  dataIndex?: string;
}

/** Collections hold elements; only elements can be rendered. */
function flattenTree(nodes: TreeNode[], out: Row[] = [], parent = ""): Row[] {
  for (const node of nodes) {
    const name = node.text ?? "";
    if (node.elementId != null) {
      out.push({
        elementId: node.elementId,
        name,
        type: node.type ?? undefined,
        collection: parent || undefined,
      });
    }
    if (Array.isArray(node.data)) {
      flattenTree(node.data, out, node.elementId == null ? name : parent);
    }
  }
  return out;
}

/**
 * Report rows are a tree of 30-plus display fields per node, half of them
 * `dc`-prefixed duplicates. `properties.columns` says which ones the report
 * actually renders and what to call them, so follow that instead of guessing.
 */
function flattenRows(
  nodes: TreeNode[],
  columns: Column[],
  depth = 0,
  out: Row[] = [],
): Row[] {
  for (const node of nodes) {
    const row: Row = { level: depth, text: node.text ?? "" };
    for (const column of columns) {
      const key = column.dataIndex;
      if (!key || key === "text" || node[key] === undefined) continue;
      row[column.title || key] = node[key];
    }
    if (node.accountId != null) row.accountId = node.accountId;
    out.push(row);
    if (Array.isArray(node.data)) {
      flattenRows(node.data, columns, depth + 1, out);
    }
  }
  return out;
}

export function registerReportTools(
  server: McpServer,
  client: CashCtrlClient,
): void {
  const lang = client.config.lang;

  defineTool(server, "get_report", {
    title: "Read a CashCtrl report",
    description:
      "Without `elementId`, lists the available reports (balance sheet, " +
      "profit and loss, VAT settlement, and so on). With one, returns that " +
      "report's figures for a fiscal period or date range.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      elementId: z.number().int().optional().describe(
        "Report to render. Omit to list what exists.",
      ),
      fiscalPeriodId: z.number().int().optional().describe(
        "Overrides startDate/endDate. Defaults to the organisation's current " +
          "period, which may not be this year.",
      ),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    },
  }, async (args) => {
    if (args.elementId === undefined) {
      const tree = await client.get<{ data?: TreeNode[] } | TreeNode[]>(
        "/api/v1/report/tree.json",
      );
      const nodes = Array.isArray(tree) ? tree : tree.data ?? [];
      return text(renderValue(localizeDeep(flattenTree(nodes), lang)));
    }

    const notes: string[] = [];
    // Dates outside every period do not error here either; they just produce
    // an empty report, which reads as "no activity".
    const periods = await client.fiscalPeriods();
    for (
      const [label, date] of [
        ["startDate", args.startDate],
        ["endDate", args.endDate],
      ] as const
    ) {
      if (date) {
        notes.push(`${label} is in ${periodForDate(periods, date).name}.`);
      }
    }
    if (!args.fiscalPeriodId && !args.startDate && !args.endDate) {
      const current = periods.find((p) => p.isCurrent);
      if (current) {
        notes.push(
          `No period given, so this is the organisation's current one, ` +
            `${current.name} (id ${current.id}).`,
        );
      }
    }

    const body = await client.get<{
      data?: TreeNode[];
      properties?: { columns?: Column[] };
    }>("/api/v1/report/element/data.json", {
      elementId: args.elementId,
      fiscalPeriod: args.fiscalPeriodId,
      startDate: args.startDate,
      endDate: args.endDate,
      language: lang,
    });

    const columns = body.properties?.columns ?? [];
    const rows = flattenRows(body.data ?? [], columns);
    return text(renderValue(
      localizeDeep({
        elementId: args.elementId,
        columns: columns
          .filter((c) => c.dataIndex && c.dataIndex !== "text")
          .map((c) => c.title ?? c.dataIndex),
        rows,
      }, lang),
      notes.length ? notes : undefined,
    ));
  });
}
