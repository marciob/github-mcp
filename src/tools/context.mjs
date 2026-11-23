// What the tools of one server share: the target repository of a call, and
// the resolution of a ref to a commit.
import { seg, filePath } from "../github.mjs";
import { str } from "./common.mjs";

export function toolContext({ gh, policy }) {
  const repoPath = (owner, repo) => `/repos/${seg(owner)}/${seg(repo)}`;

  // Checks owner and repo against the policy, and gives the API path.
  function target(args) {
    const owner = str(args, "owner", { required: true, max: 100 });
    const repo = str(args, "repo", { required: true, max: 100 });
    policy.checkRepo(owner, repo);
    return { owner, repo, base: repoPath(owner, repo) };
  }

  // A ref (branch, tag, SHA, or nothing) becomes a commit: { sha, tree, ref }.
  async function resolve(base, ref, signal) {
    let name = ref;
    if (!name) name = (await gh.get(base, { signal })).default_branch;
    const c = await gh.get(`${base}/commits/${filePath(name)}`, { signal });
    return { sha: c.sha, tree: c.commit.tree.sha, ref: name };
  }

  return { gh, policy, repoPath, target, resolve };
}
