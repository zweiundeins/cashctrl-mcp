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
    "download_document",
    "get_account_balance",
    "get_fiscal_period_status",
    "get_journal",
    "get_record",
    "get_report",
    "list_open_invoices",
    "list_records",
    "review_bank_import",
    "review_pending_import",
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

Deno.test("reports list, then render through their own column definitions", async () => {
  const { client } = await connect((url) => {
    if (url.pathname === "/api/v1/report/tree.json") {
      return json({
        data: [{
          id: "collection-1",
          text: "Abschluss",
          collectionId: 1,
          data: [
            { id: "element-1", text: "Bilanz", elementId: 1, type: "BALANCE" },
            {
              id: "element-2",
              text: "Erfolgsrechnung",
              elementId: 2,
              type: "PLS",
            },
          ],
        }],
      });
    }
    if (url.pathname === "/api/v1/report/element/data.json") {
      return json({
        properties: {
          columns: [
            { title: "Bezeichnung", dataIndex: "text" },
            { title: "2026", dataIndex: "dcEndAmount" },
          ],
        },
        data: [{
          text: "Ertrag",
          dcEndAmount: 48593.42,
          cls: "category level-0",
          expanded: true,
          data: [{
            text: "Handelsertrag",
            dcEndAmount: 14269.82,
            accountId: 42,
          }],
        }],
      });
    }
    return json({ data: [] });
  });

  const list = JSON.parse(firstText(
    await client.callTool({ name: "get_report", arguments: {} }),
  ));
  assertEquals(list.length, 2);
  assertEquals(list[0], {
    elementId: 1,
    name: "Bilanz",
    type: "BALANCE",
    collection: "Abschluss",
  });

  const report = JSON.parse(firstText(
    await client.callTool({
      name: "get_report",
      arguments: { elementId: 2, fiscalPeriodId: 2 },
    }),
  ));
  assertEquals(report.columns, ["2026"]);
  assertEquals(report.rows[0], { level: 0, text: "Ertrag", "2026": 48593.42 });
  assertEquals(report.rows[1].level, 1);
  assertEquals(report.rows[1].accountId, 42);
});

Deno.test("download_document writes to disk and links the file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { client } = await connect(
      () =>
        new Response("%PDF-1.4 fake", {
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="RE-202601.01.pdf"',
          },
        }),
      { downloadDir: dir },
    );
    const result = await client.callTool({
      name: "download_document",
      arguments: { kind: "order_pdf", ids: [14] },
    });
    const link = (result.content as { type: string; uri?: string }[])
      .find((c) => c.type === "resource_link")!;
    assertEquals(link.uri, `file://${dir}/RE-202601.01.pdf`);
    assertEquals(
      await Deno.readTextFile(`${dir}/RE-202601.01.pdf`),
      "%PDF-1.4 fake",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a server-chosen filename cannot escape the download directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { client } = await connect(
      () =>
        new Response("x", {
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="../../etc/passwd"',
          },
        }),
      { downloadDir: dir },
    );
    const result = await client.callTool({
      name: "download_document",
      arguments: { kind: "order_pdf", ids: [1] },
    });
    const link = (result.content as { type: string; uri?: string }[])
      .find((c) => c.type === "resource_link")!;
    assertStringIncludes(link.uri!, `file://${dir}/`);
    assertEquals(link.uri!.includes(".."), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("salary documents stay behind the module toggle", async () => {
  const { client } = await connect(() => new Response("%PDF"));
  const result = await client.callTool({
    name: "download_document",
    arguments: { kind: "salary_statement_pdf", ids: [1] },
  });
  assertEquals(result.isError, true);
  assertStringIncludes(firstText(result), "salary module");
});

Deno.test("the organisation summary is served as a resource", async () => {
  const { client } = await connect((url) => {
    if (url.pathname === "/api/v1/fiscalperiod/list.json") {
      return PERIODS.clone();
    }
    if (url.pathname === "/api/v1/tax/list.json") {
      return json({ data: [{ id: 9, code: "USt77", currentPercentage: 7.7 }] });
    }
    return json({ data: [] });
  });

  const { resources } = await client.listResources();
  assertEquals(
    resources.map((r: { uri: string }) => r.uri).sort(),
    ["cashctrl://org/chart-of-accounts", "cashctrl://org/summary"],
  );

  const read = await client.readResource({ uri: "cashctrl://org/summary" });
  const body = JSON.parse((read.contents[0] as { text: string }).text);
  assertEquals(body.organisation, "testorg");
  assertEquals(body.fiscalPeriods[1].id, 2);
  assertEquals(body.taxes[0].percentage, 7.7);
});

Deno.test("prompts carry the fiscal-period warning into the workflow", async () => {
  const { client } = await connect(() => json({ data: [] }));
  const prompt = await client.getPrompt({
    name: "monatsabschluss-check",
    arguments: { month: "2026-01" },
  });
  const body = (prompt.messages[0].content as { text: string }).text;
  assertStringIncludes(body, "2026-01");
  assertStringIncludes(body, "nicht");
});

const ACCOUNTS = json({
  data: [
    { id: 3, number: "1020", name: "UBS", accountClass: "ASSET" },
    {
      id: 42,
      number: "3200",
      name: "Handelsertrag",
      accountClass: "REVENUE",
      taxId: 9,
      taxCode: "USt77",
    },
    {
      id: 60,
      number: "6570",
      name: "Informatikaufwand",
      accountClass: "EXPENSE",
    },
  ],
});

/** Two bookings against 3200, one of them a same-day same-amount repeat. */
const IMPORTED = json({
  total: 3,
  data: [
    {
      id: 1,
      dateAdded: "2026-01-05 00:00:00.0",
      amount: 100,
      title: "A",
      debitId: 3,
      creditId: 42,
      taxId: null,
      taxCode: null,
      associateId: 7,
      associateName: "Kunde",
    },
    {
      id: 2,
      dateAdded: "2026-01-05 00:00:00.0",
      amount: 100,
      title: "A again",
      debitId: 3,
      creditId: 42,
      taxId: 9,
      taxCode: "USt77",
      associateId: 7,
      associateName: "Kunde",
    },
    {
      id: 3,
      dateAdded: "2026-02-01 00:00:00.0",
      amount: 50,
      title: "Kamera",
      debitId: 60,
      creditId: 3,
      taxId: null,
      taxCode: null,
      associateId: null,
    },
  ],
});

function reviewStub(url: URL): Response {
  if (url.pathname === "/api/v1/fiscalperiod/list.json") return PERIODS.clone();
  if (url.pathname === "/api/v1/account/list.json") return ACCOUNTS.clone();
  if (url.pathname === "/api/v1/journal/list.json") return IMPORTED.clone();
  if (url.pathname === "/api/v1/journal/import/list.json") {
    return json({
      data: [{ id: 23, description: "statements.zip", created: "2026-06-08" }],
    });
  }
  if (url.pathname === "/api/v1/journal/import/entry/list.json") {
    return json({
      data: [
        { id: 181, imported: false, deleted: true, confirmed: false },
        { id: 182, imported: true, deleted: false, confirmed: true },
      ],
    });
  }
  return json({ data: [] });
}

Deno.test("review_bank_import groups by contra account, bank side inferred", async () => {
  const { client, calls } = await connect(reviewStub);
  const parsed = JSON.parse(firstText(
    await client.callTool({
      name: "review_bank_import",
      arguments: { fromDate: "2026-01-01", toDate: "2026-06-30" },
    }),
  ));

  assertEquals(
    calls.some((c) => c.searchParams.get("onlyImported") === "true"),
    true,
  );
  assertStringIncludes(parsed.notes.join(" "), "1020 UBS");

  // 1020 is on every entry, so it is the bank side and never a contra account.
  const accounts = parsed.value.byContraAccount.map((g: { account: string }) =>
    g.account
  );
  assertEquals(accounts.includes("1020 UBS"), false);
  const revenue = parsed.value.byContraAccount.find((g: { account: string }) =>
    g.account === "3200 Handelsertrag"
  );
  assertEquals(revenue.count, 2);
  assertEquals(revenue.sum, 200);
});

Deno.test("review_bank_import only flags a missing tax code the account expects", async () => {
  const { client } = await connect(reviewStub);
  const parsed = JSON.parse(firstText(
    await client.callTool({
      name: "review_bank_import",
      arguments: { fromDate: "2026-01-01", toDate: "2026-06-30" },
    }),
  ));

  const flags = (id: number) =>
    (parsed.value.flagged.find((f: { id: number }) => f.id === id)?.flags ??
      []) as string[];

  // 3200 defines a default tax code and entry 1 has none.
  assertStringIncludes(flags(1).join(" "), "tax_missing");
  // 6570 defines none, so entry 3 is not nagged about tax, only the associate.
  assertEquals(flags(3).some((f) => f.startsWith("tax_missing")), false);
  assertEquals(flags(3).includes("no_associate"), true);
  // Both entries still count towards the aggregate.
  assertEquals(parsed.value.summary.withoutTaxCode, 2);
});

Deno.test("review_bank_import spots a re-imported statement line", async () => {
  const { client } = await connect(reviewStub);
  const parsed = JSON.parse(firstText(
    await client.callTool({
      name: "review_bank_import",
      arguments: { fromDate: "2026-01-01", toDate: "2026-06-30" },
    }),
  ));
  const dupes = parsed.value.flagged.filter((f: { flags: string[] }) =>
    f.flags.includes("possible_duplicate")
  );
  assertEquals(dupes.map((d: { id: number }) => d.id).sort(), [1, 2]);
});

Deno.test("review_bank_import surfaces entries that were never booked", async () => {
  const { client } = await connect(reviewStub);
  const parsed = JSON.parse(firstText(
    await client.callTool({
      name: "review_bank_import",
      arguments: { fromDate: "2026-01-01", toDate: "2026-06-30" },
    }),
  ));
  assertEquals(parsed.value.unbookedImports, [{
    importId: 23,
    description: "statements.zip",
    created: "2026-06-08",
    staged: 1,
    ignored: 1,
    confirmedNotBooked: 0,
  }]);
});

Deno.test("get_fiscal_period_status reports the result and month state", async () => {
  const { client } = await connect((url) => {
    if (url.pathname === "/api/v1/fiscalperiod/list.json") {
      return PERIODS.clone();
    }
    if (url.pathname === "/api/v1/fiscalperiod/read.json") {
      return json({
        data: {
          id: 2,
          name: "2026",
          start: "2026-01-01 00:00:00.0",
          end: "2026-12-31 23:59:59.0",
          isClosed: false,
          closedMonthIds: ["2026-01"],
          openMonthIds: ["2026-02"],
        },
      });
    }
    if (url.pathname === "/api/v1/fiscalperiod/result") return json(15992);
    return json({ data: [] });
  });

  const parsed = JSON.parse(firstText(
    await client.callTool({
      name: "get_fiscal_period_status",
      arguments: { fiscalPeriodId: 2 },
    }),
  ));
  assertEquals(parsed.result, 15992);
  assertEquals(parsed.name, "2026");
  assertEquals(parsed.closedMonths, ["2026-01"]);
  assertEquals(parsed.pendingDepreciations, 0);
});

Deno.test("the new prompts are registered", async () => {
  const { client } = await connect(() => json({ data: [] }));
  const { prompts } = await client.listPrompts();
  const names = prompts.map((p: { name: string }) => p.name).sort();
  assertEquals(names, [
    "bank-abgleich",
    "jahresabschluss",
    "monatsabschluss-check",
    "mwst-abstimmung",
    "offene-posten",
  ]);
});

/** One staged entry matched to an invoice, one ignored, one already booked. */
function stagingStub(url: URL): Response {
  if (url.pathname === "/api/v1/fiscalperiod/list.json") return PERIODS.clone();
  if (url.pathname === "/api/v1/account/list.json") return ACCOUNTS.clone();
  if (url.pathname === "/api/v1/journal/import/list.json") {
    return json({
      data: [{
        id: 18,
        description: "statements.zip",
        created: "2026-06-08",
        targetAccountId: 3,
      }],
    });
  }
  if (url.pathname === "/api/v1/journal/import/read.json") {
    return json({
      data: { id: 18, description: "statements.zip", targetAccountId: 3 },
    });
  }
  if (url.pathname === "/api/v1/journal/import/entry/list.json") {
    return json({
      total: 3,
      data: [
        {
          id: 116,
          dateAdded: "2026-05-20 00:00:00.0",
          amount: 4852.35,
          title: "Zahlung",
          reference: "RE-202601.01",
          debitId: 3,
          creditId: 42,
          associateName: "moxi AG",
          orderId: 34,
          orderStatusId: 18,
          confirmed: true,
          deleted: false,
          imported: false,
        },
        {
          id: 117,
          dateAdded: "2026-05-21 00:00:00.0",
          amount: 12,
          title: "Spesen",
          debitId: 60,
          creditId: 3,
          deleted: true,
          imported: false,
        },
        {
          id: 118,
          dateAdded: "2026-05-22 00:00:00.0",
          amount: 99,
          title: "Alt",
          debitId: 60,
          creditId: 3,
          imported: true,
        },
      ],
    });
  }
  if (url.pathname === "/api/v1/order/read.json") {
    return json({
      data: {
        id: 34,
        nr: "RE-202601.01",
        associateName: "moxi AG",
        total: 4852.35,
        open: 4852.35,
        statusName: "Offen",
      },
    });
  }
  if (url.pathname === "/api/v1/order/category/read_status.json") {
    return json({ data: { id: 18, name: "Bezahlt", isClosed: true } });
  }
  return json({ data: [] });
}

Deno.test("review_pending_import lists imports that still have unbooked entries", async () => {
  const { client } = await connect(stagingStub);
  const parsed = JSON.parse(firstText(
    await client.callTool({ name: "review_pending_import", arguments: {} }),
  ));
  assertEquals(parsed.pendingImports, [{
    importId: 18,
    description: "statements.zip",
    created: "2026-06-08",
    targetAccount: "1020 UBS",
    staged: 2,
    ignored: 1,
    matchedToOrders: 1,
  }]);
});

Deno.test("review_pending_import names the invoices an execute would close", async () => {
  const { client } = await connect(stagingStub);
  const parsed = JSON.parse(firstText(
    await client.callTool({
      name: "review_pending_import",
      arguments: { importId: 18 },
    }),
  ));

  assertEquals(parsed.value.summary, {
    entries: 3,
    alreadyBooked: 1,
    staged: 1,
    ignored: 1,
    wouldCloseOrders: 1,
  });

  const closing = parsed.value.wouldClose[0];
  assertEquals(closing.entryId, 116);
  assertEquals(closing.matchedOrder.nr, "RE-202601.01");
  assertEquals(closing.matchedOrder.open, 4852.35);
  assertEquals(closing.newStatus, {
    id: 18,
    name: "Bezahlt",
    closesOrder: true,
  });
  assertStringIncludes(parsed.notes.join(" "), "cannot execute");
});

Deno.test("an ignored entry never lands in wouldClose", async () => {
  const { client } = await connect((url) => {
    if (url.pathname === "/api/v1/journal/import/entry/list.json") {
      return json({
        total: 1,
        data: [{
          id: 116,
          dateAdded: "2026-05-20 00:00:00.0",
          amount: 4852.35,
          title: "Zahlung",
          debitId: 3,
          creditId: 42,
          orderId: 34,
          orderStatusId: 18,
          deleted: true,
          imported: false,
        }],
      });
    }
    return stagingStub(url);
  });
  const parsed = JSON.parse(firstText(
    await client.callTool({
      name: "review_pending_import",
      arguments: { importId: 18 },
    }),
  ));
  assertEquals(parsed.value.wouldClose, []);
  assertEquals(
    parsed.value.ignoredWithMatch[0].matchedOrder.nr,
    "RE-202601.01",
  );
});
