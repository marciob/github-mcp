// Tests for the serverless handler: discovery, token check, scope, JSON-RPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebHandler } from "../src/web.mjs";
import { createApp } from "../src/app.mjs";
import { fakeGitHub, config } from "./fake-github.mjs";

const RESOURCE = "https://gh.example.app/api/mcp";
const { server } = createApp({ config: config(), fetch: fakeGitHub({}).fetch });
const logs = [];
const handle = createWebHandler({
  server,
  resource: RESOURCE,
  authServer: "https://auth.example.app",
  scope: "github",
  verifyToken: async (t) => (t === "good" ? "client-1" : t === "boom" ? Promise.reject(new Error("db down")) : null),
  log: (l) => logs.push(l),
});
const post = (body, token, headers = {}) =>
  handle(new Request(RESOURCE, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) }));
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } };

test("discovery names the authorization server and the scope", async () => {
  for (const u of ["https://gh.example.app/.well-known/oauth-protected-resource/api/mcp", "https://gh.example.app/api/mcp?op=resource"]) {
    const r = await (await handle(new Request(u))).json();
    assert.equal(r.resource, RESOURCE);
    assert.deepEqual(r.authorization_servers, ["https://auth.example.app"]);
    assert.deepEqual(r.scopes_supported, ["github"]);
  }
});

test("no token or a wrong token gets 401 with the discovery address", async () => {
  for (const t of [null, "bad"]) {
    const r = await post(init, t);
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), 'Bearer resource_metadata="https://gh.example.app/.well-known/oauth-protected-resource/api/mcp", scope="github"');
  }
});

test("a failed token check gives 503, not 401, so the client does not log in again", async () => {
  assert.equal((await post(init, "boom")).status, 503);
});

test("a valid token reaches the MCP server, and a notification gets 202", async () => {
  const r = await post(init, "good");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result.protocolVersion, "2025-11-25");
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, "good")).status, 202);
  const list = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "good")).json();
  assert.equal(list.result.tools.length, 20);
});

test("bad bodies, batches and other paths are refused", async () => {
  const bad = await handle(new Request(RESOURCE, { method: "POST", headers: { authorization: "Bearer good" }, body: "{" }));
  assert.equal(bad.status, 400);
  assert.equal((await post([init], "good")).status, 400);
  assert.equal((await post(init, "good", { "mcp-method": "tools/list" })).status, 400);
  assert.equal((await handle(new Request("https://gh.example.app/other"))).status, 404);
  assert.equal((await handle(new Request(RESOURCE, { headers: { authorization: "Bearer good" } }))).status, 405);
});

test("the log has no token", () => {
  assert.ok(!logs.join("\n").includes("good"));
});
