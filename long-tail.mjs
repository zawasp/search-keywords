#!/usr/bin/env node
/**
 * Pull search query data from Google Search Console and/or Bing Webmaster and
 * filter for long-tail candidates.
 *
 * For apples-to-apples diffs between runs, pin the Google window with e.g.
 *   --from 2026-01-18 --to 2026-04-18
 * or anchor the end with --to 2026-04-18 --days 90 (same end date + same days).
 * Bing rows from GetQueryStats are aggregated; this script does not filter by date.
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
 *    - To use another port: export GOOGLE_OAUTH_PORT=<port> and add
 *      http://127.0.0.1:<port>/ in the console the same way.
 *
 * 6) Place the client secret JSON where this script can find it (first match wins)
 *    - Set GOOGLE_OAUTH_CLIENT_JSON to the absolute path, OR
 *    - Save as google-oauth-client.json in the project root, OR
 *    - Drop the downloaded JSON in the project root named like client_secret_....json
 *      (if several exist, the newest file by mtime is used).
 *
 * 7) Install deps and sign in from this project root
 *    - pnpm install
 *    - pnpm run auth   (or: node auth.mjs)
 *    - Open the printed URL, sign in, approve access.
 *    - After success, tokens are saved to .google-token.json (refresh token
 *      for later runs without a browser, until revoked or expired per Google rules).
 *    - Expired tokens are deleted automatically; you are prompted to sign in again.
 *
 * 8) Target site / property URL
 *    - Use the exact property string Search Console expects, e.g.:
 *        https://example.com/   or   sc-domain:example.com
 *    - Pass --site <url> or set GOOGLE_SITE_URL in .env / .env.local (loaded from cwd).
 *    - Or pass --all-properties to query every property your account can access.
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
 * Use --all-properties to query every Bing site from GetUserSites.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { google } from "googleapis";
import { config } from "dotenv";
import { withAuthorizedGoogleClient } from "./lib/google-auth.mjs";
import { longTailExportBaseName } from "./lib/export-names.mjs";
import {
  fetchBingQueryStatsRows,
  fetchBingSiteUrls,
  fetchBingUserSites,
} from "./lib/bing-api.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.cwd();
config({ path: path.join(projectRoot, ".env") });
config({ path: path.join(projectRoot, ".env.local") });
const ROW_LIMIT = 25000;

function cliArgs() {
  return process.argv.slice(2).filter((a) => a !== "--");
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** @param {string} s */
function parseYmdLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function wordCount(q) {
  return q.trim().split(/\s+/).filter(Boolean).length;
}

/** @param {string | undefined} raw */
function parseOutputLimit(raw) {
  if (raw == null || String(raw).trim() === "") return Infinity;
  const n = Number(raw);
  if (n === 0) return Infinity;
  if (!Number.isFinite(n) || n < 1) {
    console.error("Invalid --limit: use a positive integer, 0 for no cap, or omit for no cap.");
    process.exit(1);
  }
  return Math.floor(n);
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
      from: { type: "string" },
      to: { type: "string" },
      "min-words": { type: "string", default: "4" },
      "min-impressions": { type: "string", default: "1" },
      "min-position": { type: "string" },
      "max-position": { type: "string" },
      exclude: { type: "string", multiple: true },
      format: { type: "string", default: "table" },
      out: { type: "string" },
      "export-dated": { type: "boolean" },
      "export-dir": { type: "string" },
      limit: { type: "string" },
      help: { type: "boolean", short: "h" },
      "list-properties": { type: "boolean" },
      "all-properties": { type: "boolean" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`Usage: node long-tail.mjs [options]
       or: pnpm run long-tail -- [options]

Options:
  --source <provider>    google|bing|both (default google).
  --list-properties      List properties available for selected provider(s).
  --all-properties       Query every accessible property (ignores --site / --bing-site).
  --site <url>           Google property URL (or GOOGLE_SITE_URL). Required unless --all-properties.
  --bing-site <url>      Bing site URL (or BING_SITE_URL). Required unless --all-properties.
  --bing-api-key <key>   Bing Webmaster API key (or BING_WEBMASTER_API_KEY).
  --days <n>             Lookback window in days (Google only). Default 90. Ignored if both --from and --to are set.
  --from <YYYY-MM-DD>    Start of Google Search Console date range (inclusive). Use with --to for fixed windows.
  --to <YYYY-MM-DD>      End of GSC range (inclusive). With --from: exact window. Without --from: anchor end and go back --days.
  --min-words <n>        Minimum words in query (default 4).
  --min-impressions <n>  Minimum impressions (default 1).
  --min-position <n>     Minimum average position.
  --max-position <n>     Maximum average position.
  --exclude <substring>  Drop queries containing substring (repeatable).
  --format table|json|csv
  --out <file>           Write output to file.
  --export-dated         Write under ./exports/ (see Export filenames below).
  --export-dir <dir>     Directory for --export-dated (default ./exports).
  --limit <n>            Max rows after filtering/sort (omit or 0 = no cap).
  -h, --help             Show this help.

Auth:
  Run pnpm run auth before the first Google export. Expired tokens are removed
  automatically and you are prompted to sign in again (or: pnpm run auth -- --force).

Export filenames (--export-dated):
  <kind>-<site-slug>-<from>_to_<to>.<ext>
  kind:   google-long-tail | bing-long-tail | search-long-tail (depends on --source)
  slug:   property id from --site / --bing-site (e.g. sc-domain:example.com → example-com)
          use "all" for --all-properties, or when --source both with different sites
  Example:
    google-long-tail-example-com-2026-02-27_to_2026-05-28.csv
    search-long-tail-all-2026-02-27_to_2026-05-28.csv

Output columns:
  --source both                    adds source (google|bing)
  --all-properties                 adds site (property URL)
  --source both --all-properties   adds both source and site

Notes:
  --out wins over --export-dated.
  --all-properties skips properties that fail with permission errors and continues.
  Bing GetQueryStats is not date-filtered; use --from/--to only for Google.
`);
    process.exit(0);
  }

  const source = String(values.source || "google").toLowerCase();
  if (!["google", "bing", "both"].includes(source)) {
    console.error("Invalid --source. Use one of: google, bing, both.");
    process.exit(1);
  }

  const listProperties = Boolean(values["list-properties"]);
  const allProperties = Boolean(values["all-properties"]);
  const site = values.site || process.env.GOOGLE_SITE_URL || process.env.GSC_SITE_URL;
  const bingSite = values["bing-site"] || process.env.BING_SITE_URL || site;
  const needsGoogle = !listProperties && (source === "google" || source === "both");
  const needsBing = !listProperties && (source === "bing" || source === "both");

  if (needsGoogle && !allProperties && !site) {
    console.error("Missing --site or GOOGLE_SITE_URL for Google source (or use --all-properties).");
    process.exit(1);
  }
  if (needsBing && !allProperties && !bingSite) {
    console.error("Missing --bing-site (or BING_SITE_URL) for Bing source (or use --all-properties).");
    process.exit(1);
  }

  return {
    source,
    listProperties,
    allProperties,
    site,
    bingSite,
    bingApiKey: values["bing-api-key"] || process.env.BING_WEBMASTER_API_KEY,
    days: Math.max(1, Number(values.days) || 90),
    from: values.from ? String(values.from).trim() : undefined,
    to: values.to ? String(values.to).trim() : undefined,
    minWords: Math.max(1, Number(values["min-words"]) || 4),
    minImpressions: Math.max(0, Number(values["min-impressions"]) || 1),
    minPosition: values["min-position"] != null ? Number(values["min-position"]) : undefined,
    maxPosition: values["max-position"] != null ? Number(values["max-position"]) : undefined,
    exclude: values.exclude || [],
    format: /** @type {"table" | "json" | "csv"} */ (values.format || "table"),
    out: values.out,
    exportDated: Boolean(values["export-dated"]),
    exportDir: values["export-dir"],
    limit: parseOutputLimit(values.limit),
  };
}

/**
 * Resolve Google Search Console [startDate, endDate] (inclusive calendar days, local timezone).
 * @param {{ days: number; from?: string; to?: string }} opts
 */
function resolveGscDateRange(opts) {
  const days = opts.days;
  const fromRaw = opts.from;
  const toRaw = opts.to;

  const todayLocal = () => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  };

  if (fromRaw && toRaw) {
    const start = parseYmdLocal(fromRaw);
    const end = parseYmdLocal(toRaw);
    if (!start) throw new Error(`Invalid --from "${fromRaw}" (expected YYYY-MM-DD).`);
    if (!end) throw new Error(`Invalid --to "${toRaw}" (expected YYYY-MM-DD).`);
    if (start > end) throw new Error("--from must be on or before --to.");
    return { start, end, explicit: true };
  }

  if (toRaw && !fromRaw) {
    const end = parseYmdLocal(toRaw);
    if (!end) throw new Error(`Invalid --to "${toRaw}" (expected YYYY-MM-DD).`);
    const start = new Date(end);
    start.setDate(start.getDate() - days);
    return { start, end, explicit: false };
  }

  if (fromRaw && !toRaw) {
    const start = parseYmdLocal(fromRaw);
    if (!start) throw new Error(`Invalid --from "${fromRaw}" (expected YYYY-MM-DD).`);
    const end = todayLocal();
    if (start > end) throw new Error("--from must be on or before today when --to is omitted.");
    return { start, end, explicit: false };
  }

  const end = todayLocal();
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return { start, end, explicit: false };
}

async function fetchGoogleSiteUrls(webmasters) {
  const res = await webmasters.sites.list({});
  return (res.data.siteEntry || []).map((s) => s.siteUrl).filter(Boolean);
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

function parseBingDate(raw) {
  if (typeof raw !== "string") return null;
  const iso = Date.parse(raw);
  if (Number.isFinite(iso)) return new Date(iso);
  const m = raw.match(/\/Date\((\d+)(?:[+-]\d{4})?\)\//);
  if (!m) return null;
  const ms = Number(m[1]);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

async function fetchBingQueryRows(siteUrl, apiKey) {
  const rows = await fetchBingQueryStatsRows(siteUrl, apiKey);
  const byQuery = new Map();
  for (const row of rows) {
    const query = String(row?.Query || "").trim();
    if (!query) continue;
    const clicks = Number(row?.Clicks || 0) || 0;
    const impressions = Number(row?.Impressions || 0) || 0;
    const rawPos = Number(row?.AvgImpressionPosition ?? row?.AvgClickPosition ?? 0) || 0;
    const date = parseBingDate(row?.Date);

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
    ...(row.site ? { site: row.site } : {}),
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
      await withAuthorizedGoogleClient(async (auth) => {
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
      });
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

  let start;
  let end;
  let gscRangeExplicit = false;
  try {
    const r = resolveGscDateRange(opts);
    start = r.start;
    end = r.end;
    gscRangeExplicit = r.explicit;
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }

  if (gscRangeExplicit) {
    console.error(`Note: --days (${opts.days}) is ignored when both --from and --to are set.`);
  }

  const filtered = [];

  if (includeGoogle) {
    await withAuthorizedGoogleClient(async (auth) => {
      const webmasters = google.webmasters({ version: "v3", auth });
      const googleSites = opts.allProperties
        ? await fetchGoogleSiteUrls(webmasters)
        : [opts.site];

      if (googleSites.length === 0) {
        console.error("No Google properties found.");
        return;
      }

      if (opts.allProperties) {
        console.error(`Fetching Google queries for ${googleSites.length} propert${googleSites.length === 1 ? "y" : "ies"} ...`);
      }

      for (const siteUrl of googleSites) {
        console.error(
          `Fetching Google queries for ${siteUrl} (${ymd(start)} … ${ymd(end)}, inclusive) ...`,
        );
        let rawGoogle = [];
        try {
          rawGoogle = await fetchAllGoogleQueryRows(webmasters, siteUrl, ymd(start), ymd(end));
        } catch (err) {
          const msg = apiErrorMessage(err);
          if (/sufficient permission|not a verified owner|not part of this site/i.test(msg)) {
            if (opts.allProperties) {
              console.error(`Skipped ${siteUrl}: ${msg}`);
              continue;
            }
            console.error(msg);
            console.error(`
The --site string must match a Google Search Console property for your account.
Use:
  pnpm run long-tail -- --source google --list-properties
  pnpm run long-tail -- --all-properties
`);
            process.exit(1);
          }
          throw err;
        }
        console.error(`Fetched ${rawGoogle.length} query rows from Google for ${siteUrl}.`);
        for (const row of rawGoogle) {
          const enriched = {
            ...row,
            query: row.keys?.[0],
            site: opts.allProperties ? siteUrl : undefined,
            source: opts.source === "both" ? "google" : undefined,
          };
          const candidate = applyFilters(enriched, opts);
          if (candidate) filtered.push(candidate);
        }
      }
    });
  }

  if (includeBing) {
    const apiKey = requireBingApiKey(opts);
    const bingSites = opts.allProperties
      ? await fetchBingSiteUrls(apiKey)
      : [opts.bingSite];

    if (bingSites.length === 0) {
      console.error("No Bing sites found.");
    } else {
      if (opts.allProperties) {
        console.error(`Fetching Bing queries for ${bingSites.length} site${bingSites.length === 1 ? "" : "s"} ...`);
      }
      if (includeGoogle) {
        console.error(
          `Note: Bing Webmaster GetQueryStats is not date-filtered in this script; compare Bing rows across runs with care.`,
        );
      }

      for (const siteUrl of bingSites) {
        console.error(`Fetching Bing queries for ${siteUrl} ...`);
        let rawBing = [];
        try {
          rawBing = await fetchBingQueryRows(siteUrl, apiKey);
        } catch (err) {
          console.error(`Skipped ${siteUrl}: ${apiErrorMessage(err)}`);
          continue;
        }
        console.error(`Fetched ${rawBing.length} aggregated query rows from Bing for ${siteUrl}.`);
        for (const row of rawBing) {
          const enriched = {
            ...row,
            site: opts.allProperties ? siteUrl : undefined,
            source: opts.source === "both" ? "bing" : undefined,
          };
          const candidate = applyFilters(enriched, opts);
          if (candidate) filtered.push(candidate);
        }
      }
      console.error("Note: Bing AI/grounding query reporting is not available in the public Webmaster API.");
    }
  }

  filtered.sort((a, b) => b.impressions - a.impressions);
  const sliced = filtered.slice(0, opts.limit);
  const columns = [];
  if (opts.source === "both") columns.push("source");
  if (opts.allProperties) columns.push("site");
  columns.push("query", "words", "impressions", "clicks", "ctr", "position");

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

  const exportDirDefault = path.join(__dirname, "exports");
  const exportBaseName = longTailExportBaseName(opts);

  let outPath = opts.out;
  if (!outPath && opts.exportDated) {
    const dir = opts.exportDir || exportDirDefault;
    const ext = opts.format === "json" ? "json" : opts.format === "csv" ? "csv" : "txt";
    fs.mkdirSync(dir, { recursive: true });
    const rangeSlug = `${ymd(start)}_to_${ymd(end)}`;
    outPath = path.join(dir, `${exportBaseName}-${rangeSlug}.${ext}`);
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
