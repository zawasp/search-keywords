import path from "node:path";

/**
 * Filename slugs for gsc-exports (site-specific or "all" for --all-properties).
 */

/** @param {string | undefined} siteUrl */
export function siteExportSlug(siteUrl) {
  const s = String(siteUrl || "").trim().toLowerCase();
  if (!s) return "unknown";

  const domain = /^sc-domain:(.+)$/i.exec(s);
  if (domain) return slugify(domain[1]);

  try {
    const u = new URL(s.endsWith("/") ? s : `${s}/`);
    return slugify(u.hostname.replace(/^www\./, ""));
  } catch {
    return slugify(s);
  }
}

/** @param {string} s */
function slugify(s) {
  return (
    s
      .replace(/^https?:\/\//i, "")
      .replace(/[/?#].*$/, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "site"
  );
}

/**
 * @param {{ source: string; site?: string; bingSite?: string; allProperties?: boolean }} opts
 */
export function exportPropertySlug(opts) {
  if (opts.allProperties) return "all";

  if (opts.source === "both") {
    const google = siteExportSlug(opts.site);
    const bing = siteExportSlug(opts.bingSite);
    return google === bing ? google : "all";
  }

  if (opts.source === "bing") return siteExportSlug(opts.bingSite);
  return siteExportSlug(opts.site);
}

/**
 * @param {{ source: string; allProperties?: boolean }} opts
 */
function longTailKindPrefix(opts) {
  if (opts.allProperties) {
    if (opts.source === "google") return "gsc-long-tail";
    if (opts.source === "bing") return "bing-long-tail";
    return "search-long-tail";
  }
  if (opts.source === "google") return "gsc-long-tail";
  if (opts.source === "bing") return "bing-long-tail";
  return "search-long-tail";
}

/**
 * e.g. gsc-long-tail-example-com or search-long-tail-all
 * @param {{ source: string; site?: string; bingSite?: string; allProperties?: boolean }} opts
 */
export function longTailExportBaseName(opts) {
  return `${longTailKindPrefix(opts)}-${exportPropertySlug(opts)}`;
}

/** e.g. sitemap-not-indexed-example-com */
export function indexStatusExportBaseName(siteUrl) {
  return `sitemap-not-indexed-${siteExportSlug(siteUrl)}`;
}

/** Per-property inspection cache path. */
export function defaultIndexStatusCachePath(exportDir, siteUrl) {
  return path.join(exportDir, `sitemap-index-inspection-cache-${siteExportSlug(siteUrl)}.jsonl`);
}
