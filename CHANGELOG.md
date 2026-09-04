# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is below `1.0.0`, tool names and result shapes may change in
minor releases.

## [Unreleased]

## [0.1.0] - 2026-09-04

First release. Read-only: no tool in this version writes to CashCtrl.

### Added

- 18 tools over the 376-endpoint API: `list_records`, `get_record`, `search`,
  `list_open_invoices`, `get_journal`, `get_account_balance`, `get_report`,
  `download_document`, `review_bank_import`, `review_pending_import`,
  `get_fiscal_period_status`, `get_history`, `validate_year_end`,
  `create_backup`, `backup_changes`, plus `search_api`, `describe_endpoint`
  and `call_api` as a searchable escape hatch for everything not covered.
- Two MCP resources (`cashctrl://org/summary`, `cashctrl://org/chart-of-accounts`)
  and five prompts (`offene-posten`, `monatsabschluss-check`, `bank-abgleich`,
  `mwst-abstimmung`, `jahresabschluss`).
- Incremental SQLite backups with a version history per record, which is the
  record-level history the CashCtrl API does not keep.
- A policy layer that refuses the two GETs which mutate state, refuses
  `fiscalperiod/switch`, gates writes behind `CASHCTRL_MODE=write`, and keeps
  the salary module off unless `CASHCTRL_ENABLE_SALARY=1`.
