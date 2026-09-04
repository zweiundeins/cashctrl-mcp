# cashctrl-mcp — plan

An MCP server for the CashCtrl accounting API, built on
[`@zweiundeins/cashctrl-ts-sdk`](https://github.com/zweiundeins/cashctrl-ts-sdk)
(v0.3.0, published to JSR and npm).

Status: **phase 1 done** — 9 read tools, verified against a live organisation.
See [README.md](README.md). Phase 2 next.

---

## 1. Do we have a usable spec?

Yes. `cashctrl-ts-sdk/spec/openapi.json` is an OpenAPI 3.1 document covering all
**376 endpoints**, valid under `redocly lint`, plus a typed SDK generated from
it. That is a far better starting point than the HTML reference.

| Artefact | What it gives us |
| --- | --- |
| `spec/api.json` (907 KB) | scraped endpoint + parameter IR, 849 params |
| `spec/openapi.json` (1.9 MB) | OpenAPI 3.1, 376 ops (192 POST / 184 GET) |
| `spec/responses.json` (761 KB) | live-probed response shapes, 95 endpoints |
| `src/generated/resources.ts` | 62 typed resource classes, 64 `updatePreserving` |
| `.github/workflows/upstream.yml` | weekly re-scrape → PR when upstream moves |

Caveats that carry straight into the MCP:

- **Request params are authoritative, responses are not.** Only 95/376
  endpoints (25%) have probed response shapes, from a single organisation.
  Unprobed fields are `unknown`.
- ~~Every response is declared `application/json`~~ — **fixed in phase 0.** All
  59 file endpoints now carry their real media type. The same fix also caught
  four endpoints the *SDK* got wrong (`file.get()`, `domain.current.logo()`,
  `order.payment.download()`, `salary.payment.download()` were parsing PDFs as
  JSON).
- **No `$ref` reuse** — response schemas are inlined per endpoint, which is why
  the file is 1.9 MB. Phase 0 added `spec/index.json` (376 endpoints, 2134
  params, prose capped at 200 chars, 450 KB): searchable in memory, still far
  too big to dump into a conversation.
- **0% of write paths have ever been executed** against a live server. Orders,
  journal entries, persons and articles are typechecked and contract-tested
  only. An MCP with write tools is the first thing that would really exercise
  them.

## 2. The core design problem

376 endpoints, and a practical budget of roughly **20–25 tools** before tool
descriptions crowd out the conversation. So: no 1:1 endpoint mapping, and no
generated tool-per-endpoint.

The shape that fits is **curated tools for the 90% + a searchable escape
hatch for the tail**:

1. A dozen or so hand-written, semantically meaningful tools for what people
   actually ask an accounting system.
2. `search_api` / `describe_endpoint` / `call_api` over the compact index, so
   the remaining ~350 endpoints stay reachable without costing context until
   they are needed.

### Proposed tool surface

**Discovery + escape hatch (3)**

| Tool | Notes |
| --- | --- |
| `search_api` | keyword search over the compact endpoint index; returns path, method, summary, param names |
| `describe_endpoint` | full parameter docs for one path |
| `call_api` | arbitrary path + params. GET always; POST only in write mode, and only with `confirm: true` |

**Read (7)**

| Tool | Notes |
| --- | --- |
| `list_records` | resource enum (account, person, order, journal, article, asset, file, tax, currency, costcenter, location, text, fiscalperiod, …) + `query`, `filter`, `limit`, `start`, `fields`, `fiscalPeriodId` |
| `get_record` | resource + id, full entity |
| `search` | fulltext fan-out across persons / orders / articles / accounts / journal |
| `list_open_invoices` | `order/list` with `onlyOpen` / `onlyOverdue`, SALES or PURCHASE |
| `get_journal` | date range, account, associate; the workhorse for "what did we book on 6500 in Q2" |
| `get_account_balance` | `account/balance` by number or id, at a date |
| `get_report` | `report/tree` + `report/element/data` — balance sheet, P&L, per period or date range |

**Documents (2)** — never base64 into the conversation.

| Tool | Notes |
| --- | --- |
| `download_document` | order/salary PDF or ZIP → writes to a configured directory, returns a path + MCP `resource_link` |
| `get_file` | file id → local path (follows the redirect to object storage) |

**Write (4, off by default)**

| Tool | Notes |
| --- | --- |
| `create_order` | invoice/quote with items; `dry_run: true` by default, echoes the resolved payload |
| `create_journal_entry` | same pattern; refuses closed fiscal periods |
| `update_record` | read-modify-write via the SDK's `updatePreserving` — never a raw `update` |
| `set_status` | order/salary status transitions (book, sent, paid) |

**MCP resources** (cheap context primers, fetched on demand rather than pushed):
`cashctrl://org/chart-of-accounts`, `cashctrl://org/summary` (fiscal periods,
tax codes, order categories, currencies), `cashctrl://spec/openapi.json`.

**MCP prompts**: `offene-posten`, `monatsabschluss-check`, `mwst-abstimmung`.

### Response shaping — the thing that decides whether this is usable

Entities are wide: `order/list` returns **78 fields per row**, `order/read` 89,
`person/list` 76, `journal/list` 53. The API's default `limit` is 100. So a
naive `order/list` is ~7,800 fields in one response — tens of thousands of
tokens, and most MCP clients truncate around ~25k anyway.

Therefore, non-negotiable in the read layer:

- A per-resource **default field set** (~8–12 columns), with `fields: "*"` to
  opt out.
- `limit` defaulted low (25), `total` always reported, and an explicit
  `next_start` hint so paging is obvious.
- Localized XML (`<values><de>Kasse</de>…</values>`) resolved to the configured
  language via the SDK's `localize()` before the model ever sees it.
- Custom fields (also XML, `<values><customField1>…`) resolved against
  `customfield/list`, cached per session.
- Null/empty fields dropped from output.

## 3. Stolpersteine

### API semantics

1. **Updates are full replacements.** The docs are explicit: omitted parameters
   are treated as empty. `order.update({id, items})` wipes description, notes,
   due days, everything. Only ever expose `updatePreserving` /
   `mergeUpdate(existing, changes, WRITABLE_FIELDS)`. This is the single
   biggest data-loss footgun in the API.
2. **HTTP 200 on validation failure**, with `success: false`. The SDK promotes
   this to `CashCtrlValidationError`; the MCP must surface `err.byField()` as
   structured, actionable text so the model can correct itself instead of
   retrying blindly.
3. **Sequence numbers are consumed on create and never returned on delete.**
   Creating an order, person, article or salary statement burns the next
   number; deleting the record leaves a permanent gap in audit-relevant
   invoice numbering. An LLM "just trying" a create is not free.
4. **The SDK retries POSTs** (3 attempts, on 429/408/5xx *and on network
   errors*). A create that timed out server-side but actually succeeded gets
   retried → duplicate invoice, two sequence numbers burnt. Write tools must
   construct the client with `retry: { attempts: 0 }` and, on ambiguous
   failure, verify via a list query on `nr`/`reference` rather than retrying.
5. **Two GET endpoints have side effects**: `fiscalperiod/reopen_months.json`
   (reopens closed months) and `sequencenumber/get` (consumes a number). They
   must be on a hard deny list even in read-only mode — "it's a GET" is not a
   safety property here. Phase 0 exported this list from the SDK as
   `SIDE_EFFECTING_GETS` / `isSideEffectingGet()`; import it rather than
   re-deriving it.
6. **`fiscalperiod/switch` mutates server-side state** for the whole
   organisation, not just our session — a human in the UI sees the period
   change under them. But it cannot simply be banned: looking at last year is a
   normal question. The resolution is that it is almost never needed —

   - **46 endpoints take the period explicitly** as `fiscalPeriodId` or
     `fiscalPeriod`, including everything that matters for historical reads:
     `account/list` (with its opening/closing balances), `journal/list`,
     `order/list`, `report/element/data`, `report/collection/*`,
     `salary/statement/list`, `inventory/asset/list`. Always pass it.
   - **The four that look period-ambient are not.** `account/balance` and
     `account/costcenter/balance` take a `date` that resolves the period
     containing it — measured, §7. `fiscalperiod/exchangediff` takes `id`
     (fiscal period) or `date`; it only looked ambient because its parameter is
     called `id` rather than `fiscalPeriodId`. That leaves
     `fiscalperiod/depreciations`, whose `id` is undocumented and untestable in
     this org.

   So **no read needs the switch**, it stays on the deny list in read mode, and
   no borrow-and-restore helper is needed in v1.

   The trap that replaces it: **a date in no defined fiscal period returns `0`,
   not an error.** Validate every date against `fiscalperiod/list` before
   calling, and state in the response which period the number came from.
7. **Rate limits are undocumented.** The reference says only "too many
   requests hit the API too quickly, we recommend adding delays" and points at
   the ToS — no published numbers, no `X-RateLimit-*` headers. Fan-out tools
   (`search` across five resources) need a conservative client-side throttle,
   e.g. a small concurrency cap plus a minimum inter-request gap, and must
   honour `Retry-After`.
8. **File upload is three steps**: `file/prepare` → HTTP `PUT` to a
   pre-authenticated Oracle object-storage URL → `file/persist`. And `file/get`
   *redirects* to storage. Any attachment tooling needs redirect handling and
   real filesystem access, not just the SDK.
9. **The API is form-encoded although it returns JSON**, with its own
   conventions: `true`/`false` as strings, dates as `YYYY-MM-DD`, CSV params
   comma-joined, JSON params as JSON *strings*, `null` meaning "clear".
   The SDK handles this — but `call_api` passes user-supplied params through,
   so it must serialize via `serializeParam`, never `JSON.stringify` the lot.
10. **One API user = one organisation**, with the permissions of its assigned
    role. Multi-org means multiple keys and an `organisation` parameter or
    multiple server instances.

### Spec / SDK quality

11. **Do not emit `outputSchema`** for endpoints whose response shape was never
    probed (281 of 376). MCP clients validate `structuredContent` against the
    declared schema, so a wrong schema turns a working call into a hard error.
    Emit output schemas only for the probed 95, or for none at all initially.
12. **Upstream changes without announcement.** The SDK's weekly re-scrape is
    the early-warning system; the MCP should depend on a pinned SDK version and
    treat spec drift as a normal PR, not an incident.
13. **Write paths are unproven.** Phase 3 needs a disposable trial
    organisation. Do not develop write tools against real books — see
    Stolperstein 3.

### Legal / data protection

14. **The salary module is 90 of the 376 endpoints** and contains special-category
    personal data: AHV numbers, insurance member numbers, individual salaries.
    Ship it **off by default** behind an explicit `--enable-salary`, and say so
    in the README.
15. **Journal writes are VAT-relevant bookkeeping** under Swiss retention rules
    (GeBüV / OR 957a). Everything the MCP writes carries the API user's name in
    the CashCtrl audit trail. Recommend a dedicated MCP API user so its actions
    are distinguishable from a human's.
16. **The real safety boundary is the CashCtrl role**, not our flags. The
    README should lead with "create a read-only API user", because a read-only
    role makes every guardrail below it redundant — and unlike our code, it
    cannot be argued around by a model.
17. **Customer and employee data leaves for the model provider** on every call.
    Worth one honest paragraph in the README rather than silence.

### MCP client reality

18. **Elicitation is not universally supported.** Don't design write
    confirmation around it. Use an in-band two-phase pattern: `dry_run: true`
    by default returning the resolved payload, then an explicit second call.
19. **Tool annotations (`readOnlyHint`, `destructiveHint`) are advisory.**
    Set them, but enforce in `policy.ts`.
20. **Response size caps** in clients (~25k tokens) mean truncation must be
    ours and explicit, with the remaining `total` stated, not the client's
    silent cut.

## 4. Architecture

```
/develop/cashctrl-mcp
  deno.json                  Deno-first, dnt → npm (same pipeline as the SDK)
  src/
    server.ts                stdio MCP server
    client.ts                SDK wiring, per-organisation, retry policy per mode
    policy.ts                mode gating, deny list, write confirmation, module toggles
    format.ts                field projection, localize, custom fields, paging, truncation
    tools/
      discovery.ts           search_api, describe_endpoint, call_api
      read.ts                list_records, get_record, search, list_open_invoices, get_journal
      report.ts              get_report, get_account_balance
      documents.ts           download_document, get_file
      write.ts               create_order, create_journal_entry, update_record, set_status
    resources.ts             cashctrl:// MCP resources
    prompts.ts
    spec/index.json          generated, committed (~126 KB)
  scripts/build-index.ts     openapi.json → compact index
  tests/
  README.md
```

**Runtime: Deno + `dnt` npm build**, matching `cashctrl-ts-sdk`. Reasons: same
toolchain as the SDK we depend on, `npx -y @zweiundeins/cashctrl-mcp` for
everyone else via dnt, and Deno's permission model
(`--allow-net=myorg.cashctrl.com --allow-env=CASHCTRL_*`) is a genuine
containment layer for a process holding accounting credentials.

Note: **deno is not installed in this dev container** (node 24 is). Either
install it, or the fallback is a plain Node/tsdown project — which costs the
permission model and the toolchain symmetry.

**Configuration**

```
CASHCTRL_ORGANISATION   subdomain
CASHCTRL_APIKEY         per-organisation API key
CASHCTRL_LANG           de | fr | it | en   (default de)
CASHCTRL_MODE           read | write        (default read)
CASHCTRL_DOWNLOAD_DIR   where documents land
CASHCTRL_ENABLE_SALARY  off by default
```

## 5. Phases

| Phase | Scope | Notes |
| --- | --- | --- |
| 0 | ~~Upstream spec fixes in `cashctrl-ts-sdk`~~ | **done, released as 0.3.0**: 59 file endpoints carry real media types, 4 broken SDK methods fixed, `SIDE_EFFECTING_GETS` exported, `spec/index.json` + `deno task index` added |
| 1 | ~~Skeleton + read tools + `format.ts` + policy/deny list~~ | **done**: 9 tools, 31 tests, smoke-tested read-only against `zweiundeinsgmbh` |
| 2 | Reports, documents, MCP resources and prompts | |
| 3 | Write mode, against a **disposable trial organisation only** | first live exercise of the SDK's write paths |
| 4 | Packaging (dnt → npm), CI, README, `claude mcp add` instructions | |

## 6. Decisions

- **Runtime: Deno + dnt → npm**, same as `cashctrl-ts-sdk`. Deno needs
  installing in this container first.
- **Writes ship, behind `CASHCTRL_MODE=write`** with `dry_run` defaults.
  Phase 3 needs a disposable trial organisation.
- **`fiscalperiod/switch` is denied in read mode.** Settled by the measurement
  in §7: every read can target a period explicitly, so the switch buys nothing.

Still open:

- ~~Vendor the compact index vs generate it~~ — settled: the SDK generates and
  commits `spec/index.json`, but `spec/` is not published to npm or JSR, so the
  MCP vendors it from GitHub at build time. No change to the SDK's package
  contents, and the weekly upstream PR keeps it current.
- **Multi-organisation**: one server per org (simple, matches the one-key-one-org
  API model) vs an `organisation` param on every tool.
- **`fiscalperiod/depreciations`**: does its `id` mean the fiscal period?
  Undocumented and unresolved (§7). If not, it is the single endpoint that
  would still need a switch.

## 7. Measured against a live organisation

Read-only GETs against `zweiundeinsgmbh`, 2026-09-04. No writes, no switch.

The org's **current fiscal period is 2025 (id 1) although it is September
2026** — which is itself the argument for never trusting the ambient period.

`GET /api/v1/account/balance?id=…&date=…`, cross-checked against
`account/list?fiscalPeriodId=…` closing amounts:

| account | no date | 2025-06-30 | 2025-12-31 | 2026-09-04 | 2026-12-31 | 2024-12-31 |
| --- | --- | --- | --- | --- | --- | --- |
| 1020 UBS | 8454.54 | 874.53 | 8454.54 | 6187.47 | 6187.47 | **0** |
| 3200 Handelsertrag | 0 | 0 | 0 | 14269.82 | 14269.82 | **0** |
| 3400 Dienstleistungsertrag | 110160.04 | 59185.23 | 110160.04 | 35494.30 | 35494.30 | **0** |

1. **`date` crosses fiscal periods.** The 2026 columns match
   `account/list?fiscalPeriodId=2` exactly, even though the current period is
   2025. No switch required.
2. **It resolves the period containing the date, then computes as-of within
   it** — it is not cumulative since inception. P&L account 3200 reads 0 for
   every 2025 date and 14269.82 for 2026 dates.
3. **A date outside every defined fiscal period returns `0`, silently.**
   2024-12-31 yields 0 on all three accounts rather than an error. This is the
   worst failure mode in the whole read surface: a plausible number, wrong,
   with no signal. Validate dates against `fiscalperiod/list` first.
4. **`account/balance` returns a bare JSON number**, not the `{success, data}`
   envelope — worth a note where response handling is generic.
5. `account/costcenter/balance` takes the identical `date` parameter, so it
   behaves the same by construction. Unverified: this org has 0 cost centers.
6. `fiscalperiod/exchangediff` accepts `id` (fiscal period) **or** `date`, so it
   was never ambient — the earlier classification was wrong because its
   parameter is called `id`, not `fiscalPeriodId`.
7. `fiscalperiod/depreciations` accepts `id`, documented only as "the ID of the
   entry". This org has no depreciations, so all three calls returned 0 rows and
   the question stands.
