# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-05-29

### Added

- **`gsc-sitemap-index-status.mjs`** — fetch sitemap URLs and list those not indexed via GSC URL Inspection API (`pnpm run index-status`).
- **`gsc-login.mjs`** — dedicated Google OAuth sign-in (`pnpm run auth`, `--force`).
- **`lib/gsc-auth.mjs`** — shared OAuth loopback, service account, token refresh on `invalid_grant`.
- **`lib/gsc-export-names.mjs`** — site slugs in export filenames (`example-com`, `all`, etc.).
- **Long-tail:** `--from` / `--to` for fixed GSC date windows; `--all-properties` to query every accessible property.
- **Index status:** `--refresh`, `--cache-max-age-days`, per-site JSONL cache with `inspectedAt`.
- **Export naming:** `{kind}-{site-slug}-{dates}.ext` for long-tail; `sitemap-not-indexed-{site-slug}-{date}.ext` for index status.
- **`pnpm` scripts:** `auth`, `index-status`, `help:auth`, `help:index-status`.
### Changed

- **Long-tail** — local calendar dates, uncapped `--limit` (omit or `0`), dated exports include GSC range in filename.
- **README** — full setup, export filename rules, and multi-property examples.
- **Help text** — inline `--help` documents export patterns, auth, and Bing date caveats.

## [1.0.0] - 2026-04-03

### Added

- Initial **`gsc-long-tail.mjs`**: Google Search Console and Bing Webmaster long-tail query export.
- Filters: `--min-words`, impressions, position, `--exclude`.
- Output: `table`, `json`, `csv`; `--export-dated`; `--list-properties`.
- OAuth and Bing API key support.
