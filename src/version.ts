/**
 * The server's version, reported to MCP clients in `initialize`.
 *
 * Kept here rather than read from deno.json because the npm build has no
 * deno.json at runtime. The publish workflow fails when this and deno.json
 * disagree, so the duplication cannot drift silently.
 */
export const VERSION = "0.1.0";
