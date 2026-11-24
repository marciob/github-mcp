#!/usr/bin/env node
// The command line: start the server, check the token, manage OAuth clients.
import crypto from "node:crypto";
import { loadConfig } from "../src/config.mjs";
import { createApp, packageVersion } from "../src/app.mjs";
import { createOAuth } from "../src/oauth.mjs";
import { serveHttp } from "../src/http.mjs";

const HELP = `github-mcp ${packageVersion()}

Usage:
  github-mcp serve          Start the MCP server over HTTP
  github-mcp check          Check the GitHub token and print the configuration
  github-mcp clients        List the OAuth clients (such as Gemini)
  github-mcp revoke <id>    Remove one OAuth client and its tokens ("all" for every client)
  github-mcp random         Print a random value, for a route, a secret or a token

Configuration: environment variables. See README.md.`;

const log = (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

function oauthOf(config) {
  return createOAuth({
    approvalSecret: config.approvalSecret,
    publicUrl: config.publicUrl,
    route: config.route,
    file: config.oauthFile,
    redirectHosts: config.redirectHosts,
    log,
  });
}

async function main([cmd, ...rest]) {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return console.log(HELP);
  if (cmd === "random") return console.log(crypto.randomBytes(16).toString("hex"));

  const config = loadConfig();

  if (cmd === "serve") {
    const { server, tools } = createApp({ config });
    const oauth = oauthOf(config);
    const running = await serveHttp({ server, adminToken: config.adminToken, oauth, route: config.route, host: config.host, port: config.port, log });
    log(`github-mcp ${packageVersion()} listens on http://${config.host}:${running.port}${config.route} for ${config.publicUrl}`);
    log(`${tools.length} tools${config.readOnly ? " (read-only)" : ""}${config.adminTools && !config.readOnly ? " (with settings tools)" : ""}. Repositories: ${config.repos.join(", ")}. Protected branches: ${config.protectedBranches.join(", ") || "none"}`);
    if (config.approvalSecretFile) log(`approval secret: in ${config.approvalSecretFile}`);
    const stop = () => running.close().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return;
  }

  if (cmd === "check") {
    const { gh, tools } = createApp({ config });
    const r = await gh.request("GET", "/user");
    console.log(`GitHub user: ${r.data.login}`);
    const scopes = r.headers.get("x-oauth-scopes");
    console.log(`Token type: ${scopes === null ? "fine-grained (permissions are set on github.com)" : `classic, scopes: ${scopes || "none"}`}`);
    console.log(`Rate limit left: ${r.headers.get("x-ratelimit-remaining")} of ${r.headers.get("x-ratelimit-limit")}`);
    console.log(`Public URL: ${config.publicUrl}`);
    console.log(`Listens on: http://${config.host}:${config.port}${config.route}`);
    console.log(`Repositories: ${config.repos.join(", ")}`);
    console.log(`Protected branches: ${config.protectedBranches.join(", ") || "none"}`);
    console.log(`Tools: ${tools.map((t) => t.name).join(", ")}`);
    console.log(`Admin token: ${config.adminToken ? "set" : "not set"}`);
    console.log(`Approval secret: ${config.approvalSecretFile ? `in ${config.approvalSecretFile}` : "set"}`);
    return;
  }

  if (cmd === "clients") {
    const rows = oauthOf(config).clients();
    if (rows.length === 0) return console.log("No OAuth client.");
    for (const c of rows) console.log(`${c.id}  ${c.approved ? "approved" : "not approved"}  ${c.at.slice(0, 16)}  ${c.name}  ${c.redirectHosts.join(" ")}`);
    return;
  }

  if (cmd === "revoke") {
    const id = rest[0];
    if (!id) throw new Error("give a client id from: github-mcp clients (or all)");
    if (!oauthOf(config).revoke(id)) throw new Error(`no client ${id}`);
    return console.log(id === "all" ? "Removed all clients and tokens." : `Removed ${id} and its tokens.`);
  }

  throw new Error(`unknown command: ${cmd}\n\n${HELP}`);
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`github-mcp: ${e.message}\n`);
  process.exit(1);
});
