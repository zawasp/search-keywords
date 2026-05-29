#!/usr/bin/env node
/**
 * Fetch URLs from a sitemap and list those not indexed in Google
 * (via Search Console URL Inspection API).
 *
 * Prerequisites: same Google OAuth setup as long-tail.mjs
 * (pnpm run auth, .google-token.json, lib/google-auth.mjs, etc.).
 *
 * Quota: ~2,000 URL Inspection calls per property per day, ~600/minute.
 * There is no batch inspect endpoint — parallel requests are used instead
 * (default --concurrency 8). Use --concurrency 1 --delay-ms 120 for serial mode.
 *
 * Cache: results are stored in JSONL with inspectedAt. By default, cache entries
 * older than 7 days (or without inspectedAt) are re-fetched. Stale cache caused
 * false "not indexed" rows when GSC had indexed the URL since the last run.
 * Use --refresh for a fully up-to-date export.
 *
 * Usage:
 *   pnpm run index-status -- --sitemap https://example.com/sitemap-index.xml
 *   pnpm run index-status -- --limit 5
 *   pnpm run index-status -- --refresh --format csv
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { google } from "googleapis";
import { config } from "dotenv";
import { withAuthorizedGoogleClient } from "./lib/google-auth.mjs";
import {
  defaultIndexStatusCachePath,
  indexStatusExportBaseName,
} from "./lib/export-names.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.cwd();
config({ path: path.join(projectRoot, ".env") });
config({ path: path.join(projectRoot, ".env.local") });

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_DELAY_MS = 0;
const DEFAULT_CACHE_MAX_AGE_DAYS = 7;
const MAX_RETRIES = 4;
const EXPORT_DIR = path.join(__dirname, "exports");

function cliArgs() {
  return process.argv.slice(2).filter((a) => a !== "--");
}

function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string | undefined} site GSC property URL */
function resolveSitemapUrl(site, explicit) {
  if (explicit) return explicit;
  const fromEnv = process.env.GOOGLE_SITEMAP_URL || process.env.GSC_SITEMAP_URL;
  if (fromEnv) return fromEnv;
  if (site && /^https?:\/\//i.test(site)) {
    const base = site.endsWith("/") ? site : `${site}/`;
    return new URL("sitemap-index.xml", base).href;
  }
  return undefined;
}

/** @param {string} xml */
function extractLocs(xml) {
  const locs = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) locs.push(m[1].trim());
  return locs;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/** @param {string} sitemapUrl */
async function collectSitemapUrls(sitemapUrl) {
  const xml = await fetchText(sitemapUrl);
  const locs = extractLocs(xml);
  const isIndex = /<sitemapindex[\s>]/i.test(xml);

  if (isIndex) {
    const nested = await Promise.all(locs.map((loc) => collectSitemapUrls(loc)));
    return [...new Set(nested.flat())];
  }

  return [...new Set(locs)];
}

/**
 * Whether a cached inspection row is still fresh enough to reuse.
 * Rows without inspectedAt are always stale (legacy cache from before timestamps).
 * @param {{ inspectedAt?: string }} row
 * @param {number} maxAgeDays 0 = never reuse cache
 */
function isCacheFresh(row, maxAgeDays) {
  if (maxAgeDays <= 0) return false;
  const at = row?.inspectedAt;
  if (!at) return false;
  const ms = Date.now() - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 0) return false;
  return ms < maxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * Indexed if URL Inspection verdict is PASS or coverage clearly says indexed.
 * @param {Record<string, unknown> | undefined} indexStatus
 */
function isUrlIndexed(indexStatus) {
  if (!indexStatus) return false;

  const verdict = String(indexStatus.verdict || "");
  const coverage = String(indexStatus.coverageState || "");
  const lower = coverage.toLowerCase();

  if (verdict === "PASS") return true;

  if (
    lower.startsWith("indexed") ||
    lower.includes("submitted and indexed") ||
    lower === "indexed"
  ) {
    return true;
  }

  const notIndexedHints = [
    "not indexed",
    "unknown to google",
    "duplicate",
    "redirect",
    "excluded",
    "blocked",
    "noindex",
    "forbidden",
    "soft 404",
    "not found",
    "page with redirect",
    "crawled - currently not indexed",
    "discovered - currently not indexed",
  ];
  if (notIndexedHints.some((hint) => lower.includes(hint))) return false;

  if (verdict === "FAIL" || verdict === "NEUTRAL") return false;

  return false;
}

function parseCli() {
  const { values } = parseArgs({
    args: cliArgs(),
    options: {
      site: { type: "string" },
      sitemap: { type: "string" },
      out: { type: "string" },
      "export-dated": { type: "boolean", default: true },
      "export-dir": { type: "string" },
      format: { type: "string", default: "txt" },
      limit: { type: "string" },
      concurrency: { type: "string", default: String(DEFAULT_CONCURRENCY) },
      "delay-ms": { type: "string", default: String(DEFAULT_DELAY_MS) },
      "cache-file": { type: "string" },
      "skip-cached": { type: "boolean", default: true },
      "cache-max-age-days": { type: "string", default: String(DEFAULT_CACHE_MAX_AGE_DAYS) },
      refresh: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`Usage: node index-status.mjs [options]
       or: pnpm run index-status -- [options]

Fetches all URLs from the sitemap, calls GSC URL Inspection for each, and
writes URLs that are not indexed.

Options:
  --site <url>           Google property (or GOOGLE_SITE_URL). URL-prefix needs trailing /.
  --sitemap <url>        Sitemap or sitemap index URL (or GOOGLE_SITEMAP_URL).
                         For URL-prefix properties, defaults to <site>sitemap-index.xml.
                         Required for sc-domain: properties unless GOOGLE_SITEMAP_URL is set.
  --out <file>           Output path (overrides --export-dated).
  --export-dated         Dated file under ./exports/ (default on when --out omitted).
  --export-dir <dir>     Export directory (default ./exports).
  --format txt|csv       txt = one URL per line; csv includes verdict and coverage.
  --limit <n>            Inspect at most N URLs (for testing).
  --concurrency <n>      Parallel inspections in flight (default ${DEFAULT_CONCURRENCY}; max ~600/min).
  --delay-ms <n>         Extra pause before each API call (default ${DEFAULT_DELAY_MS}; use with --concurrency 1).
  --cache-file <path>    JSONL cache per site (default exports/sitemap-index-inspection-cache-<site>.jsonl).
  --skip-cached          Reuse recent cache hits instead of calling the API (default on).
  --no-skip-cached       Re-inspect every URL (same as --refresh).
  --cache-max-age-days <n>  Max cache age when --skip-cached (default ${DEFAULT_CACHE_MAX_AGE_DAYS}).
                            Entries without inspectedAt are always re-fetched.
  --refresh              Re-inspect all URLs (--no-skip-cached, --cache-max-age-days 0).
  -h, --help             Show this help.

Export filenames (--export-dated, default on):
  sitemap-not-indexed-<site-slug>-YYYY-MM-DD.<ext>
  cache (default): sitemap-index-inspection-cache-<site-slug>.jsonl
  slug from --site (e.g. sc-domain:example.com → example-com)
  Example: sitemap-not-indexed-example-com-2026-05-29.csv

Notes:
  Reusing stale cache can list URLs as not indexed after GSC has indexed them.
  Use --refresh for an up-to-date export, or --format csv to see inspectedAt per row.

Auth:
  Run pnpm run auth before the first run. Expired tokens are removed automatically
  and you are prompted to sign in again (or: pnpm run auth -- --force).
`);
    process.exit(0);
  }

  const site = values.site || process.env.GOOGLE_SITE_URL || process.env.GSC_SITE_URL;
  if (!site) {
    console.error("Missing --site or GOOGLE_SITE_URL.");
    process.exit(1);
  }

  const sitemap = resolveSitemapUrl(site, values.sitemap);
  if (!sitemap) {
    console.error(
      "Missing --sitemap or GOOGLE_SITEMAP_URL (required for sc-domain: properties; URL-prefix sites default to sitemap-index.xml).",
    );
    process.exit(1);
  }

  const format = String(values.format || "txt").toLowerCase();
  if (!["txt", "csv"].includes(format)) {
    console.error("Invalid --format. Use txt or csv.");
    process.exit(1);
  }

  const limitRaw = values.limit;
  const limit =
    limitRaw == null || String(limitRaw).trim() === ""
      ? Infinity
      : Math.max(1, Math.floor(Number(limitRaw) || 0));

  const concurrency = Math.max(1, Math.floor(Number(values.concurrency) || DEFAULT_CONCURRENCY));

  const refresh = values.refresh === true;
  const skipCached = refresh ? false : values["skip-cached"] !== false;
  const cacheMaxAgeDays = refresh
    ? 0
    : Math.max(0, Number(values["cache-max-age-days"]) || DEFAULT_CACHE_MAX_AGE_DAYS);

  return {
    site,
    sitemap,
    out: values.out,
    exportDated: values["export-dated"] !== false,
    exportDir: values["export-dir"] || EXPORT_DIR,
    format,
    limit,
    concurrency,
    delayMs: Math.max(0, Number(values["delay-ms"]) || DEFAULT_DELAY_MS),
    cacheFile:
      values["cache-file"] || defaultIndexStatusCachePath(EXPORT_DIR, site),
    skipCached,
    cacheMaxAgeDays,
  };
}

function loadCache(cachePath) {
  /** @type {Map<string, object>} */
  const map = new Map();
  if (!fs.existsSync(cachePath)) return map;
  const lines = fs.readFileSync(cachePath, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.url) map.set(row.url, row);
    } catch {
      // ignore bad lines
    }
  }
  return map;
}

function appendCache(cachePath, row) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.appendFileSync(cachePath, `${JSON.stringify(row)}\n`, "utf8");
}

/** Serialize cache appends when running parallel workers. */
function createCacheWriter(cachePath) {
  let chain = Promise.resolve();
  return (row) => {
    chain = chain.then(() => appendCache(cachePath, row));
    return chain;
  };
}

function apiErrorMessage(err) {
  return (
    err?.response?.data?.error?.message ||
    err?.errors?.[0]?.message ||
    err?.message ||
    String(err)
  );
}

function isQuotaError(err) {
  const status = err?.response?.status ?? err?.code;
  const msg = apiErrorMessage(err);
  return status === 429 || /quota|rate limit|resource exhausted/i.test(msg);
}

async function inspectUrl(searchconsole, siteUrl, inspectionUrl) {
  const res = await searchconsole.urlInspection.index.inspect({
    requestBody: {
      inspectionUrl,
      siteUrl,
    },
  });
  const indexStatus = res.data?.inspectionResult?.indexStatusResult;
  return {
    url: inspectionUrl,
    inspectedAt: new Date().toISOString(),
    indexed: isUrlIndexed(indexStatus),
    verdict: indexStatus?.verdict ?? "",
    coverageState: indexStatus?.coverageState ?? "",
    indexingState: indexStatus?.indexingState ?? "",
    lastCrawlTime: indexStatus?.lastCrawlTime ?? "",
    googleCanonical: indexStatus?.googleCanonical ?? "",
  };
}

async function inspectUrlWithRetry(searchconsole, siteUrl, inspectionUrl) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await inspectUrl(searchconsole, siteUrl, inspectionUrl);
    } catch (err) {
      lastErr = err;
      if (!isQuotaError(err) || attempt === MAX_RETRIES) throw err;
      const backoffMs = Math.min(60_000, 1000 * 2 ** attempt);
      console.error(
        `Rate limited on ${inspectionUrl}; retry ${attempt + 1}/${MAX_RETRIES} in ${backoffMs}ms`,
      );
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

/**
 * Run async tasks with a fixed concurrency limit.
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<void>} worker
 */
async function runPool(items, concurrency, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

function csvEscape(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeOutput(rows, format, outPath) {
  let body;
  if (format === "csv") {
    const headers = [
      "url",
      "inspectedAt",
      "verdict",
      "coverageState",
      "indexingState",
      "lastCrawlTime",
      "googleCanonical",
    ];
    body = [
      headers.join(","),
      ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(",")),
    ].join("\n");
  } else {
    body = rows.map((r) => r.url).join("\n");
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body + (body ? "\n" : ""), "utf8");
}

async function main() {
  const opts = parseCli();

  console.error(`Loading sitemap: ${opts.sitemap}`);
  const allUrls = await collectSitemapUrls(opts.sitemap);
  allUrls.sort();
  console.error(`Found ${allUrls.length} URL(s) in sitemap.`);

  const urlsToCheck = allUrls.slice(0, opts.limit);
  if (urlsToCheck.length < allUrls.length) {
    console.error(`Limiting inspection to ${urlsToCheck.length} URL(s) (--limit).`);
  }

  const cache = loadCache(opts.cacheFile);

  await withAuthorizedGoogleClient(async (auth) => {
  const searchconsole = google.searchconsole({ version: "v1", auth });
  const writeCache = createCacheWriter(opts.cacheFile);

  const notIndexed = [];
  let skippedFresh = 0;
  let skippedStale = 0;
  const pending = [];

  for (const url of urlsToCheck) {
    const cached = cache.get(url);
    if (opts.skipCached && cached && isCacheFresh(cached, opts.cacheMaxAgeDays)) {
      skippedFresh++;
      if (!cached.indexed) notIndexed.push(cached);
      continue;
    }
    if (cached) skippedStale++;
    pending.push(url);
  }

  console.error(
    `Inspecting ${pending.length} URL(s) with concurrency ${opts.concurrency}` +
      (opts.delayMs > 0 ? ` (+${opts.delayMs}ms delay per call)` : "") +
      (skippedFresh ? `; ${skippedFresh} fresh cache hit(s)` : "") +
      (skippedStale ? `; ${skippedStale} stale/missing cache → re-inspect` : "") +
      (opts.skipCached ? ` (cache max age ${opts.cacheMaxAgeDays}d)` : "") +
      ".",
  );

  let inspected = 0;
  let completed = skippedFresh;
  let quotaAborted = false;

  await runPool(pending, opts.concurrency, async (url) => {
    if (quotaAborted) return;

    if (opts.delayMs > 0) await sleep(opts.delayMs);

    let row;
    try {
      row = await inspectUrlWithRetry(searchconsole, opts.site, url);
    } catch (err) {
      const msg = apiErrorMessage(err);
      if (isQuotaError(err)) {
        quotaAborted = true;
        console.error(`\nQuota or rate limit after ${inspected} inspection(s): ${msg}`);
        console.error("Partial results will be written. Re-run later; cache preserves progress.");
        return;
      }
      console.error(`Failed ${url}: ${msg}`);
      row = {
        url,
        inspectedAt: new Date().toISOString(),
        indexed: false,
        verdict: "ERROR",
        coverageState: msg,
        indexingState: "",
        lastCrawlTime: "",
        googleCanonical: "",
      };
    }

    inspected++;
    cache.set(url, row);
    await writeCache(row);
    if (!row.indexed) notIndexed.push(row);

    completed++;
    if (completed % 20 === 0 || completed === urlsToCheck.length) {
      console.error(
        `Progress: ${completed}/${urlsToCheck.length} (${inspected} inspected, ${skippedFresh} from cache, ${notIndexed.length} not indexed)`,
      );
    }
  });

  const ext = opts.format === "csv" ? "csv" : "txt";
  const exportBase = indexStatusExportBaseName(opts.site);
  let outPath = opts.out;
  if (!outPath && opts.exportDated) {
    fs.mkdirSync(opts.exportDir, { recursive: true });
    outPath = path.join(opts.exportDir, `${exportBase}-${ymd()}.${ext}`);
  }
  if (!outPath) {
    outPath = path.join(opts.exportDir, `${exportBase}.${ext}`);
  }

  writeOutput(notIndexed, opts.format, outPath);

  console.error(`\nDone. ${notIndexed.length} not-indexed URL(s) written to ${outPath}`);
  console.error(`Cache: ${opts.cacheFile}`);
  });
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
