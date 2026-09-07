/**
 * MCP server for the CashCtrl accounting API.
 *
 * Run: deno task start   (see README for configuration)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CashCtrlClient } from "./client.ts";
import { VERSION } from "./version.ts";
import { registerReadTools } from "./tools/read.ts";
import { registerDiscoveryTools } from "./tools/discovery.ts";
import { registerReportTools } from "./tools/report.ts";
import { registerDocumentTools } from "./tools/documents.ts";
import { registerReviewTools, registerStagingTools } from "./tools/review.ts";
import { registerHistoryTools } from "./tools/history.ts";
import { registerYearEndTools } from "./tools/yearend.ts";
import { registerBackupTools } from "./tools/backup.ts";
import { registerWriteTools } from "./tools/write.ts";
import { registerResources } from "./context.ts";
import { registerPrompts } from "./prompts.ts";

export function createServer(client: CashCtrlClient): McpServer {
  const server = new McpServer({
    name: "cashctrl",
    version: VERSION,
  }, {
    instructions:
      `CashCtrl accounting for the organisation "${client.config.organisation}", ` +
      `in ${client.config.mode} mode.\n\n` +
      "Notes that change answers:\n" +
      "- The organisation's *current* fiscal period is whatever a human last " +
      "selected, and may not be this year. Check `list_records` on " +
      "`fiscalperiod` before reading anything period-dependent, and pass " +
      "`fiscalPeriodId` explicitly.\n" +
      "- `get_account_balance` picks the period from the date you give it.\n" +
      "- Lists return a column subset by default. Ask for `fields` when a " +
      "column is missing rather than assuming it does not exist.\n" +
      "- The `cashctrl://org/summary` and `cashctrl://org/chart-of-accounts` " +
      "resources answer most setup questions without a tool call.",
  });

  registerReadTools(server, client);
  registerReportTools(server, client);
  registerDocumentTools(server, client);
  registerReviewTools(server, client);
  registerStagingTools(server, client);
  registerHistoryTools(server, client);
  registerYearEndTools(server, client);
  registerBackupTools(server, client);
  // Only in write mode: registering them in read mode would advertise tools
  // whose every call the policy refuses.
  if (client.config.mode === "write") registerWriteTools(server, client);
  registerDiscoveryTools(server, client);
  registerResources(server, client);
  registerPrompts(server);
  return server;
}
