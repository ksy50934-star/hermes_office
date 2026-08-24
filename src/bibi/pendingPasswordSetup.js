/**
 * Remembers that a signed-in user still owes us a password.
 *
 * Accepting an invite produces a session *before* it produces a password. In
 * between, the user is authenticated and has no way to ever sign in again — a
 * reload at that moment would drop them into the workspace, and the next visit,
 * once the session expired, would leave them at a password form for a password
 * that was never set.
 *
 * So the obligation is written down when the invite session is established and
 * cleared only when the password actually saves. It is keyed by user id: a
 * marker left by one account must not follow another into the setup screen.
 *
 * What is stored is a flag, never a credential.
 */

const KEY_PREFIX = "bibi.auth.password-setup:";

function keyFor(userId) {
  return `${KEY_PREFIX}${userId}`;
}

/**
 * Storage is injected so the behaviour is testable without a DOM, and so a
 * browser that refuses `localStorage` — private mode, a blocked third-party
 * context — degrades to "no marker" instead of throwing on load.
 */
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function markPasswordSetupPending(userId, storage = defaultStorage()) {
  if (!userId || !storage) return false;
  try {
    storage.setItem(keyFor(userId), "1");
    return true;
  } catch {
    // A full or disabled store is not a reason to fail the sign-in. The user
    // simply loses the reload safety net, which is strictly better than being
    // unable to accept the invite at all.
    return false;
  }
}

export function isPasswordSetupPending(userId, storage = defaultStorage()) {
  if (!userId || !storage) return false;
  try {
    return storage.getItem(keyFor(userId)) === "1";
  } catch {
    return false;
  }
}

export function clearPasswordSetupPending(userId, storage = defaultStorage()) {
  if (!userId || !storage) return false;
  try {
    storage.removeItem(keyFor(userId));
    return true;
  } catch {
    return false;
  }
}

export { KEY_PREFIX };
