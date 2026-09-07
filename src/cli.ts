/**
 * Entry point for `cashctrl-mcp` and `deno task start`.
 *
 * Separate from server.ts so the server stays importable: `import.meta.main`
 * is a Deno-ism that never fires under Node, and a bin script has to run on
 * import anyway.
 *
 * Wrapped in a function rather than using top-level await, because dnt cannot
 * emit CommonJS from a module that has one, and the library half of this
 * package should stay usable from `require`.
 */

import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CashCtrlClient } from "./client.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createServer } from "./server.ts";

async function main(): Promise<void> {
  const server = createServer(new CashCtrlClient(loadConfig()));
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    // stdout is the MCP transport, so anything meant for a human goes to
    // stderr or it corrupts the protocol stream.
    console.error(
      `cashctrl-mcp: ${err.message}\n\n` +
        "Required: CASHCTRL_ORGANISATION, CASHCTRL_APIKEY.\n" +
        "Optional: CASHCTRL_LANG (de), CASHCTRL_MODE (read), " +
        "CASHCTRL_DOWNLOAD_DIR, CASHCTRL_ENABLE_SALARY.",
    );
    process.exit(2);
  }
  throw err;
});
