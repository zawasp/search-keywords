# search-keywords

Export and filter long-tail search queries from [Google Search Console](https://search.google.com/search-console) and/or [Bing Webmaster Tools](https://www.bing.com/webmasters). The tool pulls query performance data, applies filters (word count, impressions, position, exclusions), and prints or writes `table`, `json`, or `csv`.

## Requirements

- **Node.js** 18 or newer
- **pnpm** 10 (see `packageManager` in `package.json`)

## Install

From the project root:

```bash
pnpm install
```

Configuration can live in a **`.env`** or **`.env.local`** file in the project root (same directory you run commands from). Variables are loaded automatically by the script.

---

## Google Search Console setup

1. **Google Cloud project** — [Google Cloud Console](https://console.cloud.google.com/) — create or select a project.

2. **Enable the API** — APIs & Services → Library → search for **Google Search Console API** → Enable.

3. **OAuth consent screen** — APIs & Services → OAuth consent screen. For personal use, **External** with yourself as a test user is typical.

4. **OAuth client (browser sign-in)** — Credentials → Create credentials → **OAuth client ID** → application type **Desktop app**.  
   Add this **Authorized redirect URI** (must match exactly):

   ```text
   http://127.0.0.1:39393/
   ```

   If you use a custom port, set `GSC_OAUTH_PORT` and add `http://127.0.0.1:<port>/` in the console.

5. **Client secret JSON** — Download the OAuth client JSON. The script picks the first path that exists:

   | Priority | How |
   |----------|-----|
   | 1 | `GSC_OAUTH_CLIENT_JSON` — absolute path to the JSON file |
   | 2 | `gsc-oauth-client.json` next to `gsc-long-tail.mjs` |
   | 3 | Any `client_secret*.json` in the script directory (newest file wins if several exist) |

6. **First run** — Run `pnpm run list-properties` (or the main script with `--list-properties`). Open the printed URL, sign in, approve access. Tokens are saved to **`.gsc-token.json`** beside the script for later runs without a browser.

7. **Site / property** — Use the exact URL Search Console expects, for example `https://example.com/` or `sc-domain:example.com`. Pass **`--site`** or set **`GSC_SITE_URL`** in `.env`.

**Scope used:** `https://www.googleapis.com/auth/webmasters.readonly`

### Service account (no browser)

1. Create a service account, download its JSON key.
2. `export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/key.json`
3. In Search Console, add that service account email as a user with access to the property.

---

## Bing Webmaster (optional)

1. In Bing Webmaster Tools → **Settings** → **API Access**, create an API key.
2. Pass **`--bing-api-key`** or set **`BING_WEBMASTER_API_KEY`**.
3. Pass **`--bing-site`** or set **`BING_SITE_URL`** (if omitted when using Bing alone, the script still requires a site URL for Bing).

When using **`--source both`**, Bing falls back to **`--site` / `GSC_SITE_URL`** for `bing-site` if `BING_SITE_URL` is not set.

---

## Environment variables (reference)

| Variable | Purpose |
|----------|---------|
| `GSC_SITE_URL` | Default Google property URL |
| `GSC_OAUTH_CLIENT_JSON` | Absolute path to Google OAuth client JSON |
| `GSC_OAUTH_PORT` | Loopback port for OAuth (default `39393`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Service account key path (alternative to OAuth) |
| `BING_WEBMASTER_API_KEY` | Bing Webmaster API key |
| `BING_SITE_URL` | Bing site URL |

---

## npm scripts

Run from the project root. **Extra CLI flags must come after `--`** so they are passed to the script, not to pnpm.

| Command | What it runs |
|---------|----------------|
| `pnpm run long-tail -- [options]` | Main export (default source: Google) |
| `pnpm run list-properties -- [options]` | List Google and/or Bing properties/sites |
| `pnpm run help` | Print CLI help |

Direct invocation (no pnpm):

```bash
node gsc-long-tail.mjs [options]
```

---

## CLI options

| Option | Description |
|--------|-------------|
| `--source <provider>` | `google` \| `bing` \| `both` (default: `google`) |
| `--list-properties` | List properties for the selected provider(s); does not export queries |
| `--site <url>` | Google property URL (or use `GSC_SITE_URL`) |
| `--bing-site <url>` | Bing site URL (or `BING_SITE_URL`; with `both`, can follow `GSC_SITE_URL`) |
| `--bing-api-key <key>` | Bing API key (or `BING_WEBMASTER_API_KEY`) |
| `--days <n>` | Lookback window in days for **Google** only (default: `90`) |
| `--min-words <n>` | Minimum words in the query string (default: `4`) |
| `--min-impressions <n>` | Minimum impressions (default: `1`) |
| `--min-position <n>` | Minimum average position (optional) |
| `--max-position <n>` | Maximum average position (optional) |
| `--exclude <substring>` | Drop queries containing this substring; repeatable |
| `--format <fmt>` | `table`, `json`, or `csv` (default: `table`) |
| `--out <file>` | Write output to this file |
| `--export-dated` | Write under `gsc-exports/` (or `--export-dir`) with a date in the filename |
| `--export-dir <dir>` | Directory for `--export-dated` (default: `./gsc-exports` relative to the script) |
| `--limit <n>` | Max rows after filter/sort (default: `200`) |
| `-h`, `--help` | Show built-in help |

**Notes:**

- **`--out`** wins over **`--export-dated`** if both are set (dated export is ignored).
- With **`--source both`**, the table/JSON/CSV includes a **`source`** column (`google` / `bing`).
- Bing data is aggregated from the Webmaster API; behavior and date ranges differ from Google’s API.

---

## Examples

List Google properties you can access:

```bash
pnpm run list-properties -- --source google
```

List Bing sites (requires API key):

```bash
pnpm run list-properties -- --source bing --bing-api-key YOUR_KEY
```

Long-tail export for Google (site from env or flag):

```bash
pnpm run long-tail -- --site https://example.com/
```

Stricter long-tail: at least 5 words, top 50 by impressions, CSV to a file:

```bash
pnpm run long-tail -- \
  --site https://example.com/ \
  --min-words 5 \
  --limit 50 \
  --format csv \
  --out queries.csv
```

Dated export folder:

```bash
pnpm run long-tail -- --site https://example.com/ --export-dated --format csv
```

Google + Bing together:

```bash
pnpm run long-tail -- \
  --source both \
  --site https://example.com/ \
  --bing-api-key YOUR_KEY
```

---

## Files to keep private

These are gitignored or should stay local:

- `.env`, `.env.local`
- `.gsc-token.json` (OAuth refresh token)
- `gsc-oauth-client.json`, `client_secret*.json`
- Exported outputs (optional): add `gsc-exports/` to `.gitignore` if you do not want those files in version control
