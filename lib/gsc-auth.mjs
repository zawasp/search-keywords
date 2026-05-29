import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectDir = path.join(__dirname, "..");
export const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];
export const DEFAULT_OAUTH_PORT = 39393;
export const TOKEN_PATH = path.join(projectDir, ".gsc-token.json");

function discoverClientSecretJsonPath() {
  let files = [];
  try {
    files = fs.readdirSync(projectDir);
  } catch {
    return null;
  }
  const matches = files.filter((f) => /^client_secret.*\.json$/i.test(f));
  if (matches.length === 0) return null;
  if (matches.length === 1) return path.join(projectDir, matches[0]);
  matches.sort(
    (a, b) =>
      fs.statSync(path.join(projectDir, b)).mtimeMs -
      fs.statSync(path.join(projectDir, a)).mtimeMs,
  );
  return path.join(projectDir, matches[0]);
}

function loadOAuthClientSecrets() {
  const orderedPaths = [];
  if (process.env.GSC_OAUTH_CLIENT_JSON) {
    orderedPaths.push(process.env.GSC_OAUTH_CLIENT_JSON);
  }
  orderedPaths.push(path.join(projectDir, "gsc-oauth-client.json"));
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

async function obtainOAuthTokens(oauth2Client, port) {
  const code = await oauthLoopbackAuthorize(oauth2Client, port);
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8");
  return oauth2Client;
}

function createOAuth2Client(secrets, port) {
  const redirectUri = `http://127.0.0.1:${port}/`;
  return new google.auth.OAuth2(secrets.client_id, secrets.client_secret, redirectUri);
}

function printMissingCredentialsHelp() {
  console.error(`No Google credentials found.

OAuth (sign in with browser - recommended for local use):
  - Google Cloud -> APIs & Services -> Credentials -> OAuth client ID -> type "Desktop app"
  - Enable "Google Search Console API" for that project
  - Add redirect URI: http://127.0.0.1:${DEFAULT_OAUTH_PORT}/
  - Download the JSON and either:
      - save as gsc-oauth-client.json in the project root, or
      - drop client_secret....json in the project root, or
      - set GSC_OAUTH_CLIENT_JSON=/absolute/path/to/client_secret....json

Service account (no browser):
  - export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
  - add that service account email as user on the GSC property.
`);
}

function isInvalidGrantError(err) {
  const message = err?.message || String(err);
  const responseError = err?.response?.data?.error;
  return message.includes("invalid_grant") || responseError === "invalid_grant";
}

function clearSavedToken() {
  if (fs.existsSync(TOKEN_PATH)) {
    fs.unlinkSync(TOKEN_PATH);
  }
}

async function ensureOAuth2Client(secrets, port, { force = false } = {}) {
  const oauth2Client = createOAuth2Client(secrets, port);

  if (force) {
    clearSavedToken();
  }

  if (!force && fs.existsSync(TOKEN_PATH)) {
    oauth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
    try {
      await oauth2Client.getAccessToken();
      return { auth: oauth2Client, reused: true };
    } catch (err) {
      if (!isInvalidGrantError(err)) throw err;
      console.error("Saved Google token expired or revoked. Sign in again.");
      clearSavedToken();
    }
  }

  const auth = await obtainOAuthTokens(oauth2Client, port);
  console.error(`Saved refresh token to ${TOKEN_PATH}`);
  return { auth, reused: false };
}

/**
 * Sign in via OAuth (or validate service account). Use force to replace a saved token.
 * @returns {Promise<{ auth: import("google-auth-library").JSONClient, mode: "oauth" | "service_account", reused?: boolean }>}
 */
export async function authenticateGoogle({ force = false } = {}) {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyPath && fs.existsSync(keyPath)) {
    const auth = new google.auth.GoogleAuth({ keyFile: keyPath, scopes: SCOPES });
    return { auth: await auth.getClient(), mode: "service_account" };
  }

  const secrets = loadOAuthClientSecrets();
  if (!secrets) {
    printMissingCredentialsHelp();
    process.exit(1);
  }

  const port = Number(process.env.GSC_OAUTH_PORT) || DEFAULT_OAUTH_PORT;
  const { auth, reused } = await ensureOAuth2Client(secrets, port, { force });
  return { auth, mode: "oauth", reused };
}

/** @returns {Promise<import("google-auth-library").JSONClient>} */
export async function getAuthorizedClient() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyPath && fs.existsSync(keyPath)) {
    const auth = new google.auth.GoogleAuth({ keyFile: keyPath, scopes: SCOPES });
    return auth.getClient();
  }

  const secrets = loadOAuthClientSecrets();
  if (!secrets) {
    printMissingCredentialsHelp();
    process.exit(1);
  }

  const port = Number(process.env.GSC_OAUTH_PORT) || DEFAULT_OAUTH_PORT;
  const { auth } = await ensureOAuth2Client(secrets, port);
  return auth;
}

/** Run a Google API callback; on invalid_grant, clear the token and retry once. */
export async function withAuthorizedGoogleClient(fn) {
  try {
    return await fn(await getAuthorizedClient());
  } catch (err) {
    if (!isInvalidGrantError(err)) throw err;
    console.error("Google token expired or revoked. Sign in again.");
    clearSavedToken();
    return fn(await getAuthorizedClient());
  }
}
