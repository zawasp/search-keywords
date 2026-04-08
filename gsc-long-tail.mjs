#!/usr/bin/env node
/**
 * Pull search query data from Google Search Console and/or Bing Webmaster and
 * filter for long-tail candidates.
 *
 * =============================================================================
 * GOOGLE SEARCH CONSOLE API — SETUP (step by step)
 * =============================================================================
 *
 * 1) Google Cloud project
 *    - Open https://console.cloud.google.com/ and pick or create a project.
 *
 * 2) Enable the API
 *    - APIs & Services → Library → search “Google Search Console API” → Enable.
 *    - Without this, token exchange or API calls fail with API-not-enabled errors.
 *
 * 3) OAuth consent screen (first time in the project)
 *    - APIs & Services → OAuth consent screen.
 *    - Choose User type (usually “External” for personal / testing).
 *    - Fill app name, support email, scopes are added by the client; for testing you
 *      can add yourself as a test user if the app stays in Testing.
 *
 * 4) Create OAuth client credentials (browser sign-in — typical for local runs)
 *    - APIs & Services → Credentials → Create credentials → OAuth client ID.
 *    - Application type: “Desktop app” (this script uses a loopback redirect).
 *    - Download the JSON. It contains client_id and client_secret under either
 *      “installed” or “web” — both shapes are supported by loadOAuthClientSecrets().
 *
 * 5) Redirect URI (must match what Google sends the user back to)
 *    - Default loopback: http://127.0.0.1:39393/
 *    - In Google Cloud Console, edit the Desktop client and add that exact URI
 *      under “Authorized redirect URIs” if your client type requires it.
 *    - To use another port: export GSC_OAUTH_PORT=<port> and add
 *      http://127.0.0.1:<port>/ in the console the same way.
 *
 * 6) Place the client secret JSON where this script can find it (first match wins)
 *    - Set GSC_OAUTH_CLIENT_JSON to the absolute path, OR
 *    - Save as gsc-oauth-client.json next to this file, OR
 *    - Drop the downloaded JSON in this project directory named like client_secret_....json
 *      (if several exist, the newest file by mtime is used).
 *
 * 7) Install deps and run from this project root
 *    - pnpm install
 *    - pnpm run list-properties   (or: node gsc-long-tail.mjs --list-properties)
 *    - First Google run: a URL is printed; open it, sign in, approve access.
 *    - After success, tokens are saved to .gsc-token.json here (refresh token
 *      for later runs without a browser, until revoked or expired per Google rules).
 *
 * 8) Target site / property URL
 *    - Use the exact property string Search Console expects, e.g.:
 *        https://example.com/   or   sc-domain:example.com
 *    - Pass --site <url> or set GSC_SITE_URL in .env / .env.local (loaded from cwd).
 *    - List what your account can access: --list-properties
 *
 * 9) Alternative: service account (no browser)
 *    - Create a service account, download a JSON key.
 *    - export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/key.json
 *    - In Search Console, add that service account’s email as a user with access
 *      to the property (Owner or Full user as appropriate).
 *
 * Scope used for Google: https://www.googleapis.com/auth/webmasters.readonly
 *
 * =============================================================================
 * BING WEBMASTER (optional; --source bing or both)
 * =============================================================================
 * API key from Bing Webmaster Tools → Settings → API Access.
 * Pass --bing-api-key or set BING_WEBMASTER_API_KEY; site via --bing-site or BING_SITE_URL.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { google } from "googleapis";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.cwd();
config({ path: path.join(projectRoot, ".env") });
config({ path: path.join(projectRoot, ".env.local") });
const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];
const DEFAULT_OAUTH_PORT = 39393;
const TOKEN_PATH = path.join(__dirname, ".gsc-token.json");
const ROW_LIMIT = 25000;
const BING_API_BASE = "https://ssl.bing.com/webmaster/api.svc/json";

function cliArgs() {
  return process.argv.slice(2).filter((a) => a !== "--");
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function wordCount(q) {
  return q.trim().split(/\s+/).filter(Boolean).length;
}

function parseCli() {
  const { values } = parseArgs({
    args: cliArgs(),
    options: {
      source: { type: "string", default: "google" },
      site: { type: "string" },
      "bing-site": { type: "string" },
      "bing-api-key": { type: "string" },
      days: { type: "string", default: "90" },
      "min-words": { type: "string", default: "4" },
      "min-impressions": { type: "string", default: "1" },
      "min-position": { type: "string" },
      "max-position": { type: "string" },
      exclude: { type: "string", multiple: true },
      format: { type: "string", default: "table" },
      out: { type: "string" },
      "export-dated": { type: "boolean" },
      "export-dir": { type: "string" },
      limit: { type: "string", default: "200" },
      help: { type: "boolean", short: "h" },
      "list-properties": { type: "boolean" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`Usage: node gsc-long-tail.mjs [options]
       or: pnpm run long-tail -- [options]

Options:
  --source <provider>    google|bing|both (default google).
  --list-properties      List properties available for selected provider(s).
  --site <url>           Google property URL (or GSC_SITE_URL).
  --bing-site <url>      Bing site URL (or BING_SITE_URL).
  --bing-api-key <key>   Bing Webmaster API key (or BING_WEBMASTER_API_KEY).
  --days <n>             Lookback window in days (Google only). Default 90.
  --min-words <n>        Minimum words in query (default 4).
  --min-impressions <n>  Minimum impressions (default 1).
  --min-position <n>     Minimum average position.
  --max-position <n>     Maximum average position.
  --exclude <substring>  Drop queries containing substring (repeatable).
  --format table|json|csv
  --out <file>           Write output to file.
  --export-dated         Write to gsc-exports/<source>-long-tail-YYYY-MM-DD.<ext>.
  --export-dir <dir>     Directory for --export-dated (default ./gsc-exports).
  --limit <n>            Max rows after filtering/sort (default 200).
  -h, --help             Show this help.
`);
    process.exit(0);
  }

  const source = String(values.source || "google").toLowerCase();
  if (!["google", "bing", "both"].includes(source)) {
    console.error("Invalid --source. Use one of: google, bing, both.");
    process.exit(1);
  }

  const listProperties = Boolean(values["list-properties"]);
  const site = values.site || process.env.GSC_SITE_URL;
  const bingSite = values["bing-site"] || process.env.BING_SITE_URL || site;
  const needsGoogle = !listProperties && (source === "google" || source === "both");
  const needsBing = !listProperties && (source === "bing" || source === "both");

  if (needsGoogle && !site) {
    console.error("Missing --site or GSC_SITE_URL for Google source.");
    process.exit(1);
  }
  if (needsBing && !bingSite) {
    console.error("Missing --bing-site (or BING_SITE_URL) for Bing source.");
    process.exit(1);
  }

  return {
    source,
    listProperties,
    site,
    bingSite,
    bingApiKey: values["bing-api-key"] || process.env.BING_WEBMASTER_API_KEY,
    days: Math.max(1, Number(values.days) || 90),
    minWords: Math.max(1, Number(values["min-words"]) || 4),
    minImpressions: Math.max(0, Number(values["min-impressions"]) || 1),
    minPosition: values["min-position"] != null ? Number(values["min-position"]) : undefined,
    maxPosition: values["max-position"] != null ? Number(values["max-position"]) : undefined,
    exclude: values.exclude || [],
    format: /** @type {"table" | "json" | "csv"} */ (values.format || "table"),
    out: values.out,
    exportDated: Boolean(values["export-dated"]),
    exportDir: values["export-dir"],
    limit: Math.max(1, Number(values.limit) || 200),
  };
}

function discoverClientSecretJsonPath() {
  let files = [];
  try {
    files = fs.readdirSync(__dirname);
  } catch {
    return null;
  }
  const matches = files.filter((f) => /^client_secret.*\.json$/i.test(f));
  if (matches.length === 0) return null;
  if (matches.length === 1) return path.join(__dirname, matches[0]);
  matches.sort(
    (a, b) =>
      fs.statSync(path.join(__dirname, b)).mtimeMs -
      fs.statSync(path.join(__dirname, a)).mtimeMs,
  );
  return path.join(__dirname, matches[0]);
}

function loadOAuthClientSecrets() {
  const orderedPaths = [];
  if (process.env.GSC_OAUTH_CLIENT_JSON) {
    orderedPaths.push(process.env.GSC_OAUTH_CLIENT_JSON);
  }
  orderedPaths.push(path.join(__dirname, "gsc-oauth-client.json"));
  const discovered = discoverClientSecretJsonPath();
  if (discovered) orderedPaths.push(discovered);

  const seen = new Set();
  for (const p of orderedPaths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const c = raw.installed || raw.web;
      if (c?.client_id && c?.client_secret) return c;
    } catch {
      // keep searching
    }
  }
  return null;
}

async function oauthLoopbackAuthorize(oauth2Client, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        const code = url.searchParams.get("code");
        const err = url.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (err) {
          res.end(`<p>Authorization failed: ${err}</p>`);
          server.close(() => reject(new Error(err)));
          return;
        }
        if (!code) {
          res.end("<p>No code in callback.</p>");
          server.close(() => reject(new Error("No authorization code")));
          return;
        }
        res.end("<p>Authorized. You can close this tab.</p>");
        server.close(() => resolve(code));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
    server.listen(port, "127.0.0.1", () => {
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: SCOPES,
      });
      console.error(`Open this URL in a browser:\n${authUrl}\n`);
    });
    server.on("error", reject);
  });
}

async function getAuthorizedClient() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyPath && fs.existsSync(keyPath)) {
    const auth = new google.auth.GoogleAuth({ keyFile: keyPath, scopes: SCOPES });
    return auth.getClient();
  }

  const secrets = loadOAuthClientSecrets();
  if (!secrets) {
    console.error(`No Google credentials found.

OAuth (sign in with browser - recommended for local use):
  - Google Cloud -> APIs & Services -> Credentials -> OAuth client ID -> type "Desktop app"
  - Enable "Google Search Console API" for that project
  - Add redirect URI: http://127.0.0.1:${DEFAULT_OAUTH_PORT}/
  - Download the JSON and either:
      - save as gsc-oauth-client.json next to gsc-long-tail.mjs, or
      - drop client_secret....json in the same directory, or
      - set GSC_OAUTH_CLIENT_JSON=/absolute/path/to/client_secret....json

Service account (no browser):
  - export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
  - add that service account email as user on the GSC property.
`);
    process.exit(1);
  }

  const port = Number(process.env.GSC_OAUTH_PORT) || DEFAULT_OAUTH_PORT;
  const redirectUri = `http://127.0.0.1:${port}/`;
  const oauth2Client = new google.auth.OAuth2(
    secrets.client_id,
    secrets.client_secret,
    redirectUri,
  );

  if (fs.existsSync(TOKEN_PATH)) {
    const t = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    oauth2Client.setCredentials(t);
    return oauth2Client;
  }

  const code = await oauthLoopbackAuthorize(oauth2Client, port);
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8");
  console.error(`Saved refresh token to ${TOKEN_PATH}`);
  return oauth2Client;
}

async function fetchAllGoogleQueryRows(webmasters, siteUrl, startDate, endDate) {
  const rows = [];
  let startRow = 0;
  for (;;) {
    const res = await webmasters.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ["query"],
        rowLimit: ROW_LIMIT,
        startRow,
        dataState: "all",
      },
    });
    const batch = res.data.rows || [];
    rows.push(...batch);
    if (batch.length < ROW_LIMIT) break;
    startRow += ROW_LIMIT;
  }
  return rows;
}

function parseMsDate(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.match(/\/Date\((\d+)(?:[+-]\d{4})?\)\//);
  if (!m) return null;
  const ms = Number(m[1]);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

async function fetchBingJson(method, params, apiKey) {
  const url = new URL(`${BING_API_BASE}/${method}`);
  url.searchParams.set("apikey", apiKey);
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null) continue;
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url);
  const body = await res.text();
  let parsed = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    // keep raw body for fallback
  }
  if (!res.ok) {
    const message = parsed?.Message || body || `Bing API ${method} failed`;
    throw new Error(`Bing API ${method} failed: ${message}`);
  }
  if (parsed?.ErrorCode) {
    throw new Error(`Bing API ${method} failed: ${parsed.Message || "unknown error"}`);
  }
  return parsed;
}

function requireBingApiKey(opts) {
  const key = opts.bingApiKey || process.env.BING_WEBMASTER_API_KEY;
  if (key) return key;
  console.error(`Missing Bing API key.

Set one of:
  - --bing-api-key <key>
  - BING_WEBMASTER_API_KEY=<key>

Generate it in Bing Webmaster Tools -> Settings -> API Access.
`);
  process.exit(1);
}

async function fetchBingQueryRows(siteUrl, apiKey) {
  const payload = await fetchBingJson("GetQueryStats", { siteUrl }, apiKey);
  const rows = Array.isArray(payload?.d) ? payload.d : [];
  const byQuery = new Map();
  for (const row of rows) {
    const query = String(row?.Query || "").trim();
    if (!query) continue;
    const clicks = Number(row?.Clicks || 0) || 0;
    const impressions = Number(row?.Impressions || 0) || 0;
    const rawPos = Number(row?.AvgImpressionPosition ?? row?.AvgClickPosition ?? 0) || 0;
    const date = parseMsDate(row?.Date);

    let agg = byQuery.get(query);
    if (!agg) {
      agg = { query, clicks: 0, impressions: 0, weightedPos: 0, weight: 0, latestDate: null };
      byQuery.set(query, agg);
    }
    agg.clicks += clicks;
    agg.impressions += impressions;
    if (rawPos > 0 && impressions > 0) {
      agg.weightedPos += rawPos * impressions;
      agg.weight += impressions;
    }
    if (!agg.latestDate || (date && date > agg.latestDate)) {
      agg.latestDate = date || agg.latestDate;
    }
  }

  return [...byQuery.values()].map((item) => ({
    query: item.query,
    clicks: item.clicks,
    impressions: item.impressions,
    ctr: item.impressions > 0 ? item.clicks / item.impressions : 0,
    position: item.weight > 0 ? item.weightedPos / item.weight : 0,
  }));
}

async function fetchBingUserSites(apiKey) {
  const payload = await fetchBingJson("GetUserSites", {}, apiKey);
  return Array.isArray(payload?.d) ? payload.d : [];
}

function applyFilters(row, opts) {
  const query = row.query ?? row.keys?.[0];
  if (!query) return null;
  const words = wordCount(query);
  if (words < opts.minWords) return null;

  const impressions = Number(row.impressions ?? row.Impressions ?? 0) || 0;
  if (impressions < opts.minImpressions) return null;

  const position = Number(row.position ?? row.AvgImpressionPosition ?? row.AvgClickPosition ?? 0) || 0;
  if (opts.minPosition != null && position < opts.minPosition) return null;
  if (opts.maxPosition != null && position > opts.maxPosition) return null;

  for (const ex of opts.exclude) {
    if (ex && query.toLowerCase().includes(ex.toLowerCase())) return null;
  }

  const clicks = Number(row.clicks ?? row.Clicks ?? 0) || 0;
  const ctr =
    row.ctr != null || row.Ctr != null
      ? Number(row.ctr ?? row.Ctr) || 0
      : impressions > 0
        ? clicks / impressions
        : 0;

  return {
    ...(row.source ? { source: row.source } : {}),
    query,
    words,
    impressions,
    clicks,
    ctr,
    position,
  };
}

function formatTable(rows, headers) {
  const widths = headers.map((h) => Math.max(h.length, ...rows.map((r) => String(r[h]).length)));
  const line = (obj) => headers.map((h, i) => String(obj[h]).padEnd(widths[i])).join("  ");
  return [line(Object.fromEntries(headers.map((h) => [h, h]))), ...rows.map(line)].join("\n");
}

function csvEscape(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function apiErrorMessage(err) {
  return (
    err?.response?.data?.error?.message ||
    err?.response?.data?.Message ||
    err?.errors?.[0]?.message ||
    err?.message ||
    String(err)
  );
}

async function main() {
  const opts = parseCli();
  const includeGoogle = opts.source === "google" || opts.source === "both";
  const includeBing = opts.source === "bing" || opts.source === "both";

  if (opts.listProperties) {
    if (includeGoogle) {
      const auth = await getAuthorizedClient();
      const webmasters = google.webmasters({ version: "v3", auth });
      const res = await webmasters.sites.list({});
      const sites = res.data.siteEntry || [];
      console.log("Google properties:");
      if (sites.length === 0) {
        console.log("(none)");
      } else {
        for (const s of sites) {
          console.log(`${s.siteUrl}\t${s.permissionLevel || "?"}`);
        }
      }
      console.log("");
    }

    if (includeBing) {
      const apiKey = requireBingApiKey(opts);
      const sites = await fetchBingUserSites(apiKey);
      console.log("Bing sites:");
      if (sites.length === 0) {
        console.log("(none)");
      } else {
        for (const s of sites) {
          const url = s?.Url;
          if (!url) continue;
          console.log(`${url}\t${s.IsVerified ? "verified" : "not-verified"}`);
        }
      }
      console.log("");
    }
    return;
  }

  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - opts.days);

  const filtered = [];

  if (includeGoogle) {
    const auth = await getAuthorizedClient();
    const webmasters = google.webmasters({ version: "v3", auth });
    console.error(
      `Fetching Google queries for ${opts.site} (${ymd(start)} ... ${ymd(end)}) ...`,
    );
    let rawGoogle = [];
    try {
      rawGoogle = await fetchAllGoogleQueryRows(webmasters, opts.site, ymd(start), ymd(end));
    } catch (err) {
      const msg = apiErrorMessage(err);
      if (/sufficient permission|not a verified owner|not part of this site/i.test(msg)) {
        console.error(msg);
        console.error(`
The --site string must match a Google Search Console property for your account.
Use:
  pnpm run long-tail -- --source google --list-properties
`);
        process.exit(1);
      }
      throw err;
    }
    console.error(`Fetched ${rawGoogle.length} query rows from Google.`);
    for (const row of rawGoogle) {
      const enriched = {
        ...row,
        query: row.keys?.[0],
        source: opts.source === "both" ? "google" : undefined,
      };
      const candidate = applyFilters(enriched, opts);
      if (candidate) filtered.push(candidate);
    }
  }

  if (includeBing) {
    const apiKey = requireBingApiKey(opts);
    console.error(`Fetching Bing queries for ${opts.bingSite} ...`);
    const rawBing = await fetchBingQueryRows(opts.bingSite, apiKey);
    console.error(`Fetched ${rawBing.length} aggregated query rows from Bing.`);
    for (const row of rawBing) {
      const enriched = opts.source === "both" ? { ...row, source: "bing" } : row;
      const candidate = applyFilters(enriched, opts);
      if (candidate) filtered.push(candidate);
    }
    console.error("Note: Bing AI/grounding query reporting is not available in the public Webmaster API.");
  }

  filtered.sort((a, b) => b.impressions - a.impressions);
  const sliced = filtered.slice(0, opts.limit);
  const columns =
    opts.source === "both"
      ? ["source", "query", "words", "impressions", "clicks", "ctr", "position"]
      : ["query", "words", "impressions", "clicks", "ctr", "position"];

  console.error(`Long-tail matches (after filters): ${filtered.length}. Showing ${sliced.length}.`);

  let output;
  if (opts.format === "json") {
    output = JSON.stringify(sliced, null, 2);
  } else if (opts.format === "csv") {
    output = [columns.join(","), ...sliced.map((r) => columns.map((c) => csvEscape(r[c])).join(","))].join(
      "\n",
    );
  } else {
    output = formatTable(sliced, columns);
  }

  const exportDirDefault = path.join(__dirname, "gsc-exports");
  const exportBaseName =
    opts.source === "google" ? "gsc-long-tail" : opts.source === "bing" ? "bing-long-tail" : "search-long-tail";

  let outPath = opts.out;
  if (!outPath && opts.exportDated) {
    const dir = opts.exportDir || exportDirDefault;
    const ext = opts.format === "json" ? "json" : opts.format === "csv" ? "csv" : "txt";
    fs.mkdirSync(dir, { recursive: true });
    outPath = path.join(dir, `${exportBaseName}-${ymd(new Date())}.${ext}`);
  }

  if (opts.out && opts.exportDated) {
    console.error("Note: --out takes precedence; --export-dated ignored.");
  }

  if (outPath) {
    fs.writeFileSync(outPath, output + "\n", "utf8");
    console.error(`Wrote ${outPath}`);
  } else {
    process.stdout.write(output + (output.endsWith("\n") ? "" : "\n"));
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
