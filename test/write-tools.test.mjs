// Tests for the write tools, against a fake GitHub API that records each call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";
import { fakeGitHub, config } from "./fake-github.mjs";

const R = "/repos/alice/app";
const TIP = "a".repeat(40);
const TREE = "t".repeat(40);
const json = (body, status = 200) => ({ status, body });

function base(extra = {}) {
  return {
    [`GET ${R}`]: json({ full_name: "alice/app", default_branch: "main" }),
    [`GET ${R}/git/ref/heads/main`]: json({ object: { sha: TIP } }),
    [`GET ${R}/git/ref/heads/feature/x`]: json({ object: { sha: TIP } }),
    [`GET ${R}/commits/main`]: json({ sha: TIP, commit: { tree: { sha: TREE } } }),
    [`GET ${R}/git/commits/${TIP}`]: json({ sha: TIP, tree: { sha: TREE } }),
    [`GET ${R}/git/trees/${TREE}`]: json({ truncated: false, tree: [
      { path: "run.sh", type: "blob", mode: "100755" },
      { path: "old.txt", type: "blob", mode: "100644" },
      { path: "src/a.ts", type: "blob", mode: "100644" },
    ] }),
    [`POST ${R}/git/blobs`]: json({ sha: "b".repeat(40) }, 201),
    [`POST ${R}/git/trees`]: json({ sha: "n".repeat(40) }, 201),
    [`POST ${R}/git/commits`]: json({ sha: "c".repeat(40), html_url: "https://github.com/alice/app/commit/ccc" }, 201),
    [`PATCH ${R}/git/refs/heads/main`]: json({ object: { sha: "c".repeat(40) } }),
    [`PATCH ${R}/git/refs/heads/feature/x`]: json({ object: { sha: "c".repeat(40) } }),
    [`POST ${R}/git/refs`]: json({ ref: "refs/heads/new" }, 201),
    ...extra,
  };
}

function setup(routes, extra) {
  const gh = fakeGitHub(routes);
  const { server } = createApp({ config: config(extra), fetch: gh.fetch });
  const call = async (name, args) => (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { owner: "alice", repo: "app", ...args } } })).result;
  const bodyOf = (key) => JSON.parse(gh.calls.find((c) => c.key === key).init.body);
  const writes = () => gh.calls.filter((c) => c.init.method && c.init.method !== "GET").map((c) => c.key);
  return { call, gh, bodyOf, writes };
}

test("commit_files writes many files in one commit, keeps modes, deletes, and moves the branch without force", async () => {
  const { call, bodyOf } = setup(base());
  const r = await call("commit_files", {
    branch: "main",
    message: "Change things",
    files: [
      { path: "run.sh", content: "#!/bin/sh\necho hi\n" },
      { path: "old.txt", delete: true },
      { path: "img.png", content: "iVBORw0KGgo=", base64: true },
      { path: "src/new.ts", content: "export {}\n" },
    ],
  });
  assert.equal(r.isError, false, r.content[0].text);
  assert.match(r.content[0].text, /Committed ccccccc to main: 3 files written, 1 deleted/);
  assert.match(r.content[0].text, /https:\/\/github.com\/alice\/app\/commit\/ccc/);
  const tree = bodyOf(`POST ${R}/git/trees`);
  assert.equal(tree.base_tree, TREE);
  assert.deepEqual(tree.tree.find((e) => e.path === "run.sh"), { path: "run.sh", mode: "100755", type: "blob", content: "#!/bin/sh\necho hi\n" });
  assert.deepEqual(tree.tree.find((e) => e.path === "old.txt"), { path: "old.txt", mode: "100644", type: "blob", sha: null });
  assert.equal(tree.tree.find((e) => e.path === "img.png").sha, "b".repeat(40));
  assert.deepEqual(bodyOf(`POST ${R}/git/commits`), { message: "Change things", tree: "n".repeat(40), parents: [TIP] });
  assert.deepEqual(bodyOf(`PATCH ${R}/git/refs/heads/main`), { sha: "c".repeat(40), force: false });
});

test("commit_files creates a missing branch from the default branch", async () => {
  const { call, bodyOf } = setup(base({ [`PATCH ${R}/git/refs/heads/fix/bug`]: json({}) }));
  const r = await call("commit_files", { branch: "fix/bug", message: "Fix", files: [{ path: "src/a.ts", content: "x" }] });
  assert.match(r.content[0].text, /Created the branch fix\/bug from main/);
  assert.deepEqual(bodyOf(`POST ${R}/git/refs`), { ref: "refs/heads/fix/bug", sha: TIP });
});

test("commit_files writes nothing when a delete names a missing file, or the branch is not where expected", async () => {
  const a = setup(base());
  const r1 = await a.call("commit_files", { branch: "main", message: "m", files: [{ path: "nope.txt", delete: true }] });
  assert.match(r1.content[0].text, /no such file/);
  assert.deepEqual(a.writes(), []);
  const b = setup(base());
  const r2 = await b.call("commit_files", { branch: "main", message: "m", expected_head_sha: "d".repeat(40), files: [{ path: "x", content: "y" }] });
  assert.match(r2.content[0].text, /not at d+/);
  assert.deepEqual(b.writes(), []);
});

test("commit_files says so when the branch moved during the commit", async () => {
  const { call } = setup(base({ [`PATCH ${R}/git/refs/heads/main`]: json({ message: "Update is not a fast forward" }, 422) }));
  const r = await call("commit_files", { branch: "main", message: "m", files: [{ path: "x", content: "y" }] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /moved while the commit was made/);
});

test("commit_files on an empty repository makes the first commit with the contents API", async () => {
  const { call, bodyOf } = setup({
    [`GET ${R}/git/ref/heads/main`]: json({ message: "Git Repository is empty." }, 409),
    [`PUT ${R}/contents/README.md`]: json({ commit: { sha: "e".repeat(40), html_url: "https://github.com/alice/app/commit/eee" } }, 201),
  });
  const r = await call("commit_files", { branch: "main", message: "Start", files: [{ path: "README.md", content: "# App\n" }] });
  assert.match(r.content[0].text, /Committed eeeeeee to main: 1 file/);
  assert.deepEqual(bodyOf(`PUT ${R}/contents/README.md`), { message: "Start", content: Buffer.from("# App\n").toString("base64"), branch: "main" });
});

test("bad file lists are refused before any call", async () => {
  const { call, gh } = setup(base());
  for (const files of [[], [{ path: "../etc/passwd", content: "x" }], [{ path: ".git/config", content: "x" }], [{ path: "a" }], [{ path: "a", content: "1" }, { path: "a", content: "2" }]]) {
    const r = await call("commit_files", { branch: "main", message: "m", files });
    assert.equal(r.isError, true, JSON.stringify(files));
  }
  const bad = await call("commit_files", { branch: "a..b", message: "m", files: [{ path: "a", content: "1" }] });
  assert.match(bad.content[0].text, /not a valid branch name/);
  assert.equal(gh.calls.length, 0);
});

test("reset_branch force-moves a branch and gives the old SHA to undo it", async () => {
  const { call, bodyOf } = setup(base());
  const to = "f".repeat(40);
  const r = await call("reset_branch", { branch: "feature/x", to });
  assert.match(r.content[0].text, new RegExp(`from ${TIP} to ${to}. To undo: reset_branch with to "${TIP}"`));
  assert.deepEqual(bodyOf(`PATCH ${R}/git/refs/heads/feature/x`), { sha: to, force: true });
});

test("PROTECTED_BRANCHES stops reset and delete, and the default branch is never deleted", async () => {
  const p = setup(base(), { protectedBranches: ["main", "release/*"] });
  assert.match((await p.call("reset_branch", { branch: "main", to: "f".repeat(40) })).content[0].text, /protected branch/);
  assert.match((await p.call("delete_branch", { branch: "release/1.0" })).content[0].text, /protected branch/);
  assert.deepEqual(p.writes(), []);
  const q = setup(base());
  assert.match((await q.call("delete_branch", { branch: "main" })).content[0].text, /default branch/);
  assert.deepEqual(q.writes(), []);
});

test("delete_branch gives the SHA to make the branch again", async () => {
  const { call, writes } = setup(base({ [`DELETE ${R}/git/refs/heads/feature/x`]: { status: 204 } }));
  const r = await call("delete_branch", { branch: "feature/x" });
  assert.match(r.content[0].text, new RegExp(`It was at ${TIP}. To undo: create_branch`));
  assert.deepEqual(writes(), [`DELETE ${R}/git/refs/heads/feature/x`]);
});

test("a pull request opens into the default branch, and a failed merge says why", async () => {
  const { call, bodyOf } = setup(base({
    [`POST ${R}/pulls`]: json({ number: 7, draft: false, html_url: "https://github.com/alice/app/pull/7" }, 201),
    [`PUT ${R}/pulls/7/merge`]: json({ message: "Pull Request is not mergeable" }, 405),
    [`PUT ${R}/pulls/8/merge`]: json({ sha: "9".repeat(40), merged: true, message: "Pull Request successfully merged" }),
  }));
  const r = await call("create_or_update_pull_request", { title: "Fix", head: "fix/bug", body: "Why" });
  assert.match(r.content[0].text, /Opened pull request #7: fix\/bug -> main/);
  assert.deepEqual(bodyOf(`POST ${R}/pulls`), { title: "Fix", body: "Why", head: "fix/bug", base: "main", draft: false });
  assert.match((await call("merge_pull_request", { number: 7 })).content[0].text, /did not merge #7: .*not mergeable/);
  const ok = await call("merge_pull_request", { number: 8, method: "squash", expected_head_sha: "abc" });
  assert.match(ok.content[0].text, /Merged pull request #8 with squash/);
});

test("READ_ONLY leaves no tool that writes", async () => {
  const { server } = createApp({ config: config({ readOnly: true }), fetch: fakeGitHub({}).fetch });
  const r = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(r.result.tools.every((t) => t.annotations.readOnlyHint === true));
  const c = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "commit_files", arguments: {} } });
  assert.equal(c.error.code, -32602);
});

test("an error result says plainly that the call failed, and enums take any case", async () => {
  const { call } = setup(base({ [`PUT ${R}/pulls/9/merge`]: json({ sha: "9".repeat(40), message: "ok" }) }));
  const bad = await call("merge_pull_request", { number: 9, method: "fast-forward" });
  assert.match(bad.content[0].text, /^ERROR: the call failed\. Tell the user that it failed/);
  assert.equal(bad._reason, undefined);
  const ok = await call("merge_pull_request", { number: 9, method: "SQUASH" });
  assert.match(ok.content[0].text, /Merged pull request #9 with squash/);
});
