# Bibi Workspace — Threat Model

Scope: the Vercel frontend and API, the Supabase project, and the local Mac
connector. Out of scope: the security of Hermes itself and of the Mac it runs on.

## 1. What is being protected

| Asset | Why it matters |
|---|---|
| The owner's conversations and work history | The substance of the product |
| Supabase service-role key | Bypasses row level security entirely |
| Connector bearer token | Authorises a Mac to receive and execute the owner's work |
| The Mac's local state — profile directories, credentials, cookies | Never belongs in the cloud, at any fidelity |
| Execution integrity | Work must run on the profile it was assigned to, and evidence must be checkable |

## 2. Trust boundaries

```
  ① browser ──┬── ② Vercel functions ──┬── ③ Supabase Postgres
              │                        │
              └── (RLS, anon key)      └── (service role)
                                       ▲
                                       │ ④ HTTPS, outbound only
                                  ⑤ Mac connector
                                       │ ⑥ execFile, no shell
                                   hermes CLI
```

| # | Boundary | Enforcement |
|---|---|---|
| ① | Browser → Postgres | RLS on every table, enabled **and forced**; anon key only |
| ② | Browser → API | Supabase access token verified with `auth.getUser`, never trusted for its claims |
| ③ | API → Postgres | Service role, plus an explicit `owner_id` filter on every query |
| ④ | Mac → cloud | Bearer token, hashed at rest; HTTPS enforced unless loopback |
| ⑤ | Cloud → Mac | **None, by construction.** There is no inbound path |
| ⑥ | Connector → Hermes | `execFile` with an argv array, an env allowlist, and a roster-matched profile id |

## 3. Threats and mitigations

### T1 — Service-role key reaches the browser
Vite inlines every `VITE_`-prefixed variable into the shipped bundle, so this
mistake publishes the key the moment the site builds.

*Mitigations.* `src/cloud/env.js` classifies the key it is handed and refuses a
`service_role` JWT or an `sb_secret_` key; a privileged *variable name* under
`VITE_` is fatal even if the value looks harmless. `api/_lib/serverEnv.js`
repeats the check server-side. `tests/cloudClientBoundary.test.js` decodes every
JWT in the built bundle and fails if any carries a privileged role.

### T2 — A browser session forges state
A client could otherwise mark work succeeded, fabricate an assistant reply, or
insert a work item that claims to be running.

*Mitigations.* The browser's entire write surface is: create a conversation, and
insert a work item. Every transition goes through `/api/work/transition` and the
one lifecycle reducer. `messages` has no insert policy at all, so an assistant
turn cannot be fabricated. A `before insert` trigger rewrites every
execution-controlled column on a client insert, including forcing `kind = 'work'`
so a client cannot bind a fake chat command to a conversation.

### T3 — One account reaches another's data
*Mitigations.* Every user table is scoped by `owner_id = auth.uid()`. The API
adds its own `owner_id` filter because the service role has no policy left to
catch a mistake. A connector token resolves to exactly one owner; another
account's work item reads as **not found**, not as forbidden.

### T4 — Connector token theft
*Mitigations.* Only a SHA-256 hash is stored, so a database dump yields nothing
usable. Comparison is constant-time and an unknown token is indistinguishable
from a wrong one. The token travels only in an `Authorization` header, never in
a URL. It is non-enumerable on the config object, so `JSON.stringify` and log
lines cannot leak it, and it is excluded from the CLI child's environment.

### T5 — Inbound access to the Mac
*Mitigations.* The connector is a poller. `tests/connectorOutbound.test.js`
fails the build if any connector module references `createServer`, `.listen(`,
`node:http`, `node:net` or a WebSocket server. A configured
`BIBI_CONNECTOR_INBOUND_PORT` is a startup error, not a setting.

### T6 — Local state exfiltration
*Mitigations.* Evidence is a hash plus a redacted excerpt, never a file copy.
`assertNoLocalStateSource` refuses profile state files, cookie jars, credential
files, `.ssh`, `.env` and key files. The CLI executor's only filesystem access
is a `stat` on a home directory; it never opens anything inside a profile.

### T7 — Command injection through a prompt
A chat turn is user-controlled text that becomes a CLI argument.

*Mitigations.* `execFile` with an argv array and no shell, so metacharacters are
data. `tests/connectorCliExecutor.test.js` fails if the executor source contains
`exec(` or `shell: true`.

### T8 — Running the wrong profile
The organisational id `bibi-01` and the physical rollback directory `bibi-01`
share a name. Confusing them would run the recovery copy as if it were the CEO.

*Mitigations.* The mapping is one-directional:
`toOrganizationProfileId("bibi-01")` returns null. `bibi-01` is absent from
`EXECUTION_PROFILE_IDS`, so `homeForExecutionProfile` refuses it, the heartbeat
drops it, and the database check constraint cannot store it as an
`execution_profile`. Four independent layers, each tested.

### T9 — Duplicate execution on reconnect
Both hops are at-least-once.

*Mitigations.* Unique constraints, not client discipline:
`(owner_id, client_request_id)` for intake, `(conversation_id, client_message_id)`
for turns and replies, `(work_item_id, event_id)` for transitions. Leases are
claimed with `for update skip locked` and a partial unique index on live leases,
so two connector nodes cannot run the same item.

### T10 — Resource exhaustion on the Mac
*Mitigations.* `--max-turns`, a wall-clock timeout with `SIGKILL`, a bounded
output buffer, and a capped lease batch size.

### T11 — Silent failure presented as success
The failure mode that erodes trust fastest.

*Mitigations.* No heartbeat is `UNKNOWN`, never online. An unreachable profile
is `release`d back to the queue rather than reported as failed. An empty CLI
response is an error, not an empty answer. A queued chat turn says it is queued
rather than claiming a reply is being written.

## 4. Accepted risks

| Risk | Why accepted |
|---|---|
| A compromised Mac can return false results | The connector is the owner's own machine; nothing above it can verify Hermes' honesty |
| The service role can read all rows | Inherent to a server-side control plane; the mitigation is that only the Vercel functions hold it |
| Evidence excerpts could still contain sensitive user content | Redaction targets credentials, not the owner's own material, which is the point of the evidence |

## 5. Exercised against the live system

The schema described here is applied to the live Supabase project, and as of
2026-08-24 the controls below have been exercised by a real session rather than
only reasoned about. A temporary Auth user signed in to the deployed app, sent a
chat turn on `bibi-02`, an outbound connector polled the deployed control plane
with a real token, the Hermes CLI ran the work on this Mac, and the reply came
back into the conversation. The temporary user was then deleted and its
owner-scoped rows cascaded to zero.

| Control | Verified here by | Exercised live | Still needs |
|---|---|---|---|
| RLS policies | SQL analysis of the migrations | One authenticated owner's rows written and read back through the policies | A deliberate cross-account read attempt |
| Connector token auth | Unit tests over a fake store | One real poll accepted with a valid token; an unauthenticated request rejected with HTTP 401 | One poll with a revoked token |
| Chat atomicity and reply write-back | Fakes reproducing the unique constraints | One real turn end to end: accepted 1, succeeded 1, failed 0, released 0, assistant reply in the database | — |
| CLI execution | Fixture binaries | One run against the real `hermes` on the Mac, with command, stdout and stderr evidence rows | — |

The two remaining cells are negative-path checks, and both are cheap to run once
the permanent account and connector token exist (see the status block in
`00-OVERVIEW.md`). Everything else in §3 is now a claim about a running system,
not only about code.
