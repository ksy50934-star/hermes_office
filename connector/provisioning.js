/**
 * Permanent provisioning of the owner account and the connector credential.
 *
 * This is the one step the repository deliberately left open: the code, the
 * schema, the deployment and a real end-to-end run all exist, but there is no
 * permanent Auth user and there are no `connector_nodes` / `connector_credentials`
 * rows, because those are created against the owner's real login email. This
 * module is that step, written so it can be reviewed before it is ever run.
 *
 * Five artifacts have to end up consistent with each other:
 *
 *   authUser            Supabase Auth user for the owner
 *   connectorNode       `connector_nodes` row, one per Mac
 *   connectorCredential `connector_credentials` row holding only a SHA-256 hash
 *   keychainToken       the token plaintext, in the login keychain
 *   keychainPassword    the login password, in the login keychain
 *
 * Three outcomes are possible and there is no fourth:
 *
 *   all five absent   provision, with rollback if any step fails
 *   all five present  report and change nothing (idempotent re-run)
 *   anything else     refuse, naming exactly what exists
 *
 * The refusal is the important one. A half-provisioned state is not something
 * to repair by guessing — a `connector_nodes` row with no credential and a
 * Keychain item with no row look identical from here, and picking wrong either
 * strands a credential the owner cannot revoke or overwrites one that is in
 * use. So the tool stops and hands the operator the facts instead. An Auth user
 * that already exists is one of those partial states and gets the same refusal;
 * see `classifyProvisioningState` for why there is no flag that overrides it.
 *
 * Nothing in this module returns a secret. The token exists in memory for the
 * duration of one call, goes into the Keychain and into a SHA-256 hash, and is
 * registered with the secret guard on the line that creates it.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";

import { connectorTokenPrefix, hashConnectorToken } from "../api/_lib/connectorAuth.js";
import { KEYCHAIN_SERVICES } from "./keychain.js";
import { fingerprint } from "./secretGuard.js";

export class ProvisioningError extends Error {
  constructor(message, code, detail = {}) {
    super(message);
    this.name = "ProvisioningError";
    this.code = code;
    this.detail = detail;
  }
}

/** In dependency order: each artifact is created after the one before it. */
export const PROVISION_ARTIFACTS = Object.freeze([
  "authUser",
  "connectorNode",
  "connectorCredential",
  "keychainToken",
  "keychainPassword",
]);

/**
 * A node label becomes a Keychain account, a database value and a string inside
 * a rendered plist. Constraining it to this charset is what lets every one of
 * those uses be safe by construction rather than by escaping.
 */
const NODE_LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/**
 * Deliberately not a full RFC 5322 grammar. This rejects the mistakes an
 * operator actually makes — a stray space, a missing dot, a copied display
 * name — and leaves the authoritative judgement to Supabase.
 */
const OWNER_EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** `bibi_` marks the token's origin; 32 bytes is the entropy. */
export const CONNECTOR_TOKEN_PREFIX = "bibi_";
const CONNECTOR_TOKEN_BYTES = 32;

export function normaliseOwnerEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) {
    throw new ProvisioningError("소유자 이메일(--owner-email)이 필요합니다.", "MISSING_OWNER_EMAIL");
  }
  if (email.length > 254 || !OWNER_EMAIL_PATTERN.test(email)) {
    throw new ProvisioningError(`소유자 이메일 형식이 올바르지 않습니다: ${email}`, "INVALID_OWNER_EMAIL");
  }
  return email;
}

export function normaliseNodeLabel(value) {
  const label = String(value ?? "").trim();
  if (!label) {
    throw new ProvisioningError("노드 라벨(--node-label)이 필요합니다.", "MISSING_NODE_LABEL");
  }
  if (!NODE_LABEL_PATTERN.test(label)) {
    throw new ProvisioningError(
      `노드 라벨은 소문자·숫자·'.'·'_'·'-'만 쓸 수 있고 2~64자여야 합니다: ${label}`,
      "INVALID_NODE_LABEL",
    );
  }
  return label;
}

/**
 * base64url so the token survives a shell, a plist and an HTTP header without
 * any encoding step that could silently change it.
 */
export function generateConnectorToken(randomBytes = nodeRandomBytes) {
  return `${CONNECTOR_TOKEN_PREFIX}${randomBytes(CONNECTOR_TOKEN_BYTES).toString("base64url")}`;
}

export function keychainCoordinates({ ownerEmail, nodeLabel }) {
  return {
    token: { service: KEYCHAIN_SERVICES.connectorToken, account: nodeLabel },
    password: { service: KEYCHAIN_SERVICES.ownerLogin, account: ownerEmail },
  };
}

// ---------------------------------------------------------------------------
// Supabase admin adapter
// ---------------------------------------------------------------------------

/** Enough pages to find one owner; a cap so a bad response cannot spin. */
const USER_PAGE_SIZE = 200;
const MAX_USER_PAGES = 20;

/**
 * The narrow surface provisioning is allowed to use, so the tests can supply a
 * deterministic double instead of a Supabase client. Everything here is scoped
 * by owner even though the service role bypasses row level security, for the
 * same reason `api/_lib/store.js` does it: on the server there is no policy
 * left to catch a mistake.
 */
export function createSupabaseAdmin(client) {
  function unwrap(result, context) {
    if (result?.error) throw new ProvisioningError(`${context}: ${result.error.message}`, "SUPABASE_ERROR");
    return result?.data ?? null;
  }

  return {
    async findUserByEmail(email) {
      for (let page = 1; page <= MAX_USER_PAGES; page += 1) {
        const data = unwrap(
          await client.auth.admin.listUsers({ page, perPage: USER_PAGE_SIZE }),
          "listUsers",
        );
        const users = data?.users ?? [];
        const match = users.find((user) => String(user?.email ?? "").toLowerCase() === email);
        if (match) return { id: match.id, email };
        if (users.length < USER_PAGE_SIZE) return null;
      }
      throw new ProvisioningError(
        "Auth 사용자 목록이 너무 많아 소유자를 확정할 수 없습니다.",
        "USER_LOOKUP_EXHAUSTED",
      );
    },

    async createUser({ email, password }) {
      // Confirmed on creation: there is no registration path in the app, so an
      // unconfirmed owner would be an account nobody can finish creating.
      const data = unwrap(
        await client.auth.admin.createUser({ email, password, email_confirm: true }),
        "createUser",
      );
      const id = data?.user?.id;
      if (!id) throw new ProvisioningError("Auth 사용자를 생성했지만 id를 받지 못했습니다.", "CREATE_USER_NO_ID");
      return { id, email };
    },

    async deleteUser(id) {
      unwrap(await client.auth.admin.deleteUser(id), "deleteUser");
    },

    async findNodeByLabel({ ownerId, label }) {
      const data = unwrap(
        await client
          .from("connector_nodes")
          .select("id, label, status, connector_mode, last_heartbeat_at")
          .eq("owner_id", ownerId)
          .eq("label", label)
          .maybeSingle(),
        "findNodeByLabel",
      );
      return data ?? null;
    },

    async insertNode({ ownerId, label }) {
      const data = unwrap(
        await client
          .from("connector_nodes")
          .insert({ owner_id: ownerId, label, platform: "macos", connector_mode: "outbound-local-mac" })
          .select("id, label, status")
          .single(),
        "insertNode",
      );
      return data;
    },

    async deleteNode({ ownerId, id }) {
      unwrap(await client.from("connector_nodes").delete().eq("owner_id", ownerId).eq("id", id), "deleteNode");
    },

    async findCredentialForNode({ ownerId, connectorNodeId }) {
      const data = unwrap(
        await client
          .from("connector_credentials")
          .select("id, token_hash, token_prefix, revoked_at")
          .eq("owner_id", ownerId)
          .eq("connector_node_id", connectorNodeId)
          .is("revoked_at", null)
          .maybeSingle(),
        "findCredentialForNode",
      );
      return data ?? null;
    },

    async insertCredential({ ownerId, connectorNodeId, tokenHash, tokenPrefix }) {
      const data = unwrap(
        await client
          .from("connector_credentials")
          .insert({
            owner_id: ownerId,
            connector_node_id: connectorNodeId,
            token_hash: tokenHash,
            token_prefix: tokenPrefix,
          })
          .select("id, token_prefix")
          .single(),
        "insertCredential",
      );
      return data;
    },

    async deleteCredential({ ownerId, id }) {
      unwrap(
        await client.from("connector_credentials").delete().eq("owner_id", ownerId).eq("id", id),
        "deleteCredential",
      );
    },
  };
}

// ---------------------------------------------------------------------------
// State inspection and the three-way decision
// ---------------------------------------------------------------------------

/**
 * Read every artifact's existence without reading any secret. The Keychain is
 * asked only whether an item is there; `security find-generic-password` is
 * never given `-w` on this path.
 */
export async function inspectProvisioningState({ admin, keychain, ownerEmail, nodeLabel }) {
  const coordinates = keychainCoordinates({ ownerEmail, nodeLabel });

  const user = await admin.findUserByEmail(ownerEmail);
  const node = user ? await admin.findNodeByLabel({ ownerId: user.id, label: nodeLabel }) : null;
  const credential = user && node
    ? await admin.findCredentialForNode({ ownerId: user.id, connectorNodeId: node.id })
    : null;

  const tokenItem = await keychain.hasItem(coordinates.token);
  const passwordItem = await keychain.hasItem(coordinates.password);

  return {
    ownerEmail,
    nodeLabel,
    authUser: { present: Boolean(user), id: user?.id ?? null },
    connectorNode: { present: Boolean(node), id: node?.id ?? null, status: node?.status ?? null },
    connectorCredential: {
      present: Boolean(credential),
      id: credential?.id ?? null,
      tokenPrefix: credential?.token_prefix ?? null,
      tokenHashFingerprint: credential?.token_hash ? fingerprint(credential.token_hash) : null,
    },
    keychainToken: { present: tokenItem.present === true, ...coordinates.token },
    keychainPassword: { present: passwordItem.present === true, ...coordinates.password },
  };
}

export function presentArtifacts(state) {
  return PROVISION_ARTIFACTS.filter((name) => state?.[name]?.present === true);
}

/**
 * Three outcomes, no fourth, and no flag that adds one.
 *
 * An existing Auth user is a partial state like any other, and it is refused
 * like any other. There was a `--allow-existing-owner` escape hatch here and it
 * has been removed, because the only thing it could do with an account it did
 * not create was assume the supplied password was that account's password —
 * store it in the Keychain, bind a connector to the account, and report
 * success. Nothing in that sequence verifies the password. If it were wrong,
 * the owner would hold a Keychain item that never signs in, against an account
 * this tool has no way to distinguish from an attacker's.
 *
 * Verifying it is not a fix that belongs here either: a service-role tool
 * proving a password by signing in with it is a credential check written into
 * the provisioning path, and getting that wrong is worse than refusing. So the
 * refusal stands and names what exists, and adopting a dashboard-created
 * account is an operator decision made in the dashboard — by deleting it and
 * re-running, or by finishing it there.
 */
export function classifyProvisioningState(state) {
  const present = presentArtifacts(state);
  const missing = PROVISION_ARTIFACTS.filter((name) => !present.includes(name));

  if (missing.length === 0) return { decision: "already-provisioned", present, missing };
  if (present.length === 0) return { decision: "provision", present, missing };
  return { decision: "refuse", present, missing };
}

function safeReadback(state, { status, steps = [], rollback = null }) {
  return {
    status,
    ownerEmail: state.ownerEmail,
    nodeLabel: state.nodeLabel,
    ownerId: state.authUser.id,
    connectorNodeId: state.connectorNode.id,
    connectorCredentialId: state.connectorCredential.id,
    nodeStatus: state.connectorNode.status,
    tokenPrefix: state.connectorCredential.tokenPrefix,
    tokenHashFingerprint: state.connectorCredential.tokenHashFingerprint,
    keychain: {
      token: { ...state.keychainToken },
      password: { ...state.keychainPassword },
    },
    present: presentArtifacts(state),
    steps,
    ...(rollback ? { rollback } : {}),
  };
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

async function runRollback(undo) {
  const results = [];
  // Reverse order: the last thing created is the first thing removed, so a
  // foreign key never blocks its own cleanup.
  for (const step of [...undo].reverse()) {
    try {
      await step.run();
      results.push({ name: step.name, outcome: "undone" });
    } catch {
      // The message is dropped rather than surfaced: it can quote a value the
      // caller passed in. What matters here is which artifact is stranded.
      results.push({ name: step.name, outcome: "failed" });
    }
  }
  return { clean: results.every((entry) => entry.outcome === "undone"), steps: results };
}

/**
 * Create the five artifacts, or leave the account exactly as it was found.
 *
 * @param {object} options
 * @param {object} options.admin      from `createSupabaseAdmin`
 * @param {object} options.keychain   from `createKeychain`
 * @param {object} options.guard      from `createSecretGuard`
 * @param {string} options.ownerEmail explicit, non-secret input
 * @param {string} options.nodeLabel  explicit, non-secret input
 * @param {string} options.password   read from stdin or an inherited fd
 * @param {() => string} [options.generateToken]
 */
export async function provisionConnector({
  admin,
  keychain,
  guard,
  ownerEmail,
  nodeLabel,
  password,
  generateToken = generateConnectorToken,
}) {
  const email = normaliseOwnerEmail(ownerEmail);
  const label = normaliseNodeLabel(nodeLabel);
  if (typeof password !== "string" || !password) {
    throw new ProvisioningError("소유자 비밀번호를 읽지 못했습니다.", "MISSING_PASSWORD");
  }
  guard?.register(password);

  const before = await inspectProvisioningState({ admin, keychain, ownerEmail: email, nodeLabel: label });
  const verdict = classifyProvisioningState(before);

  if (verdict.decision === "already-provisioned") {
    return safeReadback(before, { status: "already-provisioned", steps: [] });
  }

  if (verdict.decision === "refuse") {
    throw new ProvisioningError(
      `이미 일부만 만들어져 있어 중단합니다. 존재: ${verdict.present.join(", ")} / 없음: ${verdict.missing.join(", ")}`,
      "PARTIAL_STATE",
      { state: safeReadback(before, { status: "refused", steps: [] }), present: verdict.present, missing: verdict.missing },
    );
  }

  const coordinates = keychainCoordinates({ ownerEmail: email, nodeLabel: label });
  const undo = [];
  const steps = [];

  try {
    // Nothing was present, so the owner is created here or not at all. There is
    // no branch that keeps an account this tool did not make.
    const user = await admin.createUser({ email, password });
    const ownerId = user.id;
    undo.push({ name: "authUser", run: () => admin.deleteUser(ownerId) });
    steps.push({ name: "authUser", outcome: "created" });

    const node = await admin.insertNode({ ownerId, label });
    undo.push({ name: "connectorNode", run: () => admin.deleteNode({ ownerId, id: node.id }) });
    steps.push({ name: "connectorNode", outcome: "created" });

    // Registered on the line that creates it, so there is no window in which a
    // thrown error could carry it into an unscrubbed message.
    const token = guard ? guard.register(generateToken()) : generateToken();
    const credential = await admin.insertCredential({
      ownerId,
      connectorNodeId: node.id,
      tokenHash: hashConnectorToken(token),
      tokenPrefix: connectorTokenPrefix(token),
    });
    undo.push({ name: "connectorCredential", run: () => admin.deleteCredential({ ownerId, id: credential.id }) });
    steps.push({ name: "connectorCredential", outcome: "created" });

    await keychain.addItem({ ...coordinates.token, secret: token, comment: `Bibi Workspace connector token (${label})` });
    undo.push({ name: "keychainToken", run: () => keychain.deleteItem(coordinates.token) });
    steps.push({ name: "keychainToken", outcome: "created" });

    await keychain.addItem({ ...coordinates.password, secret: password, comment: "Bibi Workspace owner login" });
    undo.push({ name: "keychainPassword", run: () => keychain.deleteItem(coordinates.password) });
    steps.push({ name: "keychainPassword", outcome: "created" });

    // Read the world back rather than reporting what we believe we wrote.
    const after = await inspectProvisioningState({ admin, keychain, ownerEmail: email, nodeLabel: label });
    const missing = classifyProvisioningState(after).missing;
    if (missing.length > 0) {
      throw new ProvisioningError(
        `생성 직후 확인에서 빠진 항목이 있습니다: ${missing.join(", ")}`,
        "READBACK_INCOMPLETE",
      );
    }
    return safeReadback(after, { status: "provisioned", steps });
  } catch (error) {
    const rollback = await runRollback(undo);
    throw new ProvisioningError(
      rollback.clean
        ? "프로비저닝에 실패해 만들었던 항목을 모두 되돌렸습니다."
        : "프로비저닝에 실패했고 일부 항목을 되돌리지 못했습니다. 수동 확인이 필요합니다.",
      rollback.clean ? "PROVISION_FAILED_ROLLED_BACK" : "PROVISION_FAILED_ROLLBACK_INCOMPLETE",
      { cause: error?.code ?? "UNKNOWN", steps, rollback },
    );
  }
}

/** The read-only half: the same safe report, with nothing created. */
export async function readbackProvisioning({ admin, keychain, ownerEmail, nodeLabel }) {
  const email = normaliseOwnerEmail(ownerEmail);
  const label = normaliseNodeLabel(nodeLabel);
  const state = await inspectProvisioningState({ admin, keychain, ownerEmail: email, nodeLabel: label });
  const verdict = classifyProvisioningState(state);
  return safeReadback(state, {
    status: verdict.decision === "already-provisioned"
      ? "complete"
      : verdict.present.length === 0
        ? "unprovisioned"
        : "partial",
    steps: [],
  });
}
