import os from "node:os";
import path from "node:path";

/**
 * Local Mac connector configuration.
 *
 * The connector is the only thing that bridges the cloud control plane and the
 * user's Hermes install, so its configuration is where the topology is actually
 * enforced. It dials out over HTTPS and it never accepts a connection, so an
 * inbound port is not a setting with a safe value — it is a refusal.
 *
 * Local execution is opt-in. A connector started without an explicit opt-in
 * runs in dry-run mode: it still polls, leases and reports honestly, but it does
 * not drive a real profile. That is deliberate, so that installing the
 * connector is never the same act as authorising it to act.
 *
 * When live execution *is* enabled, the Hermes CLI settings become required
 * rather than optional. A connector that is authorised to act but cannot say
 * which binary or which profile root to act through would otherwise fail at the
 * first command instead of at startup.
 */

export class ConnectorConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ConnectorConfigError";
    this.code = code;
  }
}

export const SUPPORTED_CONNECTOR_MODE = "outbound-local-mac";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

/** One turn cap and one wall-clock cap, so a runaway session cannot pin the Mac. */
const DEFAULT_HERMES_MAX_TURNS = 12;
const DEFAULT_HERMES_TIMEOUT_MS = 300_000;
const DEFAULT_HERMES_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function text(env, key, fallback = "") {
  const value = String(env?.[key] ?? "").trim();
  return value || fallback;
}

function positiveInteger(env, key, fallback) {
  const raw = text(env, key);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConnectorConfigError(`${key}는 양의 정수여야 합니다.`, "INVALID_NUMBER");
  }
  return value;
}

function parseUrl(value, key) {
  try {
    return new URL(value);
  } catch {
    throw new ConnectorConfigError(`${key}가 올바른 URL이 아닙니다.`, "INVALID_URL");
  }
}

function isLoopback(url) {
  return LOOPBACK_HOSTNAMES.has(url.hostname);
}

export function loadConnectorConfig(env = process.env) {
  const mode = text(env, "BIBI_CONNECTOR_MODE");
  if (!mode) {
    throw new ConnectorConfigError(
      `BIBI_CONNECTOR_MODE를 ${SUPPORTED_CONNECTOR_MODE}로 설정하세요.`,
      "MISSING_MODE",
    );
  }
  if (mode !== SUPPORTED_CONNECTOR_MODE) {
    throw new ConnectorConfigError(
      `지원하지 않는 커넥터 모드 '${mode}'입니다. 이 커넥터는 로컬 Mac에서 바깥으로만 연결합니다.`,
      "UNSUPPORTED_MODE",
    );
  }

  const inboundPort = text(env, "BIBI_CONNECTOR_INBOUND_PORT");
  if (inboundPort) {
    throw new ConnectorConfigError(
      `커넥터는 인바운드 포트를 열지 않습니다. BIBI_CONNECTOR_INBOUND_PORT(${inboundPort})를 비우세요.`,
      "INBOUND_PORT_CONFIGURED",
    );
  }

  const controlPlaneRaw = text(env, "BIBI_CONTROL_PLANE_URL");
  if (!controlPlaneRaw) {
    throw new ConnectorConfigError("BIBI_CONTROL_PLANE_URL이 필요합니다.", "MISSING_CONTROL_PLANE");
  }
  const controlPlane = parseUrl(controlPlaneRaw, "BIBI_CONTROL_PLANE_URL");
  // Plain HTTP is tolerated only against loopback, which is how the owner runs
  // the control plane locally before the first deploy.
  if (controlPlane.protocol !== "https:" && !isLoopback(controlPlane)) {
    throw new ConnectorConfigError(
      `BIBI_CONTROL_PLANE_URL은 https여야 합니다. 커넥터 토큰이 평문으로 나갑니다: ${controlPlaneRaw}`,
      "INSECURE_CONTROL_PLANE",
    );
  }

  const token = text(env, "BIBI_CONNECTOR_TOKEN");
  if (!token) {
    throw new ConnectorConfigError("BIBI_CONNECTOR_TOKEN이 필요합니다.", "MISSING_TOKEN");
  }

  // Dry run unless the operator explicitly says otherwise.
  const dryRun = text(env, "BIBI_CONNECTOR_ALLOW_LOCAL_EXECUTION").toLowerCase() !== "true";

  const hermesBin = text(env, "BIBI_HERMES_BIN");
  const hermesDefaultHome = text(env, "BIBI_HERMES_DEFAULT_HOME");
  const hermesProfilesRoot = text(env, "BIBI_HERMES_PROFILES_ROOT");

  if (!dryRun) {
    if (!hermesBin) {
      throw new ConnectorConfigError(
        "BIBI_HERMES_BIN이 필요합니다. 실행할 hermes 실행 파일 경로를 지정하세요.",
        "MISSING_HERMES_BIN",
      );
    }
    if (!hermesDefaultHome) {
      throw new ConnectorConfigError(
        "BIBI_HERMES_DEFAULT_HOME이 필요합니다. CEO비비가 실행되는 기본 홈(~/.hermes)입니다.",
        "MISSING_HERMES_DEFAULT_HOME",
      );
    }
    if (!hermesProfilesRoot) {
      throw new ConnectorConfigError(
        "BIBI_HERMES_PROFILES_ROOT가 필요합니다. bibi-02~bibi-18 프로필 홈의 상위 디렉터리입니다.",
        "MISSING_HERMES_PROFILES_ROOT",
      );
    }
  }

  const config = {
    mode,
    controlPlaneUrl: controlPlaneRaw.replace(/\/+$/, ""),
    nodeLabel: text(env, "BIBI_CONNECTOR_NODE_LABEL", "local-mac"),
    dryRun,
    // Hermes is driven as a subprocess. A profile is chosen only by setting the
    // child's HERMES_HOME; there is no profile flag on the CLI.
    hermesBin,
    hermesDefaultHome,
    hermesProfilesRoot,
    bibiWorldRoot: text(env, "BIBI_WORLD_ROOT", path.join(text(env, "HOME", os.homedir()), "Documents", "bibi-world")),
    hermesMaxTurns: positiveInteger(env, "BIBI_HERMES_MAX_TURNS", DEFAULT_HERMES_MAX_TURNS),
    hermesTimeoutMs: positiveInteger(env, "BIBI_HERMES_TIMEOUT_MS", DEFAULT_HERMES_TIMEOUT_MS),
    hermesMaxOutputBytes: positiveInteger(env, "BIBI_HERMES_MAX_OUTPUT_BYTES", DEFAULT_HERMES_MAX_OUTPUT_BYTES),
    pollIntervalMs: positiveInteger(env, "BIBI_CONNECTOR_POLL_INTERVAL_MS", 5_000),
    heartbeatIntervalMs: positiveInteger(env, "BIBI_CONNECTOR_HEARTBEAT_INTERVAL_MS", 30_000),
    requestTimeoutMs: positiveInteger(env, "BIBI_CONNECTOR_REQUEST_TIMEOUT_MS", 20_000),
    maxBatch: positiveInteger(env, "BIBI_CONNECTOR_MAX_BATCH", 4),
    // The first four characters are enough to tell two tokens apart in a log
    // without being enough to use one.
    tokenPrefix: `${token.slice(0, 4)}…`,
  };

  // Non-enumerable so JSON.stringify, console.log and structured logging all
  // omit it. Reading config.token still works for the transport.
  Object.defineProperty(config, "token", {
    value: token,
    enumerable: false,
    writable: false,
  });

  return config;
}
