/**
 * Connector authentication.
 *
 * The connector presents a bearer token. The database stores only its SHA-256
 * hash, so a database dump does not yield a usable connector credential. The
 * lookup is by hash, and the comparison of the stored and computed hash is
 * constant-time so a caller cannot learn a prefix by timing the endpoint.
 *
 * A token identifies exactly one owner and one connector node. Everything
 * downstream is scoped to that owner, so a valid token for one account can
 * never reach another account's work.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export function hashConnectorToken(token) {
  return createHash("sha256").update(String(token ?? ""), "utf8").digest("hex");
}

export function connectorTokenPrefix(token) {
  return `${String(token ?? "").slice(0, 4)}…`;
}

function safeEquals(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerToken(headers = {}) {
  const raw = headers.authorization ?? headers.Authorization ?? "";
  const match = String(raw).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

/**
 * @returns {Promise<{ok: true, ownerId: string, credentialId: string, connectorNodeId: string}
 *   | {ok: false, status: number, code: string, message: string}>}
 */
export async function authenticateConnector({ headers, store }) {
  const token = bearerToken(headers);
  if (!token) {
    return { ok: false, status: 401, code: "MISSING_TOKEN", message: "Connector token is required." };
  }

  const tokenHash = hashConnectorToken(token);
  const credential = await store.findConnectorCredential(tokenHash);

  // An unknown token and a known-but-wrong one must be indistinguishable.
  if (!credential || !safeEquals(credential.token_hash, tokenHash)) {
    return { ok: false, status: 401, code: "INVALID_TOKEN", message: "Connector token is not recognised." };
  }
  if (credential.revoked_at) {
    return { ok: false, status: 401, code: "REVOKED_TOKEN", message: "Connector token has been revoked." };
  }

  return {
    ok: true,
    ownerId: credential.owner_id,
    credentialId: credential.id,
    connectorNodeId: credential.connector_node_id,
  };
}
