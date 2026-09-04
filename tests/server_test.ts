import { assertEquals, assertStringIncludes } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CashCtrlHttp } from "@zweiundeins/cashctrl-ts-sdk";
import { CashCtrlClient } from "../src/client.ts";
import { createServer } from "../src/server.ts";
import type { Config } from "../src/config.ts";

const config: Config = {
  organisation: "testorg",
  apiKey: "secret",
  lang: "de",
  mode: "read",
  downloadDir: "/tmp",
  enableSalary: false,
};

/** Boots the server against a fetch stub and returns a connected client. */
async function connect(
  handler: (url: URL) => Response,
  overrides: Partial<Config> = {},
) {
  const calls: URL[] = [];
  const http = new CashCtrlHttp({
    organisation: "testorg",
    apiKey: "secret",
    retry: { attempts: 0 },
    fetch: (input) => {
      const url = input instanceof URL ? input : new URL(String(input));
      calls.push(url);
      return Promise.resolve(handler(url));
    },
  });
  const server = createServer(
    new CashCtrlClient({ ...config, ...overrides }, http),
  );
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, calls };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

function firstText(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] })
    .content;
  return content[0].text;
}

Deno.test("the tool surface stays small enough to be usable", async () => {
  const { client } = await connect(() => json({ data: [] }));
  const { tools } = await client.listTools();
  const names = tools.map((t: { name: string }) => t.name).sort();
  assertEquals(names, [
    "call_api",
    "describe_endpoint",
    "get_account_balance",
    "get_journal",
    "get_record",
    "list_open_invoices",
    "list_records",
    "search",
    "search_api",
  ]);
  assertEquals(tools.length < 25, true);
});

Deno.test("list_records projects, paginates and reports the total", async () => {
  const { client, calls } = await connect((url) => {
    if (url.pathname === "/api/v1/account/list.json") {
      return json({
        total: 120,
        data: [{
          id: 3,
          number: "1020",
          name: "<values><de>UBS</de></values>",
          notes: "internal",
          created: "2026-01-01",
        }],
      });
    }
    return json({ data: [] });
  });

  const parsed = JSON.parse(firstText(
    await client.callTool({
      name: "list_records",
      arguments: { resource: "account", limit: 1 },
    }),
  ));
  assertEquals(parsed.total, 120);
  assertEquals(parsed.next_start, 1);
  assertEquals(parsed.rows[0].name, "UBS");
  assertEquals(parsed.rows[0].notes, undefined);
  assertEquals(calls[0].searchParams.get("limit"), "1");
});

Deno.test("a denied resource fails as a result, not a transport error", async () => {
  const { client } = await connect(() => json({ data: [] }));
  const result = await client.callTool({
    name: "list_records",
    arguments: { resource: "salary_statement" },
  });
  assertEquals(result.isError, true);
  assertStringIncludes(firstText(result), "salary module");
});

Deno.test("call_api refuses a write in read mode", async () => {
  const { client } = await connect(() => json({ success: true }));
  const result = await client.callTool({
    name: "call_api",
    arguments: {
      path: "order/create.json",
      method: "POST",
      params: { categoryId: 1 },
      confirm: true,
    },
  });
  assertEquals(result.isError, true);
  assertStringIncludes(firstText(result), "read mode");
});

Deno.test("call_api demands confirmation for a write even in write mode", async () => {
  const { client } = await connect(() => json({ success: true }), {
    mode: "write",
  });
  const result = await client.callTool({
    name: "call_api",
    arguments: { path: "order/create.json", method: "POST", params: {} },
  });
  assertEquals(result.isError, true);
  assertStringIncludes(firstText(result), "confirm: true");
});

Deno.test("call_api will not hand a file body to a JSON parser", async () => {
  const { client } = await connect(() => json({}));
  const result = await client.callTool({
    name: "call_api",
    arguments: { path: "order/document/read.pdf", params: { ids: 1 } },
  });
  assertEquals(result.isError, true);
  assertStringIncludes(firstText(result), "returns a file");
});

Deno.test("get_account_balance refuses a date outside every fiscal period", async () => {
  const { client } = await connect((url) => {
    if (url.pathname === "/api/v1/fiscalperiod/list.json") {
      return json({
        data: [{ id: 1, name: "2025", start: "2025-01-01", end: "2025-12-31" }],
      });
    }
    return json({ data: [] });
  });
  const result = await client.callTool({
    name: "get_account_balance",
    arguments: { accountId: 3, date: "2024-12-31" },
  });
  assertEquals(result.isError, true);
  assertStringIncludes(firstText(result), "falls in no fiscal period");
});

Deno.test("get_account_balance names the period the number came from", async () => {
  const { client } = await connect((url) => {
    if (url.pathname === "/api/v1/fiscalperiod/list.json") {
      return json({
        data: [
          {
            id: 1,
            name: "2025",
            start: "2025-01-01",
            end: "2025-12-31",
            isCurrent: true,
          },
          { id: 2, name: "2026", start: "2026-01-01", end: "2026-12-31" },
        ],
      });
    }
    if (url.pathname === "/api/v1/account/balance") return json(6187.47);
    return json({ data: [] });
  });
  const parsed = JSON.parse(firstText(
    await client.callTool({
      name: "get_account_balance",
      arguments: { accountId: 3, date: "2026-09-04" },
    }),
  ));
  assertEquals(parsed.value.balance, 6187.47);
  assertStringIncludes(parsed.notes[0], "2026");
});

const PERIODS = json({
  data: [
    {
      id: 1,
      name: "2025",
      start: "2025-01-01",
      end: "2025-12-31",
      isCurrent: true,
    },
    { id: 2, name: "2026", start: "2026-01-01", end: "2026-12-31" },
  ],
});

Deno.test("get_journal passes the date bounds through unshifted", async () => {
  const { client, calls } = await connect((url) =>
    url.pathname === "/api/v1/fiscalperiod/list.json"
      ? PERIODS.clone()
      : json({ total: 0, data: [] })
  );
  await client.callTool({
    name: "get_journal",
    arguments: { fromDate: "2026-01-01", toDate: "2026-03-31" },
  });
  const journal = calls.find((c) =>
    c.pathname === "/api/v1/journal/list.json"
  )!;
  assertEquals(JSON.parse(journal.searchParams.get("filter")!), [
    { field: "dateAdded", comparison: "gt", value: "2026-01-01" },
    { field: "dateAdded", comparison: "lt", value: "2026-03-31" },
  ]);
});

Deno.test("get_journal derives the period from the range, not the UI", async () => {
  const { client, calls } = await connect((url) =>
    url.pathname === "/api/v1/fiscalperiod/list.json"
      ? PERIODS.clone()
      : json({ total: 0, data: [] })
  );
  const result = await client.callTool({
    name: "get_journal",
    arguments: { fromDate: "2026-01-01", toDate: "2026-01-31" },
  });
  const journal = calls.find((c) =>
    c.pathname === "/api/v1/journal/list.json"
  )!;
  // The current period is 2025; asking for January 2026 must not read 2025.
  assertEquals(journal.searchParams.get("fiscalPeriodId"), "2");
  assertStringIncludes(JSON.parse(firstText(result)).notes[0], "2026");
});

Deno.test("get_journal says so when the range spans two periods", async () => {
  const { client } = await connect((url) =>
    url.pathname === "/api/v1/fiscalperiod/list.json"
      ? PERIODS.clone()
      : json({ total: 0, data: [] })
  );
  const result = await client.callTool({
    name: "get_journal",
    arguments: { fromDate: "2025-11-01", toDate: "2026-02-01" },
  });
  const notes = JSON.parse(firstText(result)).notes.join(" ");
  assertStringIncludes(notes, "are missing");
});
