/**
 * Which application view is the Bibi Workspace.
 *
 * The CEO surface owns its own connector and cloud status, so the legacy Hermes
 * chrome around it — the gateway online count, the workspace refresh button and
 * the core-health error banner — has to be able to ask "am I on that surface?".
 * That question is asked from more than one place in `App.jsx`, so the answer
 * lives here rather than as a bare `view === "ceo"` repeated at each call site.
 */

export const BIBI_VIEW_ID = "ceo";

/**
 * Every view that displays organisation, conversations, work or artifacts uses
 * the authenticated cloud contract. Legacy Hermes Office remains available only
 * for low-level system/plugin/terminal tooling; it never supplies Bibi data.
 */
export const BIBI_SURFACE_IDS = Object.freeze(new Set([
  "ceo", "office", "chat", "meeting", "kanban", "command", "data", "sessions", "team",
]));

export function isBibiSurface(view) {
  return BIBI_SURFACE_IDS.has(view);
}

/**
 * Whether the Bibi surface is showing an authentication gate or the workspace.
 *
 * The shell owns the navigation but not the session, and the workspace owns the
 * session but not the navigation, so one of them has to tell the other. This is
 * the vocabulary they share. It lives here, next to `isBibiSurface`, because
 * this module is already the seam between the legacy chrome and the Bibi
 * surface, and because a bare boolean crossing that seam would not say which
 * way round it ran.
 */
export const AUTH_GATE = Object.freeze({
  /** A gate is on screen: sign in, redeem an invite, or set a password. */
  LOCKED: "LOCKED",
  /** The signed-in workspace is on screen. */
  OPEN: "OPEN",
});

/**
 * Default to locked.
 *
 * The shell renders before the workspace has reported anything, and for that
 * first frame the honest answer is "not signed in yet". Defaulting to OPEN
 * would flash a full navigation bar at someone who has not authenticated.
 */
export function isAuthLocked(view, gate) {
  return isBibiSurface(view) && gate !== AUTH_GATE.OPEN;
}
