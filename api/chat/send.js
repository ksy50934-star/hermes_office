/**
 * Send one chat turn.
 *
 * This exists as an API route rather than a direct table insert because a chat
 * message has to become a command in the same breath. The browser holds no
 * insert policy on `messages`; only this route, running as the service role,
 * can create the pair.
 */

import { handleChatSend } from "../_lib/handlers.js";
import { authenticateUser } from "../_lib/userAuth.js";
import { createServiceRoleClient, createWorkspaceStore } from "../_lib/store.js";

function sendJson(response, status, body) {
  response.status(status);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.send(JSON.stringify(body));
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return;
  }

  let supabase;
  try {
    supabase = createServiceRoleClient(process.env);
  } catch (error) {
    sendJson(response, 500, { error: error.code ?? "SERVER_MISCONFIGURED", message: error.message });
    return;
  }

  const auth = await authenticateUser({ headers: request.headers, supabase });
  if (!auth.ok) {
    sendJson(response, auth.status, { error: auth.code, message: auth.message });
    return;
  }

  try {
    const result = await handleChatSend({
      auth,
      body: request.body ?? {},
      store: createWorkspaceStore(supabase),
    });
    sendJson(response, result.status, result.body);
  } catch (error) {
    sendJson(response, 500, { error: "INTERNAL_ERROR", message: error.message });
  }
}
