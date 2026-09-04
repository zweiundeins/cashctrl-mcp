/**
 * Vendors the SDK's compact endpoint index into this repo.
 *
 * `spec/` is not published to npm or JSR, so the index cannot be imported from
 * the package; it is fetched from the tag instead. Pin the tag deliberately —
 * the index is what the discovery tools describe, so it should move when we
 * decide to, not when upstream re-scrapes.
 *
 * Run: deno task vendor:spec [--tag v0.3.0]
 */

const args = Deno.args;
const tagIdx = args.indexOf("--tag");
const tag = tagIdx >= 0 ? args[tagIdx + 1] : "v0.3.0";
const url =
  `https://raw.githubusercontent.com/zweiundeins/cashctrl-ts-sdk/${tag}/spec/index.json`;

const response = await fetch(url);
if (!response.ok) {
  console.error(`fetch failed: ${response.status} ${url}`);
  Deno.exit(1);
}
const body = await response.text();
const parsed = JSON.parse(body) as { endpoints: unknown[] };

const out = new URL("../spec/index.json", import.meta.url);
await Deno.writeTextFile(out, body.endsWith("\n") ? body : body + "\n");
await Deno.writeTextFile(
  new URL("../spec/VERSION", import.meta.url),
  `${tag}\n`,
);
console.log(
  `vendored ${parsed.endpoints.length} endpoints from ${tag} (${
    Math.round(body.length / 1024)
  } KB)`,
);
