import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CashCtrlClient } from "../client.ts";
import { findEndpoint, normalizePath, searchEndpoints } from "../spec.ts";
import { isAllowed } from "../policy.ts";
import { renderValue } from "../format.ts";
import { defineTool, text } from "./util.ts";

const BINARY_SUFFIX = /\.(pdf|xlsx|csv|zip|vcf|xml|html)$/;
const BINARY_PATHS = new Set([
  "/api/v1/file/get",
  "/api/v1/domain/current/logo",
  "/api/v1/order/payment/download",
  "/api/v1/salary/payment/download",
]);

function returnsFile(path: string): boolean {
  return BINARY_PATHS.has(path) || BINARY_SUFFIX.test(path);
}

export function registerDiscoveryTools(
  server: McpServer,
  client: CashCtrlClient,
): void {
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

  defineTool(server, "search_api", {
    title: "Search the CashCtrl API",
    description:
      "Finds endpoints among all 376 by keyword. Use it when no dedicated " +
      "tool covers what you need, then `describe_endpoint` and `call_api`.",
    annotations: readOnly,
    inputSchema: {
      query: z.string().min(1).describe(
        'Space-separated terms, all of which must match, e.g. "order status".',
      ),
      limit: z.number().int().min(1).max(40).default(15),
    },
  }, (args) => {
    const hits = searchEndpoints(args.query, args.limit);
    if (!hits.length) {
      return Promise.resolve(text(`No endpoint matches "${args.query}".`));
    }
    return Promise.resolve(text(renderValue(hits.map((e) => ({
      method: e.method,
      path: e.path,
      summary: e.summary,
      params: e.params.map((p) => p.required ? `${p.name}*` : p.name),
      allowed: isAllowed(client.config, e.method, e.path),
    })))));
  });

  defineTool(server, "describe_endpoint", {
    title: "Describe a CashCtrl endpoint",
    description:
      "Full parameter documentation for one endpoint. Accepts either " +
      "`account/list.json` or `/api/v1/account/list.json`.",
    annotations: readOnly,
    inputSchema: {
      path: z.string().min(1),
      method: z.enum(["GET", "POST"]).optional(),
    },
  }, (args) => {
    const endpoint = findEndpoint(args.path, args.method);
    if (!endpoint) {
      return Promise.resolve(text(
        `No endpoint at ${normalizePath(args.path)}. Try search_api.`,
      ));
    }
    return Promise.resolve(text(renderValue({
      method: endpoint.method,
      path: endpoint.path,
      summary: endpoint.summary,
      description: endpoint.description,
      group: endpoint.group,
      returnsFile: returnsFile(endpoint.path),
      allowed: isAllowed(client.config, endpoint.method, endpoint.path),
      params: endpoint.params,
    })));
  });

  defineTool(server, "call_api", {
    title: "Call a CashCtrl endpoint",
    description:
      "Calls any endpoint the dedicated tools do not cover. Parameters are " +
      "encoded the way CashCtrl expects (booleans as strings, dates as " +
      "YYYY-MM-DD, arrays as CSV or JSON). Writes need CASHCTRL_MODE=write " +
      "and `confirm: true`.",
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      path: z.string().min(1),
      method: z.enum(["GET", "POST"]).default("GET"),
      params: z.record(z.string(), z.unknown()).default({}),
      confirm: z.boolean().default(false).describe(
        "Required for POST. Creating a record consumes a sequence number " +
          "permanently, even if the record is deleted again.",
      ),
    },
  }, async (args) => {
    const path = normalizePath(args.path);
    const endpoint = findEndpoint(path, args.method);
    if (!endpoint) {
      throw new Error(`No endpoint at ${path}. Try search_api.`);
    }
    if (returnsFile(path)) {
      throw new Error(
        `${path} returns a file, not JSON. File tools land in a later ` +
          `version; use the CashCtrl UI for now.`,
      );
    }
    if (args.method === "POST" && !args.confirm) {
      throw new Error(
        `${path} is a write. Re-issue with confirm: true once you are sure; ` +
          `creates consume a sequence number that deletion does not return.`,
      );
    }

    const body = args.method === "GET"
      ? await client.get<unknown>(path, args.params)
      : await client.post<unknown>(path, args.params);
    return text(renderValue(body));
  });
}
