// The Vercel function. It serves the MCP endpoint /api/mcp and the discovery
// documents (vercel.json rewrites them here).
//
// Tokens come from an external OAuth server that keeps them in a Postgres
// table (Neon). That server can serve several MCP servers and give each one
// its own scope. A token must have the scope AUTH_SCOPE.
//
// Environment (set in Vercel, never in the repo):
//   GITHUB_TOKEN        GitHub token of the server
//   TOKEN_DATABASE_URL  Neon connection string of the token table
//   AUTH_SERVER         issuer URL of the OAuth server, such as https://auth.example.com
//   AUTH_SCOPE          scope of this server, default "github"
//   PUBLIC_URL          public URL of the MCP endpoint, such as https://github-mcp.example.app/api/mcp
//   REPOS, PROTECTED_BRANCHES, READ_ONLY, GITHUB_API_URL   as in README.md
import crypto from "node:crypto";
import { createApp } from "../src/app.mjs";
import { createWebHandler } from "../src/web.mjs";
import { neonQuery } from "../src/neon.mjs";

const env = process.env;
const csv = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const scope = env.AUTH_SCOPE || "github";

const { server } = createApp({
  config: {
    githubToken: env.GITHUB_TOKEN,
    githubApiUrl: env.GITHUB_API_URL || "https://api.github.com",
    repos: env.REPOS ? csv(env.REPOS) : ["*"],
    protectedBranches: csv(env.PROTECTED_BRANCHES),
    readOnly: ["1", "true", "yes"].includes(String(env.READ_ONLY ?? "").toLowerCase()),
  },
});

const query = neonQuery(env.TOKEN_DATABASE_URL);
const sha = (s) => crypto.createHash("sha256").update(s).digest("base64url");

// The token table of the OAuth server: the digest of each token, its kind,
// scope, expiry and revocation. A token for another server (another scope) does not open
// this one.
async function verifyToken(bearer) {
  const [row] = await query(
    "SELECT client_id, scope FROM mcp_tokens WHERE hash = $1 AND kind = 'access' AND revoked_at IS NULL AND expires_at > now()",
    [sha(bearer)],
  );
  if (!row || !String(row.scope).split(" ").includes(scope)) return null;
  return String(row.client_id).slice(0, 24);
}

const handle = createWebHandler({
  server,
  verifyToken,
  resource: env.PUBLIC_URL,
  authServer: env.AUTH_SERVER,
  scope,
  log: (line) => console.log(line),
});

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
