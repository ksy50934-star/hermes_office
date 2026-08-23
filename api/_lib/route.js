/**
 * Shared plumbing for the connector-facing Vercel functions.
 *
 * Each route is POST-only and authenticates a connector token before it does
 * anything else. Errors are returned as a code and a message with no detail
 * about why a token failed, so the endpoint cannot be used to probe which
 * tokens exist.
 */

import { authenticateConnector } from "./connectorAuth.js";
import { createServiceRoleClient, createWorkspaceStore } from "./store.js";
import { loadServerEnv } from "./serverEnv.js";

function sendJson(response, status, body) {
  response.status(status);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.send(JSON.stringify(body));
}

export function connectorRoute(handler) {
  return async function route(request, response) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }

    let env;
    try {
      env = loadServerEnv(process.env);
    } catch (error) {
      // A misconfigured deployment must fail loudly rather than serve a
      // half-working control plane.
      sendJson(response, 500, { error: error.code ?? "SERVER_MISCONFIGURED", message: error.message });
      return;
    }

    const store = createWorkspaceStore(createServiceRoleClient(process.env));
    const auth = await authenticateConnector({ headers: request.headers, store });
    if (!auth.ok) {
      sendJson(response, auth.status, { error: auth.code, message: auth.message });
      return;
    }

    try {
      const result = await handler({
        auth,
        body: request.body ?? {},
        store,
        leaseTtlMs: env.leaseTtlMs,
        maxBatch: env.maxLeaseBatch,
      });
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, 500, { error: "INTERNAL_ERROR", message: error.message });
    }
  };
}
