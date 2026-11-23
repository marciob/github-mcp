// A small client for the GitHub REST API, on fetch. The token goes in the
// Authorization header and nowhere else: not in a log, not in an error.
//
// Sources:
// - https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api
// - https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 25_000;

export class GitHubError extends Error {
  constructor(status, message, hint = "") {
    super(`GitHub answered ${status}: ${message}${hint ? `. ${hint}` : ""}`);
    this.name = "GitHubError";
    this.status = status;
  }
}

function hintFor(status, headers, path) {
  if (status === 401) return "The GitHub token of the server is not valid or has expired. The owner of the server must replace it";
  if ((status === 403 || status === 429) && headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    const wait = Number.isFinite(reset) ? Math.max(0, Math.ceil(reset - Date.now() / 1000)) : null;
    return `The rate limit is used up${wait !== null ? `. It resets in ${wait} seconds` : ""}`;
  }
  if (status === 403) return "The token has no permission for this. The owner can add the permission to the token";
  if (status === 404) return `Not found: ${path}. Check the owner, the repository, the path and the ref. A private repository that the token cannot see also gives 404`;
  if (status === 409) return "Conflict. The branch moved, or the repository is empty";
  if (status === 422) return "GitHub refused the input";
  return "";
}

// `fetch` can be replaced, for tests.
export function createGitHub({ token, apiUrl = "https://api.github.com", fetch = globalThis.fetch, userAgent = "github-mcp-gemini" }) {
  if (typeof token !== "string" || token.trim() === "") throw new Error("no GitHub token");
  const base = apiUrl.replace(/\/+$/, "");

  // Returns { status, headers, data }. `data` is JSON, text, or a Buffer.
  async function request(method, path, { query, body, accept = "application/vnd.github+json", as = "json", signal } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await fetch(url, {
      method,
      headers: {
        accept,
        authorization: `Bearer ${token}`,
        "x-github-api-version": API_VERSION,
        "user-agent": userAgent,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok && res.status !== 304) {
      let message = res.statusText || "error";
      try {
        const j = await res.json();
        if (j?.message) message = j.message;
        if (Array.isArray(j?.errors) && j.errors.length) {
          message += ` (${j.errors.map((e) => (typeof e === "string" ? e : e.message ?? e.code)).filter(Boolean).join("; ")})`;
        }
      } catch {
        // No JSON body.
      }
      throw new GitHubError(res.status, message, hintFor(res.status, res.headers, path));
    }
    let data = null;
    if (res.status !== 204) {
      if (as === "buffer") data = Buffer.from(await res.arrayBuffer());
      else if (as === "text") data = await res.text();
      else {
        const t = await res.text();
        data = t ? JSON.parse(t) : null;
      }
    }
    return { status: res.status, headers: res.headers, data };
  }

  const get = (path, opts) => request("GET", path, opts).then((r) => r.data);

  return { request, get };
}

// One part of a path, for a URL. A path of a file keeps its slashes.
export const seg = (s) => encodeURIComponent(String(s));
export const filePath = (p) => String(p).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
