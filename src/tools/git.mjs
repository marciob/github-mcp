// Tools for branches and commits. The writes use the git data API, so many
// files go in one commit, and a commit never moves a branch that someone
// else moved in the meantime (the update is a fast-forward).
//
// Sources:
// - https://docs.github.com/en/rest/git/refs
// - https://docs.github.com/en/rest/git/trees
// - https://docs.github.com/en/rest/git/commits
// - https://docs.github.com/en/rest/commits/commits#compare-two-commits
import { ToolError } from "../rpc.mjs";
import { seg, filePath } from "../github.mjs";
import { ALWAYS, OWNER, REPO, REF, PER_PAGE, str, int, bool, day } from "./common.mjs";
import { formatFiles } from "./diff.mjs";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const ACT = "To change the repository, always call this tool, and never say that a change is done before the tool confirms it.";
const MAX_FILES = 100;
const MAX_CONTENT = 10 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/i;

// A branch name that git accepts, without the rare cases.
export function branchName(args, key, { required = true } = {}) {
  const b = str(args, key, { required, max: 250 });
  if (b === undefined) return undefined;
  if (!/^[A-Za-z0-9._/-]+$/.test(b) || b.startsWith("/") || b.startsWith("-") || b.endsWith("/") || b.endsWith(".lock") || b.includes("..") || b.includes("//")) {
    throw new ToolError(`"${key}" is not a valid branch name: use letters, digits, ".", "_", "-" and "/"`);
  }
  return b;
}

export function gitTools(ctx) {
  const { gh, policy, target, resolve } = ctx;
  const refPath = (base, branch) => `${base}/git/refs/heads/${filePath(branch)}`;

  // The SHA at the tip of a branch, or null when there is no such branch.
  // An empty repository gives { empty: true }.
  async function head(base, branch, signal) {
    try {
      return (await gh.get(`${base}/git/ref/heads/${filePath(branch)}`, { signal })).object.sha;
    } catch (e) {
      if (e.status === 404) return null;
      if (e.status === 409) return { empty: true };
      throw e;
    }
  }

  function guard(branch, what) {
    if (policy.isProtected(branch)) throw new ToolError(`${branch} is a protected branch on this server: ${what} is not allowed. The owner sets PROTECTED_BRANCHES.`);
  }

  const tools = [];

  tools.push({
    name: "list_commits",
    title: "List commits",
    description: `Lists the recent commits of a branch, the newest first, optionally only those that touch one path. ${ALWAYS}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        ref: REF,
        path: { type: "string", description: "Only commits that change this file or directory." },
        page: { type: "integer", description: "Page number, from 1." },
      },
      required: ["owner", "repo"],
    },
    annotations: READ,
    async run(args, { signal }) {
      const { base } = target(args);
      const page = int(args, "page", { max: 100 }) ?? 1;
      const rows = await gh.get(`${base}/commits`, { query: { sha: str(args, "ref", { max: 250 }), path: str(args, "path", { max: 1000 }), per_page: PER_PAGE, page }, signal });
      const lines = rows.map((c) => `${c.sha.slice(0, 7)}  ${day(c.commit.author?.date)}  ${c.author?.login ?? c.commit.author?.name ?? "?"}  ${c.commit.message.split("\n")[0].slice(0, 120)}`);
      if (rows.length === PER_PAGE) lines.push(`More: call again with page ${page + 1}.`);
      return lines.length ? lines.join("\n") : "No commit.";
    },
  });

  tools.push({
    name: "compare_refs",
    title: "Compare two refs",
    description: `Shows the commits and the diff between two branches, tags or commits (base...head). Use it to review what a branch changes. ${ALWAYS}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        base: { type: "string", description: "The older ref, such as main." },
        head: { type: "string", description: "The newer ref, such as my-feature." },
        diff: { type: "boolean", description: "false: list the files only, with no diff. Default true." },
      },
      required: ["owner", "repo", "base", "head"],
    },
    annotations: READ,
    async run(args, { signal }) {
      const { base } = target(args);
      const from = str(args, "base", { required: true, max: 250 });
      const to = str(args, "head", { required: true, max: 250 });
      const withPatch = args.diff === undefined ? true : bool(args, "diff");
      const c = await gh.get(`${base}/compare/${filePath(from)}...${filePath(to)}`, { query: { per_page: 100 }, signal });
      const out = [
        `${to} is ${c.ahead_by} commits ahead of and ${c.behind_by} behind ${from} (${c.status}). ${c.files?.length ?? 0} files changed.`,
        ...c.commits.slice(-20).map((x) => `${x.sha.slice(0, 7)}  ${x.commit.message.split("\n")[0].slice(0, 120)}`),
        "",
        formatFiles(c.files ?? [], { withPatch }),
      ];
      return out.join("\n");
    },
  });

  tools.push({
    name: "create_branch",
    title: "Create a branch",
    description: `Creates a new branch from a branch, tag or commit. commit_files can also create the branch, so you need this tool only for an empty new branch. ${ACT}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        branch: { type: "string", description: "Name of the new branch, such as fix/login-error." },
        from_ref: { type: "string", description: "Branch, tag or commit SHA to start from. Empty: the default branch." },
      },
      required: ["owner", "repo", "branch"],
    },
    annotations: WRITE,
    write: true,
    async run(args, { signal }) {
      const { base } = target(args);
      const branch = branchName(args, "branch");
      const start = await resolve(base, str(args, "from_ref", { max: 250 }), signal);
      if (await head(base, branch, signal)) throw new ToolError(`The branch ${branch} exists already.`);
      await gh.request("POST", `${base}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: start.sha }, signal });
      return `Created the branch ${branch} at ${start.sha.slice(0, 7)} (from ${start.ref}).`;
    },
  });

  tools.push({
    name: "commit_files",
    title: "Commit files",
    description:
      "Writes one commit to a branch, with many files added, changed or deleted at once. Give the complete new content of each file. " +
      "If the branch does not exist, the tool creates it from create_from (default: the default branch). " +
      `The commit goes on top of the branch: if someone pushed in the meantime, it fails, and you read the files again. ${ACT}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        branch: { type: "string", description: "Branch to commit to. It can be the default branch." },
        message: { type: "string", description: "Commit message." },
        files: {
          type: "array",
          description: `The files of the commit, at most ${MAX_FILES}.`,
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: 'Path of the file, such as "src/app.ts".' },
              content: { type: "string", description: "The complete new content of the file. Not needed for a delete." },
              delete: { type: "boolean", description: "true: delete this file." },
              base64: { type: "boolean", description: "true: content is base64, for a binary file." },
            },
            required: ["path"],
          },
        },
        create_from: { type: "string", description: "If the branch does not exist: the branch, tag or SHA to create it from. Empty: the default branch." },
        expected_head_sha: { type: "string", description: "Optional. The SHA that you expect at the tip of the branch. If the branch is somewhere else, nothing is written." },
      },
      required: ["owner", "repo", "branch", "message", "files"],
    },
    annotations: WRITE,
    write: true,
    async run(args, { signal }) {
      const { base, owner, repo } = target(args);
      const branch = branchName(args, "branch");
      const message = str(args, "message", { required: true, max: 20_000 });
      const expected = str(args, "expected_head_sha", { max: 40 });
      const files = parseFiles(args.files);

      let tip = await head(base, branch, signal);
      let note = "";
      if (tip?.empty) {
        // The git data API does not work on an empty repository. The first
        // file goes through the contents API, and makes the first commit.
        const first = files.find((f) => !f.delete);
        if (!first) throw new ToolError("The repository is empty: there is nothing to delete.");
        const r = await gh.request("PUT", `${base}/contents/${filePath(first.path)}`, {
          body: { message, content: first.base64 ? first.content : Buffer.from(first.content, "utf8").toString("base64"), branch },
          signal,
        });
        tip = r.data.commit.sha;
        files.splice(files.indexOf(first), 1);
        note = ` The repository was empty: ${first.path} went in a first commit (${tip.slice(0, 7)}).`;
        if (files.length === 0) return `Committed ${tip.slice(0, 7)} to ${branch}: 1 file.${note}\n${r.data.commit.html_url}`;
      } else if (!tip) {
        const start = await resolve(base, str(args, "create_from", { max: 250 }), signal);
        await gh.request("POST", `${base}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: start.sha }, signal });
        tip = start.sha;
        note = ` Created the branch ${branch} from ${start.ref}.`;
      } else if (expected && expected.toLowerCase() !== tip.toLowerCase() && !tip.toLowerCase().startsWith(expected.toLowerCase())) {
        throw new ToolError(`The branch ${branch} is at ${tip.slice(0, 7)}, not at ${expected}. Nothing was written. Read the files again, then commit.`);
      }

      const parent = await gh.get(`${base}/git/commits/${seg(tip)}`, { signal });
      // The modes of the current files, so an executable file stays one, and
      // a delete of a file that is not there gives a clear error.
      const current = await gh.get(`${base}/git/trees/${seg(parent.tree.sha)}`, { query: { recursive: 1 }, signal });
      const modes = new Map(current.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.mode]));
      for (const f of files) {
        if (f.delete && !current.truncated && !modes.has(f.path)) throw new ToolError(`Cannot delete ${f.path}: there is no such file on ${branch}. Nothing was written.`);
      }
      const entries = await Promise.all(
        files.map(async (f) => {
          const mode = modes.get(f.path) ?? "100644";
          if (f.delete) return { path: f.path, mode, type: "blob", sha: null };
          if (f.base64) {
            const b = await gh.request("POST", `${base}/git/blobs`, { body: { content: f.content, encoding: "base64" }, signal });
            return { path: f.path, mode, type: "blob", sha: b.data.sha };
          }
          return { path: f.path, mode, type: "blob", content: f.content };
        }),
      );
      const tree = (await gh.request("POST", `${base}/git/trees`, { body: { base_tree: parent.tree.sha, tree: entries }, signal })).data;
      if (tree.sha === parent.tree.sha) return `No change: the files on ${branch} already have this content. Nothing was written.${note}`;
      const commit = (await gh.request("POST", `${base}/git/commits`, { body: { message, tree: tree.sha, parents: [tip] }, signal })).data;
      try {
        await gh.request("PATCH", refPath(base, branch), { body: { sha: commit.sha, force: false }, signal });
      } catch (e) {
        if (e.status === 422) throw new ToolError(`The branch ${branch} moved while the commit was made. Nothing was written to the branch. Read the files again, then commit.`);
        throw e;
      }
      const changed = files.filter((f) => !f.delete).length;
      const deleted = files.length - changed;
      const n = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
      return `Committed ${commit.sha.slice(0, 7)} to ${branch}: ${n(changed, "file")} written, ${deleted} deleted.${note}\n${commit.html_url ?? `https://github.com/${owner}/${repo}/commit/${commit.sha}`}`;
    },
  });

  tools.push({
    name: "reset_branch",
    title: "Reset a branch (force)",
    description:
      "Moves a branch to another commit, as a force push. Commits after that point leave the branch. " +
      `The result gives the old SHA, so the change can be undone with this tool. ${ACT}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        branch: { type: "string", description: "The branch to move." },
        to: { type: "string", description: "Commit SHA, branch or tag to move the branch to." },
      },
      required: ["owner", "repo", "branch", "to"],
    },
    annotations: DESTRUCTIVE,
    write: true,
    async run(args, { signal }) {
      const { base } = target(args);
      const branch = branchName(args, "branch");
      guard(branch, "a force update");
      const before = await head(base, branch, signal);
      if (!before || before.empty) throw new ToolError(`No branch ${branch}.`);
      const to = str(args, "to", { required: true, max: 250 });
      const sha = SHA.test(to) ? to : (await resolve(base, to, signal)).sha;
      if (sha === before) return `${branch} is at ${sha.slice(0, 7)} already. Nothing changed.`;
      await gh.request("PATCH", refPath(base, branch), { body: { sha, force: true }, signal });
      return `Moved ${branch} from ${before} to ${sha}. To undo: reset_branch with to "${before}".`;
    },
  });

  tools.push({
    name: "delete_branch",
    title: "Delete a branch",
    description: `Deletes a branch. The default branch cannot be deleted. The result gives the SHA of the branch, so it can be made again with create_branch. ${ACT}`,
    inputSchema: {
      type: "object",
      properties: { owner: OWNER, repo: REPO, branch: { type: "string", description: "The branch to delete." } },
      required: ["owner", "repo", "branch"],
    },
    annotations: DESTRUCTIVE,
    write: true,
    async run(args, { signal }) {
      const { base } = target(args);
      const branch = branchName(args, "branch");
      guard(branch, "a delete");
      const info = await gh.get(base, { signal });
      if (info.default_branch === branch) throw new ToolError(`${branch} is the default branch of the repository. It cannot be deleted.`);
      const before = await head(base, branch, signal);
      if (!before || before.empty) throw new ToolError(`No branch ${branch}.`);
      await gh.request("DELETE", refPath(base, branch), { signal });
      return `Deleted the branch ${branch}. It was at ${before}. To undo: create_branch with branch "${branch}" and from_ref "${before}".`;
    },
  });

  return tools;
}

function parseFiles(value) {
  if (!Array.isArray(value) || value.length === 0) throw new ToolError('"files" is a list of { path, content } objects, with one file or more');
  if (value.length > MAX_FILES) throw new ToolError(`"files" takes at most ${MAX_FILES} files in one commit`);
  const seen = new Set();
  let size = 0;
  return value.map((f, i) => {
    if (!f || typeof f !== "object") throw new ToolError(`files[${i}] is an object with path and content`);
    const path = typeof f.path === "string" ? f.path.replace(/^\/+/, "") : "";
    if (!path || path.length > 1000 || path.split("/").some((p) => p === "" || p === "." || p === "..") || path.startsWith(".git/")) {
      throw new ToolError(`files[${i}].path is not a valid path`);
    }
    if (seen.has(path)) throw new ToolError(`${path} is in "files" two times`);
    seen.add(path);
    const del = f.delete === true || f.delete === "true";
    const b64 = f.base64 === true || f.base64 === "true";
    if (!del && typeof f.content !== "string") throw new ToolError(`files[${i}] (${path}) needs "content", the complete new text of the file, or "delete": true`);
    if (b64 && !/^[A-Za-z0-9+/=\s]*$/.test(f.content)) throw new ToolError(`files[${i}] (${path}): content is not base64`);
    size += del ? 0 : f.content.length;
    if (size > MAX_CONTENT) throw new ToolError(`The files hold more than ${MAX_CONTENT / 1024 / 1024} MB. Commit them in parts.`);
    return { path, content: del ? null : f.content, delete: del, base64: b64 };
  });
}
