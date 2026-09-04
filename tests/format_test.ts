import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  compact,
  MAX_RESULT_CHARS,
  parseCustom,
  renderList,
  shapeRow,
} from "../src/format.ts";

Deno.test("projects to the requested columns and always keeps id", () => {
  const row = { id: 7, number: "1020", name: "UBS", notes: "x", created: "y" };
  assertEquals(shapeRow(row, { lang: "de", fields: ["number", "name"] }), {
    number: "1020",
    name: "UBS",
    id: 7,
  });
});

Deno.test("resolves localized XML to the configured language", () => {
  const row = { id: 1, name: "<values><de>Kasse</de><en>Cash</en></values>" };
  assertEquals(shapeRow(row, { lang: "en", fields: ["name"] }).name, "Cash");
  assertEquals(shapeRow(row, { lang: "de", fields: ["name"] }).name, "Kasse");
});

Deno.test("custom fields are parsed and labelled", () => {
  const xml = "<values><customField3>Blau</customField3></values>";
  assertEquals(parseCustom(xml), { customField3: "Blau" });
  assertEquals(
    parseCustom(xml, new Map([["customField3", "Farbe"]])),
    { Farbe: "Blau" },
  );
  assertEquals(parseCustom("plain text"), undefined);
});

Deno.test("custom XML entities are unescaped", () => {
  assertEquals(
    parseCustom(
      "<values><customField1>a &amp; b &lt;c&gt;</customField1></values>",
    ),
    { customField1: "a & b <c>" },
  );
});

Deno.test("empty values are dropped so wide entities stay readable", () => {
  assertEquals(compact({ a: 1, b: null, c: "", d: undefined, e: [], f: 0 }), {
    a: 1,
    f: 0,
  });
});

Deno.test("list envelope reports total and where to resume", () => {
  const body = renderList({
    resource: "order",
    total: 412,
    start: 25,
    rows: [{ id: 1 }, { id: 2 }],
  });
  const parsed = JSON.parse(body);
  assertEquals(parsed.total, 412);
  assertEquals(parsed.returned, 2);
  assertEquals(parsed.next_start, 27);
});

Deno.test("no next_start once the list is exhausted", () => {
  const parsed = JSON.parse(
    renderList({
      resource: "tax",
      total: 2,
      start: 0,
      rows: [{ id: 1 }, { id: 2 }],
    }),
  );
  assertEquals(parsed.next_start, undefined);
});

Deno.test("oversized results are cut here, and say so", () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({
    id: i,
    blob: "x".repeat(500),
  }));
  const body = renderList({ resource: "order", total: 400, start: 0, rows });
  const parsed = JSON.parse(body);
  assertEquals(body.length <= MAX_RESULT_CHARS, true);
  assertEquals(parsed.rows.length < 400, true);
  assertStringIncludes(parsed.notes.join(" "), "Truncated to");
});

Deno.test("localized blobs embedded in a larger string are resolved", () => {
  const row = {
    id: 1,
    debitName:
      "1100 <values><de>Debitoren</de><en>Accounts receivable</en></values>",
  };
  assertEquals(
    shapeRow(row, { lang: "de", fields: ["debitName"] }).debitName,
    "1100 Debitoren",
  );
  assertEquals(
    shapeRow(row, { lang: "en", fields: ["debitName"] }).debitName,
    "1100 Accounts receivable",
  );
});
