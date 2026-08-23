# Bibi Workspace — Architecture

Ticket: `HOFFICE-NEW-001`. Starting point: the upstream Hermes Office product in
this repository. This document describes what was built on top of it and, just
as importantly, which of its assumptions were replaced rather than renamed.

## 1. The shape of the system

```
   Browser (Vercel static)          Vercel functions            Supabase
  ┌──────────────────────┐        ┌──────────────────┐      ┌───────────────┐
  │ BibiWorkspace.jsx    │ RLS    │ /api/connector/* │      │ Postgres      │
  │  · CEO-first chat    ├───────►│ /api/work/*      ├─────►│  + RLS        │
  │  · roster bibi-01..18│ anon   │  service role    │      │  + Realtime   │
  │  · work board        │◄───────┤                  │◄─────┤  + Auth       │
  └──────────────────────┘realtime└──────────────────┘      └───────┬───────┘
                                            ▲                       │
                                            │ HTTPS, outbound only  │
                                   ┌────────┴────────────┐          │
                                   │ Local Mac connector │──────────┘
                                   │  connector/index.js │  (never inbound)
                                   └────────┬────────────┘
                                            │ execFile, no shell
                                   ┌────────┴─────────────┐
                                   │ hermes chat (subproc) │
                                   │ HERMES_HOME selects   │
                                   │ default, bibi-02..18  │
                                   └──────────────────────┘
```

There is exactly one arrow into the Mac, and it starts on the Mac. The control
plane cannot reach the connector; the connector polls it.

## 2. What changed from upstream, and why

| Upstream assumption | Why it does not hold | What replaced it |
|---|---|---|
| Nine generic profiles (`default`, `hermes-*`), with `default` and `hermes-director` collapsed into one UI profile by `src/profileIds.js` | The real install has eighteen independent Bibis, each with its own session identity, and `default` is a specific one of them rather than a catch-all | `src/bibi/roster.js` — eighteen frozen role slots plus an explicit, one-directional mapping to physical profiles (§3) |
| Hermes reachable from the server at `HERMES_TARGET` (`host.docker.internal`, a VPS address) | Hermes runs on a laptop with no public address | `connector/` polls outbound and drives `hermes` as a subprocess; there is no network address for Hermes at all |
| Server proxies the browser straight through to the Hermes gateway (`hermesProxy.js`, `/hermes/*`) | Requires the server to reach the runtime | The browser talks to Postgres; the connector carries work to the Mac |
| Docker Compose deployment on a VPS | Target is Vercel plus a laptop | `vercel.json`, `api/`, `supabase/migrations/` |
| `isProfileAvailable()` returns `true` for `default` once the workspace loads | Treats absence of a signal as health | `src/bibi/connectionState.js` — no heartbeat is `UNKNOWN`, never online |

The upstream surfaces (office map, meetings, kanban, data room, terminal) are
untouched and still reachable from the navigation. The CEO surface was added
ahead of them and is now the default view.

## 3. Two identifier spaces

This is the single most important thing to understand before changing anything
here, and it is the correction the 2026-08-24 revision of the brief made:

| | Values | Meaning |
|---|---|---|
| **Organisational role slot** | `bibi-01` .. `bibi-18` (18) | What the user sees, assigns work to, and owns conversations under |
| **Physical execution profile** | `default`, `bibi-02` .. `bibi-18` (18) | A real Hermes profile directory on the Mac |

CEO비비 is the role slot `bibi-01`, but it **executes on the `default` profile at
`~/.hermes`**. There is no physical profile named `bibi-01` in use.

A directory called `profiles/bibi-01` does exist on the Mac. It is a **rollback
original**, not a runtime. So the mapping is deliberately asymmetric:

```js
toExecutionProfileId("bibi-01")    === "default"   // role slot → runtime
toOrganizationProfileId("default") === "bibi-01"   // runtime → role slot
toOrganizationProfileId("bibi-01") === null        // rollback original: not anyone's runtime
```

That last line is the safety property. If it returned `"bibi-01"`, then a
connector that saw the rollback directory on disk would report the CEO as
available, and work would run against the recovery copy as if it were live.
Enforced at four layers:

| Layer | Enforcement |
|---|---|
| Roster | `toOrganizationProfileId("bibi-01")` returns null |
| Availability | `describeProfileAvailability` translates before lookup, so bibi-01 is satisfied only by `default` |
| Connector | `listProfileIds()` filters with `isExecutionProfileId`, which excludes `bibi-01` |
| Database | `check (execution_profile = 'default' or execution_profile ~ '^bibi-(0[2-9]|1[0-8])$')` |

Both identities travel together from the poll response through execution into
every report and every evidence row, so a stored artifact always says which role
slot was assigned *and* which profile produced it.

## 4. Module map

| Concern | Module | Notes |
|---|---|---|
| Roster and mapping | `src/bibi/roster.js` | Frozen. All eighteen roles transcribed from the read-only bibi-world declarations |
| Sign-in validation | `src/bibi/authForm.js` | Field rules and error wording; no registration path exists |
| Profile mismatch warnings | `src/bibi/profileMismatch.js` | Translates physical → role slot; classifies, never substitutes |
| Local-vs-VPS warnings | `src/bibi/runtimeEnvironment.js` | Blocks on remote target, inbound port, exposed key |
| Work lifecycle | `src/bibi/workLifecycle.js` | Pure reducer, shared by the API and the connector |
| Idempotency | `src/bibi/idempotency.js` | Bounded LRU ledger, intake and command keys |
| Honest availability | `src/bibi/connectionState.js` | ONLINE / STALE / OFFLINE / UNKNOWN → LIVE / QUEUED / BLOCKED |
| Client key boundary | `src/cloud/env.js` | Classifies Supabase keys; refuses privileged ones |
| Data adapter | `src/cloud/workspaceClient.js` | Reads under RLS; transitions via the API |
| CEO surface | `src/BibiWorkspace.jsx` | Default view, wired into `src/App.jsx` |
| Hermes CLI executor | `connector/hermesCliExecutor.js` | `execFile`, no shell; profile chosen only by `HERMES_HOME` |
| Connector | `connector/*.js` | Outbound only; no module imports `node:http`/`node:net` |
| Control plane | `api/_lib/*.js`, `api/connector/*`, `api/work/*` | Service role, owner-scoped |
| Schema | `supabase/migrations/*.sql` | Forward-only, RLS enabled and forced |

## 5. Work lifecycle

```
intake ──assign──► assigned ──lease──► leased ──start──► running ──succeed──► succeeded
                      ▲                   │                 │       └──fail──► failed
                      │                   └───release───────┘
                      │                        (lease expiry / Mac asleep)
                      ├──unblock── blocked ◄──block──┘
                      └──────────── cancel ────────────► cancelled
```

Two properties carry most of the weight:

- **A lost lease is not a failure.** The Mac sleeping mid-task returns the work
  to `assigned` with its assignment intact. Reporting that as a failure would
  teach the owner to distrust failures.
- **Every event has an id, applied at most once.** `work_events` has a unique
  constraint on `(work_item_id, event_id)`. A redelivered report is a duplicate,
  not a second transition, so a reconnect cannot inflate an attempt counter or
  re-run finished work.

## 6. Authority split

| Actor | May write | Enforced by |
|---|---|---|
| Browser | Its own conversations; its own chat turn; work intake | RLS policies + the `work_items` insert guard trigger |
| Vercel functions | Everything, scoped to one owner | Service role + explicit `owner_id` filters on every query |
| Connector | Nothing directly | Has no database credential at all; it reports over HTTPS and the API decides |

The connector never holds a Supabase key. It holds a bearer token whose SHA-256
hash is what the database stores, so a database dump yields no usable credential.

## 7. Reconnect and idempotency

| Hop | Failure | Absorbed by |
|---|---|---|
| Browser → intake | Retried POST after a dropped response | `unique (owner_id, client_request_id)`; the client reuses the id and the duplicate returns the original row |
| Browser → chat | Resent message | `unique (conversation_id, client_message_id)` with `ignoreDuplicates` |
| Control plane → connector | Same command polled twice | `suppressDuplicateCommands` keyed on `(workItemId, type, attempt)` |
| Connector → control plane | Retried report | Deterministic event ids (`<command>:start`, `:succeed`, `:fail`) + the unique event constraint |
| Realtime | Socket drops, tab sleeps | `onResync` refetches; realtime replays nothing, so the cache is not trusted |
| Two connector nodes | Both poll at once | `bibi_claim_work` uses `for update skip locked`; a partial unique index on live leases is the backstop |

## 8. Execution contract

Hermes is driven as a subprocess. The verified invocation is:

```
hermes chat -q <PROMPT> -Q --source tool --max-turns <N>
```

A profile is selected **only** by the child process's `HERMES_HOME`. There is no
profile flag. `connector/hermesCliExecutor.js` is the sole place this happens,
and it holds these properties:

| Property | How |
|---|---|
| No shell | `execFile` with an argv array, so a prompt is data, never syntax |
| No secret leakage | The child inherits an allowlist (`PATH`, `HOME`, `LANG`, …) plus `HERMES_HOME`; `process.env` is not forwarded, so the connector token stays out |
| No traversal | The profile id is matched against the roster, not sanitised |
| Rollback safety | `bibi-01` is not an execution profile, so its directory can never be run |
| Bounded | `BIBI_HERMES_TIMEOUT_MS` with a `SIGKILL`, and `BIBI_HERMES_MAX_OUTPUT_BYTES` |
| Redacted | stdout and stderr pass through `redactSecrets` before becoming a result or evidence |
| No state reads | The only filesystem access is a `stat` on the home directory |

`listProfileIds()` reports a profile only when its home directory exists, so an
absent profile shows as OFFLINE rather than being claimed.

Required when `BIBI_CONNECTOR_ALLOW_LOCAL_EXECUTION=true`, and refused at
startup otherwise: `BIBI_HERMES_BIN`, `BIBI_HERMES_DEFAULT_HOME`,
`BIBI_HERMES_PROFILES_ROOT`.

## 9. Chat is executable

A chat turn is a command, not a stored row. `bibi_send_chat_message` creates the
user's message and an `assigned` work item with `kind = 'chat'` in one atomic
call, so a question can never exist with nothing assigned to answer it.

```
user message ─┬─► messages (role = user)
  (one call)  └─► work_items (kind = chat, status = assigned, conversation_id)
                        │
                        └─ leased → running → succeed
                                                 │
                                                 └─► bibi_record_assistant_message
                                                       → messages (role = assistant)
```

| Duplicate risk | Prevented by |
|---|---|
| Resent turn | `unique (conversation_id, client_message_id)`; the function returns the original pair |
| Duplicate command | `unique (owner_id, client_request_id)` where the id is `chat:<client_message_id>` |
| Duplicate reply | The reply's `client_message_id` is `assistant:<work_item_id>`, so a redelivered success conflicts |

The browser holds no insert policy on `messages`: a direct insert would produce
a turn nothing would answer, and would let a client fabricate an assistant
reply. Chat commands are excluded from the work board by `kind = 'work'`, so
dispatch does not bury deliberate work.

## 10. Deployment status

No functional gaps remain in this repository, and the deployed system has been
exercised for real. The `bibi-workspace-18` Vercel project is live with its
production target Ready at <https://bibi-workspace-18.vercel.app>, the Supabase
project is linked, and migrations `…000100` through `…000600` — all six — are
applied to the remote database.

The whole path in §5 and §9 has been run end to end against that deployment: a
chat turn on `bibi-02` became a leased command, an outbound connector on this Mac
claimed it, the Hermes CLI ran it, and the assistant reply was written back into
the same conversation with its evidence rows. Nothing about the lifecycle,
lease or write-back is untested against the live system any more.

What remains is provisioning, not code:

| Outstanding | Why |
|---|---|
| Permanent owner Auth account | Created against the owner's real login email, which is not yet fixed |
| Permanent `connector_nodes` / `connector_credentials` rows | The permanent token is issued to that account |

The temporary identity used for the end-to-end run was deleted afterwards and
its owner-scoped rows cascaded away, so those tables are empty right now by
design rather than by omission.

`00-OVERVIEW.md` holds the canonical status block, the evidence and the two
remaining owner steps. This session did not create permanent accounts, issue
permanent tokens, or modify the live Hermes runtime.
