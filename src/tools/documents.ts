import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CashCtrlClient } from "../client.ts";
import { defineTool } from "./util.ts";

interface DocumentKind {
  path: string;
  /** Which id parameter the endpoint expects. */
  id: "ids" | "elementId" | "collectionId" | "id";
  period?: boolean;
  extension: string;
  mimeType: string;
}

const KINDS: Record<string, DocumentKind> = {
  order_pdf: {
    path: "/api/v1/order/document/read.pdf",
    id: "ids",
    extension: "pdf",
    mimeType: "application/pdf",
  },
  order_zip: {
    path: "/api/v1/order/document/read.zip",
    id: "ids",
    extension: "zip",
    mimeType: "application/zip",
  },
  salary_statement_pdf: {
    path: "/api/v1/salary/document/read.pdf",
    id: "ids",
    extension: "pdf",
    mimeType: "application/pdf",
  },
  salary_certificate_pdf: {
    path: "/api/v1/salary/certificate/document/read.pdf",
    id: "ids",
    extension: "pdf",
    mimeType: "application/pdf",
  },
  report_element_pdf: {
    path: "/api/v1/report/element/download.pdf",
    id: "elementId",
    period: true,
    extension: "pdf",
    mimeType: "application/pdf",
  },
  report_element_xlsx: {
    path: "/api/v1/report/element/download.xlsx",
    id: "elementId",
    period: true,
    extension: "xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  report_collection_pdf: {
    path: "/api/v1/report/collection/download.pdf",
    id: "collectionId",
    period: true,
    extension: "pdf",
    mimeType: "application/pdf",
  },
  file: {
    path: "/api/v1/file/get",
    id: "id",
    extension: "bin",
    mimeType: "application/octet-stream",
  },
};

/**
 * Keeps the written path inside the download directory. The name can come from
 * a `Content-Disposition` the server chose, so treat it as untrusted.
 */
function safeName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").trim();
  return cleaned.length ? cleaned.slice(0, 120) : fallback;
}

function nameFromHeaders(response: Response): string | undefined {
  const disposition = response.headers.get("content-disposition");
  const match = disposition?.match(
    /filename\*?=(?:UTF-8''|")?([^";]+)/i,
  );
  return match ? decodeURIComponent(match[1].trim()) : undefined;
}

export function registerDocumentTools(
  server: McpServer,
  client: CashCtrlClient,
): void {
  defineTool(server, "download_document", {
    title: "Download a CashCtrl document",
    description:
      "Downloads an invoice, salary document, report or stored file and " +
      "writes it to the server's download directory, returning the path. " +
      "Binary content is never inlined into the conversation.\n\n" +
      "Kinds: " + Object.keys(KINDS).join(", ") + ".",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      kind: z.enum(Object.keys(KINDS) as [string, ...string[]]),
      ids: z.array(z.number().int()).optional().describe(
        "Order, salary statement or certificate ids. Several are merged into " +
          "one document.",
      ),
      elementId: z.number().int().optional(),
      collectionId: z.number().int().optional(),
      fileId: z.number().int().optional(),
      fiscalPeriodId: z.number().int().optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      filename: z.string().optional().describe(
        "Name to save under. Directories are stripped.",
      ),
    },
  }, async (args): Promise<CallToolResult> => {
    const kind = KINDS[args.kind];
    const params: Record<string, unknown> = {};

    switch (kind.id) {
      case "ids":
        if (!args.ids?.length) throw new Error(`${args.kind} needs \`ids\`.`);
        params.ids = args.ids;
        break;
      case "elementId":
        if (args.elementId === undefined) {
          throw new Error(`${args.kind} needs \`elementId\`.`);
        }
        params.elementId = args.elementId;
        break;
      case "collectionId":
        if (args.collectionId === undefined) {
          throw new Error(`${args.kind} needs \`collectionId\`.`);
        }
        params.collectionId = args.collectionId;
        break;
      case "id":
        if (args.fileId === undefined) {
          throw new Error(`${args.kind} needs \`fileId\`.`);
        }
        params.id = args.fileId;
        break;
    }
    if (kind.period) {
      params.fiscalPeriod = args.fiscalPeriodId;
      params.startDate = args.startDate;
      params.endDate = args.endDate;
      params.language = client.config.lang;
    }

    const response = await client.raw(kind.path, params);
    const bytes = new Uint8Array(await response.arrayBuffer());

    const suffix = args.ids?.join("-") ?? args.elementId ?? args.collectionId ??
      args.fileId;
    const fallback = `${args.kind}-${suffix}.${kind.extension}`;
    const name = safeName(
      args.filename ?? nameFromHeaders(response) ?? fallback,
      fallback,
    );

    await Deno.mkdir(client.config.downloadDir, { recursive: true });
    const path = `${client.config.downloadDir.replace(/\/+$/, "")}/${name}`;
    await Deno.writeFile(path, bytes);

    const mimeType = response.headers.get("content-type")?.split(";")[0] ??
      kind.mimeType;
    return {
      content: [
        {
          type: "text",
          text: `Wrote ${bytes.length} bytes to ${path} (${mimeType}).`,
        },
        {
          type: "resource_link",
          uri: `file://${path}`,
          name,
          mimeType,
          description: `${args.kind} from CashCtrl`,
        },
      ],
    };
  });
}
