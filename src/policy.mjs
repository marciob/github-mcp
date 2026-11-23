// What the server lets a client touch, on top of what the GitHub token
// allows. The token is the real limit. This is a second fence that the owner
// sets in the configuration.
import { ToolError } from "./rpc.mjs";

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

// `repos`: patterns such as "*", "alice/*", "alice/app". Case does not matter.
// `protectedBranches`: branch names (or "*" patterns) that get no force
// update and no delete.
export function createPolicy({ repos = ["*"], protectedBranches = [] } = {}) {
  const pats = repos.map((p) => p.trim().toLowerCase()).filter(Boolean);
  const prot = protectedBranches.map((p) => p.trim()).filter(Boolean);
  const glob = (pat, s) => new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(s);

  function allowsRepo(full) {
    const f = String(full).toLowerCase();
    return pats.some((p) => p === "*" || glob(p, f));
  }

  function checkRepo(owner, repo) {
    if (typeof owner !== "string" || !NAME.test(owner)) throw new ToolError('"owner" is a GitHub user or organization name, such as "octocat"');
    if (typeof repo !== "string" || !NAME.test(repo)) throw new ToolError('"repo" is a repository name, such as "hello-world"');
    if (!allowsRepo(`${owner}/${repo}`)) throw new ToolError(`This server does not give access to ${owner}/${repo}. The owner of the server sets the repositories in REPOS.`);
  }

  function isProtected(branch) {
    return prot.some((p) => glob(p, branch));
  }

  return { allowsRepo, checkRepo, isProtected, repos: pats, protectedBranches: prot };
}
