# learn-mcp-tools

A local MCP (Model Context Protocol) server that gives an agent read access to a
campus LMS portal — pages, links, forms, tables, and downloadable course files —
plus an assignment upload tool that stays disabled until you explicitly turn it
on. It talks to the portal over the ordinary web session (form POST, CSRF token,
cookie jar), so it works against the same pages a student uses in a browser.

Signing in is a one-time manual step in a real browser window. Credentials are
never read by this project, never stored, and never passed through the terminal.

## Tools

| Tool | Access | Purpose |
| --- | --- | --- |
| `status` | read | Report whether the stored session still works and which portal surfaces respond |
| `page` | read | Fetch one same-origin page: title, headings, links, forms, tables, files |
| `download` | read | Save a file served from the portal's access routes into a local directory |
| `assignment` | read | Read one assignment page: submission state, deadline text, exact submit form shape |
| `submit` | write | Upload one local file as the assignment submission (requires the write flag) |
| `auth` | — | Open a headed browser for a one-time manual sign-in, or validate a pasted cookie header |

Every response is JSON. Failures come back as `isError: true` with a stable code:
`config_missing`, `session_missing`, `session_expired`, `session_invalid`,
`auth_timeout`, `origin_rejected`, `write_disabled`, `file_missing`,
`file_unreadable`, `body_too_large`, `cloudflare_challenge`, `http_error`,
`state_corrupt`, `internal`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `LMS_BASE_URL` | *required* | Portal origin, for example `https://lms.example.edu`. No default: the server exits with `config_missing` when it is unset |
| `LMS_STATE_DIR` | `~/.local/state/learn-mcp-tools` | Directory for `state.json` (mode `0600`) and the browser profile. Must be outside the repository |
| `LMS_DOWNLOAD_DIR` | `~/Downloads/learn-mcp-tools` | Where `download` writes files |
| `LMS_ALLOW_WRITE` | `0` | Set to `1` to enable the `submit` tool. Anything else keeps it disabled |
| `LMS_BROWSER_PATH` | auto-detected | Chrome/Chromium/Brave executable used for the one-time sign-in |
| `LMS_HEADLESS` | `0` | Set to `1` to hide the sign-in window. Interactive SSO normally needs a visible window |

## Install

```bash
git clone <your-fork-url> learn-mcp-tools
cd learn-mcp-tools
npm install
```

Dependencies are pinned to exact versions in `package.json`. No lockfile is
tracked, which keeps the tree free of generated content.

## Use

1. Export the portal origin for your shell:

   ```bash
   export LMS_BASE_URL="https://lms.example.edu"
   ```

2. Sign in once. A browser window opens; complete the sign-in there (SSO or
   e-mail/password — whatever the portal offers):

   ```bash
   npm run auth
   ```

   On success the cookies are written to `$LMS_STATE_DIR/state.json` with mode
   `0600`, and the command prints `"authenticated": true`.

3. Check the read path against real identifiers taken from your portal links:

   ```bash
   npm run smoke -- --pertemuan <meeting-id> --tugas <assignment-id>
   ```

   The script prints one `METHOD path` line per HTTP request, so a run is easy
   to audit. It also exercises the negative cases: a foreign-origin path, a
   non-access download path, and — when you pass `--dry-run-submit --file <path>`
   with `LMS_ALLOW_WRITE=1` — the exact multipart request that `submit` would
   send, without sending it.

## Register with an MCP client

Add a server entry to your client's configuration (for example
`~/.omp/agent/mcp.json`):

```json
{
  "mcpServers": {
    "learn": {
      "type": "stdio",
      "command": "/usr/bin/node",
      "args": ["/path/to/learn-mcp-tools/src/server.mjs"],
      "env": {
        "LMS_BASE_URL": "https://lms.example.edu",
        "LMS_ALLOW_WRITE": "0"
      },
      "timeout": 120000
    }
  }
}
```

The `timeout` is raised because a multipart upload can outlive the usual 30
second default.

## Enabling submission

`submit` refuses to run unless `LMS_ALLOW_WRITE=1` is present in the server's
environment. Reload the MCP server after changing it. Use `dry_run: true` first:
it builds and reports the exact request (action, field names, field value
lengths, file size) without sending anything.

## Security notes

- The repository stores no credentials, tokens, or cookies, and no portal
  hostname. The base URL comes from the environment only.
- The session lives in `$LMS_STATE_DIR/state.json`, outside the repository, mode
  `0600`. Delete that file to sign out.
- Requests are restricted to the configured origin, throttled, and rate-limited;
  redirects are followed only within that origin.
- Session values are stripped from process output and from tool payloads before
  they are written, so logs stay safe to share.
- No password is ever accepted as an argument, read from a file, or typed
  programmatically. If you use a cookie header with `auth`, treat that string as
  a secret: it is validated, stored with mode `0600`, and never echoed back.

## License

MIT
