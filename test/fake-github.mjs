// A fake GitHub REST API for the tests. Routes are "METHOD /path" keys. A
// handler gets (url, init) and returns { status, body, headers }.
export function fakeGitHub(routes) {
  const calls = [];
  async function fetch(url, init = {}) {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    calls.push({ key, url: u, init });
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    const r = typeof handler === "function" ? await handler(u, init) : handler;
    const raw = r.raw !== undefined;
    const body = raw ? r.raw : JSON.stringify(r.body ?? null);
    return new Response(r.status === 204 ? null : body, {
      status: r.status ?? 200,
      headers: { "content-type": raw ? "application/vnd.github.raw" : "application/json", ...(r.headers ?? {}) },
    });
  }
  return { fetch, calls };
}

export const config = (extra = {}) => ({
  githubToken: "test-github-token-never-logged",
  githubApiUrl: "https://api.github.test",
  repos: ["*"],
  protectedBranches: [],
  readOnly: false,
  ...extra,
});
