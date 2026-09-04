/** Search over the vendored endpoint index (see scripts/vendor-index.ts). */

import indexJson from "../spec/index.json" with { type: "json" };

export interface SpecParam {
  name: string;
  type:
    | "TEXT"
    | "NUMBER"
    | "BOOLEAN"
    | "JSON"
    | "CSV"
    | "DATE"
    | "HTML"
    | "XML";
  required: boolean;
  description: string;
  enum?: string[];
}

export interface SpecEndpoint {
  path: string;
  method: "GET" | "POST";
  group: string[];
  summary: string;
  description: string;
  anchor: string;
  params: SpecParam[];
}

interface SpecIndex {
  source: string;
  endpoints: SpecEndpoint[];
}

const index = indexJson as SpecIndex;

export const endpoints: readonly SpecEndpoint[] = index.endpoints;

const byPath = new Map<string, SpecEndpoint[]>();
for (const endpoint of endpoints) {
  const list = byPath.get(endpoint.path) ?? [];
  list.push(endpoint);
  byPath.set(endpoint.path, list);
}

/** Looks an endpoint up by path, and by method when the path has both. */
export function findEndpoint(
  path: string,
  method?: "GET" | "POST",
): SpecEndpoint | undefined {
  const candidates = byPath.get(normalizePath(path));
  if (!candidates) return undefined;
  return method
    ? candidates.find((e) => e.method === method) ?? candidates[0]
    : candidates[0];
}

/** Accepts `account/list.json` as well as the full `/api/v1/...` form. */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith("/api/v1/")) return trimmed;
  return `/api/v1/${trimmed.replace(/^\/+/, "")}`;
}

/**
 * Ranks endpoints against space-separated terms. Path and summary matches
 * outweigh prose, so "list orders" finds `order/list.json` rather than the
 * forty endpoints whose descriptions mention an order.
 */
export function searchEndpoints(
  query: string,
  limit = 15,
): SpecEndpoint[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  const scored: { endpoint: SpecEndpoint; score: number }[] = [];
  for (const endpoint of endpoints) {
    const path = endpoint.path.toLowerCase();
    const summary = endpoint.summary.toLowerCase();
    const group = endpoint.group.join(" ").toLowerCase();
    const prose = endpoint.description.toLowerCase();
    const params = endpoint.params.map((p) => p.name.toLowerCase()).join(" ");

    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      let termScore = 0;
      if (path.includes(term)) termScore += 10;
      if (summary.includes(term)) termScore += 6;
      if (group.includes(term)) termScore += 3;
      if (params.includes(term)) termScore += 2;
      if (prose.includes(term)) termScore += 1;
      if (termScore === 0) matchedAll = false;
      score += termScore;
    }
    if (matchedAll && score > 0) scored.push({ endpoint, score });
  }

  scored.sort((a, b) =>
    b.score - a.score || a.endpoint.path.localeCompare(b.endpoint.path)
  );
  return scored.slice(0, limit).map((s) => s.endpoint);
}
