import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type AccountSummary,
  type CashCtrlClient,
  periodForDate,
} from "../client.ts";
import { localizeDeep, renderValue, type Row } from "../format.ts";
import { defineTool, text } from "./util.ts";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

interface Entry extends Row {
  id: number;
  dateAdded?: string;
  amount?: number;
  title?: string;
  reference?: string;
  debitId?: number | null;
  creditId?: number | null;
  taxId?: number | null;
  associateId?: number | null;
  associateName?: string | null;
}

function label(account?: AccountSummary): string {
  return account
    ? `${account.number ?? account.id} ${account.name ?? ""}`.trim()
    : "—";
}

/**
 * For a bank import one side is always the bank account itself; the other side
 * is the booking decision worth reviewing.
 */
function contraOf(
  entry: Entry,
  accounts: Map<number, AccountSummary>,
  bankId?: number,
): AccountSummary | undefined {
  const debit = entry.debitId ? accounts.get(entry.debitId) : undefined;
  const credit = entry.creditId ? accounts.get(entry.creditId) : undefined;
  if (bankId) return entry.debitId === bankId ? credit : debit;
  // Without an explicit bank account, the non-balance-sheet side is the
  // interesting one; fall back to the debit side.
  const isPnl = (a?: AccountSummary) =>
    a?.accountClass === "EXPENSE" || a?.accountClass === "REVENUE";
  if (isPnl(debit)) return debit;
  if (isPnl(credit)) return credit;
  return debit ?? credit;
}

/**
 * In a bank import the same account sits on one side of nearly every entry, so
 * the most frequent one is the bank account even when the caller did not say.
 */
function inferBankAccount(entries: Entry[]): number | undefined {
  const counts = new Map<number, number>();
  for (const entry of entries) {
    for (const id of [entry.debitId, entry.creditId]) {
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  // Only trust it if it really dominates; a mixed set has no single bank side.
  return best && best[1] > entries.length / 2 ? best[0] : undefined;
}

export function registerReviewTools(
  server: McpServer,
  client: CashCtrlClient,
): void {
  const lang = client.config.lang;

  defineTool(server, "review_bank_import", {
    title: "Review imported bank bookings",
    description:
      "Reviews the journal entries that came from a bank statement import " +
      "(CAMT, MT940, CSV). Groups them by contra account so the booking " +
      "pattern is visible at a glance, flags entries that look wrong, and " +
      "lists imports whose entries were never booked.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      fromDate: DATE.optional(),
      toDate: DATE.optional(),
      fiscalPeriodId: z.number().int().optional(),
      accountId: z.number().int().optional().describe(
        "The bank account the statements were imported into. Improves which " +
          "side of each booking is treated as the contra account.",
      ),
      includeAllEntries: z.boolean().default(false).describe(
        "List every entry, not just the flagged ones.",
      ),
      limit: z.number().int().min(1).max(500).default(200),
    },
  }, async (args) => {
    const notes: string[] = [];
    let fiscalPeriodId = args.fiscalPeriodId;
    const periods = await client.fiscalPeriods();
    if (fiscalPeriodId === undefined) {
      const anchor = args.fromDate ?? args.toDate;
      const period = anchor
        ? periodForDate(periods, anchor)
        : periods.find((p) => p.isCurrent);
      fiscalPeriodId = period?.id;
      if (period) notes.push(`Fiscal period ${period.name} (id ${period.id}).`);
    }

    const filter = [
      ...(args.fromDate
        ? [{ field: "dateAdded", comparison: "gt", value: args.fromDate }]
        : []),
      ...(args.toDate
        ? [{ field: "dateAdded", comparison: "lt", value: args.toDate }]
        : []),
    ];

    const [{ data, total }, accounts] = await Promise.all([
      client.listWithTotal<Entry>("/api/v1/journal/list.json", {
        onlyImported: true,
        accountId: args.accountId,
        fiscalPeriodId,
        filter: filter.length ? filter : undefined,
        limit: args.limit,
        sort: "dateAdded",
        dir: "ASC",
      }),
      client.accounts(),
    ]);

    const bankId = args.accountId ?? inferBankAccount(data);
    if (!args.accountId && bankId) {
      notes.push(
        `Treated ${label(accounts.get(bankId))} as the bank side, since it ` +
          `appears on most entries. Pass accountId to override.`,
      );
    }

    // Same day, same amount, same contra account twice is what a re-imported
    // statement looks like.
    const seen = new Map<string, number>();
    for (const entry of data) {
      const key = `${entry.dateAdded}|${entry.amount}|${
        contraOf(entry, accounts, bankId)?.id
      }`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    const groups = new Map<
      string,
      { class?: string; count: number; sum: number }
    >();
    const flagged: Row[] = [];
    const all: Row[] = [];
    let withoutTax = 0;
    let withoutAssociate = 0;

    for (const entry of data) {
      const contra = contraOf(entry, accounts, bankId);
      const name = label(contra);
      const group = groups.get(name) ??
        { class: contra?.accountClass, count: 0, sum: 0 };
      group.count += 1;
      group.sum = Math.round((group.sum + (entry.amount ?? 0)) * 100) / 100;
      groups.set(name, group);

      const flags: string[] = [];
      // Only flag a missing tax code where the account itself defines one:
      // most accounts have no default, so "no tax code" alone is just noise.
      if (!entry.taxId && contra?.taxId) {
        flags.push(`tax_missing (account defaults to ${contra.taxCode})`);
      }
      if (!entry.taxId) withoutTax += 1;
      if (!entry.associateId) {
        withoutAssociate += 1;
        flags.push("no_associate");
      }
      const key = `${entry.dateAdded}|${entry.amount}|${contra?.id}`;
      if ((seen.get(key) ?? 0) > 1) flags.push("possible_duplicate");

      const row: Row = {
        id: entry.id,
        date: entry.dateAdded?.slice(0, 10),
        amount: entry.amount,
        title: entry.title,
        reference: entry.reference,
        contra: name,
        taxCode: entry.taxCode ?? null,
        associate: entry.associateName || null,
      };
      all.push(row);
      if (flags.length) flagged.push({ ...row, flags });
    }

    // Entries staged by an import but never booked are invisible in the
    // journal, so they have to be counted on the import side.
    const imports = await client.listWithTotal<Row>(
      "/api/v1/journal/import/list.json",
      { fiscalPeriodId, limit: 50 },
    );
    const unbooked: Row[] = [];
    for (const record of imports.data) {
      const entries = await client.listWithTotal<Row>(
        "/api/v1/journal/import/entry/list.json",
        { importId: record.id as number, limit: 200 },
      );
      const pending = entries.data.filter((e) => !e.imported);
      if (!pending.length) continue;
      unbooked.push({
        importId: record.id,
        description: record.description,
        created: String(record.created ?? "").slice(0, 10),
        staged: pending.length,
        ignored: pending.filter((e) => e.deleted).length,
        confirmedNotBooked: pending.filter((e) =>
          e.confirmed && !e.deleted
        ).length,
      });
    }

    return text(renderValue(
      localizeDeep({
        entries: total,
        byContraAccount: [...groups.entries()]
          .map(([account, g]) => ({ account, ...g }))
          .sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum)),
        summary: {
          withoutTaxCode: withoutTax,
          withoutAssociate,
          flagged: flagged.length,
        },
        flagged,
        ...(args.includeAllEntries ? { allEntries: all } : {}),
        unbookedImports: unbooked,
      }, lang),
      notes,
    ));
  });

  defineTool(server, "get_fiscal_period_status", {
    title: "Fiscal period status",
    description:
      "Where a fiscal period stands for closing: profit or loss, which months " +
      "are closed, and the depreciations and exchange differences still " +
      "waiting to be booked.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      fiscalPeriodId: z.number().int().optional().describe(
        "Defaults to the organisation's current period.",
      ),
    },
  }, async (args) => {
    const periods = await client.fiscalPeriods();
    const id = args.fiscalPeriodId ?? periods.find((p) => p.isCurrent)?.id;
    if (id === undefined) throw new Error("No fiscal period found.");

    const period = await client.read<Row>("/api/v1/fiscalperiod/read.json", {
      id,
    });
    // `result` returns a bare number, and `id` here is the fiscal period —
    // same convention as depreciations and exchangediff.
    const result = await client.get<number>("/api/v1/fiscalperiod/result", {
      id,
    });
    const depreciations = await client.listWithTotal<Row>(
      "/api/v1/fiscalperiod/depreciations.json",
      { id },
    );
    const exchangeDiff = await client.listWithTotal<Row>(
      "/api/v1/fiscalperiod/exchangediff.json",
      { id },
    );

    return text(renderValue(localizeDeep({
      fiscalPeriodId: id,
      name: period.name,
      start: String(period.start ?? "").slice(0, 10),
      end: String(period.end ?? "").slice(0, 10),
      isClosed: period.isClosed,
      result,
      closedMonths: period.closedMonthIds,
      openMonths: period.openMonthIds,
      pendingDepreciations: depreciations.total,
      depreciations: depreciations.data,
      pendingExchangeDifferences: exchangeDiff.total,
      exchangeDifferences: exchangeDiff.data,
    }, lang)));
  });
}

interface StagedEntry extends Entry {
  importId?: number;
  orderId?: number | null;
  orderStatusId?: number | null;
  confirmed?: boolean;
  deleted?: boolean;
  imported?: boolean;
  duplicate?: boolean;
  taxCode?: string | null;
}

/** Registers the pre-execute review of a staged bank import. */
export function registerStagingTools(
  server: McpServer,
  client: CashCtrlClient,
): void {
  const lang = client.config.lang;

  defineTool(server, "review_pending_import", {
    title: "Review a staged bank import",
    description:
      "Shows what executing a bank import would do, before it is executed. " +
      "CashCtrl matches incoming payments against open invoices when the " +
      "import is created, so an execute can close customer invoices — this " +
      "lists exactly which ones. Without `importId`, lists imports that still " +
      "have unbooked entries.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      importId: z.number().int().optional(),
      fiscalPeriodId: z.number().int().optional(),
    },
  }, async (args) => {
    const periods = await client.fiscalPeriods();
    const fiscalPeriodId = args.fiscalPeriodId ??
      periods.find((p) => p.isCurrent)?.id;

    if (args.importId === undefined) {
      const imports = await client.listWithTotal<Row>(
        "/api/v1/journal/import/list.json",
        { fiscalPeriodId, limit: 50 },
      );
      const accounts = await client.accounts();
      const pending: Row[] = [];
      for (const record of imports.data) {
        const entries = await client.listWithTotal<StagedEntry>(
          "/api/v1/journal/import/entry/list.json",
          { importId: record.id as number, limit: 200 },
        );
        const staged = entries.data.filter((e) => !e.imported);
        if (!staged.length) continue;
        pending.push({
          importId: record.id,
          description: record.description,
          created: String(record.created ?? "").slice(0, 10),
          targetAccount: label(
            accounts.get(record.targetAccountId as number),
          ),
          staged: staged.length,
          ignored: staged.filter((e) => e.deleted).length,
          matchedToOrders: staged.filter((e) => e.orderId).length,
        });
      }
      return text(renderValue(localizeDeep({ pendingImports: pending }, lang)));
    }

    const [record, entries, accounts] = await Promise.all([
      client.read<Row>("/api/v1/journal/import/read.json", {
        id: args.importId,
      }),
      client.listWithTotal<StagedEntry>(
        "/api/v1/journal/import/entry/list.json",
        { importId: args.importId, limit: 500 },
      ),
      client.accounts(),
    ]);

    const orders = new Map<number, Row>();
    const statuses = new Map<number, Row>();
    for (const entry of entries.data) {
      if (entry.orderId && !orders.has(entry.orderId)) {
        orders.set(
          entry.orderId,
          await client.read<Row>("/api/v1/order/read.json", {
            id: entry.orderId,
          }),
        );
      }
      if (entry.orderStatusId && !statuses.has(entry.orderStatusId)) {
        statuses.set(
          entry.orderStatusId,
          await client.read<Row>("/api/v1/order/category/read_status.json", {
            id: entry.orderStatusId,
          }),
        );
      }
    }

    const describe = (entry: StagedEntry): Row => {
      const order = entry.orderId ? orders.get(entry.orderId) : undefined;
      const status = entry.orderStatusId
        ? statuses.get(entry.orderStatusId)
        : undefined;
      return {
        entryId: entry.id,
        date: entry.dateAdded?.slice(0, 10),
        amount: entry.amount,
        title: entry.title,
        reference: entry.reference,
        contra: label(
          accounts.get(
            (entry.debitId === record.targetAccountId
              ? entry.creditId
              : entry.debitId) as number,
          ),
        ),
        associate: entry.associateName || null,
        taxCode: entry.taxCode ?? null,
        state: entry.deleted
          ? "ignored"
          : entry.confirmed
          ? "confirmed"
          : "staged",
        ...(order
          ? {
            matchedOrder: {
              id: entry.orderId,
              nr: order.nr,
              associate: order.associateName,
              total: order.total,
              open: order.open,
              currentStatus: order.statusName,
            },
            newStatus: status
              ? {
                id: status.id,
                name: status.name,
                closesOrder: status.isClosed,
              }
              : { id: entry.orderStatusId },
          }
          : {}),
      };
    };

    const staged = entries.data.filter((e) => !e.imported);
    const live = staged.filter((e) => !e.deleted);
    const wouldClose = live
      .filter((e) => e.orderId && statuses.get(e.orderStatusId ?? 0)?.isClosed)
      .map(describe);
    const ignoredWithMatch = staged
      .filter((e) => e.deleted && e.orderId)
      .map(describe);

    return text(renderValue(
      localizeDeep({
        importId: args.importId,
        description: record.description,
        targetAccount: label(accounts.get(record.targetAccountId as number)),
        summary: {
          entries: entries.total,
          alreadyBooked: entries.data.length - staged.length,
          staged: live.length,
          ignored: staged.length - live.length,
          wouldCloseOrders: wouldClose.length,
        },
        wouldClose,
        ignoredWithMatch,
        entries: live.map(describe),
      }, lang),
      [
        "Matching is done by CashCtrl when the import is created, so these " +
        "matches are the same ones the web UI shows.",
        "Executing the import books every confirmed entry and applies the " +
        "statuses below. This server cannot execute it.",
      ],
    ));
  });
}
