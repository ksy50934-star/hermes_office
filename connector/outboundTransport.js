/**
 * Outbound HTTP transport to the cloud control plane.
 *
 * Every method here is a request the Mac initiates. There is no server, no
 * socket to accept on, and no callback URL for the control plane to call back
 * into, which is what makes the connector safe to run on a laptop behind any
 * network without opening a port or a tunnel.
 *
 * The connector token travels only in the Authorization header, and it is never
 * placed in a URL, where it would land in logs and browser history.
 */

const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" };

class ControlPlaneError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ControlPlaneError";
    this.status = status;
  }
}

export function createOutboundTransport(config, { fetchImpl = globalThis.fetch } = {}) {
  async function request(path, { method = "POST", body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetchImpl(`${config.controlPlaneUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          ...JSON_HEADERS,
          Authorization: `Bearer ${config.token}`,
          "X-Bibi-Connector-Mode": config.mode,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const text = await response.text();
      let payload = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { message: text.slice(0, 240) };
        }
      }

      if (!response.ok) {
        throw new ControlPlaneError(
          payload.error ?? payload.message ?? `control plane responded ${response.status}`,
          response.status,
        );
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    heartbeat(payload) {
      return request("/api/connector/heartbeat", { body: payload });
    },
    /**
     * Ask for work. The control plane grants the lease as part of the response,
     * so the connector never has to make a separate claim call that could
     * succeed while the follow-up fails.
     */
    poll({ max }) {
      return request("/api/connector/poll", { body: { max } });
    },
    renewLease({ leaseId, workItemId }) {
      return request("/api/connector/lease/renew", { body: { leaseId, workItemId } });
    },
    report(event) {
      return request("/api/connector/report", { body: event });
    },
    listProjectionTargets() {
      return request("/api/connector/projection/targets", { body: {} });
    },
    uploadProjection(payload) {
      return request("/api/connector/projection/upload", { body: payload });
    },
    uploadRuntimeProjection(payload) {
      return request("/api/connector/runtime/projection", { body: payload });
    },
  };
}

export { ControlPlaneError };
