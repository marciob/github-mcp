// Tests for the read tools, against a fake GitHub API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";
import { fakeGitHub, config } from "./fake-github.mjs";

const R = "/repos/alice/app";
const routes = {
  "GET /user/repos": { body: [
    { full_name: "alice/app", private: true, default_branch: "main", pushed_at: "2026-11-20T10:00:00Z", description: "The app" },
    { full_name: "bob/other", private: false, default_branch: "master", pushed_at: "2026-11-01T10:00:00Z" },
  ] },
  [`GET ${R}`]: { body: { full_name: "alice/app", private: true, default_branch: "main", language: "TypeScript", pushed_at: "2026-11-20T10:00:00Z", open_issues_count: 3, permissions: { admin: true, push: true, pull: true } } },
  [`GET ${R}/branches`]: { body: [{ name: "main" }, { name: "feature/x" }] },
  [`GET ${R}/commits/main`]: { body: { sha: "a".repeat(40), commit: { tree: { sha: "t".repeat(40) } } } },
  [`GET ${R}/commits/feature/x`]: { body: { sha: "b".repeat(40), commit: { tree: { sha: "u".repeat(40) } } } },
  [`GET ${R}/git/trees/${"t".repeat(40)}`]: (u) => ({ body: { truncated: false, tree: u.searchParams.get("recursive")
    ? [{ path: "README.md", type: "blob", size: 10 }, { path: "src", type: "tree" }, { path: "src/index.ts", type: "blob", size: 99 }, { path: "src/lib", type: "tree" }, { path: "src/lib/a.ts", type: "blob", size: 5 }]
    : [{ path: "README.md", type: "blob", size: 10 }, { path: "src", type: "tree" }] } }),
  [`GET ${R}/readme`]: { raw: "# App\nHello" },
  [`GET ${R}/contents/src/index.ts`]: { raw: Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n" },
  [`GET ${R}/contents/logo.png`]: { raw: Buffer.from([0x89, 0x50, 0x00, 0x01]) },
  [`GET ${R}/contents/src`]: { body: [{ sha: "x", type: "file", path: "src/index.ts" }] },
  "GET /search/code": { body: { total_count: 2, incomplete_results: false, items: [
    { path: "src/index.ts", repository: { full_name: "alice/app" }, text_matches: [{ fragment: "export function\n createServer()" }] },
    { path: "x.js", repository: { full_name: "bob/other" }, text_matches: [] },
  ] } },
};

const setup = (extra) => {
  const gh = fakeGitHub(routes);
  const { server } = createApp({ config: config(extra), fetch: gh.fetch });
  const call = async (name, args) => (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).result;
  return { call, gh };
};

test("list_repos lists repositories and keeps to REPOS", async () => {
  const { call } = setup({ repos: ["alice/*"] });
  const r = await call("list_repos", {});
  assert.match(r.content[0].text, /alice\/app  private  default:main/);
  assert.doesNotMatch(r.content[0].text, /bob\/other/);
});

test("a repository outside REPOS is refused before any call to GitHub", async () => {
  const { call, gh } = setup({ repos: ["alice/app"] });
  const r = await call("get_repo_overview", { owner: "bob", repo: "other" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /does not give access/);
  assert.equal(gh.calls.length, 0);
});

test("get_repo_overview gives branches, top level and README", async () => {
  const { call } = setup();
  const t = (await call("get_repo_overview", { owner: "alice", repo: "app" })).content[0].text;
  assert.match(t, /Default branch: main/);
  assert.match(t, /feature\/x/);
  assert.match(t, /^src\/$/m);
  assert.match(t, /# App/);
});

test("get_tree lists one level, or all levels with recursive", async () => {
  const { call } = setup();
  const one = (await call("get_tree", { owner: "alice", repo: "app", path: "src" })).content[0].text;
  assert.match(one, /src\/index.ts  99 B/);
  assert.match(one, /src\/lib\//);
  assert.doesNotMatch(one, /a\.ts/);
  const all = (await call("get_tree", { owner: "alice", repo: "app", path: "src", recursive: true })).content[0].text;
  assert.match(all, /src\/lib\/a.ts/);
  const file = await call("get_tree", { owner: "alice", repo: "app", path: "README.md" });
  assert.match(file.content[0].text, /is a file/);
});

test("read_files cuts a long file at 2000 lines and says how to read on", async () => {
  const { call } = setup();
  const t = (await call("read_files", { owner: "alice", repo: "app", paths: ["src/index.ts"] })).content[0].text;
  assert.match(t, /lines 1-2000 of 2500/);
  assert.match(t, /start_line 2001/);
  const tail = (await call("read_files", { owner: "alice", repo: "app", paths: ["src/index.ts"], start_line: 2490 })).content[0].text;
  assert.match(tail, /lines 2490-2500 of 2500/);
  assert.match(tail, /^line 2500$/m);
});

test("read_files shows no binary file, names a directory, and reports a missing file without failing the others", async () => {
  const { call } = setup();
  const t = (await call("read_files", { owner: "alice", repo: "app", paths: ["logo.png", "src", "nope.txt", "src/index.ts"], start_line: 1, end_line: 2 })).content[0].text;
  assert.match(t, /logo.png: binary file, 4 bytes/);
  assert.match(t, /src is a directory/);
  assert.match(t, /nope.txt: GitHub answered 404/);
  assert.match(t, /lines 1-2 of 2500/);
});

test("read_files at a branch with a slash keeps the slash in the path", async () => {
  const { call, gh } = setup();
  await call("read_files", { owner: "alice", repo: "app", paths: ["src/index.ts"], ref: "feature/x" });
  const c = gh.calls.find((x) => x.key.includes("/contents/"));
  assert.equal(c.url.searchParams.get("ref"), "feature/x");
});

test("search_code adds the repository and drops results outside REPOS", async () => {
  const { call, gh } = setup({ repos: ["alice/*"] });
  const t = (await call("search_code", { query: "createServer", owner: "alice", repo: "app" })).content[0].text;
  assert.equal(gh.calls[0].url.searchParams.get("q"), "createServer repo:alice/app");
  assert.match(t, /alice\/app  src\/index.ts/);
  assert.match(t, /export function createServer\(\)/);
  assert.doesNotMatch(t, /bob/);
});

test("the GitHub token goes only in the Authorization header", async () => {
  const { call, gh } = setup();
  await call("list_repos", {});
  const c = gh.calls[0];
  assert.equal(c.init.headers.authorization, "Bearer test-github-token-never-logged");
  assert.ok(!c.url.toString().includes("test-github-token"));
});

test("bad arguments give a clear error", async () => {
  const { call } = setup();
  assert.match((await call("read_files", { owner: "alice", repo: "app" })).content[0].text, /"paths" is required/);
  assert.match((await call("get_tree", { owner: "../x", repo: "app" })).content[0].text, /"owner"/);
  assert.match((await call("read_files", { owner: "alice", repo: "app", paths: ["a"], start_line: 5, end_line: 2 })).content[0].text, /smaller/);
});

// A small tar writer for the tests: one ustar header per file, with a pax
// header for a long path, as GitHub sends.
import zlib from "node:zlib";
function header(name, size, type = "0") {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write("0000644\0", 100);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function tarGz(files) {
  const parts = [];
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body);
    const full = `alice-app-abc123/${name}`;
    if (full.length > 100) {
      const rec = ` path=${full}\n`;
      let len = rec.length + 2;
      len = String(len).length + rec.length;
      const pax = Buffer.from(`${len}${rec}`);
      parts.push(header("PaxHeader", pax.length, "x"), pad(pax));
    }
    parts.push(header(full, data.length), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

test("grep_repo finds lines in the tarball, keeps to the path, and handles long paths", async () => {
  const deep = `src/${"d".repeat(90)}/deep.ts`;
  const gz = tarGz({ "README.md": "createServer is here\n", "src/a.ts": "const x = 1;\nexport function createServer() {}\n", [deep]: "createServer()\n", "img.bin": Buffer.from([0, 1, 2]) });
  const gh = fakeGitHub({ ...routes, [`GET ${R}/tarball/main`]: { raw: gz } });
  const { server } = createApp({ config: config(), fetch: gh.fetch });
  const call = async (args) => (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "grep_repo", arguments: args } })).result.content[0].text;
  const all = await call({ owner: "alice", repo: "app", pattern: "createServer(" });
  assert.match(all, /^2 matching lines in 3 files at main \(1 binary or large files skipped\)/);
  assert.match(all, /^src\/a.ts:2: export function createServer\(\) \{\}$/m);
  assert.ok(all.includes(`${deep}:1: createServer()`));
  const some = await call({ owner: "alice", repo: "app", pattern: "^export", regex: true, path: "src" });
  assert.match(some, /^1 matching lines/);
  const bad = await call({ owner: "alice", repo: "app", pattern: "(", regex: true });
  assert.match(bad, /not valid/);
});
