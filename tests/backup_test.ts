import { assertEquals, assertStringIncludes } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CashCtrlHttp } from "@zweiundeins/cashctrl-ts-sdk";
import { CashCtrlClient } from "../src/client.ts";
import { createServer } from "../src/server.ts";
import { canonical } from "../src/backup/db.ts";
import type { Config } from "../src/config.ts";

const config: Config = {
  organisation: "testorg",
  apiKey: "secret",
  lang: "de",
  mode: "read",
  downloadDir: "/tmp",
  enableSalary: false,
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

/** One fiscal period and a journal whose contents the test controls. */
function stub(journal: () => unknown[]) {
  return (url: URL): Response => {
    if (url.pathname === "/api/v1/fiscalperiod/list.json") {
      return json({
        data: [{
          id: 1,
          name: "2026",
          start: "2026-01-01",
          end: "2026-12-31",
          isCurrent: true,
        }],
      });
    }
    if (url.pathname === "/api/v1/journal/list.json") {
      return json({ data: journal() });
    }
    return json({ data: [] });
  };
}

async function connect(handler: (url: URL) => Response, dir: string) {
  const http = new CashCtrlHttp({
    organisation: "testorg",
    apiKey: "secret",
    retry: { attempts: 0 },
    fetch: (input) =>
      Promise.resolve(
        handler(input instanceof URL ? input : new URL(String(input))),
      ),
  });
  const server = createServer(
    new CashCtrlClient({ ...config, downloadDir: dir }, http),
  );
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

const body = (result: unknown) =>
  JSON.parse(
    (result as { content: { text: string }[] }).content[0].text,
  );

Deno.test("canonical form is stable regardless of key order", () => {
  assertEquals(
    canonical({ b: 1, a: [2, { d: 4, c: 3 }] }),
    canonical({ a: [2, { c: 3, d: 4 }], b: 1 }),
  );
});

Deno.test("a second run over unchanged data writes nothing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const rows = [{ id: 1, amount: 10, title: "one" }, {
      id: 2,
      amount: 20,
      title: "two",
    }];
    const { client, close } = await connect(stub(() => rows), dir);
    const db = `${dir}/cc.db`;

    const first = body(
      await client.callTool({
        name: "create_backup",
        arguments: { dbPath: db, includeFiles: false, throttleMs: 0 },
      }),
    );
    assertEquals(first.entities.created, 3); // 2 journal rows + 1 fiscal period

    const second = body(
      await client.callTool({
        name: "create_backup",
        arguments: { dbPath: db, includeFiles: false, throttleMs: 0 },
      }),
    );
    assertEquals(second.entities, { seen: 3, created: 0, changed: 0, gone: 0 });
    await close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a changed field becomes a new version, and the old one is kept", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let rows = [{ id: 1, amount: 10, title: "one" }, {
      id: 2,
      amount: 20,
      title: "two",
    }];
    const { client, close } = await connect(stub(() => rows), dir);
    const db = `${dir}/cc.db`;
    const backup = () =>
      client.callTool({
        name: "create_backup",
        arguments: { dbPath: db, includeFiles: false, throttleMs: 0 },
      });

    await backup();
    // Booking 1 is edited, booking 2 is deleted, booking 3 appears.
    rows = [{ id: 1, amount: 99, title: "one corrected" }, {
      id: 3,
      amount: 30,
      title: "three",
    }];
    const second = body(await backup());
    assertEquals(second.entities.changed, 1);
    assertEquals(second.entities.created, 1);
    assertEquals(second.entities.gone, 1);

    const changes = body(
      await client.callTool({
        name: "backup_changes",
        arguments: { dbPath: db, resource: "journal" },
      }),
    ).changes as {
      id: number;
      change: string;
      fields?: Record<string, unknown>;
      was?: Record<string, unknown>;
    }[];

    const edited = changes.find((c) => c.id === 1)!;
    assertEquals(edited.change, "changed");
    assertEquals(edited.fields!.amount, { from: 10, to: 99 });
    assertEquals(changes.find((c) => c.id === 3)!.change, "created");
    const removed = changes.find((c) => c.id === 2)!;
    assertEquals(removed.change, "removed");
    // The deleted booking's contents survive, which CashCtrl itself does not offer.
    assertEquals(removed.was!.amount, 20);
    await close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("one record's full version history can be replayed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let rows = [{ id: 1, amount: 10 }];
    const { client, close } = await connect(stub(() => rows), dir);
    const db = `${dir}/cc.db`;
    const backup = () =>
      client.callTool({
        name: "create_backup",
        arguments: { dbPath: db, includeFiles: false, throttleMs: 0 },
      });

    await backup();
    rows = [{ id: 1, amount: 20 }];
    await backup();
    rows = [{ id: 1, amount: 30 }];
    await backup();

    const history = body(
      await client.callTool({
        name: "backup_changes",
        arguments: { dbPath: db, entityId: 1, resource: "journal" },
      }),
    );
    assertEquals(history.versions.length, 3);
    assertEquals(
      history.versions.map((v: { doc: { amount: number } }) => v.doc.amount),
      [10, 20, 30],
    );
    assertEquals(history.versions[2].to, "current");
    await close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a disabled module is recorded rather than failing the run", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { client, close } = await connect(stub(() => []), dir);
    const result = body(
      await client.callTool({
        name: "create_backup",
        arguments: {
          dbPath: `${dir}/cc.db`,
          includeFiles: false,
          throttleMs: 0,
        },
      }),
    );
    assertStringIncludes(
      JSON.stringify(result.skipped),
      "not permitted in this configuration",
    );
    await close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
