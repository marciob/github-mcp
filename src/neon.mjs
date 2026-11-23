// One SQL query to a Neon Postgres database over its HTTP endpoint, with
// fetch and no driver. Used only by the serverless deployment, to check a
// token in the table of an external authorization server.
//
// The endpoint is https://<host>/sql, with the connection string in a header.
// This is the protocol of the official driver @neondatabase/serverless for a
// single query.
export function neonQuery(connectionString, { fetch = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (!connectionString) throw new Error("no database connection string");
  const host = new URL(connectionString).hostname;
  return async function query(sql, params = []) {
    const res = await fetch(`https://${host}/sql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "neon-connection-string": connectionString,
        "neon-raw-text-output": "true",
        "neon-array-mode": "false",
      },
      body: JSON.stringify({ query: sql, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`the database answered ${res.status}`);
    return (await res.json()).rows ?? [];
  };
}
