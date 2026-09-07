/**
 * The write tools, against an in-memory transport.
 *
 * The behaviour worth pinning is not "does a POST go out" — `call_api` already
 * did that. It is the two things these tools exist to prevent: an update that
 * silently clears the fields it was not asked about, and a write that goes out
 * before anyone has seen what it would do.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CashCtrlHttp } from "@zweiundeins/cashctrl-ts-sdk";
import { CashCtrlClient } from "../src/client.ts";
import { createServer } from "../src/server.ts";
import type { Config } from "../src/config.ts";

const config: Config = {
  organisation: "testorg",
  apiKey: "secret",
  lang: "en",
  mode: "write",
  downloadDir: "/tmp",
  enableSalary: false,
};

interface Call {
  method: string;
  path: string;
  params: Record<string, string>;
}

/**
 * A person whose read returns far more fields than any caller would resend by
 * hand — which is the whole point of the merge under test.
 */
const PERSON = {
  id: 7,
  company: "ACME AG",
  firstName: "Ada",
  lastName: "Lovelace",
  categoryId: 3,
  notes: "long-standing customer",
  isInactive: false,
  created: "2020-01-01 00:00:00.0",
  createdBy: "someone",
};

function harness(): {
  client: Client;
  calls: Call[];
  close: () => Promise<void>;
} {
  const calls: Call[] = [];
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body;
    const params: Record<string, string> = {};
    if (body instanceof URLSearchParams) {
      for (const [k, v] of body) params[k] = v;
    }
    for (const [k, v] of url.searchParams) params[k] = v;
    calls.push({ method, path: url.pathname, params });

    const json = (value: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    if (url.pathname === "/api/v1/person/read.json") {
      return json({ data: PERSON });
    }
    if (url.pathname === "/api/v1/account/list.json") {
      return json({
        data: [
          { id: 3, number: "1020", name: "Bank" },
          { id: 9, number: "3000", name: "Revenue" },
        ],
        total: 2,
      });
    }
    if (url.pathname === "/api/v1/fiscalperiod/list.json") {
      return json({
        data: [{
          id: 1,
          name: "2026",
          start: "2026-01-01 00:00:00.0",
          end: "2026-12-31 23:59:59.0",
          isCurrent: true,
        }],
        total: 1,
      });
    }
    return json({ success: true, insertId: 42, message: "ok" });
  };

  const client = new Client({ name: "test", version: "0" });
  const server = createServer(
    new CashCtrlClient(
      config,
      new CashCtrlHttp({ ...config, fetch: fetchImpl, retry: { attempts: 0 } }),
    ),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const ready = Promise.all([server.connect(b), client.connect(a)]);
  return {
    client,
    calls,
    close: async () => {
      await ready;
      await client.close();
      await server.close();
    },
  };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  return {
    text: (result.content as { text: string }[])[0].text,
    isError: result.isError === true,
  };
}

Deno.test("nothing is written without confirm", async () => {
  const h = harness();
  const { text } = await call(h.client, "create_record", {
    resource: "person",
    values: { company: "New AG", firstName: "A", lastName: "B" },
  });
  assertStringIncludes(text, "would_call");
  assertEquals(
    h.calls.filter((c) => c.method === "POST").length,
    0,
    "preview must not POST",
  );
  await h.close();
});

Deno.test("update resends the fields it was not asked to change", async () => {
  const h = harness();
  await call(h.client, "update_record", {
    resource: "person",
    id: 7,
    changes: { lastName: "Byron" },
    confirm: true,
  });

  const post = h.calls.find((c) =>
    c.method === "POST" && c.path === "/api/v1/person/update.json"
  );
  assert(post, "expected an update POST");
  assertEquals(post.params.lastName, "Byron");
  // The point of the tool: these were never mentioned by the caller and must
  // survive, because CashCtrl treats an omitted parameter as an empty value.
  assertEquals(post.params.company, "ACME AG");
  assertEquals(post.params.firstName, "Ada");
  assertEquals(post.params.notes, "long-standing customer");
  assertEquals(post.params.categoryId, "3");
  // Read-only fields are not echoed back: they are not update parameters.
  assertEquals(post.params.created, undefined);
  assertEquals(post.params.createdBy, undefined);
  await h.close();
});

Deno.test("a field the endpoint does not document is refused, not ignored", async () => {
  const h = harness();
  const { text, isError } = await call(h.client, "update_record", {
    resource: "person",
    id: 7,
    changes: { lastNmae: "typo" },
    confirm: true,
  });
  assert(isError);
  assertStringIncludes(text, "lastNmae");
  assertEquals(h.calls.filter((c) => c.method === "POST").length, 0);
  await h.close();
});

Deno.test("missing mandatory params are named before anything is sent", async () => {
  const h = harness();
  const { text, isError } = await call(h.client, "create_record", {
    resource: "person",
    values: { company: "New AG" },
    confirm: true,
  });
  assert(isError);
  assertStringIncludes(text, "firstName");
  assertEquals(h.calls.filter((c) => c.method === "POST").length, 0);
  await h.close();
});

Deno.test("journal entries resolve account numbers to ids", async () => {
  const h = harness();
  await call(h.client, "book_journal_entry", {
    debitAccount: "1020",
    creditAccount: "3000",
    amount: 250,
    date: "2026-03-04",
    title: "Consulting",
    confirm: true,
  });
  const post = h.calls.find((c) => c.path === "/api/v1/journal/create.json");
  assert(post, "expected a journal POST");
  assertEquals(post.params.debitId, "3");
  assertEquals(post.params.creditId, "9");
  assertEquals(post.params.amount, "250");
  assertEquals(post.params.dateAdded, "2026-03-04");
  await h.close();
});

Deno.test("a date in no fiscal period is refused rather than booked", async () => {
  const h = harness();
  const { isError, text } = await call(h.client, "book_journal_entry", {
    debitAccount: "1020",
    creditAccount: "3000",
    amount: 250,
    date: "2019-03-04",
    title: "Consulting",
    confirm: true,
  });
  assert(isError);
  assertStringIncludes(text, "fiscal period");
  assertEquals(h.calls.filter((c) => c.method === "POST").length, 0);
  await h.close();
});

Deno.test("an unknown account number is refused rather than guessed", async () => {
  const h = harness();
  const { isError, text } = await call(h.client, "book_journal_entry", {
    debitAccount: "9999",
    creditAccount: "3000",
    amount: 250,
    date: "2026-03-04",
    title: "Consulting",
    confirm: true,
  });
  assert(isError);
  assertStringIncludes(text, "9999");
  await h.close();
});

Deno.test("write tools are absent in read mode", async () => {
  const readClient = new Client({ name: "test", version: "0" });
  const server = createServer(
    new CashCtrlClient(
      { ...config, mode: "read" },
      new CashCtrlHttp({
        ...config,
        fetch: () => Promise.reject(new Error("no")),
      }),
    ),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await readClient.connect(a);
  const { tools } = await readClient.listTools();
  const names = tools.map((t: { name: string }) => t.name);
  for (
    const name of [
      "create_record",
      "update_record",
      "delete_record",
      "book_journal_entry",
    ]
  ) {
    assertEquals(names.includes(name), false, `${name} must not be offered`);
  }
  await readClient.close();
  await server.close();
});
