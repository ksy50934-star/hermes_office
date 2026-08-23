/**
 * Signed-in user authentication for owner-initiated actions.
 *
 * The browser holds a Supabase access token. This module verifies it with
 * Supabase and returns the user id, which every downstream query is then scoped
 * to. The token is never trusted for its claims alone: an unverified JWT is
 * just a string the caller chose.
 */

export async function authenticateUser({ headers, supabase }) {
  const raw = headers?.authorization ?? headers?.Authorization ?? "";
  const match = String(raw).match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { ok: false, status: 401, code: "MISSING_TOKEN", message: "Sign in to continue." };
  }

  const { data, error } = await supabase.auth.getUser(match[1].trim());
  if (error || !data?.user?.id) {
    return { ok: false, status: 401, code: "INVALID_SESSION", message: "Your session has expired." };
  }

  return { ok: true, ownerId: data.user.id };
}
