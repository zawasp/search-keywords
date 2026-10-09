#!/usr/bin/env node
/**
 * Per-site dedupe log for GSC "Request indexing" submissions.
 * Logs: data/indexing-submitted/<host>.tsv (see lib/indexing-log.mjs).
 *
 * Google ignores repeat requests, so a URL that was successfully submitted once
 * is skipped by default. Use --force (alias --resubmit) for a deliberate recrawl
 * after a content refresh.
 *
 *   pnpm run indexing-log -- filter  [--force] [--in queue.txt] [--out todo.txt] [urls...]
 *   pnpm run indexing-log -- record  [--force] [--result INDEXING_REQUESTED] [--source note] <urls...>
 *   pnpm run indexing-log -- import  [--force] <request-log files...>
 *   pnpm run indexing-log -- list    [--site sc-domain:example.com]
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_LOG_DIR,
  IndexingLog,
  SUCCESS_RESULTS,
  logPathFor,
  normalizeUrl,
  parseRequestLog,
  siteKey,
} from "./lib/indexing-log.mjs";

const HELP = `Usage: pnpm run indexing-log -- <command> [options]

Commands:
  filter [urls...]     Print URLs NOT yet submitted (stdout, or --out). Skipped ones go to stderr
                       as "SKIPPED_ALREADY_SUBMITTED <url> <first timestamp>". Input: args and/or --in file.
  record <urls...>     Append URLs after a SUCCESSFUL Request indexing (default result
                       INDEXING_REQUESTED). Failed / quota results are refused, never logged.
  import <files...>    Record every INDEXING_REQUESTED row from run logs (request-log.txt/.tsv).
                       QUOTA_EXCEEDED, ERROR, ALREADY_INDEXED, UNPROCESSED_* rows are ignored.
  list                 Counts per site (or entries for --site).

Options:
  --force, --resubmit  filter: keep already-submitted URLs; record/import: log a new line anyway.
  --in <file>          filter: one URL per line (# comments allowed).
  --out <file>         filter: write the to-submit list here instead of stdout.
  --result <status>    record: result to store (only INDEXING_REQUESTED accepted).
  --source <text>      record: free-text note (e.g. run id).
  --site <property>    list: sc-domain:example.com, https://example.com/ or example.com.
  --log-dir <dir>      Override log directory (default ${path.relative(process.cwd(), DEFAULT_LOG_DIR) || DEFAULT_LOG_DIR}).
  -h, --help
`;

const argv = process.argv.slice(2).filter((a) => a !== "--");
const { values, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    force: { type: "boolean", default: false },
    resubmit: { type: "boolean", default: false },
    in: { type: "string" },
    out: { type: "string" },
    result: { type: "string", default: "INDEXING_REQUESTED" },
    source: { type: "string", default: "" },
    site: { type: "string" },
    "log-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [cmd, ...rest] = positionals;
if (values.help || !cmd) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}
const force = values.force || values.resubmit;
const dir = values["log-dir"] ? path.resolve(values["log-dir"]) : DEFAULT_LOG_DIR;
const log = new IndexingLog(dir);

function readUrlFile(f) {
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter((l) => /^https?:\/\//i.test(l));
}

if (cmd === "filter") {
  const urls = [...rest, ...(values.in ? readUrlFile(values.in) : [])];
  const keep = [];
  const seen = new Set();
  let skipped = 0;
  for (const u of urls) {
    const norm = normalizeUrl(u);
    if (seen.has(norm)) continue;
    seen.add(norm);
    const hit = log.lookup(norm);
    if (hit && !force) {
      skipped++;
      console.error(`SKIPPED_ALREADY_SUBMITTED\t${u}\t${hit.timestamp}`);
      continue;
    }
    if (hit && force) console.error(`RESUBMIT_FORCED\t${u}\t(previous ${hit.timestamp})`);
    keep.push(norm);
  }
  const body = keep.join("\n") + (keep.length ? "\n" : "");
  if (values.out) fs.writeFileSync(values.out, body, "utf8");
  else process.stdout.write(body);
  console.error(`${keep.length} to submit, ${skipped} skipped (already submitted)${force ? " [--force]" : ""}.`);
} else if (cmd === "record") {
  if (!SUCCESS_RESULTS.has(values.result)) {
    console.error(`Not logging result "${values.result}": only successful submissions are logged.`);
    process.exit(2);
  }
  let added = 0;
  for (const u of rest) {
    const wrote = log.record(u, { result: values.result, source: values.source, force });
    console.error(`${wrote ? "LOGGED" : "ALREADY_LOGGED"}\t${normalizeUrl(u)}\t${logPathFor(u, dir)}`);
    if (wrote) added++;
  }
  console.error(`${added} new line(s) written.`);
} else if (cmd === "import") {
  const perSite = new Map();
  for (const f of rest) {
    for (const { url, timestamp } of parseRequestLog(f)) {
      const wrote = log.record(url, { timestamp, source: `import:${path.basename(path.dirname(f))}/${path.basename(f)}`, force });
      if (wrote) perSite.set(siteKey(url), (perSite.get(siteKey(url)) || 0) + 1);
    }
  }
  for (const [s, n] of [...perSite].sort()) console.error(`${s}\t+${n}`);
  console.error(`Imported ${[...perSite.values()].reduce((a, b) => a + b, 0)} new URL(s).`);
} else if (cmd === "list") {
  if (values.site) {
    for (const e of log.site(values.site).values()) console.log(`${e.timestamp}\t${e.url}\t${e.result}`);
  } else if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".tsv")).sort()) {
      console.log(`${f.replace(/\.tsv$/, "")}\t${log.site(f.replace(/\.tsv$/, "")).size}`);
    }
  }
} else {
  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  process.exit(1);
}
