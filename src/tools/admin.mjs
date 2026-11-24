// Tools for repository settings: visibility, features, merge options,
// archive and topics. They are off by default. Set ADMIN_TOOLS=1 to add
// them, and give the token "Administration: Read and write".
//
// There are no tools for delete, transfer, collaborators, webhooks, secrets
// or branch protection. Each change gives the old values, to undo.
//
// GitHub has no API to leave a fork network. get_repo_settings says if a
// fork can leave its network, and gives the settings page to do it.
//
// Sources:
// - https://docs.github.com/en/rest/repos/repos#update-a-repository
// - https://docs.github.com/en/rest/repos/repos#get-all-repository-topics
// - https://docs.github.com/en/rest/repos/repos#replace-all-repository-topics
// - https://docs.github.com/en/pull-requests/how-tos/work-with-forks/detaching-a-fork
// - https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
import { ToolError } from "../rpc.mjs";
import { ALWAYS, OWNER, REPO, str, bool, list, oneOf } from "./common.mjs";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const ADMIN = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const ACT = "To change the repository, always call this tool, and never say that a change is done before the tool confirms it.";

// The limits of "Leave fork network", from the GitHub docs.
const DETACH_MAX_KB = 1024 * 1024;

// Boolean settings that the PATCH accepts, with no risk to the code.
const FLAGS = ["has_issues", "has_wiki", "has_projects", "has_discussions", "allow_squash_merge", "allow_merge_commit", "allow_rebase_merge", "allow_auto_merge", "delete_branch_on_merge", "allow_forking"];
// Settings that change who sees the repository or whether it takes pushes.
// They need confirm = "owner/repo".
const RISKY = ["visibility", "archived", "default_branch"];

const flag = (v) => (v === undefined || v === null ? "?" : v ? "on" : "off");

// Can this fork leave its network with the button on GitHub?
export function detachCheck(info) {
  if (!info.fork) return null;
  const why = [];
  if (info.private) why.push("the fork is private");
  if (info.size >= DETACH_MAX_KB) why.push(`the fork is ${Math.round(info.size / 1024)} MB, and the limit is 1 GB`);
  if (info.forks_count > 0) why.push(`the fork has ${info.forks_count} child forks`);
  return { ok: why.length === 0, why };
}

export function adminTools(ctx) {
  const { gh, target } = ctx;
  const tools = [];

  tools.push({
    name: "get_repo_settings",
    title: "Get repository settings",
    description: `Gives the settings of a repository: visibility, fork source, archive state, features, merge options, topics, and if a fork can leave its fork network. ${ALWAYS}`,
    inputSchema: { type: "object", properties: { owner: OWNER, repo: REPO }, required: ["owner", "repo"] },
    annotations: READ,
    async run(args, { signal }) {
      const { owner, repo, base } = target(args);
      const [info, topics] = await Promise.all([gh.get(base, { signal }), gh.get(`${base}/topics`, { signal })]);
      const out = [
        `${info.full_name}  visibility: ${info.visibility ?? (info.private ? "private" : "public")}${info.archived ? "  archived" : ""}`,
        `Default branch: ${info.default_branch}. Size: ${Math.round((info.size ?? 0) / 1024)} MB. Forks: ${info.forks_count ?? 0}. Stars: ${info.stargazers_count ?? 0}.`,
        `Description: ${info.description || "none"}`,
        `Homepage: ${info.homepage || "none"}`,
        `Topics: ${topics.names?.join(", ") || "none"}`,
        `Features: issues ${flag(info.has_issues)}, wiki ${flag(info.has_wiki)}, projects ${flag(info.has_projects)}, discussions ${flag(info.has_discussions)}, forking ${flag(info.allow_forking)}.`,
        `Merge: merge commit ${flag(info.allow_merge_commit)}, squash ${flag(info.allow_squash_merge)}, rebase ${flag(info.allow_rebase_merge)}, auto-merge ${flag(info.allow_auto_merge)}, delete branch on merge ${flag(info.delete_branch_on_merge)}.`,
        `Your rights: ${Object.entries(info.permissions ?? {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "unknown"}`,
      ];
      const d = detachCheck(info);
      if (d) {
        out.push("", `This is a fork of ${info.parent?.full_name ?? info.source?.full_name ?? "another repository"}.`);
        out.push(
          d.ok
            ? "It can leave its fork network. GitHub has no API for this: the owner must click Settings > Danger Zone > Leave fork network on " +
                `https://github.com/${owner}/${repo}/settings. This is permanent: issues, pull requests, wiki, stars and watchers do not stay. The commits stay.`
            : `It cannot leave its fork network with the button, because ${d.why.join(" and ")}. GitHub Support can help.`,
        );
      }
      return out.join("\n");
    },
  });

  tools.push({
    name: "update_repo_settings",
    title: "Update repository settings",
    description:
      "Changes the settings of a repository: visibility, archive, default branch, description, homepage, features and merge options. " +
      'Give only the settings to change. visibility, archived and default_branch also need confirm set to "owner/repo": ask the user first. ' +
      `The result gives the old values, to undo. ${ACT}`,
    inputSchema: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO,
        visibility: { type: "string", enum: ["public", "private"], description: "Who can see the repository. Needs confirm." },
        archived: { type: "boolean", description: "true: the repository becomes read-only. false: it takes pushes again. Needs confirm." },
        default_branch: { type: "string", description: "The new default branch. It must exist. Needs confirm." },
        description: { type: "string", description: "Short description. An empty string removes it." },
        homepage: { type: "string", description: "Homepage URL. An empty string removes it." },
        ...Object.fromEntries(FLAGS.map((k) => [k, { type: "boolean", description: `The setting ${k}.` }])),
        confirm: { type: "string", description: 'The full name "owner/repo". Required for visibility, archived and default_branch.' },
      },
      required: ["owner", "repo"],
    },
    annotations: ADMIN,
    write: true,
    admin: true,
    async run(args, { signal }) {
      const { owner, repo, base } = target(args);
      const patch = {};
      if (args.visibility !== undefined) patch.visibility = oneOf(args, "visibility", ["public", "private"]);
      if (args.archived !== undefined) patch.archived = bool(args, "archived");
      const branch = str(args, "default_branch", { max: 250 });
      if (branch !== undefined) patch.default_branch = branch;
      for (const k of ["description", "homepage"]) {
        if (args[k] === "") patch[k] = "";
        else if (args[k] !== undefined) patch[k] = str(args, k, { max: k === "description" ? 350 : 500 });
      }
      for (const k of FLAGS) if (args[k] !== undefined) patch[k] = bool(args, k);
      if (Object.keys(patch).length === 0) throw new ToolError("Give at least one setting to change.");

      const risky = RISKY.filter((k) => k in patch);
      const full = `${owner}/${repo}`;
      if (risky.length && String(args.confirm ?? "").toLowerCase() !== full.toLowerCase()) {
        throw new ToolError(`${risky.join(", ")} need confirm set to "${full}". Ask the user first, then call again.`);
      }

      const old = await gh.get(base, { signal });
      // GitHub can refuse an archived repository with other changes in the
      // same call, so unarchive first and archive last.
      const { archived, ...rest } = patch;
      const steps = [];
      if (archived === false) steps.push({ archived: false });
      if (Object.keys(rest).length) steps.push(rest);
      if (archived === true) steps.push({ archived: true });

      let now = old;
      try {
        for (const body of steps) now = (await gh.request("PATCH", base, { body, signal })).data;
      } catch (e) {
        if (e.status === 422 && patch.visibility === "private" && old.fork && !old.private) {
          const d = detachCheck(old);
          throw new ToolError(
            `GitHub did not make the fork ${full} private: ${e.message}. A public fork must leave its fork network first. ` +
              (d.ok ? `GitHub has no API for this: the owner clicks Settings > Danger Zone > Leave fork network on https://github.com/${full}/settings, then calls this tool again.` : `It cannot leave with the button, because ${d.why.join(" and ")}. GitHub Support can help.`),
          );
        }
        if (e.status === 403) throw new ToolError(`${e.message}. The token needs "Administration: Read and write" on ${full}.`);
        throw e;
      }

      const shown = (o, k) => (k === "visibility" ? o.visibility ?? (o.private ? "private" : "public") : JSON.stringify(o[k] ?? null));
      const lines = Object.keys(patch).map((k) => `- ${k}: ${shown(old, k)} -> ${shown(now, k)}`);
      return [`Updated ${full}:`, ...lines, "To undo, call again with the old values.", now.html_url].filter(Boolean).join("\n");
    },
  });

  tools.push({
    name: "set_repo_topics",
    title: "Set repository topics",
    description: `Replaces all topics of a repository. Topics are lower case, with letters, digits and "-", up to 50 characters, at most 20. An empty list removes all. The result gives the old topics. ${ACT}`,
    inputSchema: {
      type: "object",
      properties: { owner: OWNER, repo: REPO, topics: { type: "array", items: { type: "string" }, description: "The complete list of topics. It replaces the old list." } },
      required: ["owner", "repo", "topics"],
    },
    annotations: ADMIN,
    write: true,
    admin: true,
    async run(args, { signal }) {
      const { owner, repo, base } = target(args);
      if (!Array.isArray(args.topics) && typeof args.topics !== "string") throw new ToolError('"topics" is a list of strings');
      const names = list(args, "topics", { max: 20 }).map((t) => t.trim().toLowerCase());
      const bad = names.find((t) => !/^[a-z0-9][a-z0-9-]{0,49}$/.test(t));
      if (bad) throw new ToolError(`"${bad}" is not a valid topic: use lower case letters, digits and "-", up to 50 characters, starting with a letter or digit`);
      const old = await gh.get(`${base}/topics`, { signal });
      const now = (await gh.request("PUT", `${base}/topics`, { body: { names }, signal })).data;
      return `Topics of ${owner}/${repo}: ${old.names?.join(", ") || "none"} -> ${now.names?.join(", ") || "none"}`;
    },
  });

  return tools;
}
