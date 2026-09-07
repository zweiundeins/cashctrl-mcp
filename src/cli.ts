/**
 * Entry point for `cashctrl-mcp`, `deno task start`, and the package's default
 * export — `deno run jsr:@zweiundeins/cashctrl-mcp` resolves here. The server
 * itself is the `./server` export, for anyone embedding it.
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

/**
 * `engines` only warns, and `npx -y` runs regardless. The backup tools import
 * node:sqlite at module load, so an older Node fails with
 * ERR_UNKNOWN_BUILTIN_MODULE before anything explains why.
 */
function assertRuntime(): void {
  const major = Number(process.versions.node?.split(".")[0]);
  if (Number.isFinite(major) && major < 24) {
    console.error(
      `cashctrl-mcp needs Node 24 or newer (found ${process.versions.node}). ` +
        `The backup tools use node:sqlite, which older Node versions do not ` +
        `expose without a flag. Upgrade Node, or run the server with Deno.`,
    );
    process.exit(2);
  }
}

async function main(): Promise<void> {
  assertRuntime();
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
