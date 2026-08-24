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

`connector/ops.js provision` is that registration. See
[Provisioning](#provisioning) below and the status block in
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
BIBI_HERMES_BIN="$HOME/.local/bin/hermes" \
BIBI_HERMES_DEFAULT_HOME="$HOME/.hermes" \
BIBI_HERMES_PROFILES_ROOT="$HOME/.hermes/profiles" \
... node connector/index.js
```

All three Hermes settings are required once local execution is enabled; the
connector refuses to start without them rather than failing at the first
command. See `.env.cloud.example` for the complete contract.

## Provisioning

One command creates the owner's Auth user, the `connector_nodes` row, the
`connector_credentials` row and both Keychain items — or refuses and changes
nothing.

```sh
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
  node connector/ops.js provision \
    --owner-email owner@example.com \
    --node-label local-mac < /path/to/password-file
```

### Where each input comes from, and why

| Input | Source | Why not elsewhere |
|---|---|---|
| owner email | `--owner-email` | Not a secret. Being explicit is what stops the connector binding to the wrong account. |
| node label | `--node-label` | Not a secret. It is the Keychain account name, so it is stable and documented. |
| owner password | stdin, or `--password-fd <n>` | A `--password` flag would put it in the shell history and in `ps`. Passing it is refused outright. |
| Supabase service key | `SUPABASE_SERVICE_ROLE_KEY` | Same reason. `--service-role-key` is refused too. |
| connector token | generated here | It is never an input. It is created, hashed, stored and forgotten in one call. |

### What ends up where

| Artifact | Location | Contents |
|---|---|---|
| Auth user | Supabase | email + password hash |
| `connector_nodes` row | Supabase | label, platform, mode |
| `connector_credentials` row | Supabase | **SHA-256 hash** and a 4-character prefix. Never the token. |
| connector token | macOS Keychain | service `com.bibi.workspace.connector-token`, account `<node label>` |
| login password | macOS Keychain | service `com.bibi.workspace.owner-login`, account `<owner email>` |

Those two service names are the stable contract. The rendered LaunchAgent
wrapper reads the first one by name, so renaming either orphans an item rather
than migrating it.

### Idempotent, or refused

| Found | Result | Exit |
|---|---|---|
| none of the five | provisions all five | 0 |
| all five | reports and changes nothing | 0 |
| anything in between | refuses, naming what exists and what does not | 3 |

A half-provisioned account is not repaired by guessing: a node row without a
credential and a Keychain item without a row look identical from here, and
picking wrong either strands a credential the owner cannot revoke or overwrites
one that is in use.

The one legitimate partial state is an owner account created by hand in the
Supabase dashboard with nothing else yet. `--allow-existing-owner` adopts it;
without that flag it is a refusal like any other.

If a step fails part-way, everything already created is removed in reverse
order and the command exits 4. If a rollback step *also* fails it exits **5**
and names the stranded artifact, because a silent partial cleanup is the one
outcome that cannot be recovered from later.

### Reading it back

```sh
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  node connector/ops.js readback --owner-email owner@example.com --node-label local-mac --json
```

Identifiers, status, the token prefix and SHA-256 fingerprints. Never a token,
never a password, never the stored hash — the hash is enough to check a guessed
token against offline, so only a fingerprint of it leaves the process.

## Running it under launchd

The LaunchAgent keeps the connector running across logins and reboots. **No
secret is written into the plist**: it carries the environment contract, and the
wrapper it launches reads the token from the Keychain at start time.

Render both files and read them before installing anything:

```sh
node connector/ops.js launchagent render \
  --node-label local-mac \
  --control-plane-url https://<your-vercel-domain> \
  --allow-local-execution
```

Install, inspect, remove:

```sh
node connector/ops.js launchagent install --node-label local-mac --control-plane-url https://… [--force]
node connector/ops.js launchagent inspect
node connector/ops.js launchagent uninstall
```

| Path | What |
|---|---|
| `~/Library/LaunchAgents/com.bibi.workspace.connector.plist` | the job, mode 600 |
| `~/Library/Application Support/BibiWorkspace/connector-run.sh` | the wrapper, mode 700 |
| `~/Library/Logs/BibiWorkspace/connector.out.log` | stdout |
| `~/Library/Logs/BibiWorkspace/connector.err.log` | stderr |

`RunAtLoad` starts it; `KeepAlive` restarts it; `ThrottleInterval` (default 30s)
is what stops a job that fails instantly from restarting as fast as the machine
allows. `uninstall` boots the job out and removes those two files. It keeps the
logs — they are the only record of why the connector stopped — and it never
touches the Keychain, because removing a launcher is not revoking a credential.

Defaults for the Hermes settings are the layout verified on this Mac,
expressed relative to `$HOME`: `~/.local/bin/hermes`, `~/.hermes` and
`~/.hermes/profiles`. `BIBI_HERMES_*` or the matching `--hermes-*` flags
override them.

## Dry run

Every command takes `--dry-run`, which validates the inputs and renders the
artifacts while touching **nothing**: no Keychain call, no Supabase client is
even imported, no `launchctl`, no file under `~/Library`. It does not read the
password either — a rehearsal should not consume the owner's secret just to
print a plan.

```sh
node connector/ops.js provision --owner-email owner@example.com --node-label local-mac --dry-run --json
node connector/ops.js launchagent install --node-label local-mac --control-plane-url https://… --dry-run
```

`--dry-run` is a rehearsal, not a bypass: a malformed email or a plain-HTTP
control plane URL still fails.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done, or already in the requested state |
| 2 | usage or input validation |
| 3 | refused: partial state, or a LaunchAgent already installed |
| 4 | failed, and everything it had created was rolled back |
| 5 | failed **and** the rollback could not finish. Needs a person. |

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
| `provision` exits 3 | Some of the five artifacts already exist; the report names which |
| `provision` exits 5 | A rollback could not finish. Do not re-run; check the named artifact first |
| Wrapper exits 78 | The Keychain item is missing or access was denied; run `provision` first |
| LaunchAgent restarting in a loop | Check `~/Library/Logs/BibiWorkspace/connector.err.log`; restarts are throttled to 30s |
