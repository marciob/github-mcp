// The configuration, from environment variables. Each secret can come from
// the variable itself or from a file (the variable with _FILE after it). A
// file is better, because a variable can show in a process list or a log.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_REDIRECT_HOSTS } from "./oauth.mjs";

const csv = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

function secret(env, name) {
  if (env[`${name}_FILE`]) {
    const file = env[`${name}_FILE`].replace(/^~(?=\/)/, os.homedir());
    const mode = fs.statSync(file).mode & 0o077;
    if (mode !== 0) throw new Error(`${file} can be read by other users. Run: chmod 600 ${file}`);
    const dirMode = fs.statSync(path.dirname(file)).mode & 0o077;
    if (dirMode & 0o022) throw new Error(`other users can write to ${path.dirname(file)}. Run: chmod 700 ${path.dirname(file)}`);
    return fs.readFileSync(file, "utf8").trim();
  }
  return env[name]?.trim() || null;
}

export function loadConfig(env = process.env) {
  const dataDir = (env.DATA_DIR || path.join(os.homedir(), ".github-mcp")).replace(/^~(?=\/)/, os.homedir());

  const githubToken = secret(env, "GITHUB_TOKEN");
  if (!githubToken) throw new Error("set GITHUB_TOKEN_FILE (a file with the token, mode 600) or GITHUB_TOKEN");

  if (!env.PUBLIC_URL) throw new Error("set PUBLIC_URL: the https address of the MCP endpoint, such as https://host.example/7f3a9c...");
  let publicUrl = env.PUBLIC_URL.replace(/\/+$/, "");
  const u = new URL(publicUrl);
  let route = u.pathname.replace(/\/+$/, "");
  if (!route) {
    route = "/mcp";
    publicUrl += route;
  }

  // The approval secret: from the configuration, or made once and kept in
  // the data directory.
  let approvalSecret = secret(env, "APPROVAL_SECRET");
  let approvalSecretFile = null;
  if (!approvalSecret) {
    approvalSecretFile = path.join(dataDir, "approval.secret");
    try {
      approvalSecret = fs.readFileSync(approvalSecretFile, "utf8").trim();
    } catch {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      approvalSecret = crypto.randomBytes(24).toString("base64url");
      fs.writeFileSync(approvalSecretFile, approvalSecret + "\n", { mode: 0o600 });
    }
  }

  const adminToken = secret(env, "ADMIN_TOKEN");
  if (adminToken && adminToken === approvalSecret) throw new Error("ADMIN_TOKEN and APPROVAL_SECRET must differ");

  const port = Number(env.PORT || 7814);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT is a number from 0 to 65535");

  return {
    githubToken,
    githubApiUrl: env.GITHUB_API_URL || "https://api.github.com",
    publicUrl,
    route,
    approvalSecret,
    approvalSecretFile,
    adminToken,
    host: env.HOST || "127.0.0.1",
    port,
    dataDir,
    oauthFile: path.join(dataDir, "oauth.json"),
    repos: env.REPOS ? csv(env.REPOS) : ["*"],
    protectedBranches: csv(env.PROTECTED_BRANCHES),
    readOnly: ["1", "true", "yes"].includes(String(env.READ_ONLY ?? "").toLowerCase()),
    adminTools: ["1", "true", "yes"].includes(String(env.ADMIN_TOOLS ?? "").toLowerCase()),
    redirectHosts: env.ALLOWED_REDIRECT_HOSTS ? csv(env.ALLOWED_REDIRECT_HOSTS) : DEFAULT_REDIRECT_HOSTS,
  };
}
