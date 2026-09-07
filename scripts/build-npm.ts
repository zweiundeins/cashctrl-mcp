/**
 * Builds an npm package from the Deno-flavoured source.
 *
 * Unlike the SDK, this is an executable rather than a library: what people
 * want from npm is `npx @zweiundeins/cashctrl-mcp` in an MCP client config,
 * not an import. So the package gets a `bin` entry, and the library export
 * stays available for anyone embedding the server.
 *
 * The source uses no Deno APIs — `node:process` and `node:fs/promises` work in
 * both runtimes — so dnt only has to rewrite the `.ts` import extensions. No
 * shims, which keeps the dependency list to the two the server actually needs.
 *
 * The vendored endpoint index needs no special handling: dnt inlines the JSON
 * import as a module, so it ships once per module tree rather than as a data
 * file the package would have to locate at runtime.
 *
 * Node 24 is the floor, and it is `node:sqlite` that sets it: the backup tools
 * use it, it is built into Deno, and on Node it only became usable without an
 * experimental flag in 24. Anyone on an older Node can still run the server
 * with Deno.
 *
 * Run: deno task build:npm [version]
 * Output: ./npm, publishable with `npm publish ./npm`.
 */

import { build, emptyDir } from "@deno/dnt";

const denoConfig = JSON.parse(await Deno.readTextFile("deno.json"));
const version = Deno.args[0] ?? denoConfig.version;

await emptyDir("./npm");

await build({
  entryPoints: [
    "./src/server.ts",
    { kind: "bin", name: "cashctrl-mcp", path: "./src/cli.ts" },
  ],
  outDir: "./npm",
  // No Deno APIs in src/, so nothing to shim. `node:sqlite` and the MCP SDK
  // resolve natively on Node.
  shims: {},
  test: false,
  typeCheck: "both",
  compilerOptions: {
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    target: "ES2022",
  },
  package: {
    name: "@zweiundeins/cashctrl-mcp",
    version,
    description:
      "MCP server for the CashCtrl accounting API: 18 read tools over all " +
      "376 endpoints, plus four write tools behind an explicit write mode.",
    keywords: [
      "mcp",
      "model-context-protocol",
      "cashctrl",
      "accounting",
      "erp",
      "buchhaltung",
      "switzerland",
      "claude",
    ],
    license: "MIT",
    // node:sqlite, used by the backup tools, is unflagged from Node 24.
    engines: { node: ">=24" },
    repository: {
      type: "git",
      url: "git+https://github.com/zweiundeins/cashctrl-mcp.git",
    },
    bugs: { url: "https://github.com/zweiundeins/cashctrl-mcp/issues" },
    // Only for dnt's type check: the source imports node:process,
    // node:fs/promises and node:sqlite, whose types Deno has built in and
    // tsc does not. Not a runtime dependency.
    devDependencies: { "@types/node": "^24" },
    homepage: "https://github.com/zweiundeins/cashctrl-mcp#readme",
  },
  async postBuild() {
    await Deno.copyFile("LICENSE", "npm/LICENSE");
    await Deno.copyFile("README.md", "npm/README.md");
  },
});

console.log(`\nbuilt npm package v${version} in ./npm`);
console.log("publish with: npm publish ./npm --access public");
