# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is below `1.0.0`, tool names and result shapes may change in
minor releases.

## [Unreleased]

### Added

- Four write tools, registered only when `CASHCTRL_MODE=write` and absent
  otherwise: `create_record`, `update_record`, `delete_record` and
  `book_journal_entry`. All preview by default — without `confirm: true` they
  return the exact request they would send and change nothing.
- `update_record` does the read-modify-write CashCtrl's update endpoints
  require. They are full replacements ("all parameters must be submitted,
  omitted parameters are treated as empty values"), so posting one directly with
  two fields clears everything else on the record. The writable field list is
  the update endpoint's own parameter list from the vendored index, not a
  hand-maintained table, so it stays correct as the API moves.
- `book_journal_entry` names accounts by number rather than id, refuses a date
  outside any fiscal period — CashCtrl answers such a date with a silent 0
  rather than an error — and refuses a closed period.
- Unknown field names are refused rather than sent. CashCtrl ignores an
  undocumented parameter silently, so a typo is not an error, it is a write that
  quietly did less than asked.

### Changed

- Depends on `@zweiundeins/cashctrl-ts-sdk` 0.5.0, with `spec/index.json`
  re-vendored from that tag. The index gained two parameters CashCtrl's own
  reference omits — `type` on `customfield/reorder` and
  `customfield/group/reorder` — and 19 whose documented structure the old index
  flattened to TEXT. That matters more here than in the SDK: the index is what
  `search_api` and `describe_endpoint` report, and what `update_record` derives
  its writable field list from, so a stale one described a call that could not
  work.
- `scripts/vendor-index.ts` defaults to the current tag rather than v0.3.0,
  which it had drifted behind.

## [0.1.0] - 2026-09-04

First release. Read-only: no tool in this version writes to CashCtrl.

### Added

- 18 tools over the 376-endpoint API: `list_records`, `get_record`, `search`,
  `list_open_invoices`, `get_journal`, `get_account_balance`, `get_report`,
  `download_document`, `review_bank_import`, `review_pending_import`,
  `get_fiscal_period_status`, `get_history`, `validate_year_end`,
  `create_backup`, `backup_changes`, plus `search_api`, `describe_endpoint` and
  `call_api` as a searchable escape hatch for everything not covered.
- Two MCP resources (`cashctrl://org/summary`,
  `cashctrl://org/chart-of-accounts`) and five prompts (`offene-posten`,
  `monatsabschluss-check`, `bank-abgleich`, `mwst-abstimmung`,
  `jahresabschluss`).
- Incremental SQLite backups with a version history per record, which is the
  record-level history the CashCtrl API does not keep.
- A policy layer that refuses the two GETs which mutate state, refuses
  `fiscalperiod/switch`, gates writes behind `CASHCTRL_MODE=write`, and keeps
  the salary module off unless `CASHCTRL_ENABLE_SALARY=1`.
