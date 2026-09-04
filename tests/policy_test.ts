import { assertEquals, assertThrows } from "@std/assert";
import { assertAllowed, PolicyError } from "../src/policy.ts";
import type { Config } from "../src/config.ts";

const base: Config = {
  organisation: "testorg",
  apiKey: "secret",
  lang: "de",
  mode: "read",
  downloadDir: "/tmp",
  enableSalary: false,
};

Deno.test("GETs that mutate state are refused in every mode", () => {
  for (const mode of ["read", "write"] as const) {
    for (
      const path of [
        "/api/v1/sequencenumber/get",
        "/api/v1/fiscalperiod/reopen_months.json",
        "/api/v1/fiscalperiod/switch.json",
      ]
    ) {
      assertThrows(
        () => assertAllowed({ ...base, mode }, "GET", path),
        PolicyError,
      );
    }
  }
});

Deno.test("writes need write mode", () => {
  assertThrows(
    () => assertAllowed(base, "POST", "/api/v1/order/create.json"),
    PolicyError,
    "read mode",
  );
  assertAllowed(
    { ...base, mode: "write" },
    "POST",
    "/api/v1/order/create.json",
  );
});

Deno.test("the salary module is off unless enabled", () => {
  assertThrows(
    () => assertAllowed(base, "GET", "/api/v1/salary/statement/list.json"),
    PolicyError,
    "salary module",
  );
  assertAllowed(
    { ...base, enableSalary: true },
    "GET",
    "/api/v1/salary/statement/list.json",
  );
});

Deno.test("ordinary reads pass", () => {
  assertEquals(
    assertAllowed(base, "GET", "/api/v1/account/list.json"),
    undefined,
  );
});
