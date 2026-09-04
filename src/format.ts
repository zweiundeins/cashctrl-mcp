import { isLocalized, localize } from "@zweiundeins/cashctrl-ts-sdk";
import type { CashCtrlLang } from "@zweiundeins/cashctrl-ts-sdk";

export type Row = Record<string, unknown>;

/**
 * Roughly 15k tokens. Clients truncate large tool results themselves, silently;
 * cutting here means the model is told what was dropped instead of guessing.
 */
export const MAX_RESULT_CHARS = 60_000;

/** Resolves CashCtrl's `<values><de>…</de></values>` blobs to one language. */
export function localizeDeep(value: unknown, lang: CashCtrlLang): unknown {
  if (typeof value === "string") {
    if (isLocalized(value)) return localize(value, lang);
    // Some fields embed the blob inside other text, e.g. the account label
    // "1100 <values><de>Debitoren</de>…</values>".
    if (value.includes("<values>")) {
      return value.replace(
        /<values>[\s\S]*?<\/values>/g,
        (blob) => localize(blob, lang),
      ).trim();
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => localizeDeep(v, lang));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Row).map(([k, v]) => [k, localizeDeep(v, lang)]),
    );
  }
  return value;
}

/**
 * Custom fields arrive as `<values><customField3>Blue</customField3></values>`.
 * Returns the raw tag names; `labels` maps them to what the user called them.
 */
export function parseCustom(
  xml: unknown,
  labels?: ReadonlyMap<string, string>,
): Row | undefined {
  if (typeof xml !== "string" || !xml.includes("<values>")) return undefined;
  const out: Row = {};
  for (const m of xml.matchAll(/<(customField\d+)>([\s\S]*?)<\/\1>/g)) {
    const [, tag, raw] = m;
    out[labels?.get(tag) ?? tag] = unescapeXml(raw);
  }
  return Object.keys(out).length ? out : undefined;
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** Drops keys whose value carries nothing, so wide entities stay readable. */
export function compact(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

export interface ShapeOptions {
  lang: CashCtrlLang;
  /** Column subset. `undefined` or `["*"]` keeps every field. */
  fields?: readonly string[];
  customLabels?: ReadonlyMap<string, string>;
}

/** Projects, localizes and compacts one entity for presentation. */
export function shapeRow(row: Row, options: ShapeOptions): Row {
  const all = !options.fields || options.fields.includes("*");
  const picked: Row = all ? { ...row } : {};
  if (!all) {
    for (const field of options.fields!) {
      if (field in row) picked[field] = row[field];
    }
    // `id` is what every follow-up call needs, so never let it be projected out.
    if (!("id" in picked) && "id" in row) picked.id = row.id;
  }

  const custom = parseCustom(row.custom, options.customLabels);
  if (custom && (all || "custom" in picked)) picked.custom = custom;
  else if (picked.custom !== undefined && !custom) delete picked.custom;

  return compact(localizeDeep(picked, options.lang) as Row);
}

export interface ListResult {
  resource: string;
  total: number;
  start: number;
  rows: Row[];
  /** Extra context worth stating, e.g. which fiscal period was used. */
  notes?: string[];
}

/**
 * Serializes a list, dropping rows rather than letting the client cut the JSON
 * mid-structure, and saying how many were dropped and where to resume.
 */
export function renderList(result: ListResult): string {
  const notes = [...(result.notes ?? [])];
  let rows = result.rows;
  let body = build(rows);

  while (body.length > MAX_RESULT_CHARS && rows.length > 1) {
    rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
    body = build(rows);
  }
  if (rows.length < result.rows.length) {
    notes.push(
      `Truncated to ${rows.length} of ${result.rows.length} fetched rows to ` +
        `stay within the response budget. Narrow \`fields\` or lower \`limit\`.`,
    );
    body = build(rows);
  }
  return body;

  function build(visible: Row[]): string {
    const shown = result.start + visible.length;
    const envelope: Row = {
      resource: result.resource,
      total: result.total,
      start: result.start,
      returned: visible.length,
    };
    if (shown < result.total) envelope.next_start = shown;
    if (notes.length) envelope.notes = notes;
    envelope.rows = visible;
    return JSON.stringify(envelope, null, 1);
  }
}

/** Serializes a single entity or scalar result. */
export function renderValue(value: unknown, notes?: string[]): string {
  const payload = notes?.length
    ? { notes, value }
    : value as Row | unknown[] | string | number;
  const text = JSON.stringify(payload, null, 1);
  return text.length > MAX_RESULT_CHARS
    ? text.slice(0, MAX_RESULT_CHARS) +
      `\n… truncated at ${MAX_RESULT_CHARS} characters.`
    : text;
}
