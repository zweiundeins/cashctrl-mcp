# cashctrl-mcp

An MCP server for the [CashCtrl](https://cashctrl.com) accounting API, built on
[`@zweiundeins/cashctrl-ts-sdk`](https://github.com/zweiundeins/cashctrl-ts-sdk).

Read-only today: nine tools over the 376-endpoint API. See [PLAN.md](PLAN.md)
for the design and the full list of Stolpersteine it works around.

> Unofficial and not affiliated with CashCtrl.

## Setup

Create an API user in CashCtrl under **Settings > Users & Roles > Add > Add API
user**. The key is scoped to one organisation and inherits the role you give
it — **assign a read-only role**. That role, not this server's `CASHCTRL_MODE`,
is the boundary that actually holds.

```jsonc
// claude_desktop_config.json, or `claude mcp add`
{
  "mcpServers": {
    "cashctrl": {
      "command": "deno",
      "args": ["run", "--allow-net", "--allow-env", "--allow-read",
               "jsr:@zweiundeins/cashctrl-mcp"],
      "env": {
        "CASHCTRL_ORGANISATION": "myorg",
        "CASHCTRL_APIKEY": "..."
      }
    }
  }
}
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `CASHCTRL_ORGANISATION` | — | Your subdomain, from `myorg.cashctrl.com` |
| `CASHCTRL_APIKEY` | — | API key for that organisation |
| `CASHCTRL_LANG` | `de` | Language for localized fields and errors |
| `CASHCTRL_MODE` | `read` | `write` unlocks POSTs via `call_api` |
| `CASHCTRL_ENABLE_SALARY` | off | `1` exposes the salary module |
| `CASHCTRL_DOWNLOAD_DIR` | cwd | For the document tools (not yet built) |

## Tools

376 endpoints do not fit in a tool list, so this is fifteen curated tools plus a
searchable escape hatch for everything else.

| Tool | What it does |
| --- | --- |
| `list_records` | Lists any of 21 resources, with filters, paging and column projection |
| `get_record` | One record by id, every field |
| `search` | One query across people, orders, articles, accounts and journal |
| `list_open_invoices` | Open or overdue orders, sales or purchase |
| `get_journal` | Journal entries for a date range, account or associate |
| `get_account_balance` | Balance of one account at a date |
| `get_report` | Lists the available reports, or renders one for a period |
| `review_bank_import` | Reviews how imported bank statements were booked |
| `review_pending_import` | Shows what executing a staged import would do, before it runs |
| `get_fiscal_period_status` | Result, closed months, pending depreciations and FX differences |
| `get_history` | CashCtrl's activity log: who changed what, when |
| `download_document` | Invoices, salary documents, reports and files, written to disk |
| `search_api` | Finds endpoints among all 376 by keyword |
| `describe_endpoint` | Full parameter documentation for one endpoint |
| `call_api` | Calls anything the tools above do not cover |

## Resources and prompts

Two resources carry context an agent would otherwise spend several calls
rediscovering, and cost nothing until read:

- `cashctrl://org/summary` — fiscal periods, currencies, tax codes, order
  categories, locations
- `cashctrl://org/chart-of-accounts` — every account with number, class and tax
  code

Five prompts wrap recurring work: `offene-posten`, `monatsabschluss-check`,
`bank-abgleich`, `mwst-abstimmung` and `jahresabschluss`. Each one tells the
model to establish the fiscal period before reading anything that depends on
it, and to name write steps as tasks rather than attempt them.

## The change history

`history/list.json` is documented as taking only `orderId`, `personId` and
`statementId`, which undersells it. On a live organisation it covers **26
entity types** — orders, book entries, salary statements, journal imports,
accounts, tax rates, fiscal periods, files, master data — with seven change
types (`CREATE`, `UPDATE`, `DELETE`, `STATUS`, `IMPORTED`, `DOWNLOAD`, `SEND`),
and the generic `filter` array works on `created`, `type`, `changeType` and
`createdBy`. `get_history` uses all of that.

Two limits worth knowing:

- **It is an activity log, not a diff.** An `UPDATE` says a record changed, not
  which field or from what value to what. For before-and-after you would need
  your own snapshots.
- **Downloading an order or salary document appends a `DOWNLOAD` entry**
  attributed to your API key. It does not modify the order record — the
  `downloaded` marker stays as the UI left it — but `download_document` is not
  invisible.

## What it guards against

The CashCtrl API has a few behaviours that produce confident wrong answers
rather than errors. These are handled, and each is covered by a test:

- **The "current" fiscal period is whatever a human last clicked.** It is not
  necessarily this year — the organisation this was built against sat on 2025
  throughout September 2026. Endpoints that accept a period get one explicitly,
  and `get_journal` derives it from the date range instead of inheriting the
  UI's. Without that, asking for January 2026 quietly returns December 2025.
- **A date in no fiscal period returns `0`, not an error.** `get_account_balance`
  refuses such a date and lists the periods that do exist.
- **Two GETs mutate state** — `sequencenumber/get` consumes a number,
  `fiscalperiod/reopen_months` reopens closed months. Both are refused in every
  mode, as is `fiscalperiod/switch`, which would move the current period for
  every user of the organisation.
- **Entities are 33 to 89 fields wide.** Lists return a per-resource column
  subset by default and say so; `fields: ["*"]` opts out.
- **Localized fields are XML blobs**, sometimes embedded in a longer string
  (`"1100 <values><de>Debitoren</de>…</values>"`). Both forms are resolved to
  `CASHCTRL_LANG`.
- **Responses can be enormous.** Results are cut here, with the count and
  `next_start` stated, rather than truncated silently by the client.
- **Filter bounds `gt`/`lt` include the boundary day.** Measured, not
  documented, so `get_journal`'s dates are inclusive at both ends.
- **Report rows carry 30-odd display fields per node**, half of them
  `dc`-prefixed duplicates. `get_report` follows the report's own
  `properties.columns` for what to show and what to call it, rather than
  guessing.
- **A booking with no tax code is usually fine.** Only 3 of 147 accounts in
  the organisation this was built against define a default tax code, so
  `review_bank_import` flags a missing one only where the contra account
  itself expects it, and reports the rest as an aggregate rather than 60 rows
  of noise.
- **Entries staged by an import but never booked are invisible in the
  journal.** They are counted on the import side and reported separately.
- **Executing a bank import can close customer invoices.** CashCtrl matches
  incoming payments against open invoices when the import is *created*, and
  the matched entry carries the target status. `review_pending_import` lists
  which invoices an execute would close, and with what status, before it
  happens.
- **Documents never enter the conversation.** They are written to
  `CASHCTRL_DOWNLOAD_DIR` and returned as a path and a resource link. Filenames
  chosen by the server are sanitised to a basename first, so a
  `Content-Disposition` cannot write outside that directory.

## Development

```sh
deno task test          # 48 tests, no network
deno task check         # typecheck, lint, format
deno task smoke         # read-only, against a live organisation (needs .env)
deno task vendor:spec   # refresh spec/index.json from a tagged SDK release
```

`spec/index.json` is the SDK's compact endpoint index, vendored because `spec/`
is not part of the published package. `spec/VERSION` records the tag it came
from.

`deno.json` sets `"minimumDependencyAge": "0"` only because the SDK release this
depends on is newer than Deno's 24-hour default. Remove that line once 0.3.0 has
aged past it.

## Not yet built

Every write tool. Writes need a disposable trial organisation first: creating
an order or person consumes a sequence number permanently, even if the record
is deleted again.

### Bank statement import

Uploading bank statements **is** possible through the API
even though nothing here does it yet: `file/prepare` returns pre-authenticated
URLs, the bytes go up with a plain `PUT`, `file/persist` saves them, and
`journal/import/create` stages the entries. CashCtrl accepts camt.052, camt.053,
camt.054, MT940, Excel and CSV, including inside a ZIP, up to 5 MB. Nothing is
booked until `journal/import/execute` runs, so the staging half is comparatively
safe — but it still writes.

The payment matching that closes customer invoices is done by CashCtrl at
`journal/import/create`, not by the web UI: there is no matching endpoint
anywhere in the 376, and staged entries come back with `orderId`, the contra
account and the target `orderStatusId` already filled in. So an API import
should match exactly as the UI does. Until that is proven against a trial
organisation, upload in the UI and use `review_pending_import` to check the
matches before executing.

## License

MIT
