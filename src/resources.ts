/**
 * The resources `list_records` and `get_record` expose.
 *
 * `defaultFields` is what makes the read layer usable: entities run 33 to 89
 * fields wide, so returning everything for 25 rows buries the answer in noise.
 * Callers who need the rest pass `fields: ["*"]`.
 */
export interface ResourceDef {
  /** Path prefix, e.g. `/api/v1/inventory/article`. */
  base: string;
  defaultFields: readonly string[];
  /** `list.json` accepts `fiscalPeriodId`. */
  fiscalPeriod?: boolean;
  /** Part of the salary module, gated by CASHCTRL_ENABLE_SALARY. */
  salary?: boolean;
  /** No `read.json`; only listing is possible. */
  listOnly?: boolean;
  /** `customfield/list` type, used to label the XML custom-field blob. */
  customFieldType?: string;
  description: string;
}

export const RESOURCES: Record<string, ResourceDef> = {
  account: {
    customFieldType: "ACCOUNT",
    base: "/api/v1/account",
    fiscalPeriod: true,
    defaultFields: [
      "number",
      "name",
      "categoryDisplay",
      "accountClass",
      "currencyCode",
      "taxCode",
      "endAmount",
      "isInactive",
    ],
    description: "Accounts in the chart of accounts, with period balances.",
  },
  account_category: {
    base: "/api/v1/account/category",
    defaultFields: ["number", "name", "parentId"],
    description: "Account category tree.",
  },
  costcenter: {
    base: "/api/v1/account/costcenter",
    fiscalPeriod: true,
    defaultFields: ["number", "name", "categoryDisplay", "endAmount"],
    description: "Cost centers.",
  },
  person: {
    customFieldType: "PERSON",
    base: "/api/v1/person",
    defaultFields: [
      "nr",
      "name",
      "company",
      "emailWork",
      "phoneWork",
      "city",
      "countryName",
      "categoryName",
      "isInactive",
    ],
    description: "People and companies: customers, vendors, employees.",
  },
  person_category: {
    base: "/api/v1/person/category",
    defaultFields: ["name", "parentId", "discountPercentage"],
    description: "Person category tree.",
  },
  order: {
    customFieldType: "ORDER",
    base: "/api/v1/order",
    fiscalPeriod: true,
    defaultFields: [
      "nr",
      "date",
      "dateDue",
      "associateName",
      "statusName",
      "total",
      "currencyCode",
      "open",
      "type",
    ],
    description:
      "Orders: invoices, quotes, credit notes, purchase orders. `open` is the unpaid amount.",
  },
  order_category: {
    base: "/api/v1/order/category",
    fiscalPeriod: true,
    defaultFields: ["nameSingular", "namePlural", "type", "bookType", "status"],
    description:
      "Order categories, which decide the document type and booking behaviour.",
  },
  journal: {
    customFieldType: "JOURNAL",
    base: "/api/v1/journal",
    fiscalPeriod: true,
    defaultFields: [
      "dateAdded",
      "title",
      "amount",
      "currencyCode",
      "debitName",
      "creditName",
      "taxCode",
      "reference",
      "associateName",
    ],
    description: "Journal entries (book entries).",
  },
  article: {
    customFieldType: "INVENTORY_ARTICLE",
    base: "/api/v1/inventory/article",
    defaultFields: [
      "nr",
      "name",
      "categoryDisplay",
      "salesPrice",
      "currencyCode",
      "stock",
      "unitName",
      "isInactive",
    ],
    description: "Articles and services in the inventory.",
  },
  asset: {
    customFieldType: "INVENTORY_ASSET",
    base: "/api/v1/inventory/asset",
    fiscalPeriod: true,
    defaultFields: ["nr", "name", "categoryDisplay", "value", "dateAdded"],
    description: "Fixed assets.",
  },
  unit: {
    base: "/api/v1/inventory/unit",
    defaultFields: ["name"],
    description: "Units of measure for articles.",
  },
  file: {
    customFieldType: "FILE",
    base: "/api/v1/file",
    defaultFields: [
      "name",
      "categoryName",
      "mimeType",
      "size",
      "description",
      "isAttached",
    ],
    description: "Files in the file manager.",
  },
  tax: {
    base: "/api/v1/tax",
    defaultFields: [
      "code",
      "documentName",
      "currentPercentage",
      "accountDisplay",
      "isInactive",
    ],
    description: "VAT tax rates.",
  },
  currency: {
    base: "/api/v1/currency",
    defaultFields: ["code", "description", "rate", "isDefault"],
    description: "Currencies and their exchange rates.",
  },
  location: {
    base: "/api/v1/location",
    defaultFields: ["name", "type", "orgName", "city", "country", "vatUid"],
    description: "Organisation locations used on documents.",
  },
  text: {
    base: "/api/v1/text",
    defaultFields: ["name", "type", "isDefault"],
    description: "Reusable text blocks for documents and mails.",
  },
  rounding: {
    base: "/api/v1/rounding",
    defaultFields: ["name", "rounding", "mode", "accountId"],
    description: "Rounding rules.",
  },
  sequencenumber: {
    base: "/api/v1/sequencenumber",
    defaultFields: ["name", "pattern", "currentValue"],
    description:
      "Sequence numbers. Reading is safe; generating one consumes it and is refused.",
  },
  fiscalperiod: {
    base: "/api/v1/fiscalperiod",
    defaultFields: [
      "name",
      "start",
      "end",
      "isCurrent",
      "isClosed",
      "lastEntryDate",
    ],
    description: "Fiscal periods.",
  },
  salary_statement: {
    customFieldType: "SALARY_STATEMENT",
    base: "/api/v1/salary/statement",
    fiscalPeriod: true,
    salary: true,
    defaultFields: ["nr", "date", "datePayment", "personId", "statusId"],
    description: "Salary statements.",
  },
  salary_type: {
    base: "/api/v1/salary/type",
    salary: true,
    defaultFields: ["number", "name", "type", "rate", "isInactive"],
    description: "Salary types (wage components).",
  },
};

export type ResourceName = keyof typeof RESOURCES;

export const RESOURCE_NAMES = Object.keys(RESOURCES) as ResourceName[];

/** One line per resource, for the tool description. */
export function resourceCatalogue(): string {
  return RESOURCE_NAMES.map((name) => `${name}: ${RESOURCES[name].description}`)
    .join("\n");
}
