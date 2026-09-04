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

```sh
claude mcp add cashctrl \
  --env CASHCTRL_ORGANISATION=myorg \
  --env CASHCTRL_APIKEY=... \
  -- deno run \
     --allow-net=myorg.cashctrl.com,objectstorage.eu-zurich-1.oraclecloud.com \
     --allow-env=CASHCTRL_ORGANISATION,CASHCTRL_APIKEY,CASHCTRL_LANG,CASHCTRL_MODE,CASHCTRL_DOWNLOAD_DIR,CASHCTRL_ENABLE_SALARY \
     --allow-read=$HOME/cashctrl --allow-write=$HOME/cashctrl \
     jsr:@zweiundeins/cashctrl-mcp
```

Or the equivalent in `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "cashctrl": {
      "command": "deno",
      "args": [
        "run",
        "--allow-net=myorg.cashctrl.com,objectstorage.eu-zurich-1.oraclecloud.com",
        "--allow-env=CASHCTRL_ORGANISATION,CASHCTRL_APIKEY,CASHCTRL_LANG,CASHCTRL_MODE,CASHCTRL_DOWNLOAD_DIR,CASHCTRL_ENABLE_SALARY",
        "--allow-read=/Users/me/cashctrl",
        "--allow-write=/Users/me/cashctrl",
        "jsr:@zweiundeins/cashctrl-mcp"
      ],
      "env": {
        "CASHCTRL_ORGANISATION": "myorg",
        "CASHCTRL_APIKEY": "...",
        "CASHCTRL_DOWNLOAD_DIR": "/Users/me/cashctrl"
      }
    }
  }
}
```

The permissions are narrow on purpose. `--allow-net` needs both hosts: CashCtrl
itself, and the object storage its file downloads redirect to. Read and write
are only needed for the directory documents and backups land in — drop them
both if you never use `download_document` or `create_backup`.

Needs Deno 2.x. SQLite comes from `node:sqlite`, which is built in, so there is
no dependency to install and no `--allow-ffi`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CASHCTRL_ORGANISATION` | — | Your subdomain, from `myorg.cashctrl.com` |
| `CASHCTRL_APIKEY` | — | API key for that organisation |
| `CASHCTRL_LANG` | `de` | Language for localized fields and errors |
| `CASHCTRL_MODE` | `read` | `write` unlocks POSTs via `call_api` |
| `CASHCTRL_ENABLE_SALARY` | off | `1` exposes the salary module |
| `CASHCTRL_DOWNLOAD_DIR` | cwd | Where documents and the backup database go |

## Tools

376 endpoints do not fit in a tool list, so this is eighteen curated tools plus a
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
| `validate_year_end` | Runs the arithmetic a close has to satisfy, check by check |
| `create_backup` | Syncs every readable entity into SQLite, incrementally |
| `backup_changes` | What changed between runs, field by field |
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

## Validating a year-end close

`validate_year_end` reports each check as `ok`, `warn`, `fail` or `info`. The
arithmetic was derived from a real closed period rather than from theory:

| Check | What must hold |
| --- | --- |
| `bilanz_balances` | Aktiven − Passiven equals **either 0 or the result** — see below |
| `result_consistent` | Ertrag − Aufwand equals `fiscalperiod/result` |
| `opening_matches_prior_close` | Every balance-sheet account opens where it closed last period |
| `pl_accounts_open_at_zero` | Profit-and-loss accounts carry nothing forward |
| `clearing_accounts_zero` | Durchlauf/Ausgleich/Verrechnung accounts end at zero |
| `depreciations_booked`, `exchange_differences_booked` | Nothing left pending |
| `months_closed` | Which months are still open |
| `unbooked_import_entries` | No staged bank entries left behind |
| `receivables_reconcile`, `payables_reconcile` | Reported, not judged — see below |

**The balance sheet identity changes when the result is booked.** CashCtrl
returns end amounts as positive magnitudes per account class, so an *open*
period shows `Aktiven − Passiven = Ergebnis`, while a *closed* one shows
`Aktiven = Passiven` with the result already inside equity. Checking only the
first form marks every properly closed year as broken; checking only the second
marks every open year as broken. The check accepts either and says which state
it found, and a gap matching neither is the real failure.

**Receivables and payables are reported, not judged.** On real data the naive
identity does not close: credit notes carry an open amount of their own, and
invoices stay open across period boundaries so `order/list` returns them under
every period. The tool shows the open documents, the gross and credit-note-
negated sums, and the account balances, and leaves the comparison to you rather
than raising a false alarm every close.

## Backups, and the versioning CashCtrl does not have

`create_backup` syncs everything readable into a SQLite database and writes a
new version of a record only when its contents actually change. Measured
against the organisation this was built on:

| Run | Time | Entities | Files |
| --- | --- | --- | --- |
| First | 38 s | 1,940 stored | 48 fetched, 57 MB |
| Every run after | 11 s | 1,902 seen, 0 written | 0 fetched, 0 bytes |

The database settles at ~60 MB and then stops growing: consecutive no-op runs
leave it byte-for-byte identical. The 11 seconds are the full id sweep, which
cannot be skipped — `lastUpdated` filtering works, but no filter can reveal a
*deletion*, and an unknown filter field is silently ignored rather than
rejected, so a filter can never be trusted to have applied.

Entities are stored as JSON documents with a content hash rather than typed
columns, because CashCtrl adds and renames fields without announcing it and a
rigid schema would break on the next upstream change.

```sql
entity(resource, entity_id, period_id, hash, doc, first_seen, gone_at)
blob(hash, size, mime, bytes)              -- deduplicated by content
file_version(file_id, hash, name, first_seen, gone_at)
run(id, started_at, seen, created, changed, gone, …)
```

`backup_changes` reads that history back: what was created, changed or removed
between two runs, each field's `from` and `to`, and — with `entityId` — the
full version history of one record. `lastUpdated` is ignored, since it moves
whenever anything else does.

Three things worth knowing:

- **It is an archive, not a restore point.** Ids do not round-trip, creates
  consume sequence numbers, and closed periods reject writes. Nothing here can
  be pushed back into CashCtrl.
- **Generated invoice PDFs are excluded on purpose.** Fetching one appends a
  `DOWNLOAD` entry to the history log, so including them would corrupt the very
  record a backup exists to preserve. Reading file *contents* was measured and
  logs nothing, so the file manager is included — and that is where your
  original bank statement files live.
- **It only knows what it has seen.** History before the first run is gone for
  good; CashCtrl cannot supply it.

SQLite comes from `node:sqlite`, built into Deno, so there is no dependency and
no `--allow-ffi`.

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
deno task test          # 58 tests, no network
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
