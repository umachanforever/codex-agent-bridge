# Local web management

The optional console adds named client keys, request accounting and operational
settings to the existing bridge. It does not replace app-server transport, tool
continuation or model-output normalization. Frontend: Vue 3, Vite, Naive UI and
Chart.js. Persistence: SQLite with WAL. Node 22+ is required, Node 24 recommended.
This is an original lightweight implementation inspired by management-console
patterns, not copied Sub2API code.

## Start

```sh
npm ci
npm --prefix web ci
npm run build
npm run build:web
# Set CODEX_BRIDGE_TOKEN or CODEX_BRIDGE_TOKEN_FILE privately before starting.
node dist/bin.js serve --agent-service-model gpt-6-luna --admin-port 8789
```

Open `http://127.0.0.1:8789/admin/`. The separate listener is loopback-only. Existing
API clients continue using the proxy port (default 8787). The admin login uses an
independent random token in `<state-dir>/admin/admin-token`, created with owner-only
permissions on first start. Read this file privately, or provision your own file
with `CODEX_BRIDGE_ADMIN_TOKEN_FILE`. Never send this token to an agent as its API key.
Changing the admin token file requires restart, invalidating all browser sessions.

### Remembering login

Password authentication remains the default, including for localhost. The login
form offers “remember login for 30 days” on your own device. Remembered opaque
sessions survive service restarts; the database stores only a digest of each
session bearer, its CSRF token, expiry and admin-credential fingerprint. Changing
the admin token and restarting invalidates them. Logout immediately revokes the
current session. Without this option, the browser keeps the session bearer in
`sessionStorage` and the server enforces a 12-hour expiry; restart requires
login again. Remembered sessions use `localStorage` for that browser origin.
Neither mode stores the administrator password in browser storage. Reveal and
rotation still require the administrator password, even in local mode.
Browser sessions created by earlier cookie-based versions require a new login
after this change; stored server-side sessions are not automatically imported.

### Optional native local login

`--admin-auth local --admin-port 8789` explicitly opts a trusted native installation
into password-free initial entry; the default is `--admin-auth password`. Sessions,
CSRF, exact same-origin checks and sensitive-key reauthentication remain enabled.
The UI displays a warning. Official container startup disables this mode, and
common container markers are rejected. Forwarded requests and non-loopback peers
are rejected by local login.

Never use this mode behind a reverse proxy, tunnel or remotely shared desktop.
A proxy can remove forwarding headers, so loopback and header checks cannot prove
the original client is local. Such deployments must retain password mode; there
is no automatic bypass based on Host or source IP. All local processes are trusted
when opting in. Returning to password mode requires a service restart.

The console shows service readiness, active requests, named keys, per-key/model/date
token totals, UTC daily trends, paginated request records and editable defaults.
Model, request deadline and concurrency changes apply to new requests, persist across
restart and override the corresponding startup values. Authentication source, bind
address, filesystem root and execution permissions cannot be changed through the UI.

## Keys and browser security

Managed client keys can be created, revealed, rotated and disabled. Lists show only
prefixes. Revealing or rotating requires re-entering the administrator token. Rotation
invalidates the old managed bearer; disabling stops accepting it for new requests,
not work already executing. The agent-service profile still accepts those requests
without a valid key but no longer attributes them to it. The local bridge profile
requires another valid key.
Keys are encrypted with AES-256-GCM; lookup uses SHA-256 digests. Back up `master.key`
separately and privately along with the database; loss of the master fails closed.
The file master protects a database-only leak, **not** compromise of the host account.

In the local bridge profile, the environment/file-backed bridge key remains valid,
is not displayed or managed in the key table, and its requests are grouped as
`legacy`. Rotate that key through its original secret source. New per-agent keys
are recommended for attribution.
Do not configure the same secret for admin login and API clients.

The console sends its session bearer in `X-Admin-Session`, scoped by browser
storage to the exact origin, including the port. This avoids sharing a login
between separate localhost services, but the bearer is readable by scripts on
that origin; use the console only on a trusted local browser profile. Sessions
retain an explicit CSRF token and exact same-origin checks on writes. The model
API still rejects browser Origin headers.
All management responses use no-store; external scripts and framing are blocked.
Management login/reveal attempts are limited. This is an HTTP loopback console, not
an Internet-facing TLS or multi-user system. All authorized clients are trusted:
key separation provides revocation/accounting, not filesystem or thread isolation.
Full-access model tools can read files accessible to the host account, including
management files; browser authentication does not sandbox those tools.

## Accounting

Only request ID, key ID, model, timestamp, elapsed time, status/error code and reported
token counters are stored. No prompts, completions, tool arguments, auth tokens or
raw error text are recorded by this module. Existing diagnostic logs have their own
sensitive-data policy and are not ingested by the console.

Token snapshots come from the existing attributable app-server usage normalization,
even if a streaming client did not ask for usage chunks. Cache and reasoning counters
are subsets, never added again to totals. Missing values remain NULL/unknown, and
the UI shows how many requests have measurements. Counts are not subscription
remaining quota or actual billed cost. No historical requests are reconstructed.

Token cards, request rows and chart axes/tooltips display M (1,000,000 tokens)
with two decimal places. Cost totals also use two decimals; positive sub-cent
costs display < US$0.01. Editable per-model unit prices retain full precision
(for example 0.005 USD/M), and each request uses its own model's rate;
stored counters and API responses remain exact integers. The report adds a USD
Standard short-context reference valuation using public OpenAI API prices checked
on 2026-09-24: https://developers.openai.com/api/docs/pricing.
It subtracts cached tokens from ordinary input, prices cache separately and never
adds reasoning tokens again. Unknown model IDs or incomplete/invalid input, cache
or output counts remain unpriced, not free; aggregates show priced coverage and
include all matching records, not just the visible page.

Built-in prices live in src/admin/pricing.ts and match exact model IDs, not guessed aliases.
Settings → Model prices supports editing input, cached input and output USD/M rates,
with only live-catalog models shown (including unpriced models as empty fields).
Hidden models retain saved rates when visible rows are edited; clearing all three
fields removes that model's price. Catalog failures show an error, not the full
built-in list. Discovery candidates are filtered by the same catalog.
Prices are saved to SQLite without a restart. Partially filled rows are
rejected; zero means explicitly free, not unknown. Saving replaces the full table
and checks its revision so stale browser tabs cannot silently overwrite newer edits.
Reports identify administrator-saved prices separately from the built-in snapshot.

The user-confirmed latest-price button fetches only the fixed official Markdown
pricing URL (no redirects or user-supplied URLs), then makes one gpt-6-luna call
through the shared in-process completion interface with host tools and web search
disabled. It reuses the proxy's app-server authentication and records that model
request in ordinary usage under the `legacy` group. No client API key is read or
sent for this internal call. Only public documentation is sent, not keys or usage data.
Queries have a two-minute deadline, one active lookup and a one-minute cooldown.
The official site must be reachable from the bridge runtime.

Model candidates are never saved automatically. Exact source excerpts and numeric
validation reject malformed/unsupported results but do not prove the model picked
the right pricing tier; the administrator must inspect the linked source and diff.
Select desired rows, fill the draft, then save explicitly. Unselected manual prices
remain unchanged. Failure leaves all saved prices intact. The query timestamp is
the retrieval time, not the tariff's effective date; manual edits are not labeled
as freshly verified official prices.
Historical records are revalued at this price snapshot, not their historical tariff.
This is not a bill: per-upstream-call context length, Fast tier, cache writes, tool
fees, taxes, subscription and custom-provider pricing are not captured. Do not infer
long-context pricing from a bridge request's cumulative input across multiple turns.

Completed requests are inserted once by request ID. SSE terminal errors are marked
failed even when HTTP headers were already 200; disconnects/timeouts are marked
499/408. Abrupt process termination can lose in-flight accounting and late upstream
usage after cancellation may remain unknown. Unauthorized traffic and health probes
are not usage records. Records older than 90 days are pruned when new records arrive.

## Authentication reuse and containers

`--auth-mode reuse` is the default: import a newer local `auth.json` into the isolated
bridge home, ask app-server to use it, and never start login/logout automatically.
`--auth-source` selects a source directory. It does not import desktop configuration
or tools. Credential refresh inside the isolated home is still owned by Codex.
Concurrent use of copies of OAuth refresh tokens can require signing in locally
again; this bridge does not implement a cross-process token-refresh coordinator.

See [Docker deployment](docker.md) for the read-only source mount and explicit
independent-login option. Avoid sharing a writable desktop Codex home with a container.

## Offline verification

`npm test` exercises encrypted persistence, authentication reuse, management access,
CSRF and request accounting with synthetic inputs. `node scripts/admin-preview.mjs`
starts an isolated UI harness after builds; its synthetic login token is in the script,
it has no model backend, and SIGINT/SIGTERM removes only its temporary state.

## Appearance

Navigation separates summary from investigation: Overview omits the detailed
reference-cost explanation panel, but includes a compact estimated-spend card
(with partial-coverage indication), alongside period-wide metrics, live
concurrency/readiness and token trends, with a link to request
details. Usage and requests owns key/model/date filters, filtered usage totals,
per-request input/output counts and pagination; it does not repeat the overview
chart or KPI grid. API keys owns credentials; Settings owns client connection,
runtime defaults and authentication/deployment details. Switching pages resets
query state so a filtered report cannot leak into the overall dashboard.
Its searchable model filter lists the deduplicated union of the current visible
app-server catalog and model names in retained request records, independent of
the selected date and key. Historical names remain selectable while app-server
is unavailable. The synthetic `unknown` request label is excluded.

The connection panel displays the Base URL as selectable text and loads its
searchable model selector from the authenticated app-server model catalog,
including every page and excluding hidden entries. Refreshing the list does not
generate a model response; selecting a model does not change the service default.

Only Settings shows client connection details with copy buttons for the
listener Base URL and default model. For Docker or remote clients, use the actual
published address instead of the displayed internal loopback listener.

New and rotated client API keys use `sk-` followed by 32 cryptographically random
bytes encoded as base64url. These are local bridge keys, not OpenAI-issued keys.
Previously issued keys remain valid; authentication does not depend on a prefix.

The console uses Vue 3 and Naive UI with light, dark and system-following themes.
Use the top-right appearance selector on either the login screen or console.
The preference is saved only in this browser; charts and dialogs follow the theme.
System mode responds to operating-system appearance changes without a reload.
