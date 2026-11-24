// Tests for the settings tools, against a fake GitHub API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";
import { fakeGitHub, config } from "./fake-github.mjs";

const R = "/repos/alice/app";
const repo = (extra = {}) => ({
  full_name: "alice/app", html_url: "https://github.com/alice/app", private: false, visibility: "public", default_branch: "main",
  size: 4013, forks_count: 0, stargazers_count: 0, has_issues: true, has_wiki: false, archived: false,
  permissions: { admin: true, push: true, pull: true }, ...extra,
});

function setup(routes, extra = { adminTools: true }) {
  const gh = fakeGitHub(routes);
  const { server, tools } = createApp({ config: config(extra), fetch: gh.fetch });
  const call = async (name, args) => (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { owner: "alice", repo: "app", ...args } } })).result;
  const writes = () => gh.calls.filter((c) => c.init.method && c.init.method !== "GET");
  return { call, gh, tools, writes };
}

test("the settings write tools are off by default and off in read-only mode", () => {
  const names = (extra) => setup({}, extra).tools.map((t) => t.name);
  assert.ok(names({}).includes("get_repo_settings"));
  assert.ok(!names({}).includes("update_repo_settings"));
  assert.ok(!names({ adminTools: true, readOnly: true }).includes("update_repo_settings"));
  assert.ok(names({ adminTools: true }).includes("update_repo_settings"));
  assert.ok(names({ adminTools: true }).includes("set_repo_topics"));
});

test("get_repo_settings says that a small public fork can leave its network, with the settings page", async () => {
  const { call } = setup({ [`GET ${R}`]: { body: repo({ fork: true, parent: { full_name: "bob/app" } }) }, [`GET ${R}/topics`]: { body: { names: ["cli"] } } });
  const r = await call("get_repo_settings", {});
  assert.equal(r.isError, false, r.content[0].text);
  assert.match(r.content[0].text, /visibility: public/);
  assert.match(r.content[0].text, /Topics: cli/);
  assert.match(r.content[0].text, /fork of bob\/app/);
  assert.match(r.content[0].text, /can leave its fork network.*https:\/\/github.com\/alice\/app\/settings/s);
});

test("get_repo_settings says why a fork cannot leave its network", async () => {
  const { call } = setup({ [`GET ${R}`]: { body: repo({ fork: true, forks_count: 2, size: 2_000_000 }) }, [`GET ${R}/topics`]: { body: { names: [] } } });
  const r = await call("get_repo_settings", {});
  assert.match(r.content[0].text, /cannot leave.*child forks/s);
  assert.match(r.content[0].text, /limit is 1 GB/);
});

test("update_repo_settings refuses visibility without confirm and sends nothing", async () => {
  const { call, writes } = setup({ [`GET ${R}`]: { body: repo() } });
  const r = await call("update_repo_settings", { visibility: "private" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /confirm set to "alice\/app"/);
  assert.equal(writes().length, 0);
});

test("update_repo_settings changes visibility with confirm and gives the old value", async () => {
  const { call, gh } = setup({ [`GET ${R}`]: { body: repo() }, [`PATCH ${R}`]: { body: repo({ private: true, visibility: "private" }) } });
  const r = await call("update_repo_settings", { visibility: "PRIVATE", confirm: "alice/app" });
  assert.equal(r.isError, false, r.content[0].text);
  assert.match(r.content[0].text, /visibility: public -> private/);
  assert.deepEqual(JSON.parse(gh.calls.find((c) => c.key === `PATCH ${R}`).init.body), { visibility: "private" });
});

test("a safe setting needs no confirm", async () => {
  const { call } = setup({ [`GET ${R}`]: { body: repo() }, [`PATCH ${R}`]: { body: repo({ has_wiki: true }) } });
  const r = await call("update_repo_settings", { has_wiki: true });
  assert.equal(r.isError, false, r.content[0].text);
  assert.match(r.content[0].text, /has_wiki: false -> true/);
});

test("archive goes last, in its own call", async () => {
  const { call, writes } = setup({ [`GET ${R}`]: { body: repo() }, [`PATCH ${R}`]: { body: repo({ archived: true }) } });
  const r = await call("update_repo_settings", { archived: true, description: "old", confirm: "alice/app" });
  assert.equal(r.isError, false, r.content[0].text);
  assert.deepEqual(writes().map((c) => JSON.parse(c.init.body)), [{ description: "old" }, { archived: true }]);
});

test("a 422 on a public fork explains how to leave the fork network", async () => {
  const { call } = setup({
    [`GET ${R}`]: { body: repo({ fork: true }) },
    [`PATCH ${R}`]: { status: 422, body: { message: "Validation Failed" } },
  });
  const r = await call("update_repo_settings", { visibility: "private", confirm: "alice/app" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /must leave its fork network first.*Leave fork network/s);
});

test("set_repo_topics checks the names and gives the old topics", async () => {
  const { call, gh } = setup({ [`GET ${R}/topics`]: { body: { names: ["old"] } }, [`PUT ${R}/topics`]: { body: { names: ["cli", "mcp"] } } });
  const bad = await call("set_repo_topics", { topics: ["Not Valid"] });
  assert.equal(bad.isError, true);
  const r = await call("set_repo_topics", { topics: ["CLI", "mcp"] });
  assert.equal(r.isError, false, r.content[0].text);
  assert.match(r.content[0].text, /old -> cli, mcp/);
  assert.deepEqual(JSON.parse(gh.calls.find((c) => c.key === `PUT ${R}/topics`).init.body), { names: ["cli", "mcp"] });
});
