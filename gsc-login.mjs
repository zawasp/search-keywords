#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "dotenv";
import { google } from "googleapis";
import { authenticateGoogle, TOKEN_PATH } from "./lib/gsc-auth.mjs";

const projectRoot = process.cwd();
config({ path: path.join(projectRoot, ".env") });
config({ path: path.join(projectRoot, ".env.local") });

function printHelp() {
  console.log(`Sign in to Google Search Console and save OAuth tokens.

Usage:
  pnpm run auth [-- --force]
  node gsc-login.mjs [--force]

Options:
  --force, -f  Delete any saved token and sign in again
  --help, -h   Show this help

Tokens are saved to ${TOKEN_PATH}.
Service accounts use GOOGLE_APPLICATION_CREDENTIALS instead (no browser sign-in).

On success, lists how many GSC properties your account can access.
Expired or revoked tokens (invalid_grant) are deleted automatically; other
scripts will prompt you to sign in again, or run with --force here.
`);
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      force: { type: "boolean", short: "f", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  const { auth, mode, reused } = await authenticateGoogle({ force: values.force });

  if (mode === "service_account") {
    console.log("Using service account from GOOGLE_APPLICATION_CREDENTIALS.");
  } else if (reused) {
    console.log(`Already authorized. Token file: ${TOKEN_PATH}`);
  } else {
    console.log(`Authorized. Saved token to ${TOKEN_PATH}`);
  }

  const webmasters = google.webmasters({ version: "v3", auth });
  const res = await webmasters.sites.list({});
  const count = res.data.siteEntry?.length ?? 0;
  console.log(
    `Verified: ${count} Google Search Console propert${count === 1 ? "y" : "ies"} accessible.`,
  );
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
