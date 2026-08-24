import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hashConnectorToken } from "../api/_lib/connectorAuth.js";
import {
  KEYCHAIN_SERVICES,
  KeychainError,
  SECURITY_BIN,
  trustedApplicationsFor,
  buildAddItemCommand,
  buildDeleteItemCommand,
  buildFindItemCommand,
  createKeychain,
  describeCommand,
} from "../connector/keychain.js";
import { EXIT, parseArguments, readSecretFromDescriptor, runOps } from "../connector/ops.js";
import {
  PROVISION_ARTIFACTS,
  ProvisioningError,
  classifyProvisioningState,
  generateConnectorToken,
  inspectProvisioningState,
  keychainCoordinates,
  normaliseNodeLabel,
  normaliseOwnerEmail,
  provisionConnector,
  readbackProvisioning,
} from "../connector/provisioning.js";
import { createSafeWriter, createSecretGuard, fingerprint } from "../connector/secretGuard.js";

// ---------------------------------------------------------------------------
// Fixtures. Nothing here reaches Supabase, the Keychain or the network; the
// doubles are the whole point, because the real versions of these calls create
// an account and write a credential.
// ---------------------------------------------------------------------------

const OWNER_EMAIL = "owner@example.com";
const NODE_LABEL = "local-mac";
const PASSWORD = "Bibi-Workspace-2026!";
const TOKEN = "bibi_TESTTOKENvalue0123456789abcdefghij";
const SERVICE_KEY = "eyJhbGciOiJIUzI1NiJ9.c2VydmljZS1yb2xl.signature";

function fakeAdmin({ users = [], nodes = [], credentials = [], fail = {} } = {}) {
  const calls = [];
  const state = { users: [...users], nodes: [...nodes], credentials: [...credentials] };
  let sequence = 0;
  const record = (name, payload = {}) => calls.push({ name, ...payload });

  function boom(name) {
    if (fail[name]) throw new Error(`${name} failed`);
  }

  return {
    calls,
    state,
    names: () => calls.map((call) => call.name),

    async findUserByEmail(email) {
      record("findUserByEmail", { email });
      return state.users.find((user) => user.email === email) ?? null;
    },
    async createUser({ email, password }) {
      record("createUser", { email, password });
      boom("createUser");
      const user = { id: `user-${(sequence += 1)}`, email, password };
      state.users.push(user);
      return { id: user.id, email };
    },
    async deleteUser(id) {
      record("deleteUser", { id });
      boom("deleteUser");
      state.users = state.users.filter((user) => user.id !== id);
    },

    async findNodeByLabel({ ownerId, label }) {
      record("findNodeByLabel", { ownerId, label });
      return state.nodes.find((node) => node.owner_id === ownerId && node.label === label) ?? null;
    },
    async insertNode({ ownerId, label }) {
      record("insertNode", { ownerId, label });
      boom("insertNode");
      const node = { id: `node-${(sequence += 1)}`, owner_id: ownerId, label, status: "unknown" };
      state.nodes.push(node);
      return node;
    },
    async deleteNode({ ownerId, id }) {
      record("deleteNode", { ownerId, id });
      boom("deleteNode");
      state.nodes = state.nodes.filter((node) => node.id !== id);
    },

    async findCredentialForNode({ ownerId, connectorNodeId }) {
      record("findCredentialForNode", { ownerId, connectorNodeId });
      return state.credentials.find(
        (row) => row.owner_id === ownerId && row.connector_node_id === connectorNodeId && !row.revoked_at,
      ) ?? null;
    },
    async insertCredential({ ownerId, connectorNodeId, tokenHash, tokenPrefix }) {
      record("insertCredential", { ownerId, connectorNodeId, tokenHash, tokenPrefix });
      boom("insertCredential");
      const row = {
        id: `cred-${(sequence += 1)}`,
        owner_id: ownerId,
        connector_node_id: connectorNodeId,
        token_hash: tokenHash,
        token_prefix: tokenPrefix,
        revoked_at: null,
      };
      state.credentials.push(row);
      return row;
    },
    async deleteCredential({ ownerId, id }) {
      record("deleteCredential", { ownerId, id });
      boom("deleteCredential");
      state.credentials = state.credentials.filter((row) => row.id !== id);
    },
  };
}

function fakeKeychain({ items = [], fail = {} } = {}) {
  const store = new Map(items.map((item) => [`${item.service}/${item.account}`, item.secret ?? "existing"]));
  const calls = [];
  const key = (service, account) => `${service}/${account}`;

  return {
    calls,
    store,
    names: () => calls.map((call) => call.name),
    async addItem({ service, account, secret }) {
      calls.push({ name: "addItem", service, account });
      if (fail.addItem) throw new KeychainError("write failed", "KEYCHAIN_WRITE_FAILED");
      store.set(key(service, account), secret);
      return { skipped: false, service, account };
    },
    async hasItem({ service, account }) {
      calls.push({ name: "hasItem", service, account });
      return { skipped: false, present: store.has(key(service, account)) };
    },
    async deleteItem({ service, account }) {
      calls.push({ name: "deleteItem", service, account });
      if (fail.deleteItem) throw new KeychainError("delete failed", "KEYCHAIN_DELETE_FAILED");
      return { skipped: false, removed: store.delete(key(service, account)) };
    },
  };
}

/** A world in which every artifact already exists, for the idempotency case. */
function provisionedWorld() {
  const coordinates = keychainCoordinates({ ownerEmail: OWNER_EMAIL, nodeLabel: NODE_LABEL });
  const admin = fakeAdmin({
    users: [{ id: "user-1", email: OWNER_EMAIL }],
    nodes: [{ id: "node-1", owner_id: "user-1", label: NODE_LABEL, status: "online" }],
    credentials: [{
      id: "cred-1",
      owner_id: "user-1",
      connector_node_id: "node-1",
      token_hash: hashConnectorToken(TOKEN),
      token_prefix: "bibi…",
      revoked_at: null,
    }],
  });
  const keychain = fakeKeychain({
    items: [
      { ...coordinates.token, secret: TOKEN },
      { ...coordinates.password, secret: PASSWORD },
    ],
  });
  return { admin, keychain };
}

const provision = (overrides = {}) => provisionConnector({
  ownerEmail: OWNER_EMAIL,
  nodeLabel: NODE_LABEL,
  password: PASSWORD,
  generateToken: () => TOKEN,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test("the owner email and node label are validated before anything is contacted", () => {
  assert.equal(normaliseOwnerEmail("  Owner@Example.COM "), OWNER_EMAIL);
  assert.equal(normaliseNodeLabel("local-mac"), "local-mac");

  for (const bad of ["", "owner", "owner@example", "own er@example.com", "a@b@c.com"]) {
    assert.throws(
      () => normaliseOwnerEmail(bad),
      (error) => error instanceof ProvisioningError && /EMAIL/.test(error.code),
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }

  // The label becomes a Keychain account, a database value and a plist string,
  // so it is constrained rather than escaped three different ways.
  for (const bad of ["", "a", "-leading", "Local-Mac", "local mac", "local/mac", "x".repeat(65)]) {
    assert.throws(
      () => normaliseNodeLabel(bad),
      (error) => error instanceof ProvisioningError && /NODE_LABEL/.test(error.code),
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

test("a generated token is base64url, prefixed and hashed with the API's own function", () => {
  const bytes = Buffer.alloc(32, 7);
  const token = generateConnectorToken(() => bytes);
  assert.equal(token, `bibi_${bytes.toString("base64url")}`);
  assert.match(token, /^bibi_[A-Za-z0-9_-]+$/);

  // The hash the connector API will compare against, not a second implementation.
  assert.equal(hashConnectorToken(token).length, 64);
  assert.notEqual(hashConnectorToken(token), hashConnectorToken(`${token}x`));
});

// ---------------------------------------------------------------------------
// The three-way decision
// ---------------------------------------------------------------------------

test("state is classified as provision, already-provisioned or refuse and nothing else", () => {
  const absent = { present: false };
  const present = { present: true };
  const all = Object.fromEntries(PROVISION_ARTIFACTS.map((name) => [name, present]));
  const none = Object.fromEntries(PROVISION_ARTIFACTS.map((name) => [name, absent]));

  assert.equal(classifyProvisioningState(all).decision, "already-provisioned");
  assert.equal(classifyProvisioningState(none).decision, "provision");

  // Every partial state refuses, including the one that used to have an escape
  // hatch. An existing Auth user is not evidence that the supplied password is
  // that account's password, and nothing here can turn it into evidence.
  for (const partial of PROVISION_ARTIFACTS) {
    const state = { ...none, [partial]: present };
    assert.equal(classifyProvisioningState(state).decision, "refuse", `${partial} alone must refuse`);
  }

  const ownerOnly = { ...none, authUser: present };
  assert.equal(classifyProvisioningState(ownerOnly, { allowExistingOwner: true }).decision, "refuse");
  assert.equal("adoptOwner" in classifyProvisioningState(ownerOnly), false, "there is no adoption outcome left");

  const ownerAndNode = { ...none, authUser: present, connectorNode: present };
  assert.equal(classifyProvisioningState(ownerAndNode, { allowExistingOwner: true }).decision, "refuse");
});

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

test("a clean provision creates all five artifacts and stores only the hash in the database", async () => {
  const admin = fakeAdmin();
  const keychain = fakeKeychain();
  const guard = createSecretGuard();

  const report = await provision({ admin, keychain, guard });

  assert.equal(report.status, "provisioned");
  assert.deepEqual(report.steps.map((step) => step.name), PROVISION_ARTIFACTS);
  assert.deepEqual(report.present, PROVISION_ARTIFACTS);

  // The database holds a hash and a prefix. It never holds the token.
  const [credential] = admin.state.credentials;
  assert.equal(credential.token_hash, hashConnectorToken(TOKEN));
  assert.equal(credential.token_prefix, "bibi…");
  assert.equal(JSON.stringify(admin.state.credentials).includes(TOKEN), false);
  assert.equal(JSON.stringify(admin.state.nodes).includes(TOKEN), false);

  // The Keychain holds the plaintext of both secrets, under the documented names.
  const coordinates = keychainCoordinates({ ownerEmail: OWNER_EMAIL, nodeLabel: NODE_LABEL });
  assert.equal(coordinates.token.service, KEYCHAIN_SERVICES.connectorToken);
  assert.equal(coordinates.token.account, NODE_LABEL);
  assert.equal(coordinates.password.service, KEYCHAIN_SERVICES.ownerLogin);
  assert.equal(coordinates.password.account, OWNER_EMAIL);
  assert.equal(keychain.store.get(`${coordinates.token.service}/${coordinates.token.account}`), TOKEN);
  assert.equal(keychain.store.get(`${coordinates.password.service}/${coordinates.password.account}`), PASSWORD);

  // The Auth user is created with the password; nothing else ever sees it.
  assert.equal(admin.state.users[0].password, PASSWORD);
});

test("the readback reports identifiers, status, prefix and fingerprints and no secret", async () => {
  const { admin, keychain } = provisionedWorld();
  const report = await readbackProvisioning({ admin, keychain, ownerEmail: OWNER_EMAIL, nodeLabel: NODE_LABEL });
  const serialised = JSON.stringify(report);

  assert.equal(report.status, "complete");
  assert.equal(report.ownerId, "user-1");
  assert.equal(report.connectorNodeId, "node-1");
  assert.equal(report.connectorCredentialId, "cred-1");
  assert.equal(report.nodeStatus, "online");
  assert.equal(report.tokenPrefix, "bibi…");
  assert.equal(report.tokenHashFingerprint, fingerprint(hashConnectorToken(TOKEN)));

  assert.equal(serialised.includes(TOKEN), false);
  assert.equal(serialised.includes(PASSWORD), false);
  // Not even the stored hash is echoed: it is enough to check a guessed token
  // against offline. Only a fingerprint of it leaves this process.
  assert.equal(serialised.includes(hashConnectorToken(TOKEN)), false);
});

test("a fully provisioned account is a no-op, not a second credential", async () => {
  const { admin, keychain } = provisionedWorld();
  const report = await provision({ admin, keychain, guard: createSecretGuard() });

  assert.equal(report.status, "already-provisioned");
  assert.equal(admin.state.credentials.length, 1);
  assert.equal(admin.state.nodes.length, 1);
  assert.equal(admin.state.users.length, 1);
  assert.equal(admin.names().includes("insertCredential"), false);
  assert.equal(admin.names().includes("createUser"), false);
  assert.equal(keychain.names().includes("addItem"), false);
});

test("a partially provisioned account is refused with the facts, and nothing is written", async () => {
  const coordinates = keychainCoordinates({ ownerEmail: OWNER_EMAIL, nodeLabel: NODE_LABEL });
  const admin = fakeAdmin({
    users: [{ id: "user-1", email: OWNER_EMAIL }],
    nodes: [{ id: "node-1", owner_id: "user-1", label: NODE_LABEL, status: "unknown" }],
  });
  const keychain = fakeKeychain({ items: [{ ...coordinates.token, secret: TOKEN }] });

  await assert.rejects(
    provision({ admin, keychain, guard: createSecretGuard() }),
    (error) => {
      assert.ok(error instanceof ProvisioningError);
      assert.equal(error.code, "PARTIAL_STATE");
      assert.deepEqual(error.detail.present, ["authUser", "connectorNode", "keychainToken"]);
      assert.deepEqual(error.detail.missing, ["connectorCredential", "keychainPassword"]);
      assert.equal(error.detail.state.status, "refused");
      return true;
    },
  );

  assert.equal(admin.names().includes("insertNode"), false);
  assert.equal(admin.names().includes("insertCredential"), false);
  assert.equal(keychain.names().includes("addItem"), false);
});

test("an owner that already exists is refused, and its password is never assumed or stored", async () => {
  const admin = fakeAdmin({ users: [{ id: "user-1", email: OWNER_EMAIL }] });
  const keychain = fakeKeychain();

  await assert.rejects(
    provision({ admin, keychain, guard: createSecretGuard() }),
    (error) => {
      assert.equal(error.code, "PARTIAL_STATE");
      assert.deepEqual(error.detail.present, ["authUser"]);
      assert.deepEqual(error.detail.missing, [
        "connectorNode", "connectorCredential", "keychainToken", "keychainPassword",
      ]);
      return true;
    },
  );

  // The supplied password was never verified against that account, so nothing
  // may act as though it were: no Keychain item, no node, no credential.
  assert.equal(keychain.store.size, 0);
  assert.equal(keychain.names().includes("addItem"), false);
  assert.equal(admin.names().includes("insertNode"), false);
  assert.equal(admin.names().includes("insertCredential"), false);
  assert.equal(admin.names().includes("deleteUser"), false, "an account we did not create is not ours to delete");
});

test("there is no option that turns the existing-owner refusal into a provision", async () => {
  const admin = fakeAdmin({ users: [{ id: "user-1", email: OWNER_EMAIL }] });
  const keychain = fakeKeychain();

  // The removed flag is passed anyway. It has to be inert rather than merely
  // undocumented: a stale runbook or shell history would otherwise still carry
  // an unverified password into the Keychain.
  await assert.rejects(
    provision({ admin, keychain, guard: createSecretGuard(), allowExistingOwner: true }),
    (error) => error.code === "PARTIAL_STATE",
  );
  assert.equal(keychain.store.size, 0);
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

test("a failure part-way through is rolled back in reverse creation order", async () => {
  const admin = fakeAdmin({ fail: { insertCredential: true } });
  const keychain = fakeKeychain();

  await assert.rejects(
    provision({ admin, keychain, guard: createSecretGuard() }),
    (error) => {
      assert.equal(error.code, "PROVISION_FAILED_ROLLED_BACK");
      assert.equal(error.detail.rollback.clean, true);
      assert.deepEqual(error.detail.rollback.steps.map((step) => step.name), ["connectorNode", "authUser"]);
      return true;
    },
  );

  // The account is exactly as it was found.
  assert.deepEqual(admin.state.users, []);
  assert.deepEqual(admin.state.nodes, []);
  assert.deepEqual(admin.state.credentials, []);
  assert.equal(keychain.store.size, 0);
});

test("a Keychain failure rolls the database rows back too", async () => {
  const admin = fakeAdmin();
  const keychain = fakeKeychain({ fail: { addItem: true } });

  await assert.rejects(
    provision({ admin, keychain, guard: createSecretGuard() }),
    (error) => error.code === "PROVISION_FAILED_ROLLED_BACK",
  );

  assert.deepEqual(admin.state.credentials, []);
  assert.deepEqual(admin.state.nodes, []);
  assert.deepEqual(admin.state.users, []);
});

test("a rollback that cannot finish is reported as needing attention, not as a clean failure", async () => {
  const admin = fakeAdmin({ fail: { insertCredential: true, deleteUser: true } });
  const keychain = fakeKeychain();

  await assert.rejects(
    provision({ admin, keychain, guard: createSecretGuard() }),
    (error) => {
      assert.equal(error.code, "PROVISION_FAILED_ROLLBACK_INCOMPLETE");
      assert.equal(error.detail.rollback.clean, false);
      assert.deepEqual(
        error.detail.rollback.steps,
        [{ name: "connectorNode", outcome: "undone" }, { name: "authUser", outcome: "failed" }],
      );
      return true;
    },
  );

  // The stranded artifact is still there, which is why the operator is told.
  assert.equal(admin.state.users.length, 1);
});

test("a readback that disagrees with what was just written fails rather than reporting success", async () => {
  const admin = fakeAdmin();
  const keychain = fakeKeychain();
  // Accepts the write and forgets it: the shape of a Keychain that is locked.
  keychain.addItem = async ({ service, account }) => {
    keychain.calls.push({ name: "addItem", service, account });
    return { skipped: false };
  };

  await assert.rejects(
    provision({ admin, keychain, guard: createSecretGuard() }),
    (error) => error.code === "PROVISION_FAILED_ROLLED_BACK",
  );
  assert.deepEqual(admin.state.credentials, []);
});

// ---------------------------------------------------------------------------
// Keychain command construction
// ---------------------------------------------------------------------------

test("Keychain commands are argv arrays, never shell strings, and the secret is last", () => {
  const command = buildAddItemCommand({ service: "svc", account: "acct", secret: TOKEN, comment: "note" });

  assert.equal(command.file, SECURITY_BIN);
  assert.equal(command.args[0], "add-generic-password");
  assert.deepEqual(command.args.slice(1, 5), ["-s", "svc", "-a", "acct"]);
  assert.ok(command.args.includes("-U"), "must update in place so a re-run converges");
  assert.deepEqual([command.args.at(-2), command.args.at(-1)], ["-w", TOKEN]);
  assert.equal(command.args[command.secretArgIndex], TOKEN);

  assert.deepEqual(buildFindItemCommand({ service: "svc", account: "acct" }).args, [
    "find-generic-password", "-s", "svc", "-a", "acct",
  ]);
  assert.deepEqual(buildFindItemCommand({ service: "svc", account: "acct", withSecret: true }).args.at(-1), "-w");
  assert.deepEqual(buildDeleteItemCommand({ service: "svc", account: "acct" }).args, [
    "delete-generic-password", "-s", "svc", "-a", "acct",
  ]);
});

test("the only printable form of a Keychain command has the secret blanked", () => {
  const command = buildAddItemCommand({ service: "svc", account: "acct", secret: TOKEN });
  const described = describeCommand(command);

  assert.equal(described.includes(TOKEN), false);
  assert.match(described, /-w \[redacted\]$/);
  assert.match(described, /^\/usr\/bin\/security add-generic-password/);

  // A read command has no secret argument, so nothing is blanked by accident.
  assert.equal(describeCommand(buildFindItemCommand({ service: "svc", account: "acct" })).includes("[redacted]"), false);
});

// ---------------------------------------------------------------------------
// Keychain access control
// ---------------------------------------------------------------------------

test("the connector token trusts exactly /usr/bin/security, and nothing else", () => {
  const command = buildAddItemCommand({
    service: KEYCHAIN_SERVICES.connectorToken,
    account: "local-mac",
    secret: TOKEN,
  });

  const trusted = command.args.filter((value, index) => command.args[index - 1] === "-T");
  assert.deepEqual(trusted, [SECURITY_BIN], "one grant, to the executable the wrapper actually runs");
  assert.deepEqual(command.trustedApplications, [SECURITY_BIN]);

  // The wrapper reads this item with no session and no window server. An item
  // written with the closed grant prompts instead of failing, and the read
  // blocks until it times out rather than returning.
  assert.equal(command.args.includes(""), false, "the closed grant must not be written for the token");
});

test("the owner login password pre-trusts nothing, because nothing automated reads it", () => {
  const command = buildAddItemCommand({
    service: KEYCHAIN_SERVICES.ownerLogin,
    account: OWNER_EMAIL,
    secret: PASSWORD,
  });

  const separator = command.args.indexOf("-T");
  assert.notEqual(separator, -1, "the ACL is always stated, never left to the default");
  assert.equal(command.args[separator + 1], "");
  assert.deepEqual(command.trustedApplications, []);
});

test("no Keychain item is ever written with the -A blanket grant", () => {
  for (const service of Object.values(KEYCHAIN_SERVICES)) {
    const command = buildAddItemCommand({ service, account: "acct", secret: TOKEN });
    assert.equal(command.args.includes("-A"), false, `${service} must not be world-readable`);
    assert.equal(describeCommand(command).includes(" -A"), false);
  }
  // Not reachable through the option either: a caller cannot smuggle it in as a
  // trusted application, because that value has to be an absolute path.
  assert.throws(
    () => buildAddItemCommand({ service: "svc", account: "acct", secret: TOKEN, trustedApplications: ["-A"] }),
    (error) => error instanceof KeychainError && error.code === "TRUSTED_APPLICATION_NOT_ABSOLUTE",
  );
});

test("the access control list is chosen by service, so a new item defaults to closed", () => {
  assert.deepEqual(trustedApplicationsFor(KEYCHAIN_SERVICES.connectorToken), [SECURITY_BIN]);
  assert.deepEqual(trustedApplicationsFor(KEYCHAIN_SERVICES.ownerLogin), []);
  assert.deepEqual(trustedApplicationsFor("com.bibi.workspace.something-new"), []);

  // The returned list is a copy: mutating it must not widen the policy for
  // every later item written in the same process.
  const first = trustedApplicationsFor(KEYCHAIN_SERVICES.connectorToken);
  first.push("/bin/sh");
  assert.deepEqual(trustedApplicationsFor(KEYCHAIN_SERVICES.connectorToken), [SECURITY_BIN]);
});

test("a trusted application that is relative, empty or control-bearing is refused", () => {
  for (const [application, code] of [
    ["security", "TRUSTED_APPLICATION_NOT_ABSOLUTE"],
    ["../../bin/sh", "TRUSTED_APPLICATION_NOT_ABSOLUTE"],
    ["", "MISSING_TRUSTED_APPLICATION"],
    ["/usr/bin/sec\nurity", "TRUSTED_APPLICATION_CONTROL_CHARACTER"],
  ]) {
    assert.throws(
      () => buildAddItemCommand({ service: "svc", account: "acct", secret: TOKEN, trustedApplications: [application] }),
      (error) => error instanceof KeychainError && error.code === code,
      `expected ${JSON.stringify(application)} to be refused as ${code}`,
    );
  }
});

test("provisioning writes each item under its own service policy, not one shared grant", async () => {
  const coordinates = keychainCoordinates({ ownerEmail: OWNER_EMAIL, nodeLabel: NODE_LABEL });

  const tokenCommand = buildAddItemCommand({ ...coordinates.token, secret: TOKEN });
  const passwordCommand = buildAddItemCommand({ ...coordinates.password, secret: PASSWORD });

  assert.deepEqual(tokenCommand.trustedApplications, [SECURITY_BIN]);
  assert.deepEqual(passwordCommand.trustedApplications, []);
});

test("an attribute that could be read as an option, or that carries a control character, is refused", () => {
  for (const account of ["-oops", "", "   ", "a".repeat(256), "line\nbreak"]) {
    assert.throws(
      () => buildAddItemCommand({ service: "svc", account, secret: TOKEN }),
      (error) => error instanceof KeychainError,
      `expected ${JSON.stringify(account)} to be refused`,
    );
  }
  assert.throws(
    () => buildAddItemCommand({ service: "svc", account: "acct", secret: "" }),
    (error) => error.code === "MISSING_SECRET",
  );
  assert.throws(
    () => buildAddItemCommand({ service: "svc", account: "acct", secret: "tok\nen" }),
    (error) => error.code === "SECRET_CONTROL_CHARACTER",
  );
});

test("a dry-run Keychain executes nothing at all, not even a read", async () => {
  const calls = [];
  const keychain = createKeychain({ dryRun: true, exec: (command) => { calls.push(command); return { stdout: "" }; } });

  const added = await keychain.addItem({ service: "svc", account: "acct", secret: TOKEN });
  const found = await keychain.hasItem({ service: "svc", account: "acct" });
  const removed = await keychain.deleteItem({ service: "svc", account: "acct" });

  assert.deepEqual(calls, []);
  assert.equal(added.skipped, true);
  // Unknown rather than false: a dry run must not claim to know what is stored.
  assert.equal(found.present, null);
  assert.equal(removed.removed, null);
  assert.equal(added.command.includes(TOKEN), false);
});

test("security exit 44 is 'not there', and any other failure is an error", async () => {
  const missing = createKeychain({
    exec: () => { const error = new Error("not found"); error.code = 44; throw error; },
  });
  assert.equal((await missing.hasItem({ service: "svc", account: "acct" })).present, false);
  assert.equal((await missing.deleteItem({ service: "svc", account: "acct" })).removed, false);

  const locked = createKeychain({
    exec: () => { const error = new Error("user interaction not allowed"); error.code = 51; throw error; },
  });
  await assert.rejects(locked.hasItem({ service: "svc", account: "acct" }), (error) => error.code === "KEYCHAIN_READ_FAILED");
  await assert.rejects(
    locked.addItem({ service: "svc", account: "acct", secret: TOKEN }),
    (error) => error.code === "KEYCHAIN_WRITE_FAILED" && !error.message.includes(TOKEN),
  );
});

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

test("the secret guard removes registered values from anything written", () => {
  const guard = createSecretGuard();
  guard.register(TOKEN);
  guard.register(PASSWORD);
  guard.register(SERVICE_KEY);

  const lines = [];
  const writer = createSafeWriter({ guard, write: (line) => lines.push(line) });

  writer.line(`token=${TOKEN} password=${PASSWORD}`);
  writer.report({ note: `service ${SERVICE_KEY}`, nested: { deep: [TOKEN] } });

  const output = lines.join("");
  for (const secret of [TOKEN, PASSWORD, SERVICE_KEY]) {
    assert.equal(output.includes(secret), false, "a registered secret must not reach the stream");
  }
  assert.match(output, /\[redacted\]/);
});

test("a value too short to be distinctive is not registered, so a report stays readable", () => {
  const guard = createSecretGuard();
  guard.register("abc");
  assert.equal(guard.size, 0);
  assert.equal(guard.scrub("status: abc"), "status: abc");
});

test("an artifact is emitted verbatim, because redacting it would rewrite working code", () => {
  const guard = createSecretGuard();
  guard.register(TOKEN);
  const lines = [];
  const writer = createSafeWriter({ guard, write: (line) => lines.push(line) });

  // The wrapper script legitimately contains this assignment. Shape-based
  // redaction would turn it into something that does not run.
  const wrapper = 'BIBI_CONNECTOR_TOKEN="$(/usr/bin/security find-generic-password -w)"';
  assert.equal(writer.artifact(wrapper), true);
  assert.equal(lines.join(""), `${wrapper}\n`);

  // A real secret in an artifact is a defect, and is caught rather than emitted.
  assert.equal(writer.artifact(`X=${TOKEN}`), false);
  assert.equal(lines.join("").includes(TOKEN), false);
});

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

test("a secret can never be passed as an argument", () => {
  for (const option of ["--password", "--service-role-key", "--token"]) {
    assert.throws(
      () => parseArguments([option, "value"]),
      (error) => error.name === "UsageError",
      `${option} must be refused outright`,
    );
  }
  assert.throws(() => parseArguments(["--nope"]), (error) => error.name === "UsageError");
  assert.throws(() => parseArguments(["--owner-email"]), (error) => error.name === "UsageError");

  const parsed = parseArguments(["provision", "--owner-email=a@b.com", "--node-label", "local-mac", "--dry-run"]);
  assert.equal(parsed.command, "provision");
  assert.equal(parsed.options["owner-email"], "a@b.com");
  assert.equal(parsed.options["dry-run"], true);
});

test("the password is read from an inherited descriptor, with one trailing newline stripped", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bibi-ops-"));
  const file = path.join(directory, "password");
  writeFileSync(file, `${PASSWORD}\n`, "utf8");
  const descriptor = openSync(file, "r");

  try {
    assert.equal(readSecretFromDescriptor(descriptor), PASSWORD);
  } finally {
    try { closeSync(descriptor); } catch { /* already consumed */ }
    rmSync(directory, { recursive: true, force: true });
  }

  assert.throws(() => readSecretFromDescriptor(0, { isTTY: true }), (error) => error.name === "UsageError");
  assert.throws(() => readSecretFromDescriptor("x"), (error) => error.name === "UsageError");
});

test("the CLI provisions through injected doubles and prints no secret", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bibi-ops-"));
  const file = path.join(directory, "password");
  writeFileSync(file, `${PASSWORD}\n`, "utf8");
  const descriptor = openSync(file, "r");

  const admin = fakeAdmin();
  const keychain = fakeKeychain();
  const out = [];
  const errors = [];

  try {
    const code = await runOps({
      argv: ["provision", "--owner-email", OWNER_EMAIL, "--node-label", NODE_LABEL, "--password-fd", String(descriptor), "--json"],
      env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY },
      write: (line) => out.push(line),
      writeError: (line) => errors.push(line),
      createAdmin: async (_env, guard) => { guard.register(SERVICE_KEY); return admin; },
      makeKeychain: () => keychain,
    });

    assert.equal(code, EXIT.OK, errors.join(""));
  } finally {
    try { closeSync(descriptor); } catch { /* already consumed */ }
    rmSync(directory, { recursive: true, force: true });
  }

  const output = out.join("");
  const report = JSON.parse(output);
  assert.equal(report.status, "provisioned");
  assert.equal(report.tokenPrefix.length > 0, true);
  assert.match(report.tokenHashFingerprint, /^sha256:[0-9a-f]{16}$/);

  for (const secret of [PASSWORD, SERVICE_KEY]) {
    assert.equal(output.includes(secret), false);
  }
  assert.equal(output.includes(admin.state.credentials[0].token_hash), false);
  assert.equal(output.includes([...keychain.store.values()][0]), false);
});

test("a password that fails the workspace policy is refused before any account is created", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bibi-ops-"));
  const file = path.join(directory, "password");
  writeFileSync(file, "short\n", "utf8");
  const descriptor = openSync(file, "r");

  const admin = fakeAdmin();
  const errors = [];

  try {
    const code = await runOps({
      argv: ["provision", "--owner-email", OWNER_EMAIL, "--node-label", NODE_LABEL, "--password-fd", String(descriptor)],
      env: {},
      write: () => {},
      writeError: (line) => errors.push(line),
      createAdmin: async () => admin,
      makeKeychain: () => fakeKeychain(),
    });
    assert.equal(code, EXIT.USAGE);
  } finally {
    try { closeSync(descriptor); } catch { /* already consumed */ }
    rmSync(directory, { recursive: true, force: true });
  }

  assert.match(errors.join(""), /PASSWORD_TOO_SHORT/);
  assert.deepEqual(admin.calls, []);
});

test("a refused partial state exits 3 and a stranded rollback exits 5", async () => {
  const coordinates = keychainCoordinates({ ownerEmail: OWNER_EMAIL, nodeLabel: NODE_LABEL });
  const directory = mkdtempSync(path.join(os.tmpdir(), "bibi-ops-"));
  const file = path.join(directory, "password");
  writeFileSync(file, PASSWORD, "utf8");

  const run = async (admin, keychain) => {
    const descriptor = openSync(file, "r");
    try {
      return await runOps({
        argv: ["provision", "--owner-email", OWNER_EMAIL, "--node-label", NODE_LABEL, "--password-fd", String(descriptor), "--json"],
        env: {},
        write: () => {},
        writeError: () => {},
        createAdmin: async () => admin,
        makeKeychain: () => keychain,
      });
    } finally {
      try { closeSync(descriptor); } catch { /* already consumed */ }
    }
  };

  try {
    const refused = await run(
      fakeAdmin({ users: [{ id: "user-1", email: OWNER_EMAIL }] }),
      fakeKeychain({ items: [{ ...coordinates.token, secret: TOKEN }] }),
    );
    assert.equal(refused, EXIT.REFUSED);

    const stranded = await run(fakeAdmin({ fail: { insertNode: true, deleteUser: true } }), fakeKeychain());
    assert.equal(stranded, EXIT.NEEDS_ATTENTION);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

test("a dry-run provision touches no Keychain, no Supabase and no descriptor", async () => {
  const out = [];
  const code = await runOps({
    argv: ["provision", "--owner-email", OWNER_EMAIL, "--node-label", NODE_LABEL, "--dry-run", "--json"],
    env: {},
    write: (line) => out.push(line),
    writeError: (line) => out.push(line),
    // Reaching either of these is the failure the test is looking for.
    createAdmin: () => { throw new Error("dry run must not build a Supabase client"); },
    makeKeychain: () => { throw new Error("dry run must not build a Keychain client"); },
  });

  assert.equal(code, EXIT.OK);
  const report = JSON.parse(out.join(""));
  assert.equal(report.status, "dry-run");
  assert.deepEqual(report.touched, []);
  assert.deepEqual(report.wouldCreate, PROVISION_ARTIFACTS);
  assert.equal(report.keychain.token.service, KEYCHAIN_SERVICES.connectorToken);
  // The environment is described, never echoed.
  assert.equal(report.serviceRoleKey, "absent");
});

test("a dry-run readback is equally inert, and both still validate their inputs", async () => {
  const out = [];
  assert.equal(
    await runOps({
      argv: ["readback", "--owner-email", OWNER_EMAIL, "--node-label", NODE_LABEL, "--dry-run", "--json"],
      env: {},
      write: (line) => out.push(line),
      writeError: (line) => out.push(line),
      createAdmin: () => { throw new Error("dry run must not build a Supabase client"); },
      makeKeychain: () => { throw new Error("dry run must not build a Keychain client"); },
    }),
    EXIT.OK,
  );
  assert.equal(JSON.parse(out.join("")).status, "dry-run");

  // Validation still runs: a dry run is a rehearsal, not a bypass.
  const errors = [];
  assert.equal(
    await runOps({
      argv: ["readback", "--owner-email", "not-an-email", "--node-label", NODE_LABEL, "--dry-run"],
      env: {},
      write: () => {},
      writeError: (line) => errors.push(line),
      createAdmin: () => { throw new Error("unreachable"); },
    }),
    EXIT.FAILED,
  );
  assert.match(errors.join(""), /이메일/);
});

test("inspecting state never asks the Keychain for a secret", async () => {
  const { admin, keychain } = provisionedWorld();
  const reads = [];
  const spy = {
    ...keychain,
    async hasItem(coordinates) {
      reads.push(coordinates);
      return keychain.hasItem(coordinates);
    },
  };

  await inspectProvisioningState({ admin, keychain: spy, ownerEmail: OWNER_EMAIL, nodeLabel: NODE_LABEL });

  assert.equal(reads.length, 2);
  for (const coordinates of reads) {
    assert.equal("withSecret" in coordinates, false);
  }
  // `hasItem` is the only Keychain read on this path; there is no read-secret
  // method on the interface provisioning uses at all.
  assert.equal(typeof keychain.readSecret, "undefined");
});
