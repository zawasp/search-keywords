# search-keywords

**Version 2.0.0** — see [CHANGELOG.md](CHANGELOG.md).

CLI tools for [Google Search Console](https://search.google.com/search-console) and [Bing Webmaster Tools](https://www.bing.com/webmasters):

- **Long-tail queries** — filter and export search terms (Google date ranges, Bing aggregate stats)
- **Index status** — sitemap URLs not indexed in Google (URL Inspection API)

Shared auth: **`lib/gsc-auth.mjs`** (OAuth loopback, service account, `.gsc-token.json`).

| Script | `pnpm` command | Purpose |
|--------|----------------|---------|
| `gsc-login.mjs` | `auth` | Google OAuth sign-in |
| `gsc-long-tail.mjs` | `long-tail` | Long-tail query export |
| `gsc-sitemap-index-status.mjs` | `index-status` | Sitemap URLs not indexed |

## Requirements

- **Node.js** 24+
- **pnpm** 11 (`packageManager` in `package.json`)

## Quick start

```bash
pnpm install
pnpm run auth
pnpm run list-properties -- --source google
```

Put config in **`.env`** or **`.env.local`** at the project root (loaded automatically).

---

## Google Search Console setup

1. **Google Cloud project** — [Google Cloud Console](https://console.cloud.google.com/).

2. **Enable the API** — APIs & Services → Library → **Google Search Console API** → Enable.

3. **OAuth consent screen** — APIs & Services → OAuth consent screen (**External** + test user is fine for personal use).

4. **OAuth client** — Credentials → **OAuth client ID** → **Desktop app**.  
   Authorized redirect URI (exact):

   ```text
   http://127.0.0.1:39393/
   ```

   Custom port: set `GSC_OAUTH_PORT` and add `http://127.0.0.1:<port>/`.

5. **Client secret JSON** — first match wins:

   | Priority | Path |
   |----------|------|
   | 1 | `GSC_OAUTH_CLIENT_JSON` (absolute path) |
   | 2 | `gsc-oauth-client.json` in project root |
   | 3 | Newest `client_secret*.json` in project root |

6. **Sign in** — `pnpm run auth` (or `pnpm run auth -- --force` to replace a bad token).  
   Token file: **`.gsc-token.json`**. Expired tokens are cleared automatically; scripts prompt you to sign in again.

7. **Property** — `https://example.com/` or `sc-domain:example.com` via **`--site`** or **`GSC_SITE_URL`**.  
   **`--all-properties`** queries every property your account can access (no `--site`).

8. **Sitemap** (index-status only) — **`--sitemap`** or **`GSC_SITEMAP_URL`**.  
   URL-prefix sites default to `{origin}/sitemap-index.xml`.  
   `sc-domain:` properties need an explicit sitemap URL.

**Scope:** `https://www.googleapis.com/auth/webmasters.readonly`

### Service account

1. Download a service account JSON key.
2. `export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`
3. Add the service account email in Search Console for the property.

No browser sign-in; use `pnpm run auth` only to verify access if you use OAuth elsewhere.

---

## Bing Webmaster (optional)

1. Bing Webmaster → **Settings** → **API Access** → API key.
2. **`--bing-api-key`** or **`BING_WEBMASTER_API_KEY`**.
3. **`--bing-site`** or **`BING_SITE_URL`** (or **`--all-properties`** for every Bing site).

With **`--source both`**, Bing uses **`GSC_SITE_URL`** when **`BING_SITE_URL`** is unset.

---

## Export filenames

All dated exports go under **`gsc-exports/`** (gitignored). The **site slug** is derived from the property URL:

| Property | Slug |
|----------|------|
| `sc-domain:example.com` | `example-com` |
| `https://www.example.com/` | `example-com` |

Use **`all`** when **`--all-properties`**, or **`--source both`** with different Google and Bing sites.

### Long-tail (`--export-dated`)

```text
<kind>-<slug>-<from>_to_<to>.<ext>
```

| `--source` | `kind` prefix |
|------------|----------------|
| `google` | `gsc-long-tail` |
| `bing` | `bing-long-tail` |
| `both` | `search-long-tail` |

Examples:

```text
gsc-long-tail-example-com-2026-02-27_to_2026-05-28.csv
search-long-tail-all-2026-02-27_to_2026-05-28.csv
```

### Index status (`--export-dated`, default on)

```text
sitemap-not-indexed-<slug>-YYYY-MM-DD.<ext>
sitemap-index-inspection-cache-<slug>.jsonl   # default --cache-file per property
```

Example: `sitemap-not-indexed-example-com-2026-05-29.csv`

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `GSC_SITE_URL` | Default Google property |
| `GSC_SITEMAP_URL` | Sitemap URL for `index-status` |
| `GSC_OAUTH_CLIENT_JSON` | Path to OAuth client JSON |
| `GSC_OAUTH_PORT` | OAuth loopback port (default `39393`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Service account key |
| `BING_WEBMASTER_API_KEY` | Bing API key |
| `BING_SITE_URL` | Bing site URL |

---

## npm scripts

Pass CLI flags after **`--`**:

| Command | Description |
|---------|-------------|
| `pnpm run auth [-- --force]` | Google OAuth sign-in |
| `pnpm run long-tail -- [options]` | Query export |
| `pnpm run index-status -- [options]` | Sitemap index check |
| `pnpm run list-properties -- [options]` | List GSC/Bing properties |
| `pnpm run help` | Long-tail help |
| `pnpm run help:auth` | Auth help |
| `pnpm run help:index-status` | Index-status help |

```bash
node gsc-login.mjs [--force]
node gsc-long-tail.mjs [options]
node gsc-sitemap-index-status.mjs [options]
```

---

## CLI: auth

| Option | Description |
|--------|-------------|
| `--force`, `-f` | Delete saved token and sign in again |
| `-h`, `--help` | Help |

---

## CLI: long-tail

| Option | Description |
|--------|-------------|
| `--source` | `google` \| `bing` \| `both` (default `google`) |
| `--list-properties` | List properties; no export |
| `--all-properties` | Every accessible property; adds `site` column |
| `--site` | Google property (or `GSC_SITE_URL`) |
| `--bing-site` | Bing site (or `BING_SITE_URL`) |
| `--bing-api-key` | Bing key (or env) |
| `--days` | Google lookback days (default `90`; ignored if `--from` + `--to`) |
| `--from`, `--to` | Fixed GSC date window (`YYYY-MM-DD`) |
| `--min-words` | Min query words (default `4`) |
| `--min-impressions` | Min impressions (default `1`) |
| `--min-position`, `--max-position` | Position filters |
| `--exclude` | Drop queries containing substring (repeatable) |
| `--format` | `table` \| `json` \| `csv` |
| `--out` | Output file (overrides `--export-dated`) |
| `--export-dated` | Write to `gsc-exports/` with site slug in filename |
| `--export-dir` | Export directory (default `./gsc-exports`) |
| `--limit` | Max rows (omit or `0` = no cap) |

**Notes:** `--source both` adds a `source` column. Bing `GetQueryStats` is not date-filtered. Permission errors on individual properties are skipped when using `--all-properties`.

---

## CLI: index status

| Option | Description |
|--------|-------------|
| `--site` | GSC property (or `GSC_SITE_URL`) |
| `--sitemap` | Sitemap URL (or `GSC_SITEMAP_URL`) |
| `--format` | `txt` \| `csv` |
| `--out` | Output file |
| `--export-dated` | Dated filename (default on) |
| `--export-dir` | Default `./gsc-exports` |
| `--limit` | Max URLs to inspect |
| `--concurrency` | Parallel calls (default `8`) |
| `--delay-ms` | Delay per API call |
| `--cache-file` | Per-site JSONL cache |
| `--skip-cached` | Reuse fresh cache (default on) |
| `--cache-max-age-days` | Cache TTL (default `7`) |
| `--refresh` | Re-inspect all URLs |
| `-h`, `--help` | Help |

**Quota:** ~2,000 URL Inspection calls per property per day. Use **`--refresh`** when results must match the GSC UI today.

---

## Examples

```bash
# Auth
pnpm run auth
pnpm run auth -- --force

# List properties
pnpm run list-properties -- --source google
pnpm run list-properties -- --source bing --bing-api-key YOUR_KEY

# Long-tail — single site, fixed window
pnpm run long-tail -- \
  --site sc-domain:example.com \
  --from 2026-02-27 --to 2026-05-28 \
  --export-dated --format csv

# Long-tail — all Google properties
pnpm run long-tail -- --all-properties --export-dated --format csv

# Long-tail — Google + Bing, one site
pnpm run long-tail -- \
  --source both \
  --site https://example.com/ \
  --bing-api-key YOUR_KEY \
  --export-dated

# Index status — domain property
pnpm run index-status -- \
  --site sc-domain:example.com \
  --sitemap https://example.com/sitemap-index.xml \
  --refresh --format csv

# Index status — URL-prefix (sitemap inferred)
pnpm run index-status -- --site https://example.com/
```

---

## Private files (gitignored)

- `.env`, `.env.local`
- `.gsc-token.json`, `gsc-oauth-client.json`, `client_secret*.json`
- `gsc-exports/`
