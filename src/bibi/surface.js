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
 * The CEO landing and direct-chat route are rendered by BibiWorkspace itself.
 * The chat route must use that renderer because it owns the conversation
 * binding, connector discovery, checkpoint readback, and Telegram bridge panel.
 * Other Bibi views keep the upstream specialist renderer and replace only their
 * data transport with the authenticated cloud contract.
 */
export const BIBI_SURFACE_IDS = Object.freeze(new Set([BIBI_VIEW_ID, "chat"]));

/** Views protected by the Bibi owner session and backed by Bibi cloud data. */
export const BIBI_CLOUD_VIEW_IDS = Object.freeze(new Set([
  "ceo", "office", "chat", "meeting", "kanban", "command", "data", "sessions", "team",
  "plugins", "system", "terminal",
]));

export function isBibiSurface(view) {
  return BIBI_SURFACE_IDS.has(view);
}

export function isBibiCloudView(view) {
  return BIBI_CLOUD_VIEW_IDS.has(view);
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
  return isBibiCloudView(view) && gate !== AUTH_GATE.OPEN;
}
