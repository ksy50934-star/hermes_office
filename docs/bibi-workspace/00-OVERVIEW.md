# Bibi Workspace — Overview

Ticket `HOFFICE-NEW-001`. A dedicated web workspace where the owner talks to
CEO비비 and delegates work to the eighteen Bibis, without Telegram, while Hermes
keeps running on the owner's own Mac.

## What this is

- **CEO-first.** `bibi-01` is the default view and the governing surface.
- **Chat is executable.** A message is not stored and forgotten: it atomically
  becomes a leased command, runs on a real profile, and the reply comes back
  into the same conversation.
- **Work is durable.** Intake lands in Postgres before anything tries to run it,
  and survives the Mac sleeping mid-task.
- **The Mac is never exposed.** The connector dials out. Nothing dials in.
- **Honest state.** No heartbeat means OFFLINE or UNKNOWN, never a hopeful
  "running".

## Reading order

| Document | What it answers |
|---|---|
| `01-ARCHITECTURE.md` | How the pieces fit, the two identifier spaces, the lifecycle, the execution contract |
| `02-THREAT-MODEL.md` | What is being protected and how |
| `03-REQUIREMENTS-TRACE.md` | Requirement → code → test |
| `../../connector/README.md` | Running the connector on the Mac |
| `../../.env.cloud.example` | The full environment contract |

## The two identifier spaces

The single most important thing to know before changing anything:

| | Values | Meaning |
|---|---|---|
| Organisational role slot | `bibi-01` .. `bibi-18` | What the user assigns work to |
| Physical execution profile | `default`, `bibi-02` .. `bibi-18` | A real Hermes profile directory |

CEO비비 is `bibi-01` but **executes on `default` (`~/.hermes`)**. The directory
`~/.hermes/profiles/bibi-01` exists and is a **rollback original** — never a
runtime. See `01-ARCHITECTURE.md` §3.

## Release status

This is the canonical status block. `01-ARCHITECTURE.md` §10,
`02-THREAT-MODEL.md` §5 and `03-REQUIREMENTS-TRACE.md` point here rather than
restating it, so there is one place to correct.

**Provenance.** Every row below was **directly verified on 2026-08-24** — by
running the repository's own checks, by driving the deployed site in a browser,
and by one real end-to-end run through the deployed control plane onto this Mac.
Nothing here is second-hand.

| Item | Status | Evidence |
|---|---|---|
| Application code, schema, tests | **DONE** | `npm run verify` — 420 of 420 tests pass, exit 0 |
| Package verification | **DONE** | `npm run verify:package` — exit 0, whole tracked-and-untracked tree scanned |
| Production deployment | **DONE** — target Ready | <https://bibi-workspace-18.vercel.app> |
| Supabase project | **DONE** — created, linked and reachable | the linked project ref lives only in `supabase/.temp/`, which is never committed |
| Migrations `…000100` … `…000600` (001–006) | **DONE** — all six applied to the remote database | remote migration list |
| Browser QA — mobile 390px and desktop 1440px | **PASS** | no console, page or network errors; no horizontal overflow; no legacy banner and no legacy status controls; logo `naturalWidth` 150 |
| Protected Preview deployment | **PASS** | index HTTP 200 and JS asset HTTP 200 through protection |
| Unauthenticated connector API | **PASS** | HTTP 401 |
| Cloud ↔ local round-trip | **PASS** — real outbound connector E2E on `bibi-02` | accepted 1, succeeded 1, failed 0, released 0; the work item succeeded on attempt 1; the assistant message written back to the database contained `E2E_OK`; 3 evidence rows recorded (command, stdout, stderr) |
| E2E receipt | recorded | SHA-256 `be669b7f6c3db58608a90eb26cfabcbffd2fe1567ea2b3d8fea93d130e2d4b80` |
| Temporary E2E Auth user | **deleted** | owner-scoped rows cascaded to 0 |
| Permanent owner Auth account | **not provisioned — deliberate** | waiting on the real login email |
| Permanent connector credential and node | **not provisioned — deliberate** | waiting on the real login email |

The product path is proven end to end: sign-in, chat dispatch, lease, execution
on a real Hermes profile and reply write-back all ran against the deployed
system, and the temporary identity used to prove it was then removed. Because it
was removed, there is currently **no** Auth account and there are **0**
`connector_nodes` and **0** `connector_credentials` rows.

That is a provisioning gap, not a code gap, and it is held open on purpose: the
permanent owner account is created against the owner's real login email, and the
permanent connector token is issued to it. Nothing in the repository blocks it.

### Remaining owner steps

Neither step is performed here. This session does not create permanent accounts
or issue permanent tokens, by instruction.

1. **Provision the owner's account** in Supabase Auth, against the real login
   email. The app has no registration path by design, so the account is created
   directly in the Supabase dashboard.
2. **Register the permanent connector.** Insert a `connector_nodes` row and a
   `connector_credentials` row holding the SHA-256 hash of a freshly generated
   token — the plaintext is shown once and never stored. Then run the connector
   on the Mac (`connector/README.md`), first in dry-run, then with
   `BIBI_CONNECTOR_ALLOW_LOCAL_EXECUTION=true`.

The E2E run already confirmed the `bibi-01 → default` mapping story against this
Mac for a specialist slot; the permanent connector's first heartbeat re-confirms
it for the live roster, and the mismatch report is built to say so loudly if the
Mac disagrees.

## Verifying locally

```
npm run verify          # lint, build, full test suite, package check
node --test tests/connectorCliExecutor.test.js   # CLI contract, fixture-driven
```

The test suite never invokes the real `hermes` binary and never touches a live
Hermes profile.
