import { assertEquals } from "@std/assert";
import {
  endpoints,
  findEndpoint,
  normalizePath,
  searchEndpoints,
} from "../src/spec.ts";

Deno.test("the vendored index covers the whole API", () => {
  assertEquals(endpoints.length, 376);
});

Deno.test("path lookup accepts both forms", () => {
  assertEquals(normalizePath("account/list.json"), "/api/v1/account/list.json");
  assertEquals(findEndpoint("account/list.json")?.method, "GET");
  assertEquals(findEndpoint("/api/v1/order/create.json")?.method, "POST");
  assertEquals(findEndpoint("nope/nope.json"), undefined);
});

Deno.test("search ranks the obvious endpoint first", () => {
  assertEquals(
    searchEndpoints("list orders")[0].path,
    "/api/v1/order/list.json",
  );
  assertEquals(
    searchEndpoints("exchange rate")[0].path.includes("exchangerate"),
    true,
  );
});

Deno.test("every term must match, so noise is excluded", () => {
  assertEquals(searchEndpoints("order zzzzz").length, 0);
});
