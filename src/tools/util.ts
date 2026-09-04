import type { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { describeError } from "../client.ts";

export function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

export interface ToolConfig<S extends z.ZodRawShape> {
  title: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema: S;
}

/**
 * `registerTool` cannot infer its argument type unless `outputSchema` is also
 * given, which leaves every handler's `args` as `any`. Pinning the shape here
 * types the handlers and keeps the cast in one place.
 *
 * Errors become error *results* rather than transport failures, so the model
 * sees why a call failed and can correct it.
 */
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: ToolConfig<S>,
  handler: (args: z.output<z.ZodObject<S>>) => Promise<CallToolResult>,
): void {
  const guarded = async (args: unknown): Promise<CallToolResult> => {
    try {
      return await handler(args as z.output<z.ZodObject<S>>);
    } catch (err) {
      return {
        content: [{ type: "text", text: describeError(err) }],
        isError: true,
      };
    }
  };
  // deno-lint-ignore no-explicit-any
  server.registerTool(name, config as any, guarded as any);
}
