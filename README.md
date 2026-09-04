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

376 endpoints do not fit in a tool list, so this is nine curated tools plus a
searchable escape hatch for everything else.

| Tool | What it does |
| --- | --- |
| `list_records` | Lists any of 21 resources, with filters, paging and column projection |
| `get_record` | One record by id, every field |
| `search` | One query across people, orders, articles, accounts and journal |
| `list_open_invoices` | Open or overdue orders, sales or purchase |
| `get_journal` | Journal entries for a date range, account or associate |
| `get_account_balance` | Balance of one account at a date |
| `search_api` | Finds endpoints among all 376 by keyword |
| `describe_endpoint` | Full parameter documentation for one endpoint |
| `call_api` | Calls anything the tools above do not cover |

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

## Development

```sh
deno task test          # 31 tests, no network
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

Reports, document downloads, MCP resources and prompts, and every write tool.
Writes need a disposable trial organisation first: creating an order or person
consumes a sequence number permanently, even if the record is deleted again.

## License

MIT
