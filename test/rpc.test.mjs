// Tests for the MCP protocol layer and the shape of the tool list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, MODERN } from "../src/rpc.mjs";
import { createApp } from "../src/app.mjs";
import { fakeGitHub, config } from "./fake-github.mjs";

const { server } = createApp({ config: config(), fetch: fakeGitHub({}).fetch });

test("initialize answers with the version that the client asked for, and instructions", async () => {
  const r = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } });
  assert.equal(r.result.protocolVersion, "2025-11-25");
  assert.deepEqual(r.result.capabilities, { tools: {} });
  assert.match(r.result.instructions, /never answer from memory/);
  const old = await server.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(old.result.protocolVersion, "2025-11-25");
});

test("a notification gets no answer, and a bad message gets -32600", async () => {
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await server.handle({ id: 1, method: "x" })).error.code, -32600);
  assert.equal((await server.handle({ jsonrpc: "2.0", id: 3, method: "nope" })).error.code, -32601);
});

test("the modern protocol answers with resultType and server info", async () => {
  const r = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } } });
  assert.equal(r.result.resultType, "complete");
  const bad = await server.handle({ jsonrpc: "2.0", id: 5, method: "ping", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2030-01-01" } } });
  assert.equal(bad.error.code, -32022);
});

// Gemini refuses a whole connector when one schema holds a keyword that it
// does not take. Only these keywords are allowed.
const ALLOWED = new Set(["type", "properties", "required", "description", "items", "enum"]);
function plain(schema, where) {
  for (const k of Object.keys(schema)) assert.ok(ALLOWED.has(k), `${where}: keyword "${k}" is not allowed`);
  if (schema.enum) assert.ok(schema.enum.every((v) => typeof v === "string") && schema.enum.length > 0, `${where}: enum of strings`);
  if (schema.type === "array") assert.ok(schema.items, `${where}: an array needs items`);
  for (const [k, v] of Object.entries(schema.properties ?? {})) plain(v, `${where}.${k}`);
  if (schema.items) plain(schema.items, `${where}[]`);
  for (const r of schema.required ?? []) assert.ok(schema.properties?.[r], `${where}: required "${r}" is not a property`);
}

test("each tool has a plain schema, a description that says to call it, and hints", async () => {
  const r = await server.handle({ jsonrpc: "2.0", id: 6, method: "tools/list" });
  assert.ok(r.result.tools.length >= 5);
  for (const t of r.result.tools) {
    assert.match(t.name, /^[a-z_]{3,40}$/);
    assert.equal(t.inputSchema.type, "object");
    plain(t.inputSchema, t.name);
    assert.match(t.description, /always call this tool/);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean");
  }
});

test("a tool that throws gives an error result, and a slow tool stops before the client gives up", async () => {
  const s = createServer({
    tools: [
      { name: "boom", run: async () => { throw new Error("broken"); } },
      { name: "slow", run: () => new Promise(() => {}) },
    ],
    instructions: "",
    serverInfo: { name: "t", version: "0" },
    timeoutMs: 50,
  });
  const a = await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom", arguments: {} } });
  assert.equal(a.result.isError, true);
  assert.match(a.result.content[0].text, /broken/);
  const b = await s.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slow", arguments: {} } });
  assert.equal(b.result.isError, true);
  assert.match(b.result.content[0].text, /stopped/);
  const c = await s.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "none", arguments: {} } });
  assert.equal(c.error.code, -32602);
});
