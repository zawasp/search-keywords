import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Per-site dedupe log of URLs already sent to Google "Request indexing".
 *
 * One append-only TSV per Search Console property (sc-domain:<host>):
 *   data/indexing-submitted/<host>.tsv
 * Columns: timestamp<TAB>url<TAB>result<TAB>source
 *
 * Lives in data/ (tracked in git), not exports/ (gitignored, cleaned up),
 * so the history survives export cleanups and syncs with the repo.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOG_DIR = path.join(__dirname, "..", "data", "indexing-submitted");
export const HEADER = "timestamp\turl\tresult\tsource";

/** Results that count as "already submitted". Anything else (quota, error) is never logged. */
export const SUCCESS_RESULTS = new Set(["INDEXING_REQUESTED"]);

/**
 * Site key (= log filename) from a URL, a host, or a GSC property
 * (sc-domain:example.com / https://www.example.com/). "www." is dropped.
 * @param {string} siteOrUrl
 */
export function siteKey(siteOrUrl) {
  const s = String(siteOrUrl || "").trim().toLowerCase();
  if (!s) throw new Error("siteKey: empty site/url");
  const dom = /^sc-domain:(.+)$/.exec(s);
  let host = dom ? dom[1] : s;
  if (/^https?:\/\//.test(host)) host = new URL(host).hostname;
  host = host.replace(/[/?#].*$/, "").replace(/^www\./, "");
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error(`siteKey: bad host "${siteOrUrl}"`);
  return host;
}

/**
 * Canonical form used in the log: lowercase scheme/host, no fragment,
 * default port dropped. Path/query and the site's own trailing-slash style are kept.
 * @param {string} url
 */
export function normalizeUrl(url) {
  const u = new URL(String(url).trim());
  u.hash = "";
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  return u.href;
}

/**
 * Comparison key: normalized URL with "www." dropped and the trailing slash
 * ignored (except root), so /blog/x and /blog/x/ count as the same page.
 * @param {string} url
 */
export function dedupeKey(url) {
  const u = new URL(normalizeUrl(url));
  u.hostname = u.hostname.replace(/^www\./, "");
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  return u.href;
}

/** @param {string} key @param {string} [dir] */
export function logPathFor(key, dir = DEFAULT_LOG_DIR) {
  return path.join(dir, `${siteKey(key)}.tsv`);
}

/**
 * Load one site's log.
 * @returns {Map<string, {timestamp: string, url: string, result: string, source: string}>} dedupeKey → first entry
 */
export function loadSiteLog(site, dir = DEFAULT_LOG_DIR) {
  const map = new Map();
  const p = logPathFor(site, dir);
  if (!fs.existsSync(p)) return map;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("timestamp\t") || line.startsWith("#")) continue;
    const [timestamp = "", url = "", result = "", source = ""] = line.split("\t");
    if (!/^https?:\/\//i.test(url)) continue;
    const k = dedupeKey(url);
    if (!map.has(k)) map.set(k, { timestamp, url, result, source });
  }
  return map;
}

/** Cache of loaded logs per site (so many lookups don't re-read the file). */
export class IndexingLog {
  constructor(dir = DEFAULT_LOG_DIR) {
    this.dir = dir;
    /** @type {Map<string, Map<string, object>>} */
    this.sites = new Map();
  }

  site(siteOrUrl) {
    const key = siteKey(siteOrUrl);
    if (!this.sites.has(key)) this.sites.set(key, loadSiteLog(key, this.dir));
    return this.sites.get(key);
  }

  /** @returns {object | undefined} existing entry if this URL was already submitted */
  lookup(url) {
    return this.site(url).get(dedupeKey(url));
  }

  has(url) {
    return Boolean(this.lookup(url));
  }

  /**
   * Append after a SUCCESSFUL submission only. Throws on non-success results.
   * With force=false an already-logged URL is not appended again.
   * @returns {boolean} whether a line was written
   */
  record(url, { result = "INDEXING_REQUESTED", timestamp = new Date().toISOString(), source = "", force = false } = {}) {
    if (!SUCCESS_RESULTS.has(result)) {
      throw new Error(`refusing to log non-success result "${result}" for ${url}`);
    }
    const norm = normalizeUrl(url);
    const site = this.site(norm);
    const k = dedupeKey(norm);
    if (site.has(k) && !force) return false;
    const p = logPathFor(norm, this.dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const clean = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").trim();
    const prefix = fs.existsSync(p) && fs.statSync(p).size > 0 ? "" : `${HEADER}\n`;
    fs.appendFileSync(p, `${prefix}${[clean(timestamp), norm, clean(result), clean(source)].join("\t")}\n`, "utf8");
    if (!site.has(k)) site.set(k, { timestamp, url: norm, result, source });
    return true;
  }
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/**
 * Parse a run log (request-log.txt / .tsv / gsc-request-log-*.txt) and return
 * rows whose status is exactly INDEXING_REQUESTED. Every other status
 * (QUOTA_EXCEEDED, ERROR, ALREADY_INDEXED, UNPROCESSED_*, AUTH_NEEDED…) is ignored.
 * Timestamp: an ISO field on the line, else the YYYY-MM-DD in the file path at 00:00 +03:00.
 * @param {string} file
 */
export function parseRequestLog(file) {
  const text = fs.readFileSync(file, "utf8");
  const pathDate = /(\d{4}-\d{2}-\d{2})/.exec(file)?.[1];
  const rows = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\t+|\s+/).map((f) => f.trim()).filter(Boolean);
    // Status = first ALL_CAPS token on the line (notes after it may mention other statuses).
    const status = fields.find((f) => /^[A-Z][A-Z_]{3,}$/.test(f));
    if (status !== "INDEXING_REQUESTED") continue;
    const url = fields.find((f) => /^https?:\/\/[^/]+/i.test(f));
    if (!url) continue;
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (/google\.com$/i.test(host)) continue;
    const ts = fields.find((f) => ISO_RE.test(f));
    const timestamp = ts
      ? new Date(ts.length === 16 ? `${ts}:00+03:00` : ts).toISOString()
      : pathDate
        ? `${pathDate}T00:00:00+03:00`
        : "";
    rows.push({ url, timestamp });
  }
  return rows;
}
