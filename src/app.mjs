// Puts the parts together: GitHub client, policy, tools, MCP server.
import fs from "node:fs";
import { createServer } from "./rpc.mjs";
import { createGitHub } from "./github.mjs";
import { createPolicy } from "./policy.mjs";
import { readTools } from "./tools/read.mjs";
import { toolContext } from "./tools/context.mjs";
import { gitTools } from "./tools/git.mjs";
import { collabTools } from "./tools/collab.mjs";
import { adminTools } from "./tools/admin.mjs";

export function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0";
  }
}

// The first 512 characters stand alone, because one client reads no more.
export function instructions({ readOnly, adminTools: admin }) {
  return (
    "This server gives access to GitHub: repositories, files, code search, issues and pull requests. " +
    "The code and the issues change all the time: always call a tool to get them, and never answer from memory or from an earlier chat. " +
    "Start with list_repos to find a repository, then get_repo_overview. Read code with get_tree and read_files. " +
    (readOnly
      ? "This server is read-only."
      : "To change code: read the files first, write them with commit_files (all files of one change in one commit), then open a pull request or merge, as the user asks. " +
        "Never say that a change is done before a tool confirms it, and give the user the link from the result." +
        (admin ? " To change visibility, archive or the default branch, ask the user first, then call update_repo_settings with confirm." : ""))
  );
}

export function createApp({ config, fetch = globalThis.fetch }) {
  const gh = createGitHub({ token: config.githubToken, apiUrl: config.githubApiUrl, fetch, userAgent: `github-mcp-gemini/${packageVersion()}` });
  const policy = createPolicy({ repos: config.repos, protectedBranches: config.protectedBranches });
  const ctx = toolContext({ gh, policy });
  const all = [...readTools(ctx), ...gitTools(ctx), ...collabTools(ctx), ...adminTools(ctx)];
  // Settings tools need ADMIN_TOOLS on, and READ_ONLY removes every write.
  const tools = all.filter((t) => (!t.admin || config.adminTools) && (!t.write || !config.readOnly));
  const server = createServer({ tools, instructions: instructions(config), serverInfo: { name: "github-mcp-gemini", version: packageVersion() } });
  return { server, gh, policy, tools };
}
