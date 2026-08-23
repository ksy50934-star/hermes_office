# Bibi Workspace — Local Mac connector

The connector is the only link between the cloud workspace and Hermes on this
Mac. It **dials out**; nothing dials in. There is no port to open, no tunnel to
configure and no inbound firewall rule to add.

## What it does

Every cycle:

1. Lists the physical Hermes profiles that actually exist on this Mac and
   reports them as a heartbeat.
2. Polls the control plane for leased work.
3. Drops anything already delivered.
4. Runs what is left through the Hermes CLI.
5. Reports the outcome with evidence.

## Before you can run it

**The outbound path is proven.** On 2026-08-24 a connector on this Mac polled the
deployed control plane at <https://bibi-workspace-18.vercel.app>, claimed a
leased chat command for `bibi-02`, ran it through the real Hermes CLI and
reported success with evidence: accepted 1, succeeded 1, failed 0, released 0,
the work item succeeded on attempt 1, and the assistant reply landed back in the
conversation. The temporary credential used for that run was revoked with its
owner afterwards.

**You still need a token.** There are currently **0 `connector_nodes` rows and
0 `connector_credentials` rows**, so `BIBI_CONNECTOR_TOKEN` below has no valid
value to take until a permanent connector is registered. That registration waits
on the owner's permanent account, not on anything in this repository.

Registering one means inserting a `connector_nodes` row and a
`connector_credentials` row holding the **SHA-256 hash** of a freshly generated
token; the plaintext is shown once and never stored. See the status block in
`../docs/bibi-workspace/00-OVERVIEW.md`.

## Running it

```sh
BIBI_CONNECTOR_MODE=outbound-local-mac \
BIBI_CONTROL_PLANE_URL=https://<your-vercel-domain> \
BIBI_CONNECTOR_TOKEN=<token issued by the workspace> \
node connector/index.js
```

That starts in **dry run**: it polls, leases and reports honestly, but does not
drive a real profile. Installing the connector is not the same act as
authorising it to act.

To let it actually run work:

```sh
BIBI_CONNECTOR_ALLOW_LOCAL_EXECUTION=true \
BIBI_HERMES_BIN=/usr/local/bin/hermes \
BIBI_HERMES_DEFAULT_HOME="$HOME/.hermes" \
BIBI_HERMES_PROFILES_ROOT="$HOME/.hermes/profiles" \
... node connector/index.js
```

All three Hermes settings are required once local execution is enabled; the
connector refuses to start without them rather than failing at the first
command. See `.env.cloud.example` for the complete contract.

## How a profile is chosen

The verified CLI contract:

```
hermes chat -q <PROMPT> -Q --source tool --max-turns <N>
```

A profile is selected **only** by the child process's `HERMES_HOME`. There is no
profile flag.

| Role slot | `HERMES_HOME` |
|---|---|
| `bibi-01` (CEO비비) | `BIBI_HERMES_DEFAULT_HOME` — `~/.hermes` |
| `bibi-02` .. `bibi-18` | `BIBI_HERMES_PROFILES_ROOT/<id>` |

`~/.hermes/profiles/bibi-01` is a **rollback original**. It is never executed,
never reported as available, and cannot be stored as an execution profile.

## What it will not do

- Open a listening socket. The test suite fails the build if any connector
  module references `createServer`, `.listen(`, `node:http` or `node:net`.
- Run through a shell. `execFile` with an argv array, so a prompt containing
  shell metacharacters is data.
- Forward its own environment to the child. Only an allowlist plus
  `HERMES_HOME`, so the connector token never reaches the CLI.
- Read anything inside a profile. Its only filesystem access is a `stat` on a
  home directory to see whether it exists.
- Upload local state. Evidence is a hash plus a redacted excerpt.

## Stopping it

Ctrl-C. Any lease it holds expires on its own and the work returns to the queue,
so nothing is lost and nothing is double-run.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `INBOUND_PORT_CONFIGURED` at startup | `BIBI_CONNECTOR_INBOUND_PORT` is set; it must be empty |
| `MISSING_HERMES_BIN` | Local execution is enabled without the CLI settings |
| Workspace shows a profile OFFLINE | Its home directory does not exist under the configured root |
| Workspace shows CEO비비 OFFLINE | `BIBI_HERMES_DEFAULT_HOME` is wrong, or `~/.hermes` is missing |
| `EXECUTION_TIMEOUT` | The run exceeded `BIBI_HERMES_TIMEOUT_MS`; the child was killed |
