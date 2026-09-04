import { SIDE_EFFECTING_GETS } from "@zweiundeins/cashctrl-ts-sdk";
import type { Config } from "./config.ts";

/**
 * Refused regardless of mode. `fiscalperiod/switch` changes the current period
 * for the whole organisation — a human in the UI sees it move — and every read
 * that matters can target a period explicitly instead, so nothing here needs it.
 */
const ALWAYS_DENIED = new Set<string>([
  ...SIDE_EFFECTING_GETS,
  "/api/v1/fiscalperiod/switch.json",
]);

export class PolicyError extends Error {}

/** Throws if the configured mode and module toggles forbid calling `path`. */
export function assertAllowed(
  config: Config,
  method: "GET" | "POST",
  path: string,
): void {
  if (ALWAYS_DENIED.has(path)) {
    throw new PolicyError(
      `${path} is refused: it changes state for the whole organisation. ` +
        `Pass an explicit fiscalPeriodId or date instead of switching periods.`,
    );
  }
  if (method === "POST" && config.mode !== "write") {
    throw new PolicyError(
      `${path} is a write and this server runs in read mode. ` +
        `Set CASHCTRL_MODE=write to allow it.`,
    );
  }
  if (!config.enableSalary && path.startsWith("/api/v1/salary/")) {
    throw new PolicyError(
      `${path} is part of the salary module, which is disabled. It holds ` +
        `AHV numbers and individual salaries; set CASHCTRL_ENABLE_SALARY=1 ` +
        `to allow it.`,
    );
  }
}

export function isAllowed(
  config: Config,
  method: "GET" | "POST",
  path: string,
): boolean {
  try {
    assertAllowed(config, method, path);
    return true;
  } catch {
    return false;
  }
}
