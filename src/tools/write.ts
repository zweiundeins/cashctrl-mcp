/**
 * The write tools.
 *
 * `call_api` could already POST anything, so these do not exist to reach more
 * endpoints. They exist because two of CashCtrl's write semantics are traps
 * that a model driving the raw endpoint walks straight into:
 *
 * 1. **Update is a full replacement.** "All parameters must be submitted,
 *    omitted parameters are treated as empty values." Posting
 *    `person/update.json` with `{ id, lastName }` does not rename the person;
 *    it renames them and clears their address, category, e-mail and
 *    everything else. `update_record` does the read-modify-write instead.
 * 2. **Creates consume a sequence number that deletion does not return.** An
 *    order created and deleted leaves a permanent gap in invoice numbering.
 *
 * Every tool here therefore previews by default: called without
 * `confirm: true` it returns the exact request it would send and changes
 * nothing. That is the same shape as `review_pending_import`, and it means a
 * model can look before it leaps without a second tool to learn.
 *
 * The writable field list for an update is not hand-maintained: it is the
 * parameter list the vendored index carries for that endpoint, so it stays
 * correct as the API moves.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CashCtrlClient } from "../client.ts";
import { periodForDate } from "../client.ts";
import { RESOURCE_NAMES, RESOURCES } from "../resources.ts";
import { renderValue, type Row } from "../format.ts";
import { findEndpoint, type SpecEndpoint } from "../spec.ts";
import { defineTool, text } from "./util.ts";

/** What CashCtrl answers to a create/update/delete. */
interface WriteResult {
  success?: boolean;
  message?: string | null;
  insertId?: number;
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

function endpointFor(
  resource: string,
  verb: "create" | "update" | "delete",
): SpecEndpoint {
  const def = RESOURCES[resource];
  if (!def) throw new Error(`Unknown resource "${resource}".`);
  const endpoint = findEndpoint(`${def.base}/${verb}.json`, "POST");
  if (!endpoint) {
    const available = writableResources(verb).join(", ");
    throw new Error(
      `${resource} has no ${verb} endpoint. Resources that do: ${available}.`,
    );
  }
  return endpoint;
}

function writableResources(verb: "create" | "update" | "delete"): string[] {
  return RESOURCE_NAMES.filter((name) =>
    findEndpoint(`${RESOURCES[name].base}/${verb}.json`, "POST")
  );
}

/**
 * Rejects keys the endpoint does not document.
 *
 * CashCtrl ignores an unknown parameter silently, so a typo in a field name
 * is not an error - it is a write that quietly did less than asked. Better to
 * refuse and name the alternatives.
 */
function assertKnownFields(endpoint: SpecEndpoint, values: Row): void {
  const known = new Set(endpoint.params.map((p) => p.name));
  const unknown = Object.keys(values).filter((k) => !known.has(k));
  if (!unknown.length) return;
  throw new Error(
    `${endpoint.path} does not take ${unknown.join(", ")}. CashCtrl ignores ` +
      `unknown parameters silently, so this would have written less than you ` +
      `asked. Documented parameters: ${[...known].sort().join(", ")}.`,
  );
}

/** Reports missing mandatory parameters with their documentation. */
function assertRequiredFields(endpoint: SpecEndpoint, values: Row): void {
  const missing = endpoint.params.filter((p) =>
    p.required && values[p.name] === undefined
  );
  if (!missing.length) return;
  const detail = missing
    .map((p) => `  ${p.name} (${p.type}): ${p.description.slice(0, 120)}`)
    .join("\n");
  throw new Error(
    `${endpoint.path} needs ${
      missing.map((p) => p.name).join(", ")
    }:\n${detail}`,
  );
}

/** The preview body, shown when `confirm` is not set. */
function preview(
  what: string,
  path: string,
  params: Row,
  notes: string[],
): string {
  return renderValue({ would_call: path, what, params }, [
    ...notes,
    "Nothing was written. Re-issue with confirm: true to apply.",
  ]);
}

export function registerWriteTools(
  server: McpServer,
  client: CashCtrlClient,
): void {
  const write = { readOnlyHint: false, openWorldHint: true } as const;
  const creatable = writableResources("create");
  const updatable = writableResources("update");
  const deletable = writableResources("delete");

  defineTool(server, "create_record", {
    title: "Create a CashCtrl record",
    description:
      "Creates one record. Previews by default; pass `confirm: true` to " +
      "apply.\n\n" +
      "Creating an order, person, article or salary statement consumes the " +
      "next number in its sequence, and deleting the record does not give " +
      "the number back — it leaves a permanent gap in audit-relevant " +
      "numbering. Prefer correcting an existing record over deleting and " +
      "recreating one.\n\n" +
      `Resources: ${creatable.join(", ")}.`,
    annotations: write,
    inputSchema: {
      resource: z.enum(creatable as [string, ...string[]]),
      values: z.record(z.string(), z.unknown()).describe(
        "Field values. Use `describe_endpoint` on the resource's " +
          "create.json to see what it takes.",
      ),
      confirm: z.boolean().default(false),
    },
  }, async (args) => {
    const endpoint = endpointFor(args.resource, "create");
    assertKnownFields(endpoint, args.values);
    assertRequiredFields(endpoint, args.values);

    if (!args.confirm) {
      return text(preview(
        `create a ${args.resource}`,
        endpoint.path,
        args.values,
        ["Creates may consume a sequence number that deletion cannot return."],
      ));
    }

    const result = await client.post<WriteResult>(endpoint.path, args.values);
    const created = typeof result.insertId === "number"
      ? await client.read<Row>(`${RESOURCES[args.resource].base}/read.json`, {
        id: result.insertId,
      }).catch(() => undefined)
      : undefined;
    return text(renderValue({
      created: args.resource,
      id: result.insertId,
      message: result.message,
      record: created,
    }));
  });

  defineTool(server, "update_record", {
    title: "Update a CashCtrl record",
    description:
      "Changes named fields on one record, preserving the rest.\n\n" +
      "CashCtrl's update endpoints are full replacements: posting them " +
      "directly with a couple of fields clears every field left out. This " +
      "tool reads the record first and resends its current values, so only " +
      "what you name in `changes` actually changes. Pass an explicit null to " +
      "clear a field.\n\n" +
      "Previews the merged request by default; pass `confirm: true` to " +
      `apply.\n\nResources: ${updatable.join(", ")}.`,
    annotations: write,
    inputSchema: {
      resource: z.enum(updatable as [string, ...string[]]),
      id: z.number().int(),
      changes: z.record(z.string(), z.unknown()).describe(
        "Only the fields to change. Everything else is preserved.",
      ),
      confirm: z.boolean().default(false),
    },
  }, async (args) => {
    const endpoint = endpointFor(args.resource, "update");
    assertKnownFields(endpoint, args.changes);

    const base = RESOURCES[args.resource].base;
    const existing = await client.read<Row>(`${base}/read.json`, {
      id: args.id,
    });
    if (!existing || typeof existing !== "object") {
      throw new Error(`No ${args.resource} with id ${args.id}.`);
    }

    // The writable set is the update endpoint's own parameter list, so
    // read-only fields like `created` are never echoed back.
    const merged: Row = {};
    for (const param of endpoint.params) {
      const value = existing[param.name];
      // `undefined` means the read did not carry the field; sending it would
      // clear the value, so leave it out and let CashCtrl keep its own.
      if (value !== undefined) merged[param.name] = value;
    }
    for (const [field, value] of Object.entries(args.changes)) {
      if (value !== undefined) merged[field] = value;
    }
    merged.id = args.id;

    const changed = Object.entries(args.changes).map(([field, value]) => ({
      field,
      from: existing[field] ?? null,
      to: value,
    }));

    if (!args.confirm) {
      return text(renderValue({
        would_call: endpoint.path,
        what: `update ${args.resource} ${args.id}`,
        changing: changed,
        preserving: Object.keys(merged).filter((k) =>
          k !== "id" && !(k in args.changes)
        ),
        params: merged,
      }, [
        `${Object.keys(merged).length - 1} fields are resent to preserve them.`,
        "Nothing was written. Re-issue with confirm: true to apply.",
      ]));
    }

    const result = await client.post<WriteResult>(endpoint.path, merged);
    const after = await client.read<Row>(`${base}/read.json`, { id: args.id })
      .catch(() => undefined);
    return text(renderValue({
      updated: args.resource,
      id: args.id,
      message: result.message,
      changed,
      record: after,
    }));
  });

  defineTool(server, "delete_record", {
    title: "Delete CashCtrl records",
    description:
      "Deletes one or more records by id. Previews by default; pass " +
      "`confirm: true` to apply.\n\n" +
      "Deletion does not return a consumed sequence number, and CashCtrl " +
      "refuses to delete records that are referenced elsewhere — a person " +
      "named on an invoice, a category that still has members. Setting " +
      "`isInactive` through `update_record` is usually the better move.\n\n" +
      `Resources: ${deletable.join(", ")}.`,
    annotations: { ...write, destructiveHint: true },
    inputSchema: {
      resource: z.enum(deletable as [string, ...string[]]),
      ids: z.array(z.number().int()).min(1),
      confirm: z.boolean().default(false),
    },
  }, async (args) => {
    const endpoint = endpointFor(args.resource, "delete");
    const base = RESOURCES[args.resource].base;

    // Show what is about to go, by name rather than by id.
    const targets: Row[] = [];
    for (const id of args.ids) {
      const record = await client.read<Row>(`${base}/read.json`, { id })
        .catch(() => undefined);
      targets.push({ id, record: record ?? "not found" });
    }

    if (!args.confirm) {
      return text(preview(
        `delete ${args.ids.length} ${args.resource} record(s)`,
        endpoint.path,
        { ids: args.ids },
        [`Deleting: ${JSON.stringify(targets).slice(0, 400)}`],
      ));
    }

    const result = await client.post<WriteResult>(endpoint.path, {
      ids: args.ids,
    });
    return text(renderValue({
      deleted: args.resource,
      ids: args.ids,
      message: result.message,
    }));
  });

  defineTool(server, "book_journal_entry", {
    title: "Book a journal entry",
    description:
      "Books a double entry, naming accounts by their number rather than " +
      "their id — `1020` rather than `3`.\n\n" +
      "This is a real, VAT-relevant posting. It is refused outside a defined " +
      "fiscal period, because CashCtrl answers such a date with a silent 0 " +
      "rather than an error, and refused in a closed period. Previews by " +
      "default; pass `confirm: true` to apply.",
    annotations: write,
    inputSchema: {
      debitAccount: z.string().describe("Account number to debit, e.g. 1020."),
      creditAccount: z.string().describe("Account number to credit."),
      amount: z.number().positive(),
      date: DATE,
      title: z.string().min(1).describe("Description of the entry."),
      reference: z.string().optional().describe("Receipt or document number."),
      taxCode: z.string().optional().describe("Tax code, e.g. VAT81."),
      confirm: z.boolean().default(false),
    },
  }, async (args) => {
    const accounts = await client.accounts();
    const byNumber = new Map(
      [...accounts.values()].map((a) => [String(a.number), a]),
    );
    const resolve = (number: string) => {
      const account = byNumber.get(number.trim());
      if (!account) {
        throw new Error(
          `No account numbered ${number}. Use list_records on \`account\`, ` +
            `or the cashctrl://org/chart-of-accounts resource.`,
        );
      }
      return account;
    };
    const debit = resolve(args.debitAccount);
    const credit = resolve(args.creditAccount);

    const periods = await client.fiscalPeriods();
    const period = periodForDate(periods, args.date);
    if (period.isClosed) {
      throw new Error(
        `${args.date} falls in ${period.name}, which is closed. Reopen it in ` +
          `CashCtrl first, or book into an open period.`,
      );
    }

    let taxId: number | undefined;
    if (args.taxCode) {
      const taxes = await client.listWithTotal<{ id: number; code: string }>(
        "/api/v1/tax/list.json",
      );
      const tax = taxes.data.find((t) => t.code === args.taxCode);
      if (!tax) {
        throw new Error(
          `No tax code "${args.taxCode}". Available: ${
            taxes.data.map((t) => t.code).join(", ")
          }.`,
        );
      }
      taxId = tax.id;
    }

    const params: Row = {
      debitId: debit.id,
      creditId: credit.id,
      amount: args.amount,
      dateAdded: args.date,
      title: args.title,
      reference: args.reference,
      taxId,
    };

    const describe = {
      debit: `${debit.number} ${debit.name}`,
      credit: `${credit.number} ${credit.name}`,
      amount: args.amount,
      date: args.date,
      period: period.name,
      title: args.title,
    };

    if (!args.confirm) {
      return text(renderValue({
        would_call: "/api/v1/journal/create.json",
        what: "book a journal entry",
        entry: describe,
        params,
      }, [
        "This posts to the books and is VAT-relevant.",
        "Nothing was written. Re-issue with confirm: true to apply.",
      ]));
    }

    const result = await client.post<WriteResult>(
      "/api/v1/journal/create.json",
      params,
    );
    return text(renderValue({
      booked: describe,
      id: result.insertId,
      message: result.message,
    }));
  });
}
