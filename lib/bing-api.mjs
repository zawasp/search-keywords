const BING_API_ROOT = "https://ssl.bing.com/webmaster/api.svc";
const JSON_TIMEOUT_MS = 10_000;
const jsonFallbackWarned = new Set();

/** @param {string} method */
function warnJsonFallback(method) {
  if (jsonFallbackWarned.has(method)) return;
  jsonFallbackWarned.add(method);
  console.error(`Bing JSON API unavailable for ${method}; using POX fallback.`);
}

/** @param {string} block @param {string} tag */
function xmlText(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : "";
}

/** @param {unknown} value */
function xmlField(value) {
  if (value == null) return "";
  return String(value);
}

/** @param {string} xml */
function parseUserSitesXml(xml) {
  const sites = [];
  const blocks = xml.match(/<Site>[\s\S]*?<\/Site>/g) || [];
  for (const block of blocks) {
    const url = xmlText(block, "Url");
    if (!url) continue;
    sites.push({
      Url: url,
      IsVerified: xmlText(block, "IsVerified").toLowerCase() === "true",
      AuthenticationCode: xmlText(block, "AuthenticationCode"),
      DnsVerificationCode: xmlText(block, "DnsVerificationCode"),
    });
  }
  return sites;
}

/** @param {string} xml */
function parseQueryStatsXml(xml) {
  const rows = [];
  const blocks = xml.match(/<QueryStats>[\s\S]*?<\/QueryStats>/g) || [];
  for (const block of blocks) {
    rows.push({
      Query: xmlText(block, "Query"),
      Clicks: xmlText(block, "Clicks"),
      Impressions: xmlText(block, "Impressions"),
      AvgImpressionPosition: xmlText(block, "AvgImpressionPosition"),
      AvgClickPosition: xmlText(block, "AvgClickPosition"),
      Date: xmlText(block, "Date"),
    });
  }
  return rows;
}

/** @param {unknown} payload */
function parseUserSitesJson(payload) {
  const items = Array.isArray(payload?.d) ? payload.d : [];
  return items
    .map((site) => ({
      Url: xmlField(site?.Url),
      IsVerified: Boolean(site?.IsVerified),
      AuthenticationCode: xmlField(site?.AuthenticationCode),
      DnsVerificationCode: xmlField(site?.DnsVerificationCode),
    }))
    .filter((site) => site.Url);
}

/** @param {unknown} payload */
function parseQueryStatsJson(payload) {
  const items = Array.isArray(payload?.d) ? payload.d : [];
  return items.map((row) => ({
    Query: xmlField(row?.Query),
    Clicks: xmlField(row?.Clicks),
    Impressions: xmlField(row?.Impressions),
    AvgImpressionPosition: xmlField(row?.AvgImpressionPosition),
    AvgClickPosition: xmlField(row?.AvgClickPosition),
    Date: xmlField(row?.Date),
  }));
}

async function fetchBingJson(method, params, apiKey) {
  const url = new URL(`${BING_API_ROOT}/json/${method}`);
  url.searchParams.set("apikey", apiKey);
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null) continue;
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  });
  const body = await res.text();
  let parsed = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    // not JSON
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("non-JSON response");
  }
  if (parsed.ErrorCode) {
    throw new Error(parsed.Message || "unknown error");
  }

  return parsed;
}

async function fetchBingPox(method, params, apiKey) {
  const url = new URL(`${BING_API_ROOT}/pox/${method}`);
  url.searchParams.set("apikey", apiKey);
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null) continue;
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, { headers: { Accept: "application/xml" } });
  const body = await res.text();
  if (!res.ok) {
    const snippet = body.replace(/\s+/g, " ").slice(0, 200);
    throw new Error(
      `Bing API ${method} failed: HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`,
    );
  }

  const faultMessage = xmlText(body, "Message");
  if (/<(?:[a-zA-Z]+:)?Fault/i.test(body) && faultMessage) {
    throw new Error(`Bing API ${method} failed: ${faultMessage}`);
  }

  return body;
}

async function fetchBing(method, params, apiKey, parsers) {
  try {
    const payload = await fetchBingJson(method, params, apiKey);
    return parsers.parseJson(payload);
  } catch {
    warnJsonFallback(method);
    const xml = await fetchBingPox(method, params, apiKey);
    return parsers.parsePox(xml);
  }
}

/** @returns {Promise<Array<{ Url: string; IsVerified: boolean }>>} */
export async function fetchBingUserSites(apiKey) {
  return fetchBing("GetUserSites", {}, apiKey, {
    parseJson: parseUserSitesJson,
    parsePox: parseUserSitesXml,
  });
}

/** @returns {Promise<string[]>} */
export async function fetchBingSiteUrls(apiKey) {
  const sites = await fetchBingUserSites(apiKey);
  return sites.map((s) => s.Url).filter(Boolean);
}

/** @returns {Promise<Array<Record<string, string>>>} */
export async function fetchBingQueryStatsRows(siteUrl, apiKey) {
  return fetchBing("GetQueryStats", { siteUrl }, apiKey, {
    parseJson: parseQueryStatsJson,
    parsePox: parseQueryStatsXml,
  });
}
