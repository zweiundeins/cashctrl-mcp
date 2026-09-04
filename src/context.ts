import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CashCtrlClient } from "./client.ts";
import { localizeDeep, type Row } from "./format.ts";

/**
 * Context an agent would otherwise burn several tool calls rediscovering. Both
 * are resources rather than tools so they cost nothing until asked for.
 */
export function registerResources(
  server: McpServer,
  client: CashCtrlClient,
): void {
  const lang = client.config.lang;

  const json = (uri: string, body: unknown) => ({
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(localizeDeep(body, lang), null, 1),
    }],
  });

  server.registerResource(
    "organisation-summary",
    "cashctrl://org/summary",
    {
      title: "Organisation summary",
      description:
        "Fiscal periods, currencies, tax codes, order categories and " +
        "locations. Read this before anything period- or tax-dependent.",
      mimeType: "application/json",
    },
    async (uri: URL) => {
      const [periods, currencies, taxes, orderCategories, locations] =
        await Promise.all([
          client.fiscalPeriods(),
          client.listWithTotal<Row>("/api/v1/currency/list.json"),
          client.listWithTotal<Row>("/api/v1/tax/list.json"),
          client.listWithTotal<Row>("/api/v1/order/category/list.json"),
          client.listWithTotal<Row>("/api/v1/location/list.json"),
        ]);

      return json(uri.href, {
        organisation: client.config.organisation,
        mode: client.config.mode,
        language: lang,
        fiscalPeriods: periods.map((p) => ({
          id: p.id,
          name: p.name,
          start: p.start?.slice(0, 10),
          end: p.end?.slice(0, 10),
          isCurrent: p.isCurrent,
          isClosed: p.isClosed,
        })),
        currencies: currencies.data.map((c) => ({
          id: c.id,
          code: c.code,
          rate: c.rate,
          isDefault: c.isDefault,
        })),
        taxes: taxes.data.map((t) => ({
          id: t.id,
          code: t.code,
          percentage: t.currentPercentage,
          documentName: t.documentName,
          isInactive: t.isInactive,
        })),
        orderCategories: orderCategories.data.map((c) => ({
          id: c.id,
          name: c.nameSingular,
          type: c.type,
          bookType: c.bookType,
        })),
        locations: locations.data.map((l) => ({
          id: l.id,
          name: l.name,
          type: l.type,
          vatUid: l.vatUid,
        })),
      });
    },
  );

  server.registerResource(
    "chart-of-accounts",
    "cashctrl://org/chart-of-accounts",
    {
      title: "Chart of accounts",
      description:
        "Every account with its number, name, class and tax code. Saves " +
        "guessing account numbers.",
      mimeType: "application/json",
    },
    async (uri: URL) => {
      const { data } = await client.listWithTotal<Row>(
        "/api/v1/account/list.json",
        { limit: 500 },
      );
      return json(uri.href, {
        count: data.length,
        accounts: data.map((a) => ({
          id: a.id,
          number: a.number,
          name: a.name,
          accountClass: a.accountClass,
          category: a.categoryDisplay,
          taxCode: a.taxCode,
          currencyCode: a.currencyCode,
          isInactive: a.isInactive,
        })),
      });
    },
  );
}
