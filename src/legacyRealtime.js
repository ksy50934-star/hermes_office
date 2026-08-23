/**
 * The legacy Hermes Gateway realtime bootstrap, behind a single on/off switch.
 *
 * The office chat runtime stays mounted on every view — it is rendered once and
 * hidden, so a conversation survives navigation. On the Bibi Workspace that
 * background runtime is wrong twice over: the surface talks to Supabase
 * Realtime, and the cloud deployment that serves it answers
 * `POST /hermes/api/auth/ws-ticket` with 405 because there is no Hermes gateway
 * behind it.
 *
 * Every ws-ticket the page mints comes from `gateway.connect()`, so gating that
 * one call — together with the reconnect triggers, which would mint a ticket the
 * moment the tab regained focus — is what keeps the request off the surface
 * entirely rather than merely making it fail more quietly.
 */
export function startLegacyRealtime({ enabled, gateway, onConnectFailure, reconnect }) {
  if (!enabled) return () => {};

  gateway.connect().catch(onConnectFailure);
  const reconnectNow = () => reconnect();
  window.addEventListener("online", reconnectNow);
  document.addEventListener("visibilitychange", reconnectNow);
  return () => {
    window.removeEventListener("online", reconnectNow);
    document.removeEventListener("visibilitychange", reconnectNow);
  };
}
