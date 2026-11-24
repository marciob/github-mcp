# github-mcp

A small remote MCP server that gives the Gemini app (gemini.google.com) access to GitHub. It also works with other MCP clients that use OAuth or a bearer token, such as Claude.

- It has no npm dependencies. It uses only Node.js and `fetch` to the GitHub REST API.
- It sends one plain JSON answer for each POST, with no SSE and no session. Gemini needs no more than that.
- It has its own OAuth 2.1 server with dynamic client registration, so Gemini can connect with no client ID.
- Its input schemas use only `type`, `properties`, `required`, `description`, `items` and string `enum`. Gemini refuses the whole connector when one tool uses a keyword such as `anyOf`, `$ref` or `additionalProperties`.

## Why this exists

The official GitHub MCP server did not connect in the Gemini app in our tests. There are two likely causes:

- It does not support dynamic client registration.
- Its tool schemas use keywords that Gemini refuses.

This server avoids both.

## Status

Version 0.1.0. The read and write tools work, with tests and a live test on github.com through the Gemini app.

## Tools

Read (13):

| Tool | What it does |
|---|---|
| `list_repos` | Lists the repositories that the token can reach. |
| `get_repo_overview` | Gives the default branch, the branches, the top level and the README. |
| `get_tree` | Lists the files under a directory, at one level or at all levels. |
| `read_files` | Reads up to 10 files. A long file comes back cut, with the next line number. |
| `grep_repo` | Finds every matching line in one repository, at any ref. It downloads the tarball and searches it in memory. |
| `search_code` | GitHub search for code, issues and pull requests. GitHub code search often misses files, so use `grep_repo` for one repository. |
| `list_commits` | Recent commits of a branch or a path. |
| `compare_refs` | Commits and diff between two refs. |
| `list_pull_requests` | Lists pull requests. |
| `get_pull_request` | Gives a pull request with its diff, and optionally its comments and reviews. |
| `list_issues` | Lists issues. |
| `get_issue` | Gives an issue with its comments. |
| `get_repo_settings` | Gives visibility, fork source, archive state, features, merge options and topics. For a fork, it says if the fork can leave its fork network. |

Write (8):

| Tool | What it does |
|---|---|
| `create_branch` | Makes a branch from a ref. |
| `commit_files` | Writes one commit with many files added, changed or deleted. It creates the branch if needed, and works on an empty repository. The update is a fast-forward, so it never overwrites a push from someone else. |
| `reset_branch` | Moves a branch to another commit (force push). The result gives the old SHA, to undo. |
| `delete_branch` | Deletes a branch, but not the default branch. The result gives the SHA, to undo. |
| `create_or_update_pull_request` | Opens, edits, closes or reopens a pull request. |
| `merge_pull_request` | Merges with merge, squash or rebase, optionally only at an expected head SHA. |
| `create_or_update_issue` | Opens or edits an issue. |
| `add_comment` | Comments on an issue or a pull request. |

Settings (2, only with `ADMIN_TOOLS=1`):

| Tool | What it does |
|---|---|
| `update_repo_settings` | Changes visibility, archive, default branch, description, homepage, features and merge options. Visibility, archive and default branch also need `confirm` set to `owner/repo`. The result gives the old values. |
| `set_repo_topics` | Replaces the topics. The result gives the old topics. |

GitHub has no API to leave a fork network. `get_repo_settings` gives the settings page, where the owner clicks Danger Zone > Leave fork network.

No tool deletes or transfers a repository, or changes branch protection, collaborators, webhooks or secrets. Each write can be undone.

Set `READ_ONLY=1` to remove the write tools. Set `PROTECTED_BRANCHES` (such as `main,release/*`) to refuse `reset_branch` and `delete_branch` on those branches.

Limits for each answer:

| Item | Limit |
|---|---|
| One file | 2,000 lines or 100,000 characters |
| One answer | 250,000 characters |
| One diff | 300 lines for each file, 1,500 lines in total. Lockfiles are not shown. |
| One commit | 100 files and 10 MB |
| One tool call | 50 seconds. After that it stops with an error, because Gemini stops a call after about 60 seconds. |

## Security model

The server is on a public URL, and its GitHub token can write code. These are the fences:

1. **The GitHub token is the real limit.** Use a fine-grained personal access token. Give it only the repositories and permissions that you need.
2. **OAuth approval.**
   - A client such as Gemini registers itself, then sends you to an approval page.
   - The page asks for the approval secret. With no secret, there is no token.
   - The approval secret opens only the approval page. It is not a bearer token.
3. **Allowed redirect hosts.** A client can register only with a redirect URI on an allowed host. The default list has the Gemini hosts, `claude.ai`, `chatgpt.com` and localhost.
4. **Short tokens.**
   - Access tokens last 1 hour, and refresh tokens last 30 days.
   - Each refresh token works one time.
   - When a used refresh token comes back, the server revokes all tokens of that client.
5. **Tokens are kept as SHA-256 digests**, in a file with mode 600.
6. **`REPOS`** limits the repositories that the tools can touch. The default is all repositories that the token can reach.
7. **A random route.** The path of `PUBLIC_URL` is the MCP endpoint. Make it random.
8. **The log has one line for each request:** method, tool, result and time. The log never holds content, tokens or secrets.

## Set up

### 1. Make a GitHub token

On GitHub, open Settings > Developer settings > Fine-grained tokens > Generate new token.

1. Select the repositories.
2. Set these repository permissions:

   | Permission | Access |
   |---|---|
   | Contents | Read and write |
   | Pull requests | Read and write |
   | Issues | Read and write |
   | Actions | Read |
   | Commit statuses | Read |
   | Workflows | Read and write (only to change files in `.github/workflows/`) |
| Administration | Read and write (only with `ADMIN_TOOLS=1`) |

   For a read-only server, set each permission to Read.
3. Put the token in a file that only you can read:

   ```sh
   mkdir -p ~/.github-mcp && chmod 700 ~/.github-mcp
   pbpaste > ~/.github-mcp/github.token   # or paste it with an editor
   chmod 600 ~/.github-mcp/github.token
   ```

### 2. Configure

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `GITHUB_TOKEN_FILE` | yes, or `GITHUB_TOKEN` | | File with the GitHub token, mode 600. |
| `PUBLIC_URL` | yes | | Public https address of the MCP endpoint, with a random path, such as `https://host.example/3f9a…`. |
| `APPROVAL_SECRET_FILE` | no | made in `DATA_DIR/approval.secret` | The secret that the approval page asks for. |
| `ADMIN_TOKEN_FILE` | no | none | A fixed bearer token, for curl or for clients that take a header. 32 characters or more. |
| `REPOS` | no | `*` | Repositories that the tools can touch, such as `alice/*,acme/api`. |
| `READ_ONLY` | no | off | `1`: only the read tools. |
| `ADMIN_TOOLS` | no | off | `1`: add the settings tools. The token needs Administration: Read and write. |
| `PROTECTED_BRANCHES` | no | none | Branches with no force reset and no delete, such as `main,release/*`. |
| `ALLOWED_REDIRECT_HOSTS` | no | Gemini, claude.ai, chatgpt.com, localhost | OAuth redirect hosts. `*` allows any https host. |
| `HOST` | no | `127.0.0.1` | Listen address. Use `0.0.0.0` in Docker. |
| `PORT` | no | `7814` | Listen port. |
| `DATA_DIR` | no | `~/.github-mcp` | OAuth clients and tokens. |
| `GITHUB_API_URL` | no | `https://api.github.com` | For GitHub Enterprise Server. |

Each `*_FILE` variable also has a plain form, such as `GITHUB_TOKEN`. A file is safer, because a process list or a log can show a variable.

### 3. Run

```sh
export GITHUB_TOKEN_FILE=~/.github-mcp/github.token
export PUBLIC_URL="https://your-host.example/$(node bin/github-mcp.mjs random)"
node bin/github-mcp.mjs check   # checks the token and shows the configuration
node bin/github-mcp.mjs serve
```

The server listens on `127.0.0.1`. Put an https proxy or tunnel in front of it. The proxy must send these paths to the server:

- the route (the path of `PUBLIC_URL`), and all paths under it
- `/.well-known/oauth-protected-resource<route>`
- `/.well-known/oauth-authorization-server<route>`
- `/.well-known/openid-configuration<route>`

#### Tailscale Funnel

Do the steps below. Do not run `tailscale funnel reset`, because it removes the other services on the host.

1. Look at the current configuration:

   ```sh
   tailscale funnel status
   ```

2. Add the routes. Replace `<route>` with your route. In each command, the `--set-path` value is the path that the public URL receives:

   ```sh
   tailscale funnel --bg --set-path /<route> http://127.0.0.1:7814/<route>
   tailscale funnel --bg --set-path /.well-known/oauth-protected-resource/<route> http://127.0.0.1:7814/.well-known/oauth-protected-resource/<route>
   tailscale funnel --bg --set-path /.well-known/oauth-authorization-server/<route> http://127.0.0.1:7814/.well-known/oauth-authorization-server/<route>
   tailscale funnel --bg --set-path /.well-known/openid-configuration/<route> http://127.0.0.1:7814/.well-known/openid-configuration/<route>
   ```

3. Look at the configuration again, and make sure that the other services are still there:

   ```sh
   tailscale funnel status
   ```

#### One host and port for each connector

Gemini keeps one OAuth login for each origin (host and port). If two MCP servers share one origin, such as two paths on `https://host.ts.net`, the login of one connector replaces the login of the other, and Gemini shows "Could not connect the account". Give this server its own origin. With Tailscale Funnel, use port 8443 or 10000 (add `--https=8443` to the commands above, and put `:8443` in `PUBLIC_URL`).

#### Other ways to put it online

- cloudflared, with a `cloudflared tunnel` to `http://127.0.0.1:7814`.
- Caddy, with `reverse_proxy 127.0.0.1:7814`.
- Any host that runs Node.js 22 or later. Set `HOST=0.0.0.0` behind its TLS proxy, and keep `DATA_DIR` on a disk that stays after a restart.

### 4. Add the connector in Gemini

1. In Gemini, open Settings > Connectors (custom MCP), and add the URL. The URL is your `PUBLIC_URL`.
2. Gemini opens the approval page. Enter the approval secret:

   ```sh
   cat ~/.github-mcp/approval.secret
   ```

3. Set the tools to "always allowed", if you want.
4. In a chat, write `@<connector name>` to make Gemini call the tools. If you do not, Gemini often answers from memory.

## Deploy on Vercel (serverless)

A serverless host has no disk that stays, so the built-in OAuth server cannot keep its clients and tokens there. On Vercel, an external OAuth server gives the tokens, and `api/mcp.js` only checks them.

The function reads the token table of that server in a Neon Postgres database over HTTP, with no driver. It expects a table `mcp_tokens(hash, kind, client_id, scope, expires_at, revoked_at)`, where `hash` is the base64url SHA-256 of the token. A token opens this server only when its scope holds `AUTH_SCOPE`.

1. Run `vercel deploy --prod`. Vercel gives the project its own hostname.
2. Set these environment variables in Vercel:

   | Variable | Meaning |
   |---|---|
   | `GITHUB_TOKEN` | The GitHub token (mark it sensitive). |
   | `TOKEN_DATABASE_URL` | Neon connection string of the token table (mark it sensitive). |
   | `AUTH_SERVER` | Issuer URL of the OAuth server. |
   | `AUTH_SCOPE` | Scope of this server. Default `github`. |
   | `PUBLIC_URL` | `https://<your-project>.vercel.app/api/mcp` |
   | `REPOS`, `PROTECTED_BRANCHES`, `READ_ONLY`, `ADMIN_TOOLS` | As above. |

3. In the OAuth server, register `PUBLIC_URL` as a resource with the scope `AUTH_SCOPE`.
4. Deploy again, so the function reads the variables.

`vercel.json` sends the discovery paths (`/.well-known/...`) to the function. Function time is limited to 60 seconds.

## Commands

```sh
github-mcp serve          # start the server
github-mcp check          # check the token and the configuration
github-mcp clients        # list the OAuth clients
github-mcp revoke <id>    # remove one client and its tokens ("all" for every client)
github-mcp random         # print a random value for a route or a secret
```

`revoke` works while the server runs.

## Tests

```sh
npm test
```

The tests need no GitHub account and no network. They use a fake GitHub API.

## Plan

- A GitHub login mode, so that each user signs in with GitHub on a server that many people share.
- Verified (signed) commits with the GraphQL `createCommitOnBranch` mutation.
- `get_ci_status`: checks and logs of GitHub Actions.

## License

MIT
