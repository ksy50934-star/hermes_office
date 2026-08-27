import {
  handleBindingVerification,
  handleChatSend,
  handleConversationBinding,
  handleHeartbeat,
  handlePendingBindings,
  handlePoll,
  handleProjectionTargets,
  handleProjectionUpload,
  handleRenewLease,
  handleReport,
  handleRuntimeProjection,
  handleTelegramSessionDiscovery,
  handleWorkTransition,
} from "./_lib/handlers.js";
import { connectorRoute, userRoute } from "./_lib/route.js";

const ROUTES = new Map([
  ["chat/send", userRoute(handleChatSend)],
  ["chat/binding", userRoute(handleConversationBinding)],
  ["work/transition", userRoute(handleWorkTransition)],
  ["connector/heartbeat", connectorRoute(handleHeartbeat)],
  ["connector/poll", connectorRoute(handlePoll)],
  ["connector/report", connectorRoute(handleReport)],
  ["connector/lease/renew", connectorRoute(handleRenewLease)],
  ["connector/runtime/projection", connectorRoute(handleRuntimeProjection)],
  ["connector/projection/targets", connectorRoute(handleProjectionTargets)],
  ["connector/projection/upload", connectorRoute(handleProjectionUpload)],
  ["connector/binding/pending", connectorRoute(handlePendingBindings)],
  ["connector/binding/verify", connectorRoute(handleBindingVerification)],
  ["connector/sessions/telegram", connectorRoute(handleTelegramSessionDiscovery)],
]);

function routePath(request) {
  const captured = request.query?.path;
  if (Array.isArray(captured)) return captured.map(String).join("/");
  if (captured) return String(captured).replace(/^\/+|\/+$/g, "");
  return "";
}

export default async function handler(request, response) {
  const route = ROUTES.get(routePath(request));
  if (!route) {
    response.status(404);
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.send(JSON.stringify({ error: "API_ROUTE_NOT_FOUND" }));
    return;
  }
  await route(request, response);
}

export { ROUTES, routePath };
