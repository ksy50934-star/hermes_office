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

The cloud control-plane path described in §5 and §9 has been exercised for real,
but cross-channel conversation continuity is not implemented. The
`bibi-workspace-18` Vercel project is live with its production target Ready at
<https://bibi-workspace-18.vercel.app>, the Supabase project is linked, and
migrations `…000100` through `…000600` — all six — are applied to the remote
database.

The whole path in §5 and §9 has been run end to end against that deployment: a
chat turn on `bibi-02` became a leased command, an outbound connector on this Mac
claimed it, the Hermes CLI ran it, and the assistant reply was written back into
the same conversation with its evidence rows. Nothing about the lifecycle,
lease or write-back is untested against the live system any more.

The verified work lifecycle does not imply that Telegram and web chat share one
conversation. That gap is design and implementation work, recorded in §11.

Provisioning items also remain:

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

## 11. Required design: cross-channel conversation continuity

### 11.1 Current verified boundary

Telegram and web chat currently create different records even when they target
the same Bibi profile:

| Channel | Durable identity | Store | Hermes execution |
|---|---|---|---|
| Telegram | Hermes `session_id` plus Telegram DM origin | profile-local `state.db` | Telegram adapter continues the channel session |
| Web cloud chat | Supabase `conversation_id` | Supabase `conversations` / `messages` | connector runs a new `hermes chat --source tool` subprocess turn |

Sharing a physical profile or a `state.db` file does not make two sessions the
same conversation. Production `/hermes/api/*` currently resolves to the SPA HTML
rather than a Hermes JSON/API relay, so the deployed browser cannot use the
upstream `session.resume` UI path as a substitute for synchronization.

### 11.2 Product invariant

The workspace must present a single continuous conversation when the same owner
explicitly opens the same Bibi thread across Telegram and web. Channel origin is
message provenance, not a reason to lose history or context. Unrelated threads
must remain separate even when they belong to the same owner and profile.

### 11.3 Canonical identity model

Introduce an owner-scoped canonical conversation and explicit channel bindings:

```text
canonical_conversation
  owner_id
  organization_profile_id
  execution_profile_id
  title / lifecycle / retention state

conversation_binding
  canonical_conversation_id
  channel                  # telegram | web | future channel
  external_conversation_id # Supabase conversation id or channel thread id
  hermes_session_id
  channel_account_id
  binding state / verified_at
```

Required properties:

- CEO role slot `bibi-01` maps to execution profile `default`; the rollback
  `profiles/bibi-01` directory is never bindable.
- A Telegram identity is paired to one Supabase owner before its messages can be
  projected into that owner's workspace.
- A binding is unique within owner, profile and channel scope. The system never
  guesses a binding from display names.
- Starting a new thread creates a new canonical conversation; choosing an
  existing thread resumes it.

### 11.4 Message projection

Keep the profile-local Hermes session as the execution/context record and project
messages to the cloud through the existing outbound-only connector. Do not open
an inbound port to the Mac.

The projection requires:

1. Per-profile `state.db` checkpoints so only committed changes are uploaded.
2. Stable idempotency keys derived from profile, Hermes session and message id.
3. Provenance fields for channel, Hermes session, source message and projected
   timestamp.
4. Deterministic ordering using source sequence plus timestamp; arrival time is
   not sufficient after offline replay.
5. Tombstone/archive events for deletions and retention changes rather than
   silent divergence.
6. Content and attachment handling rules that prevent local paths, credentials,
   tool payloads and hidden runtime context from reaching the browser.

Supabase is the owner-scoped query projection for the deployed UI; it is not
allowed to fabricate Hermes context or overwrite `state.db` history.

### 11.5 Continuing a conversation from web

Each web turn must carry the bound Hermes session id to the connector. The
executor resumes that session through a verified Hermes continuation contract
instead of starting an unbound `--source tool` session on every turn.

The continuation design must specify:

- the supported Hermes CLI or Gateway resume operation and its exact result;
- behavior when a session is running, expired, archived or unavailable;
- lease ownership so two web turns cannot resume the same session concurrently;
- idempotent retry after a dropped connector report;
- creation and binding of a replacement session only after an explicit,
  auditable continuation failure.

### 11.6 Delivery and mirroring policy

Context continuity, archive visibility and channel delivery are separate
controls:

- **Context continuity:** both channels address the same Hermes session.
- **Archive visibility:** both channels' messages appear in the web timeline.
- **Channel mirroring:** a web-originated message or answer is optionally echoed
  into Telegram.

Before implementation, decide whether web-originated turns are always mirrored
to Telegram, mirrored only when the thread was opened from Telegram, or shown in
Telegram as a compact continuation notice. The selected policy must prevent bot
loops and duplicate delivery.

### 11.7 UX requirements

- Conversation lists show Bibi, title, last activity and channel provenance.
- A Telegram-origin thread is visibly marked but opens like any other thread.
- The composer states whether the reply will also be delivered to Telegram.
- “New conversation” remains distinct from “continue this conversation.”
- Concurrent activity, offline projection and sync failure are explicit states;
  the UI does not optimistically claim synchronization.
- Archive, search, unread state and attachments operate on the canonical
  conversation rather than browser-local storage.

### 11.8 Security and governance

- Preserve the outbound-only Mac boundary.
- Apply RLS to canonical conversations, bindings and projected messages.
- Store only the minimum Telegram account/chat identifiers required for a
  verified binding; do not expose bot tokens or raw connector credentials.
- Record append-only audit events for pairing, binding, resume, replacement,
  delivery and unbinding.
- Define retention, export and deletion semantics across both Supabase and local
  Hermes history before exposing delete controls.
- Reject cross-profile and cross-owner session ids at the API, connector and
  database layers.

### 11.9 Reconciliation and observability

The connector must report checkpoint lag, projection failures, binding errors
and resume failures. A reconciliation job compares per-session counts and hashes
between the allowed local projection and cloud rows without uploading hidden
tool content. Restart and offline replay must converge without duplicates.

### 11.10 Migration and rollout

1. Add canonical conversation, binding, projection checkpoint and audit schema.
2. Build read-only outbound projection and backfill existing Telegram sessions.
3. Render projected Telegram sessions in the web archive.
4. Add verified session continuation for web turns.
5. Add the approved Telegram mirroring policy.
6. Roll out one profile at a time, beginning with `bibi-07`; preserve rollback
   to the existing Supabase-only web chat until reconciliation passes.

### 11.11 Completion evidence

Cross-channel continuity is PASS only when a unique test turn proves all of the
following:

1. A Telegram message is stored in the intended profile's `state.db`.
2. The same message appears under the mapped canonical conversation in
   Production web.
3. A web follow-up resumes the same Hermes context rather than creating an
   unrelated tool session.
4. The answer appears once in the web timeline and, when mirroring is enabled,
   once in Telegram.
5. No other profile or owner's database, conversation or channel receives it.
6. Connector restart and offline replay preserve ordering and create no
   duplicate messages.
7. The local Mac still exposes no inbound service and all authorization and RLS
   checks pass.

Until every item is demonstrated by DB/API/UI readback, the feature remains
`UNKNOWN/UNVERIFIED` or `FAIL`; session existence alone is not completion.

### 11.12 Implementation status (2026-08-24)

The local code now implements the production-capable `bibi-07` pilot path with
18-role identity validation: migration `20260824000800` adds forced-RLS
bindings, projections, checkpoints, exclusive resume leases and append-only
audit events; the connector reads only active plain user/assistant rows from a
verified Telegram session and uploads them over its existing authenticated
outbound HTTPS transport; and bound web turns verify the profile-local session
metadata before invoking the installed CLI with `--resume SESSION_ID`.

The cloud timeline renders channel provenance and honest sync status, and keeps
“새 대화” separate from “이 대화 계속하기”. Telegram mirroring remains
disabled and unsupported because no safe delivery contract was established.

Migrations `…000800` through `…001200` are applied to the linked remote
project. A one-shot connector run projected all 18 profiles with zero upload
failures; owner readback returned 18 inventory and 18 health rows, a temporary
second owner returned zero rows, and an authenticated Realtime subscription
received the `bibi-02` update. A durable cloud work item also completed through
`bibi-02` with one result and three evidence rows.

Those runtime and execution checks do not by themselves satisfy the seven
cross-channel completion checks in §11.11. Telegram mirroring remains disabled,
no Telegram message was sent for this verification, and a release still requires
current Production browser/readback evidence for the exact deployed revision.
Do not infer deployment status from this document alone.
