// The MCP server as a web-standard handler: Request in, Response out. For
// serverless hosts (Vercel), where there is no long-running process and no
// disk, so the built-in OAuth server cannot keep its state.
//
// Here an external authorization server gives the tokens. This handler only
// checks each bearer token with `verifyToken`, and serves the discovery
// document that names that authorization server (RFC 9728).
//
// One POST carries one JSON-RPC message, and the answer is one JSON object,
// as in http.mjs.
export const MAX_BODY = 4 * 1024 * 1024;

// `server`: the object of createServer in rpc.mjs.
// `verifyToken(bearer)`: returns a short client label, or null.
// `resource`: the public URL of the MCP endpoint.
// `authServer`: the issuer URL of the authorization server.
// `scope`: the scope that a token must have.
export function createWebHandler({ server, verifyToken, resource, authServer, scope, name = "GitHub MCP", log = () => {} }) {
  const route = new URL(resource).pathname;
  const metadataUrl = `${new URL(resource).origin}/.well-known/oauth-protected-resource${route}`;
  const resourceMetadata = { resource, authorization_servers: [authServer], scopes_supported: [scope], bearer_methods_supported: ["header"], resource_name: name };
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-method" };
  const json = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...(body === null ? {} : { "content-type": "application/json" }), "cache-control": "no-store", ...cors, ...headers } });
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  return async function handle(request) {
    const began = Date.now();
    const url = new URL(request.url);
    // A host rewrite can name the document in ?op=, because the path that the
    // function sees is the path of the function.
    const op = url.searchParams.get("op");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (op === "resource" || url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(resourceMetadata);
    if (op === "auth-server" || url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
      // Some clients ask the resource host for the metadata of the
      // authorization server. The answer comes from that server itself.
      const r = await fetch(`${authServer}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(8000) });
      return json(await r.json(), r.status);
    }
    if (url.pathname !== route) return json({ error: "not found" }, 404);

    const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
    let client = null;
    try {
      client = m ? await verifyToken(m[1]) : null;
    } catch (e) {
      log(`token check failed: ${e.message}`);
      return json({ error: "the token check failed, try again" }, 503);
    }
    if (!client) {
      await pause(300);
      log("refused a request with no valid token");
      return json({ error: "a valid token is required" }, 401, { "www-authenticate": `Bearer resource_metadata="${metadataUrl}", scope="${scope}"` });
    }
    if (request.method !== "POST") return json(null, 405, { allow: "POST" });
    const length = Number(request.headers.get("content-length"));
    if (length > MAX_BODY) return json({ error: "the body is too big" }, 413);
    const body = await request.text();
    if (body.length > MAX_BODY) return json({ error: "the body is too big" }, 413);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    if (Array.isArray(message)) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "One message for each request" } }, 400);
    const named = request.headers.get("mcp-method");
    if (named !== null && named !== message?.method) {
      return json({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32020, message: "The Mcp-Method header and the body do not agree" } }, 400);
    }
    const answer = await server.handle(message);
    const tool = message?.method === "tools/call" ? ` ${String(message.params?.name ?? "?").slice(0, 60)}` : "";
    const result = answer?.error ? ` error ${answer.error.code}` : answer?.result?.isError ? ` tool-error (${answer.reason ?? "?"})` : " ok";
    log(`${String(message?.method).slice(0, 60)}${tool}${result} in ${Date.now() - began} ms (${client})`);
    return answer === null ? json(null, 202) : json(answer);
  };
}
