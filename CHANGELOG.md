# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-05-29

### Added

- **`index-status.mjs`** — fetch sitemap URLs and list those not indexed via Google URL Inspection API (`pnpm run index-status`).
- **`auth.mjs`** — dedicated Google OAuth sign-in (`pnpm run auth`, `--force`).
- **`lib/google-auth.mjs`** — shared OAuth loopback, service account, automatic token refresh on `invalid_grant`.
- **`lib/export-names.mjs`** — site slugs in export filenames (`example-com`, `all`, etc.).
- **`lib/bing-api.mjs`** — Bing Webmaster client: JSON API first, POX/XML fallback on failure (10s JSON timeout).
- **Long-tail:** `--from` / `--to` for fixed Google date windows; `--all-properties` to query every accessible property.
- **Index status:** `--refresh`, `--cache-max-age-days`, per-site JSONL cache with `inspectedAt`.
- **Export naming:** `{kind}-{site-slug}-{dates}.ext` for long-tail; `sitemap-not-indexed-{site-slug}-{date}.ext` for index status.
- **`pnpm` scripts:** `auth`, `index-status`, `help:auth`, `help:index-status`.

### Changed

- **Rename** — scripts and paths no longer use the `gsc-` prefix: `long-tail.mjs`, `auth.mjs`, `index-status.mjs`, `lib/google-auth.mjs`, `lib/export-names.mjs`, `exports/`, `.google-token.json`. Legacy `GSC_*` env vars and old filenames still work as fallbacks.
- **Long-tail** — local calendar dates, uncapped `--limit` (omit or `0`), dated exports include Google range in filename.
- **Bing integration** — moved from inline JSON-only calls to `lib/bing-api.mjs` with JSON→POX fallback (Bing’s `/json/` endpoints often return 503; `/pox/` works with the same API key).
- **README** — full setup, export filename rules, multi-property examples, and Bing API protocol notes.
- **Help text** — inline `--help` documents export patterns, auth, and Bing date caveats.

### Fixed

- **Bing API** — `GetUserSites` / `GetQueryStats` no longer fail when Bing’s JSON endpoints return 503; POX fallback is used automatically.

## [1.0.0] - 2026-04-03

### Added

- Initial long-tail query export (`gsc-long-tail.mjs`): Google Search Console and Bing Webmaster.
- Filters: `--min-words`, impressions, position, `--exclude`.
- Output: `table`, `json`, `csv`; `--export-dated`; `--list-properties`.
- OAuth and Bing API key support.
