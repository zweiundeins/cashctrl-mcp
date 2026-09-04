import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CashCtrlClient, FiscalPeriod } from "../client.ts";
import { localizeDeep, renderValue, type Row } from "../format.ts";
import { defineTool, text } from "./util.ts";

type Status = "ok" | "warn" | "fail" | "info";

interface Check extends Row {
  check: string;
  status: Status;
  detail: string;
}

interface Account extends Row {
  id: number;
  number?: string;
  name?: string;
  accountClass?: string;
  openingAmount?: number;
  endAmount?: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Clearing accounts are a naming convention, not a flag on the account. */
const CLEARING = /durchlauf|ausgleich|verrechnung|transit|clearing|suspense/i;

function sumBy(accounts: Account[], cls: string, field: keyof Account): number {
  return round(
    accounts
      .filter((a) => a.accountClass === cls)
      .reduce((n, a) => n + ((a[field] as number) ?? 0), 0),
  );
}

export function registerYearEndTools(
  server: McpServer,
  client: CashCtrlClient,
): void {
  const lang = client.config.lang;

  defineTool(server, "validate_year_end", {
    title: "Validate a fiscal period for closing",
    description:
      "Runs the arithmetic a year-end close has to satisfy and reports each " +
      "check as ok, warn, fail or info. Covers the balance sheet identity, " +
      "the result, the carry-forward from the previous period, clearing " +
      "accounts, pending depreciations and exchange differences, month " +
      "closing state, and unbooked import entries. Receivables and payables " +
      "are reconciled but reported as info, because credit notes and " +
      "cross-period invoices make an exact match the exception.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      fiscalPeriodId: z.number().int().optional().describe(
        "Defaults to the organisation's current period.",
      ),
      clearingAccounts: z.array(z.string()).optional().describe(
        'Account numbers that must end at zero, e.g. ["2202","2222"]. ' +
          "Without this, accounts are picked by name.",
      ),
      tolerance: z.number().default(0.01).describe(
        "Rounding tolerance for the arithmetic checks.",
      ),
    },
  }, async (args) => {
    const periods = [...await client.fiscalPeriods()]
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const index = args.fiscalPeriodId
      ? periods.findIndex((p) => p.id === args.fiscalPeriodId)
      : periods.findIndex((p) => p.isCurrent);
    if (index < 0) throw new Error("Fiscal period not found.");
    const period: FiscalPeriod = periods[index];
    const previous: FiscalPeriod | undefined = periods[index - 1];
    const end = String(period.end).slice(0, 10);
    const tol = args.tolerance;

    const [accounts, detail, result] = await Promise.all([
      client.listWithTotal<Account>("/api/v1/account/list.json", {
        fiscalPeriodId: period.id,
        limit: 500,
      }).then((r) => r.data),
      client.read<Row>("/api/v1/fiscalperiod/read.json", { id: period.id }),
      client.get<number>("/api/v1/fiscalperiod/result", { id: period.id }),
    ]);

    const assets = sumBy(accounts, "ASSET", "endAmount");
    const liabilities = sumBy(accounts, "LIABILITY", "endAmount");
    const revenue = sumBy(accounts, "REVENUE", "endAmount");
    const expense = sumBy(accounts, "EXPENSE", "endAmount");
    const checks: Check[] = [];

    // End amounts are positive magnitudes per class, so the identity depends on
    // whether the result has been carried into equity yet: an open period shows
    // Aktiven − Passiven = Ergebnis, a closed one shows Aktiven = Passiven with
    // the result already inside equity. Anything else is a real imbalance.
    const gap = round(assets - liabilities);
    const carried = Math.abs(gap) <= tol;
    const pending = Math.abs(round(gap - result)) <= tol;
    checks.push({
      check: "bilanz_balances",
      status: carried || pending ? "ok" : "fail",
      detail: `Aktiven ${assets} − Passiven ${liabilities} = ${gap}, ` +
        `Ergebnis ${result}. ` +
        (carried
          ? "Balanced with the result already booked into equity."
          : pending
          ? "Balanced with the result not yet booked into equity."
          : `Off by ${
            round(Math.min(Math.abs(gap), Math.abs(gap - result)))
          }: ` +
            `the gap matches neither 0 nor the result.`),
      assets,
      liabilities,
      gap,
    });

    const resultDiff = round(revenue - expense - result);
    checks.push({
      check: "result_consistent",
      status: Math.abs(resultDiff) <= tol ? "ok" : "fail",
      detail: `Ertrag ${revenue} − Aufwand ${expense} = ${
        round(revenue - expense)
      }, fiscalperiod/result = ${result}`,
      difference: resultDiff,
    });

    checks.push({
      check: "result_booked_to_equity",
      status: "info",
      detail: carried
        ? "Aktiven equal Passiven, so the result is already booked into equity."
        : `Aktiven exceed Passiven by ${gap}, i.e. the result is not yet ` +
          `booked into equity. Normal for an open period.`,
    });

    if (previous) {
      const before = await client.listWithTotal<Account>(
        "/api/v1/account/list.json",
        { fiscalPeriodId: previous.id, limit: 500 },
      ).then((r) => new Map(r.data.map((a) => [a.id, a])));

      const mismatches: Row[] = [];
      let compared = 0;
      for (const account of accounts) {
        if (
          account.accountClass === "REVENUE" ||
          account.accountClass === "EXPENSE"
        ) continue;
        const prior = before.get(account.id);
        if (!prior) continue;
        compared += 1;
        const diff = round(
          (account.openingAmount ?? 0) - (prior.endAmount ?? 0),
        );
        if (Math.abs(diff) > tol) {
          mismatches.push({
            account: `${account.number} ${account.name}`,
            opening: account.openingAmount,
            priorClosing: prior.endAmount,
            difference: diff,
          });
        }
      }
      checks.push({
        check: "opening_matches_prior_close",
        status: mismatches.length ? "fail" : "ok",
        detail: `${compared} balance-sheet accounts compared against ` +
          `${previous.name}; ${mismatches.length} mismatched.`,
        ...(mismatches.length ? { mismatches } : {}),
      });
    } else {
      checks.push({
        check: "opening_matches_prior_close",
        status: "info",
        detail: "No earlier fiscal period to compare against.",
      });
    }

    const openingPl = accounts.filter((a) =>
      (a.accountClass === "REVENUE" || a.accountClass === "EXPENSE") &&
      Math.abs(a.openingAmount ?? 0) > tol
    );
    checks.push({
      check: "pl_accounts_open_at_zero",
      status: openingPl.length ? "fail" : "ok",
      detail: openingPl.length
        ? `${openingPl.length} profit-and-loss accounts carry an opening balance.`
        : "All profit-and-loss accounts start at zero.",
      ...(openingPl.length
        ? {
          accounts: openingPl.map((a) => ({
            account: `${a.number} ${a.name}`,
            opening: a.openingAmount,
          })),
        }
        : {}),
    });

    const clearing = accounts.filter((a) =>
      args.clearingAccounts
        ? args.clearingAccounts.includes(String(a.number))
        : CLEARING.test(String(a.name))
    );
    const nonZero = clearing.filter((a) => Math.abs(a.endAmount ?? 0) > tol);
    checks.push({
      check: "clearing_accounts_zero",
      status: nonZero.length ? "warn" : clearing.length ? "ok" : "info",
      detail: clearing.length
        ? `${clearing.length} clearing accounts examined, ${nonZero.length} not at zero.`
        : "No clearing accounts identified. Pass clearingAccounts to name them.",
      ...(nonZero.length
        ? {
          accounts: nonZero.map((a) => ({
            account: `${a.number} ${a.name}`,
            balance: a.endAmount,
          })),
        }
        : {}),
    });

    const [depreciations, exchange] = await Promise.all([
      client.listWithTotal<Row>("/api/v1/fiscalperiod/depreciations.json", {
        id: period.id,
      }),
      client.listWithTotal<Row>("/api/v1/fiscalperiod/exchangediff.json", {
        id: period.id,
      }),
    ]);
    checks.push({
      check: "depreciations_booked",
      status: depreciations.total ? "warn" : "ok",
      detail: depreciations.total
        ? `${depreciations.total} depreciations still to be booked.`
        : "No depreciations pending.",
    });
    checks.push({
      check: "exchange_differences_booked",
      status: exchange.total ? "warn" : "ok",
      detail: exchange.total
        ? `${exchange.total} exchange differences still to be booked.`
        : "No exchange differences pending.",
    });

    const openMonths = (detail.openMonthIds as string[] | undefined) ?? [];
    checks.push({
      check: "months_closed",
      status: detail.isClosed ? "ok" : openMonths.length ? "warn" : "info",
      detail: detail.isClosed
        ? "The fiscal period is closed."
        : `${openMonths.length} months still open: ${openMonths.join(", ")}`,
    });

    const imports = await client.listWithTotal<Row>(
      "/api/v1/journal/import/list.json",
      { fiscalPeriodId: period.id, limit: 50 },
    );
    let staged = 0;
    for (const record of imports.data) {
      const entries = await client.listWithTotal<Row>(
        "/api/v1/journal/import/entry/list.json",
        { importId: record.id as number, limit: 200 },
      );
      staged += entries.data.filter((e) => !e.imported && !e.deleted).length;
    }
    checks.push({
      check: "unbooked_import_entries",
      status: staged ? "warn" : "ok",
      detail: staged
        ? `${staged} staged import entries were never booked.`
        : "No staged import entries left over.",
    });

    // Reported, not judged: credit notes carry an open amount of their own and
    // invoices stay open across periods, so an exact match is the exception.
    for (
      const [type, name] of [["SALES", "receivables"], [
        "PURCHASE",
        "payables",
      ]] as const
    ) {
      const orders = await client.listWithTotal<Row>(
        "/api/v1/order/list.json",
        {
          fiscalPeriodId: period.id,
          onlyOpen: true,
          type,
          limit: 200,
        },
      );
      const unique = new Map(orders.data.map((o) => [o.id as number, o]));
      const gross = round(
        [...unique.values()].reduce((n, o) => n + ((o.open as number) ?? 0), 0),
      );
      const signed = round(
        [...unique.values()].reduce(
          (n, o) => n + (o.isCreditNote ? -1 : 1) * ((o.open as number) ?? 0),
          0,
        ),
      );
      const accountIds = new Set(
        [...unique.values()].map((o) => o.accountId as number),
      );
      const balances: Row[] = [];
      for (const id of accountIds) {
        if (!id) continue;
        balances.push({
          account: `${accounts.find((a) => a.id === id)?.number ?? id}`,
          balance: await client.get<number>("/api/v1/account/balance", {
            id,
            date: end,
          }),
        });
      }
      checks.push({
        check: `${name}_reconcile`,
        status: "info",
        detail:
          `${unique.size} open documents: ${gross} gross, ${signed} with ` +
          `credit notes negated. Compare against the account balance yourself — ` +
          `open documents from earlier periods are included here.`,
        openDocuments: [...unique.values()].map((o) => ({
          nr: o.nr,
          date: String(o.date ?? "").slice(0, 10),
          open: o.open,
          isCreditNote: o.isCreditNote ?? false,
        })),
        accountBalances: balances,
      });
    }

    const summary = { ok: 0, warn: 0, fail: 0, info: 0 };
    for (const c of checks) summary[c.status] += 1;

    return text(renderValue(localizeDeep({
      fiscalPeriod: { id: period.id, name: period.name, end },
      result,
      summary,
      checks,
    }, lang)));
  });
}
