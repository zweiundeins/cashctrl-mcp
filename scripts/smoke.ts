/**
 * Exercises the read tools against a live organisation, read-only.
 *
 * Every call goes through the MCP client so the transport, schemas and policy
 * are covered too, not just the CashCtrl calls underneath.
 *
 * Run: deno task smoke   (needs .env with CASHCTRL_ORGANISATION and _APIKEY)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.ts";
import { CashCtrlClient } from "../src/client.ts";
import { createServer } from "../src/server.ts";

const config = loadConfig();
if (config.mode !== "read") {
  console.error("smoke test refuses to run outside read mode");
  Deno.exit(2);
}

const server = createServer(new CashCtrlClient(config));
const client = new Client({ name: "smoke", version: "0" });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
await client.connect(clientSide);

const { tools } = await client.listTools();
console.log(`tools: ${tools.length}`);

async function show(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const body = (result.content as { text: string }[])[0].text;
  const head = body.length > 700 ? body.slice(0, 700) + "\n  …" : body;
  console.log(
    `\n--- ${name} ${JSON.stringify(args)}${result.isError ? "  [error]" : ""}`,
  );
  console.log(head.split("\n").map((l) => "  " + l).join("\n"));
}

await show("list_records", { resource: "fiscalperiod", limit: 5 });
await show("list_records", { resource: "account", limit: 3, query: "1020" });
await show("get_account_balance", {
  accountNumber: "1020",
  date: "2026-09-04",
});
await show("get_account_balance", {
  accountNumber: "1020",
  date: "2024-12-31",
});
await show("list_open_invoices", { limit: 3 });
await show("get_journal", {
  fromDate: "2026-01-01",
  toDate: "2026-01-31",
  limit: 3,
});
await show("search_api", { query: "vat report", limit: 3 });
await show("list_records", { resource: "salary_statement", limit: 1 });

await client.close();
await server.close();
