import type { CashCtrlLang } from "@zweiundeins/cashctrl-ts-sdk";

export type Mode = "read" | "write";

export interface Config {
  organisation: string;
  apiKey: string;
  lang: CashCtrlLang;
  mode: Mode;
  downloadDir: string;
  enableSalary: boolean;
}

const LANGS = new Set(["de", "fr", "it", "en"]);

class ConfigError extends Error {}

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new ConfigError(`${name} is not set`);
  return value;
}

/** Reads configuration from the environment, failing loudly rather than guessing. */
export function loadConfig(): Config {
  const lang = (Deno.env.get("CASHCTRL_LANG") ?? "de").trim();
  if (!LANGS.has(lang)) {
    throw new ConfigError(
      `CASHCTRL_LANG must be one of de, fr, it, en (got "${lang}")`,
    );
  }

  const mode = (Deno.env.get("CASHCTRL_MODE") ?? "read").trim();
  if (mode !== "read" && mode !== "write") {
    throw new ConfigError(
      `CASHCTRL_MODE must be "read" or "write" (got "${mode}")`,
    );
  }

  return {
    organisation: required("CASHCTRL_ORGANISATION"),
    apiKey: required("CASHCTRL_APIKEY"),
    lang: lang as CashCtrlLang,
    mode,
    downloadDir: Deno.env.get("CASHCTRL_DOWNLOAD_DIR")?.trim() ||
      Deno.cwd(),
    enableSalary: (Deno.env.get("CASHCTRL_ENABLE_SALARY") ?? "").trim() === "1",
  };
}

export { ConfigError };
