# Local web management

English | [简体中文](../zh-CN/admin.md)

The optional console manages named client keys, request accounting, model prices,
and runtime defaults. Node 22+ is required; Node 24 is recommended.

## Start

```sh
npm ci
npm --prefix web ci
npm run build
npm run build:web
node dist/bin.js serve --agent-service-model gpt-6-luna --admin-port 8789
```

Open `http://127.0.0.1:8789/admin/`. The management listener is loopback-only;
the model API uses port 8787 by default. The admin login uses an
independent random token in `<state-dir>/admin/admin-token`, created with owner-only
permissions on first start. Read this file privately, or provision your own file
with `CODEX_BRIDGE_ADMIN_TOKEN_FILE`. Never send this token to an agent as its API key.
Changing the admin token file requires restart, invalidating all browser sessions.

### Remembering login

Password authentication is the default. A normal session uses `sessionStorage`
and expires after 12 hours; “remember login” uses `localStorage` for 30 days and
survives service restarts. Neither mode stores the administrator password.
Changing the admin token and restarting invalidates all sessions, and logout
immediately revokes the current one.

### Optional native local login

`--admin-auth local --admin-port 8789` permits password-free initial entry only
for a trusted native installation. Sessions, CSRF and exact same-origin checks
still apply. Containers, forwarded requests and non-loopback peers cannot use
this mode. Keep password mode behind any proxy, tunnel or shared desktop.

Model, request deadline and concurrency changes apply to new requests, persist
across restarts, and override their startup values. Authentication source, bind
address, filesystem root and app-server policy defaults remain CLI-only.

## Keys and browser security

Managed client keys can be created, revealed, rotated and disabled. Lists show
only prefixes. Revealing an existing key requires the administrator password;
rotation requires confirmation, invalidates the old key and displays the
replacement for copying. Disabling affects new requests only. In agent-service
mode an unrecognized or disabled key loses attribution but does not become an
access gate; local mode requires another valid key.

Keys are encrypted with AES-256-GCM; lookup uses SHA-256 digests. Back up `master.key`
separately and privately along with the database; loss of the master fails closed.
The file master protects a database-only leak, **not** compromise of the host account.

An environment/file-backed local-mode key remains outside the key table and is
reported as `legacy`; rotate it at its original secret source. Do not reuse the
administrator secret as a client key.

The console sends its session bearer in `X-Admin-Session`, scoped by browser
storage to the exact origin, including the port. This avoids sharing a login
between separate localhost services, but the bearer is readable by scripts on
that origin; use the console only on a trusted local browser profile. Sessions
retain an explicit CSRF token and exact same-origin checks on writes. The model
API still rejects browser Origin headers.
All management responses use `no-store`; external scripts and framing are
blocked, and login/reveal attempts are rate-limited. This is a loopback console,
not an Internet-facing or multi-user system. Key separation provides revocation
and accounting, not tenant isolation.

## Accounting

Only request ID, key ID, model, timestamp, elapsed time, status/error code and reported
token counters are stored. No prompts, completions, tool arguments, auth tokens or
raw error text are recorded by this module. Existing diagnostic logs have their own
sensitive-data policy and are not ingested by the console.

Usage comes from exact app-server counters even when a streaming client omits the
usage chunk. No matching requests shows zero; matched requests without counters
remain unknown. These values are not subscription quota or billing records.

Cost is a reference estimate based on the current per-model price table. Unknown
models or incomplete counters remain unpriced. Historical requests are revalued
with the current table, so totals are not historical invoices and exclude factors
such as long-context tiers, tool fees, taxes and custom pricing.

Administrators can edit exact-model input, cached-input and output prices. The
optional price lookup fetches only the fixed official pricing page and makes one
`gpt-6-luna` request with tools and web search disabled. Client API keys,
administrator credentials and usage data are not included in its input. The
request is recorded in ordinary usage, and suggestions require administrator
review and confirmation before saving.

Completed requests are inserted once by request ID. SSE terminal errors are marked
failed even when HTTP headers were already 200; disconnects/timeouts are marked
499/408. Abrupt process termination can lose in-flight accounting and late upstream
usage after cancellation may remain unknown. Unauthorized traffic and health probes
are not usage records. Records older than 90 days are pruned when new records arrive.
