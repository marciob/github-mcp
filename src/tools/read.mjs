// Tools that read: repositories, trees, files, search. None of them changes
// anything on GitHub.
import { ToolError } from "../rpc.mjs";
import { seg, filePath } from "../github.mjs";
import { readTarGz } from "../tar.mjs";
import { ALWAYS, OWNER, REPO, REF, PER_PAGE, MAX_FILE_CHARS, MAX_FILE_LINES, MAX_TOTAL_CHARS, str, int, bool, list, oneOf, isBinary, day } from "./common.mjs";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const MAX_TREE_ENTRIES = 2_000;
const README_CHARS = 4_000;
const GREP_MAX_FILE = 1024 * 1024;
const GREP_MAX_LINE = 2_000;
const GREP_BUDGET_MS = 20_000;

export function readTools(ctx) {
  const { gh, policy, target, resolve } = ctx;

  const tools = [];

  tools.push({
    name: "list_repos",
    title: "List repositories",
    description: `Lists the GitHub repositories that this server can reach, the most recently pushed first. Use it to find the owner and name of a repository. ${ALWAYS}`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Part of the name to look for. Empty: all repositories." },
        page: { type: "integer", description: "Page number, from 1." },
      },
    },
    annotations: READ,
    async run(args, { signal }) {
      const query = str(args, "query", { max: 100 })?.toLowerCase();
      const page = int(args, "page", { max: 100 }) ?? 1;
      const perPage = query ? 100 : PER_PAGE;
      const rows = await gh.get("/user/repos", { query: { per_page: perPage, page, sort: "pushed", affiliation: "owner,collaborator,organization_member" }, signal });
      const shown = rows.filter((r) => policy.allowsRepo(r.full_name) && (!query || r.full_name.toLowerCase().includes(query)));
      const lines = shown.map((r) => `${r.full_name}  ${r.private ? "private" : "public"}  default:${r.default_branch}  pushed ${day(r.pushed_at)}${r.archived ? "  archived" : ""}${r.description ? `  ${r.description.slice(0, 120)}` : ""}`);
      const more = rows.length === perPage ? `\nMore may exist: call again with page ${page + 1}.` : "";
      return (lines.length ? lines.join("\n") : "No repository matched.") + more;
    },
  });

  tools.push({
    name: "get_repo_overview",
    title: "Get a repository overview",
    description: `Gives the default branch, the branches, the files at the top level and the start of the README of one repository. Call it first when you work on a repository. ${ALWAYS}`,
    inputSchema: { type: "object", properties: { owner: OWNER, repo: REPO, ref: REF }, required: ["owner", "repo"] },
    annotations: READ,
    async run(args, { signal }) {
      const { base } = await target(args);
      const ref = str(args, "ref", { max: 250 });
      const info = await gh.get(base, { signal });
      const branches = await gh.get(`${base}/branches`, { query: { per_page: 100 }, signal });
      const out = [
        `${info.full_name}  ${info.private ? "private" : "public"}${info.archived ? "  archived" : ""}${info.fork ? "  fork" : ""}`,
        info.description ? `Description: ${info.description}` : null,
        `Default branch: ${info.default_branch}`,
        `Language: ${info.language ?? "none"}  Pushed: ${day(info.pushed_at)}  Open issues and PRs: ${info.open_issues_count}`,
        `Your rights: ${Object.entries(info.permissions ?? {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "unknown"}`,
        `Branches (${branches.length}${branches.length === 100 ? "+" : ""}): ${branches.map((b) => b.name).join(", ") || "none"}`,
      ].filter(Boolean);
      let at;
      try {
        at = await resolve(base, ref || info.default_branch, signal);
      } catch (e) {
        if (e.status === 409) return out.concat("", "The repository is empty: it has no commit.").join("\n");
        throw e;
      }
      const tree = await gh.get(`${base}/git/trees/${seg(at.tree)}`, { signal });
      out.push("", `Top level at ${at.ref} (${at.sha.slice(0, 7)}):`);
      for (const e of tree.tree) out.push(e.type === "tree" ? `${e.path}/` : e.path);
      try {
        const readme = await gh.request("GET", `${base}/readme`, { query: { ref: at.sha }, accept: "application/vnd.github.raw+json", as: "text", signal });
        const t = readme.data;
        out.push("", `README (${t.length > README_CHARS ? `first ${README_CHARS} of ${t.length} characters` : "complete"}):`, t.slice(0, README_CHARS));
      } catch (e) {
        if (e.status !== 404) throw e;
        out.push("", "No README.");
      }
      return out.join("\n");
    },
  });

  tools.push({
    name: "get_tree",
    title: "List files in a directory",
    description: `Lists the files and directories under a path of a repository. With recursive true, it lists all files under the path. Use it to find files before you read them. ${ALWAYS}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        ref: REF,
        path: { type: "string", description: 'Directory, such as "src/lib". Empty: the root.' },
        recursive: { type: "boolean", description: "true: list all files under the path, at all depths." },
      },
      required: ["owner", "repo"],
    },
    annotations: READ,
    async run(args, { signal }) {
      const { base } = await target(args);
      const ref = str(args, "ref", { max: 250 });
      const dir = (str(args, "path", { max: 1000 }) ?? "").replace(/^\/+|\/+$/g, "");
      const recursive = bool(args, "recursive");
      const at = await resolve(base, ref, signal);
      const tree = await gh.get(`${base}/git/trees/${seg(at.tree)}`, { query: { recursive: 1 }, signal });
      const prefix = dir ? `${dir}/` : "";
      let entries = tree.tree.filter((e) => e.path.startsWith(prefix) && e.path !== dir);
      if (!recursive) entries = entries.filter((e) => !e.path.slice(prefix.length).includes("/"));
      if (dir && entries.length === 0) {
        const self = tree.tree.find((e) => e.path === dir);
        if (self?.type === "blob") throw new ToolError(`${dir} is a file, not a directory. Read it with read_files.`);
        throw new ToolError(`No directory ${dir} at ${at.ref}.`);
      }
      const lines = entries.slice(0, MAX_TREE_ENTRIES).map((e) => (e.type === "tree" ? `${e.path}/` : e.type === "commit" ? `${e.path}  (submodule)` : `${e.path}  ${e.size ?? 0} B`));
      const head = `${entries.length} entries under ${dir || "the root"} at ${at.ref} (${at.sha.slice(0, 7)}):`;
      const notes = [];
      if (entries.length > MAX_TREE_ENTRIES) notes.push(`Only the first ${MAX_TREE_ENTRIES} are shown. Ask for a deeper path.`);
      if (tree.truncated) notes.push("GitHub cut the list because the repository is very large. Ask for a deeper path, with recursive false.");
      return [head, ...lines, ...notes].join("\n");
    },
  });

  tools.push({
    name: "read_files",
    title: "Read files",
    description: `Reads the text of up to 10 files of a repository, at a branch, tag or commit. A long file comes back cut, with the line numbers to ask for next. ${ALWAYS}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        paths: { type: "array", items: { type: "string" }, description: 'Paths of the files, such as ["src/index.ts", "package.json"]. At most 10.' },
        ref: REF,
        start_line: { type: "integer", description: "First line to give, from 1. Applies to each file." },
        end_line: { type: "integer", description: "Last line to give. Applies to each file." },
      },
      required: ["owner", "repo", "paths"],
    },
    annotations: READ,
    async run(args, { signal }) {
      const { base } = await target(args);
      const paths = list(args, "paths", { required: true, max: 10 }).map((p) => p.replace(/^\/+/, ""));
      const ref = str(args, "ref", { max: 250 });
      const start = int(args, "start_line") ?? 1;
      const end = int(args, "end_line");
      if (end !== undefined && end < start) throw new ToolError('"end_line" is smaller than "start_line"');

      const one = async (p) => {
        try {
          const r = await gh.request("GET", `${base}/contents/${filePath(p)}`, { query: { ref }, accept: "application/vnd.github.raw+json", as: "buffer", signal });
          const buf = r.data;
          if (String(r.headers.get("content-type") ?? "").startsWith("application/json")) {
            try {
              const j = JSON.parse(buf.toString("utf8"));
              if (Array.isArray(j) && j.every((e) => e && e.sha && e.type && e.path)) return { p, text: `${p} is a directory. List it with get_tree.` };
            } catch {
              // A JSON file, not a listing.
            }
          }
          if (isBinary(buf)) return { p, text: `${p}: binary file, ${buf.length} bytes. Not shown.` };
          return { p, body: buf.toString("utf8") };
        } catch (e) {
          if (e.name === "GitHubError") return { p, text: `${p}: ${e.message}` };
          throw e;
        }
      };
      const results = await Promise.all(paths.map(one));

      let budget = MAX_TOTAL_CHARS;
      const out = [];
      for (const r of results) {
        if (r.text) {
          out.push(`=== ${r.text}`);
          continue;
        }
        const lines = r.body.split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        const total = lines.length;
        let last = Math.min(end ?? total, total, start + MAX_FILE_LINES - 1);
        let chunk = lines.slice(start - 1, last);
        let body = chunk.join("\n");
        const cap = Math.min(MAX_FILE_CHARS, budget);
        if (body.length > cap) {
          // Cut at a line end, so no line comes back half.
          let size = 0;
          let n = 0;
          while (n < chunk.length && size + chunk[n].length + 1 <= cap) size += chunk[n++].length + 1;
          chunk = chunk.slice(0, Math.max(n, 0));
          last = start + chunk.length - 1;
          body = chunk.join("\n");
        }
        budget -= body.length;
        if (start > total) {
          out.push(`=== ${r.p} has ${total} lines. start_line ${start} is past the end.`);
          continue;
        }
        const whole = start === 1 && last === total;
        const head = whole ? `=== ${r.p} (${total} lines${ref ? `, at ${ref}` : ""})` : `=== ${r.p} (lines ${start}-${last} of ${total}${ref ? `, at ${ref}` : ""})`;
        out.push(head, body);
        if (last < total && (end === undefined || last < end)) out.push(`[cut: call read_files again with start_line ${last + 1} to read more]`);
        if (budget <= 0) {
          out.push("[the answer reached its size limit: read the other files in another call]");
          break;
        }
      }
      return out.join("\n");
    },
  });

  tools.push({
    name: "search_code",
    title: "Search code, issues or pull requests",
    description:
      `Searches GitHub. kind "code" finds code on the default branch (GitHub code search syntax, such as "createServer language:js"). ` +
      `kind "issues" finds issues and pull requests (such as "is:open is:pr label:bug"). Give owner and repo to search one repository. ${ALWAYS}`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search text, with GitHub search qualifiers if needed." },
        kind: { type: "string", enum: ["code", "issues"], description: 'What to search: "code" (the default) or "issues" (issues and pull requests).' },
        owner: { type: "string", description: "Search only the repositories of this owner." },
        repo: { type: "string", description: "Search only this repository (give owner too)." },
        page: { type: "integer", description: "Page number, from 1." },
      },
      required: ["query"],
    },
    annotations: READ,
    async run(args, { signal }) {
      const query = str(args, "query", { required: true, max: 256 });
      const kind = oneOf(args, "kind", ["code", "issues"], "code");
      const owner = str(args, "owner", { max: 100 });
      const repo = str(args, "repo", { max: 100 });
      const page = int(args, "page", { max: 10 }) ?? 1;
      if (repo && !owner) throw new ToolError('Give "owner" with "repo".');
      if (owner && repo) policy.checkRepo(owner, repo);
      const q = `${query}${owner && repo ? ` repo:${owner}/${repo}` : owner ? ` user:${owner}` : ""}`;

      if (kind === "code") {
        const r = await gh.get("/search/code", { query: { q, per_page: PER_PAGE, page }, accept: "application/vnd.github.text-match+json", signal });
        const items = r.items.filter((i) => policy.allowsRepo(i.repository.full_name));
        const out = [`${r.total_count} results${r.incomplete_results ? " (incomplete)" : ""}. Page ${page}.`];
        for (const i of items) {
          out.push(`${i.repository.full_name}  ${i.path}`);
          for (const m of (i.text_matches ?? []).slice(0, 2)) out.push(`    ${m.fragment.replace(/\s+/g, " ").trim().slice(0, 300)}`);
        }
        if (r.total_count > page * PER_PAGE) out.push(`More: call again with page ${page + 1}.`);
        if (r.total_count === 0 && owner && repo) out.push("GitHub code search often misses files. Call grep_repo for an exact search of this repository.");
        else out.push("Read a file with read_files. For an exact search of one repository, call grep_repo.");
        return out.join("\n");
      }
      const r = await gh.get("/search/issues", { query: { q, per_page: PER_PAGE, page, sort: "updated" }, signal });
      const out = [`${r.total_count} results. Page ${page}.`];
      for (const i of r.items) {
        const full = i.repository_url.split("/repos/")[1];
        if (!policy.allowsRepo(full)) continue;
        out.push(`${full}#${i.number}  ${i.pull_request ? "PR" : "issue"}  ${i.state}  ${i.title.slice(0, 150)}  (by ${i.user?.login ?? "?"}, updated ${day(i.updated_at)})`);
      }
      if (r.total_count > page * PER_PAGE) out.push(`More: call again with page ${page + 1}.`);
      return out.join("\n");
    },
  });

  tools.push({
    name: "grep_repo",
    title: "Grep a repository",
    description:
      "Finds every line that matches a text or a regular expression in the files of one repository, at any branch, tag or commit. " +
      "It is exact and complete, unlike search_code, so prefer it to find where a name is used or defined. " +
      `It gives path:line: text. ${ALWAYS}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        pattern: { type: "string", description: "The text to find. With regex true, a JavaScript regular expression." },
        ref: REF,
        path: { type: "string", description: 'Search only under this directory or file, such as "src/". Empty: the whole repository.' },
        regex: { type: "boolean", description: "true: pattern is a regular expression. false (the default): plain text." },
        ignore_case: { type: "boolean", description: "true: upper and lower case match each other." },
        max_results: { type: "integer", description: "Most lines to give, from 1 to 300. Default 100." },
      },
      required: ["owner", "repo", "pattern"],
    },
    annotations: READ,
    async run(args, { signal }) {
      const { base } = await target(args);
      const pattern = str(args, "pattern", { required: true, max: 500 });
      const ref = str(args, "ref", { max: 250 });
      const prefix = (str(args, "path", { max: 1000 }) ?? "").replace(/^\/+/, "");
      const max = int(args, "max_results", { max: 300 }) ?? 100;
      const flags = bool(args, "ignore_case") ? "i" : "";
      let re;
      try {
        re = new RegExp(bool(args, "regex") ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      } catch (e) {
        throw new ToolError(`The regular expression is not valid: ${e.message}`);
      }
      const at = ref ?? (await gh.get(base, { signal })).default_branch;
      const r = await gh.request("GET", `${base}/tarball/${filePath(at)}`, { as: "buffer", signal });
      const hits = [];
      let files = 0;
      let skipped = 0;
      let stoppedAt = null;
      const deadline = Date.now() + GREP_BUDGET_MS;
      readTarGz(r.data, (p, data) => {
        if (prefix && !(p === prefix || p.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) return true;
        if (data.length > GREP_MAX_FILE || isBinary(data)) {
          skipped++;
          return true;
        }
        files++;
        const lines = data.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].length > GREP_MAX_LINE ? lines[i].slice(0, GREP_MAX_LINE) : lines[i];
          if (re.test(line)) {
            hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 200)}`);
            if (hits.length >= max) {
              stoppedAt = "max_results";
              return false;
            }
          }
        }
        if (Date.now() > deadline) {
          stoppedAt = "time";
          return false;
        }
        return true;
      });
      const head = `${hits.length} matching lines in ${files} files at ${at}${prefix ? ` under ${prefix}` : ""}${skipped ? ` (${skipped} binary or large files skipped)` : ""}.`;
      const notes = [];
      if (stoppedAt === "max_results") notes.push(`Stopped at ${max} lines. Give a narrower path or pattern, or a larger max_results.`);
      if (stoppedAt === "time") notes.push("Stopped early to stay inside the time limit. Give a narrower path.");
      return [head, ...hits, ...notes].join("\n");
    },
  });

  return tools;
}
