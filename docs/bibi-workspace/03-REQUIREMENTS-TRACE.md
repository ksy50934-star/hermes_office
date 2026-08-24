# Bibi Workspace — Requirements trace

Requirement → code → test. Every row is enforced by a test that fails if the
behaviour regresses.

## Product contract

| # | Requirement | Code | Test |
|---|---|---|---|
| R1 | Exact roster `bibi-01`..`bibi-18` | `src/bibi/roster.js` | `bibiRoster.test.js` — frozen, exactly 18, push throws |
| R2 | Roles are canonical, not invented | `src/bibi/roster.js` `CANONICAL_ROLES` | `bibiRoster.test.js` — re-reads `bibi-world/bibi-NN/profile.json` and compares |
| R3 | `bibi-01` executes on `default` | `toExecutionProfileId` | `bibiRoster.test.js` — mapping and round-trip |
| R4 | The rollback `bibi-01` directory is never the CEO runtime | `toOrganizationProfileId` returns null; absent from `EXECUTION_PROFILE_IDS` | `bibiRoster.test.js`, `bibiProfileMismatch.test.js`, `bibiConnectionState.test.js`, `connectorCliExecutor.test.js`, `supabaseRlsBoundary.test.js` |
| R5 | CEO-first is the governing surface | `src/BibiWorkspace.jsx`, nav in `src/App.jsx` | `bibiAuthSurface.test.js`; default view is `ceo` |
| R6 | Independent profile identity | `conversations.profile_id`, per-slot conversations | `supabaseRlsBoundary.test.js` |

## Chat is executable

| # | Requirement | Code | Test |
|---|---|---|---|
| R7 | A message atomically becomes a leased command | `bibi_send_chat_message` (migration 000500, qualified by 000600), `handleChatSend` | `bibiChatDispatch.test.js` — one turn, one command, assigned |
| R8 | Connector success writes the assistant reply back | `bibi_record_assistant_message`, `handleReport` | `bibiChatDispatch.test.js` — reply lands in the same conversation |
| R9 | No duplicate turn, command or reply | Unique `(conversation_id, client_message_id)`, `(owner_id, client_request_id)`, `(work_item_id, event_id)` | `bibiChatDispatch.test.js` — resend, redelivery, second success |
| R10 | Chat does not clutter the work board | `kind` column; `loadWorkItems` filters `kind = 'work'` | `bibiChatDispatch.test.js` |
| R11 | A browser cannot write a message directly | No insert policy on `messages` | `bibiChatDispatch.test.js` — per-statement policy scan |

## Authentication

| # | Requirement | Code | Test |
|---|---|---|---|
| R12 | Real email/password sign-in | `SignInPanel`, `signInWithPassword` | `bibiAuthSurface.test.js` — form wiring, input types, labels |
| R13 | Validation and errors are shown | `src/bibi/authForm.js` | `bibiAuthSurface.test.js` — per-field problems, translated errors |
| R14 | No public sign-up | No `signUp` anywhere | `bibiAuthSurface.test.js` — absence asserted in client and UI |
| R15 | Sign-out | `signOut`, `.bibi-signout` | `bibiAuthSurface.test.js` |

## Local execution

| # | Requirement | Code | Test |
|---|---|---|---|
| R16 | Real subprocess executor, exact argv | `connector/hermesCliExecutor.js` | `connectorCliExecutor.test.js` — fixture asserts argv verbatim |
| R17 | Profile selected only by `HERMES_HOME` | `homeForExecutionProfile` | `connectorCliExecutor.test.js` — CEO and specialist mapping, no flag |
| R18 | Fail-closed env contract | `connector/config.js` | `connectorCliExecutor.test.js` — three required vars |
| R19 | No shell, exact id validation | `execFile`, roster match | `connectorCliExecutor.test.js` — traversal cases, source scan |
| R20 | Timeout, bounded output, redaction | `classifyFailure`, `maxBuffer`, `redactSecrets` | `connectorCliExecutor.test.js` — timeout, runaway output, leaked token |
| R21 | No secret reaches the child | `INHERITED_ENV_KEYS` allowlist | `connectorCliExecutor.test.js` — no `BIBI_*`/`SUPABASE*` in child env |
| R22 | `listProfileIds` reports only present homes | `stat` per expected profile | `connectorCliExecutor.test.js` |
| R23 | No arbitrary local-state or evidence reads; the continuity reader has a narrow projection allowlist | executor `stat` only; `messageProjection.js` explicit SQL columns | `connectorCliExecutor.test.js`, `connectorOutbound.test.js`, `messageProjection.test.js` |

## Topology and boundaries

| # | Requirement | Code | Test |
|---|---|---|---|
| R24 | Outbound-only, no inbound port | `connector/*` | `connectorOutbound.test.js` — source scan, `INBOUND_PORT_CONFIGURED` |
| R25 | Honest OFFLINE/QUEUED | `src/bibi/connectionState.js` | `bibiConnectionState.test.js` — no heartbeat is UNKNOWN |
| R26 | Profile mismatch warnings | `src/bibi/profileMismatch.js` | `bibiProfileMismatch.test.js` |
| R27 | Local-vs-VPS warnings | `src/bibi/runtimeEnvironment.js` | `bibiRuntimeEnvironment.test.js` |
| R28 | RLS on every table, enabled and forced | migration 000200 | `supabaseRlsBoundary.test.js` |
| R29 | Service-role key never in the client | `src/cloud/env.js`, `api/_lib/serverEnv.js` | `cloudClientBoundary.test.js` — JWT decode of the built bundle |
| R30 | Auth boundaries on the API | `connectorAuth.js`, `userAuth.js` | `apiAuthBoundary.test.js` — cross-account, revoked, unverified |
| R31 | Lifecycle, leases, idempotency | `src/bibi/workLifecycle.js`, `bibi_claim_work` | `bibiWorkLifecycle.test.js`, `bibiIdempotency.test.js` |
| R32 | Vercel + environment contract | `vercel.json`, `.env.cloud.example` | `vercelDeploymentContract.test.js` |

## Cross-channel conversation continuity

| # | Requirement | Code | Test |
|---|---|---|---|
| R33 | Owner/profile/channel/session identity is explicit and rollback `bibi-01` is excluded | migration `000800`, `messageProjection.js` | `conversationContinuitySchema.test.js`, `messageProjection.test.js` |
| R34 | Only redacted user/assistant content is projected incrementally and replay converges | `messageProjection.js`, projection API/store | `messageProjection.test.js`, `projectionControlPlane.test.js` |
| R35 | Bound turns use verified `hermes chat --resume SESSION_ID` with no shell | `sessionBinding.js`, `hermesCliExecutor.js` | `resumeSessionExecutor.test.js` |
| R36 | One active resume per owner/profile/session | migration `000800`, `bibi_claim_work` | `conversationContinuitySchema.test.js`, `resumeControlPlane.test.js` |
| R37 | Cloud timeline shows provenance and honest sync; new and continue are separate | `workspaceClient.js`, `BibiWorkspace.jsx` | `conversationContinuityCloud.test.js` |
| R38 | Mac remains outbound-only and production `/hermes/api/*` is unused | connector transport and projection routes | `connectorOutbound.test.js`, `conversationContinuityCloud.test.js` |
| R39 | Telegram mirroring is disabled and unsupported | schema default and UI wording | `conversationContinuitySchema.test.js`, `conversationContinuityCloud.test.js` |

## Verification status

Every row above is proven by a local test: `npm run verify` runs 635 tests, all
635 pass, and it exits 0 (2026-08-24).

Those tests verify RLS, the chat functions and the lease claim by SQL analysis
and by fakes that reproduce the database's uniqueness guarantees. As of the same
date they are no longer the only evidence: one authenticated round-trip has been
run against the deployed project, covering R7–R10 (a chat turn became a leased
command and the reply was written back), R16–R23 (the real `hermes` CLI ran the
work on `bibi-02`, with command, stdout and stderr evidence rows) and R24 (the
connector reached the control plane outbound, and an unauthenticated request was
refused with HTTP 401). The work item succeeded on attempt 1: accepted 1,
succeeded 1, failed 0, released 0.

Two negative paths are still unexercised live — a cross-account read attempt and
a poll with a revoked token — and both wait on the permanent account and token
rather than on code. See `02-THREAT-MODEL.md` §5 and the canonical status block
in `00-OVERVIEW.md`.

The temporary identity used for that run was deleted afterwards and its
owner-scoped rows cascaded to zero. This session did not create permanent
accounts, issue permanent tokens, or inspect or modify the live Hermes runtime.
