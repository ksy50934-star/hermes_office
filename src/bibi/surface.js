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

export function isBibiSurface(view) {
  return view === BIBI_VIEW_ID;
}
