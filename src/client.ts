import {
  CashCtrlAuthError,
  CashCtrlHttp,
  CashCtrlRateLimitError,
  CashCtrlValidationError,
  localize,
} from "@zweiundeins/cashctrl-ts-sdk";
import type { Params } from "@zweiundeins/cashctrl-ts-sdk";
import type { Config } from "./config.ts";
import { assertAllowed } from "./policy.ts";

export interface FiscalPeriod {
  id: number;
  name: string;
  start: string;
  end: string;
  isCurrent?: boolean;
  isClosed?: boolean;
}

/**
 * Every request funnels through here so the policy check cannot be bypassed by
 * a tool that forgets to call it.
 */
export class CashCtrlClient {
  readonly config: Config;
  readonly #http: CashCtrlHttp;
  #periods?: Promise<FiscalPeriod[]>;
  readonly #customLabels = new Map<string, Promise<Map<string, string>>>();

  constructor(config: Config, http?: CashCtrlHttp) {
    this.config = config;
    this.#http = http ?? new CashCtrlHttp({
      organisation: config.organisation,
      apiKey: config.apiKey,
      lang: config.lang,
      // A retried create would burn a second sequence number, so writes get no
      // retries. Reads are idempotent and keep the default backoff.
      retry: config.mode === "write" ? { attempts: 0 } : undefined,
    });
  }

  async get<T>(path: string, params?: Params): Promise<T> {
    assertAllowed(this.config, "GET", path);
    return await this.#http.get<T>(path, params);
  }

  async post<T>(path: string, params?: Params): Promise<T> {
    assertAllowed(this.config, "POST", path);
    return await this.#http.post<T>(path, params);
  }

  async listWithTotal<T>(
    path: string,
    params?: Params,
  ): Promise<{ data: T[]; total: number }> {
    assertAllowed(this.config, "GET", path);
    return await this.#http.listWithTotal<T>(path, params);
  }

  /** `read.json` returns `{success, data}`; callers want the entity. */
  async read<T>(path: string, params?: Params): Promise<T> {
    const body = await this.get<{ data?: T } | T>(path, params);
    if (body && typeof body === "object" && "data" in body) {
      return (body as { data: T }).data;
    }
    return body as T;
  }

  fiscalPeriods(): Promise<FiscalPeriod[]> {
    this.#periods ??= this.listWithTotal<FiscalPeriod>(
      "/api/v1/fiscalperiod/list.json",
    ).then((r) => r.data);
    return this.#periods;
  }

  /**
   * Maps `customField7` to the name a user gave the field. Best-effort: the
   * response shape for `customfield/list` was never probed upstream, so a
   * missing id or name just means the raw tag is shown.
   */
  customFieldLabels(type: string): Promise<Map<string, string>> {
    let cached = this.#customLabels.get(type);
    if (!cached) {
      cached = this.listWithTotal<{ id?: number; name?: string }>(
        "/api/v1/customfield/list.json",
        { type },
      )
        .then((r) => {
          const map = new Map<string, string>();
          for (const field of r.data) {
            if (typeof field.id !== "number" || !field.name) continue;
            map.set(
              `customField${field.id}`,
              localize(field.name, this.config.lang),
            );
          }
          return map;
        })
        .catch(() => new Map<string, string>());
      this.#customLabels.set(type, cached);
    }
    return cached;
  }
}

export class DateOutsideFiscalPeriodError extends Error {}

/**
 * A date in no fiscal period does not error upstream — `account/balance`
 * returns 0, which reads as a real answer. Refuse instead.
 */
export function periodForDate(
  periods: readonly FiscalPeriod[],
  date: string,
): FiscalPeriod {
  const match = periods.find((p) =>
    date >= p.start.slice(0, 10) && date <= p.end.slice(0, 10)
  );
  if (match) return match;
  const ranges = periods
    .map((p) => `${p.name} (${p.start.slice(0, 10)}..${p.end.slice(0, 10)})`)
    .join(", ");
  throw new DateOutsideFiscalPeriodError(
    `${date} falls in no fiscal period, and CashCtrl answers 0 for such a ` +
      `date instead of failing. Defined periods: ${ranges || "none"}.`,
  );
}

/** Turns SDK errors into something a model can act on. */
export function describeError(err: unknown): string {
  if (err instanceof CashCtrlValidationError) {
    const byField = Object.entries(err.byField())
      .map(([field, messages]) => `  ${field}: ${messages.join("; ")}`)
      .join("\n");
    return `CashCtrl rejected the request:\n${byField || `  ${err.message}`}`;
  }
  if (err instanceof CashCtrlAuthError) {
    return `Authentication or permission failure (${err.status}). The API ` +
      `user's role may not cover this endpoint.`;
  }
  if (err instanceof CashCtrlRateLimitError) {
    return `Rate limited by CashCtrl${
      err.retryAfter ? `; retry after ${err.retryAfter}s` : ""
    }. CashCtrl publishes no limits, so slow down and retry.`;
  }
  return err instanceof Error ? err.message : String(err);
}
