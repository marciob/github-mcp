// Tools for pull requests, issues and comments.
//
// Sources:
// - https://docs.github.com/en/rest/pulls/pulls
// - https://docs.github.com/en/rest/issues/issues
// - https://docs.github.com/en/rest/issues/comments
import { ToolError } from "../rpc.mjs";
import { ALWAYS, OWNER, REPO, PER_PAGE, str, int, bool, list, oneOf, day } from "./common.mjs";
import { formatFiles } from "./diff.mjs";
import { branchName } from "./git.mjs";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const ACT = "To change the repository, always call this tool, and never say that a change is done before the tool confirms it.";
const BODY_CHARS = 6_000;
const NUMBER = { type: "integer", description: "The number of the pull request or issue." };

const who = (u) => u?.login ?? "?";
const cut = (t, n = BODY_CHARS) => (!t ? "(empty)" : t.length > n ? `${t.slice(0, n)}\n[cut: ${t.length - n} more characters]` : t);

export function collabTools(ctx) {
  const { gh, target } = ctx;
  const tools = [];

  tools.push({
    name: "list_pull_requests",
    title: "List pull requests",
    description: `Lists the pull requests of a repository, the most recently updated first. ${ALWAYS}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        state: { type: "string", enum: ["open", "closed", "all"], description: 'Default "open".' },
        base: { type: "string", description: "Only pull requests into this branch." },
        page: { type: "integer", description: "Page number, from 1." },
      },
      required: ["owner", "repo"],
    },
    annotations: READ,
    async run(args, { signal }) {
      const { base } = target(args);
      const page = int(args, "page", { max: 100 }) ?? 1;
      const rows = await gh.get(`${base}/pulls`, { query: { state: oneOf(args, "state", ["open", "closed", "all"], "open"), base: str(args, "base", { max: 250 }), sort: "updated", direction: "desc", per_page: PER_PAGE, page }, signal });
      const lines = rows.map((p) => `#${p.number}  ${p.merged_at ? "merged" : p.state}${p.draft ? " draft" : ""}  ${p.head.ref} -> ${p.base.ref}  ${p.title.slice(0, 120)}  (by ${who(p.user)}, updated ${day(p.updated_at)})`);
      if (rows.length === PER_PAGE) lines.push(`More: call again with page ${page + 1}.`);
      return lines.length ? lines.join("\n") : "No pull request.";
    },
  });

  tools.push({
    name: "get_pull_request",
    title: "Get a pull request",
    description: `Gives a pull request: state, branches, whether it can merge, description, changed files with the diff, and optionally the comments and reviews. ${ALWAYS}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        number: NUMBER,
        diff: { type: "boolean", description: "false: list the files only, with no diff. Default true." },
        comments: { type: "boolean", description: "true: also give the comments and the reviews." },
      },
      required: ["owner", "repo", "number"],
    },
    annotations: READ,
    async run(args, { signal }) {
      const { base } = target(args);
      const n = int(args, "number", { required: true });
      if (n === undefined) throw new ToolError('"number" is required');
      const p = await gh.get(`${base}/pulls/${n}`, { signal });
      const files = await gh.get(`${base}/pulls/${n}/files`, { query: { per_page: 100 }, signal });
      const out = [
        `#${p.number} ${p.title}`,
        `State: ${p.merged ? `merged at ${p.merged_at}` : p.state}${p.draft ? ", draft" : ""}. By ${who(p.user)}. ${p.html_url}`,
        `Branches: ${p.head.ref} (${p.head.sha.slice(0, 7)}) -> ${p.base.ref}`,
        `Mergeable: ${p.mergeable === null ? "unknown yet, ask again in a few seconds" : p.mergeable} (${p.mergeable_state}). ${p.commits} commits, ${p.changed_files} files, +${p.additions} -${p.deletions}.`,
        "",
        "Description:",
        cut(p.body),
        "",
        formatFiles(files, { withPatch: args.diff === undefined ? true : bool(args, "diff") }),
      ];
      if (files.length === 100 && p.changed_files > 100) out.push(`Only the first 100 of ${p.changed_files} files are shown.`);
      if (bool(args, "comments")) {
        const [comments, reviews, inline] = await Promise.all([
          gh.get(`${base}/issues/${n}/comments`, { query: { per_page: 50 }, signal }),
          gh.get(`${base}/pulls/${n}/reviews`, { query: { per_page: 50 }, signal }),
          gh.get(`${base}/pulls/${n}/comments`, { query: { per_page: 50 }, signal }),
        ]);
        out.push("", "Reviews:");
        for (const r of reviews) out.push(`- ${who(r.user)} ${r.state} ${day(r.submitted_at)}${r.body ? `: ${cut(r.body, 1000)}` : ""}`);
        out.push("", "Comments:");
        for (const c of comments) out.push(`- ${who(c.user)} ${day(c.created_at)}: ${cut(c.body, 1500)}`);
        for (const c of inline) out.push(`- ${who(c.user)} on ${c.path}:${c.line ?? c.original_line ?? "?"}: ${cut(c.body, 1000)}`);
      }
      return out.join("\n");
    },
  });

  tools.push({
    name: "create_or_update_pull_request",
    title: "Create or update a pull request",
    description:
      "Without number: opens a pull request from head into base (base defaults to the default branch). " +
      `With number: changes the title, the description, the base, or closes or reopens it. ${ACT}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        number: { type: "integer", description: "Give it to change an existing pull request. Leave it out to open a new one." },
        title: { type: "string", description: "Title. Required for a new pull request." },
        body: { type: "string", description: "Description, in Markdown." },
        head: { type: "string", description: "For a new pull request: the branch with the changes." },
        base: { type: "string", description: "The branch to merge into. Default: the default branch." },
        draft: { type: "boolean", description: "For a new pull request: true opens it as a draft." },
        state: { type: "string", enum: ["open", "closed"], description: "To close or reopen an existing pull request." },
      },
      required: ["owner", "repo"],
    },
    annotations: WRITE,
    write: true,
    async run(args, { signal }) {
      const { base } = target(args);
      const n = int(args, "number");
      const title = str(args, "title", { max: 256 });
      const body = str(args, "body", { max: 60_000 });
      const into = branchName(args, "base", { required: false });
      if (n !== undefined) {
        const patch = { title, body, base: into, state: args.state === undefined ? undefined : oneOf(args, "state", ["open", "closed"]) };
        for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
        if (Object.keys(patch).length === 0) throw new ToolError("Give a title, body, base or state to change.");
        const p = (await gh.request("PATCH", `${base}/pulls/${n}`, { body: patch, signal })).data;
        return `Updated pull request #${p.number} (${p.state}): ${p.title}\n${p.html_url}`;
      }
      if (!title) throw new ToolError('"title" is required for a new pull request');
      const head = branchName(args, "head");
      const target2 = into ?? (await gh.get(base, { signal })).default_branch;
      const p = (await gh.request("POST", `${base}/pulls`, { body: { title, body, head, base: target2, draft: bool(args, "draft") }, signal })).data;
      return `Opened pull request #${p.number}: ${head} -> ${target2}${p.draft ? " (draft)" : ""}\n${p.html_url}`;
    },
  });

  tools.push({
    name: "merge_pull_request",
    title: "Merge a pull request",
    description:
      'Merges a pull request into its base branch, with method "merge", "squash" or "rebase". ' +
      `Give expected_head_sha (from get_pull_request) so that nothing merges if the branch changed after you read it. ${ACT}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        number: NUMBER,
        method: { type: "string", enum: ["merge", "squash", "rebase"], description: 'Default "merge".' },
        expected_head_sha: { type: "string", description: "The head SHA that you reviewed. If the pull request has another head, nothing merges." },
        commit_title: { type: "string", description: "Optional title of the merge or squash commit." },
        commit_message: { type: "string", description: "Optional message of the merge or squash commit." },
      },
      required: ["owner", "repo", "number"],
    },
    annotations: { ...WRITE, destructiveHint: true },
    write: true,
    async run(args, { signal }) {
      const { base } = target(args);
      const n = int(args, "number");
      if (n === undefined) throw new ToolError('"number" is required');
      const body = {
        merge_method: oneOf(args, "method", ["merge", "squash", "rebase"], "merge"),
        sha: str(args, "expected_head_sha", { max: 40 }),
        commit_title: str(args, "commit_title", { max: 256 }),
        commit_message: str(args, "commit_message", { max: 20_000 }),
      };
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      try {
        const r = (await gh.request("PUT", `${base}/pulls/${n}/merge`, { body, signal })).data;
        return `Merged pull request #${n} with ${body.merge_method}: ${r.sha}. ${r.message ?? ""}`.trim();
      } catch (e) {
        if (e.status === 405) throw new ToolError(`GitHub did not merge #${n}: ${e.message}. Check get_pull_request for conflicts, failed checks or required reviews.`);
        if (e.status === 409) throw new ToolError(`The head of #${n} is not ${body.sha}: the branch changed. Read the pull request again.`);
        throw e;
      }
    },
  });

  tools.push({
    name: "list_issues",
    title: "List issues",
    description: `Lists the issues of a repository (not pull requests), the most recently updated first. ${ALWAYS}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        state: { type: "string", enum: ["open", "closed", "all"], description: 'Default "open".' },
        labels: { type: "string", description: 'Only issues with all these labels, comma separated, such as "bug,urgent".' },
        page: { type: "integer", description: "Page number, from 1." },
      },
      required: ["owner", "repo"],
    },
    annotations: READ,
    async run(args, { signal }) {
      const { base } = target(args);
      const page = int(args, "page", { max: 100 }) ?? 1;
      const rows = await gh.get(`${base}/issues`, { query: { state: oneOf(args, "state", ["open", "closed", "all"], "open"), labels: str(args, "labels", { max: 500 }), sort: "updated", per_page: PER_PAGE, page }, signal });
      const lines = rows.filter((i) => !i.pull_request).map((i) => `#${i.number}  ${i.state}  ${i.title.slice(0, 140)}${i.labels.length ? `  [${i.labels.map((l) => l.name).join(", ")}]` : ""}  (by ${who(i.user)}, ${i.comments} comments, updated ${day(i.updated_at)})`);
      if (rows.length === PER_PAGE) lines.push(`More: call again with page ${page + 1}.`);
      return lines.length ? lines.join("\n") : "No issue.";
    },
  });

  tools.push({
    name: "get_issue",
    title: "Get an issue",
    description: `Gives an issue with its description and comments. ${ALWAYS}`,
    inputSchema: { type: "object", properties: { owner: OWNER, repo: REPO, number: NUMBER }, required: ["owner", "repo", "number"] },
    annotations: READ,
    async run(args, { signal }) {
      const { base } = target(args);
      const n = int(args, "number");
      if (n === undefined) throw new ToolError('"number" is required');
      const [i, comments] = await Promise.all([gh.get(`${base}/issues/${n}`, { signal }), gh.get(`${base}/issues/${n}/comments`, { query: { per_page: 50 }, signal })]);
      const out = [
        `#${i.number} ${i.title}${i.pull_request ? "  (this is a pull request: use get_pull_request for the diff)" : ""}`,
        `State: ${i.state}${i.state_reason ? ` (${i.state_reason})` : ""}. By ${who(i.user)} on ${day(i.created_at)}. ${i.html_url}`,
        `Labels: ${i.labels.map((l) => l.name).join(", ") || "none"}. Assignees: ${i.assignees.map(who).join(", ") || "none"}.`,
        "",
        cut(i.body),
        "",
        `Comments (${i.comments}):`,
        ...comments.map((c) => `- ${who(c.user)} ${day(c.created_at)}: ${cut(c.body, 2000)}`),
      ];
      return out.join("\n");
    },
  });

  tools.push({
    name: "create_or_update_issue",
    title: "Create or update an issue",
    description: `Without number: opens a new issue. With number: changes the title, body, state, labels or assignees of an issue. ${ACT}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        number: { type: "integer", description: "Give it to change an existing issue. Leave it out to open a new one." },
        title: { type: "string", description: "Title. Required for a new issue." },
        body: { type: "string", description: "Description, in Markdown." },
        state: { type: "string", enum: ["open", "closed"], description: "To close or reopen the issue." },
        labels: { type: "array", items: { type: "string" }, description: "The complete list of labels. It replaces the old list." },
        assignees: { type: "array", items: { type: "string" }, description: "The complete list of GitHub logins to assign. It replaces the old list." },
      },
      required: ["owner", "repo"],
    },
    annotations: WRITE,
    write: true,
    async run(args, { signal }) {
      const { base } = target(args);
      const n = int(args, "number");
      const fields = {
        title: str(args, "title", { max: 256 }),
        body: str(args, "body", { max: 60_000 }),
        state: args.state === undefined ? undefined : oneOf(args, "state", ["open", "closed"]),
        labels: args.labels === undefined ? undefined : list(args, "labels", { max: 50 }),
        assignees: args.assignees === undefined ? undefined : list(args, "assignees", { max: 10 }),
      };
      for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
      if (n !== undefined) {
        if (Object.keys(fields).length === 0) throw new ToolError("Give a title, body, state, labels or assignees to change.");
        const i = (await gh.request("PATCH", `${base}/issues/${n}`, { body: fields, signal })).data;
        return `Updated issue #${i.number} (${i.state}): ${i.title}\n${i.html_url}`;
      }
      if (!fields.title) throw new ToolError('"title" is required for a new issue');
      delete fields.state;
      const i = (await gh.request("POST", `${base}/issues`, { body: fields, signal })).data;
      return `Opened issue #${i.number}: ${i.title}\n${i.html_url}`;
    },
  });

  tools.push({
    name: "add_comment",
    title: "Comment on an issue or pull request",
    description: `Adds a comment to an issue or a pull request. ${ACT}`,
    inputSchema: {
      type: "object",
      properties: { owner: OWNER, repo: REPO, number: NUMBER, body: { type: "string", description: "The comment, in Markdown." } },
      required: ["owner", "repo", "number", "body"],
    },
    annotations: WRITE,
    write: true,
    async run(args, { signal }) {
      const { base } = target(args);
      const n = int(args, "number");
      if (n === undefined) throw new ToolError('"number" is required');
      const body = str(args, "body", { required: true, max: 60_000 });
      const c = (await gh.request("POST", `${base}/issues/${n}/comments`, { body: { body }, signal })).data;
      return `Commented on #${n}.\n${c.html_url}`;
    },
  });

  return tools;
}
