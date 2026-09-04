import { assertEquals, assertThrows } from "@std/assert";
import {
  DateOutsideFiscalPeriodError,
  type FiscalPeriod,
  periodForDate,
} from "../src/client.ts";

const periods: FiscalPeriod[] = [
  {
    id: 1,
    name: "2025",
    start: "2025-01-01",
    end: "2025-12-31",
    isCurrent: true,
  },
  { id: 2, name: "2026", start: "2026-01-01", end: "2026-12-31" },
];

Deno.test("a date picks its own period, current or not", () => {
  assertEquals(periodForDate(periods, "2026-09-04").id, 2);
  assertEquals(periodForDate(periods, "2025-01-01").id, 1);
  assertEquals(periodForDate(periods, "2025-12-31").id, 1);
});

Deno.test("a date in no period is refused, since CashCtrl would answer 0", () => {
  const err = assertThrows(
    () => periodForDate(periods, "2024-12-31"),
    DateOutsideFiscalPeriodError,
  );
  assertEquals(err.message.includes("2025 (2025-01-01..2025-12-31)"), true);
});

Deno.test("timestamps in start/end do not break the comparison", () => {
  const withTime: FiscalPeriod[] = [
    {
      id: 9,
      name: "2026",
      start: "2026-01-01 00:00:00",
      end: "2026-12-31 00:00:00",
    },
  ];
  assertEquals(periodForDate(withTime, "2026-06-30").id, 9);
});
