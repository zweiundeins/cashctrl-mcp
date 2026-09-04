/**
 * MCP server for the CashCtrl accounting API.
 *
 * Run: deno task start   (see README for configuration)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.ts";
import { CashCtrlClient } from "./client.ts";
import { registerReadTools } from "./tools/read.ts";
import { registerDiscoveryTools } from "./tools/discovery.ts";

export function createServer(client: CashCtrlClient): McpServer {
  const server = new McpServer({
    name: "cashctrl",
    version: "0.1.0",
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
      "column is missing rather than assuming it does not exist.",
  });

  registerReadTools(server, client);
  registerDiscoveryTools(server, client);
  return server;
}

if (import.meta.main) {
  try {
    const config = loadConfig();
    const server = createServer(new CashCtrlClient(config));
    await server.connect(new StdioServerTransport());
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(
        `cashctrl-mcp: ${err.message}\n\n` +
          "Required: CASHCTRL_ORGANISATION, CASHCTRL_APIKEY.\n" +
          "Optional: CASHCTRL_LANG (de), CASHCTRL_MODE (read), " +
          "CASHCTRL_DOWNLOAD_DIR, CASHCTRL_ENABLE_SALARY.",
      );
      Deno.exit(2);
    }
    throw err;
  }
}
