/**
 * Execution-environment mismatch contract.
 *
 * The upstream product assumes a VPS: a Docker host running the web app next to
 * a reachable Hermes Agent, with the browser talking to a server that can dial
 * the runtime directly. This workspace does not work that way. Hermes runs on
 * the user's local Mac, the web app runs on Vercel, and the only link between
 * them is a connector on the Mac that dials *out*. Nothing dials in.
 *
 * Every check here exists to make a silent regression back to the VPS shape
 * loud: a remote Hermes target, an inbound port, a raw local-state upload, or a
 * service-role key that a browser could read.
 */

import { SEVERITY } from "./profileMismatch.js";

export const SUPPORTED_CONNECTOR_MODE = "outbound-local-mac";

export const RUNTIME_CODES = Object.freeze({
  ENVIRONMENT_UNAVAILABLE: "ENVIRONMENT_UNAVAILABLE",
  CONNECTOR_MODE_UNSET: "CONNECTOR_MODE_UNSET",
  UNSUPPORTED_CONNECTOR_MODE: "UNSUPPORTED_CONNECTOR_MODE",
  REMOTE_HERMES_TARGET: "REMOTE_HERMES_TARGET",
  INBOUND_PORT_CONFIGURED: "INBOUND_PORT_CONFIGURED",
  LOCAL_STATE_UPLOAD: "LOCAL_STATE_UPLOAD",
  SERVICE_ROLE_EXPOSED: "SERVICE_ROLE_EXPOSED",
  CLOUD_CONFIG_INCOMPLETE: "CLOUD_CONFIG_INCOMPLETE",
});

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0"]);
const REQUIRED_CLOUD_KEYS = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "BIBI_CONTROL_PLANE_URL"];

/** Client-visible variables that must never carry a privileged Supabase key. */
const CLIENT_PREFIX = "VITE_";
const PRIVILEGED_KEY_PATTERN = /(SERVICE_ROLE|SERVICE_KEY|SECRET)/i;

function warning(code, severity, message, remedy) {
  return { code, severity, message, remedy };
}

function textValue(environment, key) {
  return String(environment?.[key] ?? "").trim();
}

function isTruthyFlag(value) {
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/**
 * A Hermes target only counts as local when it resolves to this machine's
 * loopback interface. `host.docker.internal` is explicitly not local: it is the
 * upstream VPS/Docker escape hatch and would mean the container, not the Mac,
 * owns the runtime.
 */
function isLoopbackTarget(target) {
  try {
    return LOCAL_HOSTNAMES.has(new URL(target).hostname);
  } catch {
    return false;
  }
}

export function describeRuntimeMismatch(environment) {
  if (!environment || typeof environment !== "object") {
    return {
      ok: false,
      blocking: true,
      warnings: [warning(
        RUNTIME_CODES.ENVIRONMENT_UNAVAILABLE,
        SEVERITY.BLOCKING,
        "실행 환경 설정을 읽지 못했습니다.",
        "환경 변수를 로드한 뒤 다시 검사하세요. 설정을 읽지 못한 상태를 정상으로 간주하지 마세요.",
      )],
    };
  }

  const warnings = [];

  const mode = textValue(environment, "BIBI_CONNECTOR_MODE");
  if (!mode) {
    warnings.push(warning(
      RUNTIME_CODES.CONNECTOR_MODE_UNSET,
      SEVERITY.BLOCKING,
      "BIBI_CONNECTOR_MODE가 설정되지 않았습니다.",
      `로컬 Mac 커넥터를 쓰려면 BIBI_CONNECTOR_MODE=${SUPPORTED_CONNECTOR_MODE}로 설정하세요.`,
    ));
  } else if (mode !== SUPPORTED_CONNECTOR_MODE) {
    warnings.push(warning(
      RUNTIME_CODES.UNSUPPORTED_CONNECTOR_MODE,
      SEVERITY.BLOCKING,
      `지원하지 않는 커넥터 모드 '${mode}'입니다. 이 워크스페이스는 원본의 VPS·Docker 상주 방식을 쓰지 않습니다.`,
      `BIBI_CONNECTOR_MODE=${SUPPORTED_CONNECTOR_MODE}(로컬 Mac에서 바깥으로만 연결)로 바꾸세요.`,
    ));
  }

  const hermesTarget = textValue(environment, "HERMES_TARGET");
  if (hermesTarget && !isLoopbackTarget(hermesTarget)) {
    warnings.push(warning(
      RUNTIME_CODES.REMOTE_HERMES_TARGET,
      SEVERITY.BLOCKING,
      `HERMES_TARGET이 원격 주소 '${hermesTarget}'을(를) 가리킵니다. 원본 앱의 VPS·Docker 전제입니다.`,
      "Hermes는 사용자의 로컬 Mac에서 실행됩니다. 커넥터가 도는 Mac의 loopback 주소(127.0.0.1)만 사용하세요.",
    ));
  }

  const inboundPort = textValue(environment, "BIBI_CONNECTOR_INBOUND_PORT");
  if (inboundPort) {
    warnings.push(warning(
      RUNTIME_CODES.INBOUND_PORT_CONFIGURED,
      SEVERITY.BLOCKING,
      `커넥터에 인바운드 포트 ${inboundPort}이(가) 설정되어 있습니다.`,
      "커넥터는 바깥에서 들어오는 연결을 받지 않습니다. 이 값을 비우고 아웃바운드 폴링만 사용하세요.",
    ));
  }

  if (isTruthyFlag(textValue(environment, "BIBI_UPLOAD_LOCAL_STATE"))) {
    warnings.push(warning(
      RUNTIME_CODES.LOCAL_STATE_UPLOAD,
      SEVERITY.BLOCKING,
      "로컬 원본 상태 파일 업로드가 켜져 있습니다.",
      "로컬 프로필 상태 파일·자격증명·쿠키는 클라우드로 복제하지 않습니다. 요약과 증거만 전송하세요.",
    ));
  }

  const exposedPrivilegedKeys = Object.keys(environment).filter(
    (key) => key.startsWith(CLIENT_PREFIX) && PRIVILEGED_KEY_PATTERN.test(key) && textValue(environment, key),
  );
  for (const key of exposedPrivilegedKeys) {
    warnings.push(warning(
      RUNTIME_CODES.SERVICE_ROLE_EXPOSED,
      SEVERITY.BLOCKING,
      `${key}는 브라우저 번들에 그대로 들어가는 이름입니다. 권한이 큰 키를 클라이언트에 노출합니다.`,
      `${CLIENT_PREFIX} 접두사를 떼고 서버 전용 환경 변수로 옮기세요. 브라우저에는 anon 키만 둡니다.`,
    ));
  }

  const missingCloudKeys = REQUIRED_CLOUD_KEYS.filter((key) => !textValue(environment, key));
  if (missingCloudKeys.length) {
    warnings.push(warning(
      RUNTIME_CODES.CLOUD_CONFIG_INCOMPLETE,
      SEVERITY.WARNING,
      `클라우드 설정이 완료되지 않았습니다: ${missingCloudKeys.join(", ")}`,
      "Vercel과 Supabase 환경 변수를 채우기 전까지 워크스페이스는 오프라인으로 표시됩니다.",
    ));
  }

  return {
    ok: warnings.length === 0,
    blocking: warnings.some((item) => item.severity === SEVERITY.BLOCKING),
    warnings,
  };
}

/**
 * The findings that describe the *connector's* environment rather than the
 * browser's. The browser cannot read any of them: it has no view of the Mac's
 * process environment, only of the `connector_nodes` row the connector chose to
 * write. Until the connector has actually checked in there is no row to read
 * these from, and an unread value is not a misconfigured one.
 */
export const CONNECTOR_DERIVED_CODES = Object.freeze([
  RUNTIME_CODES.CONNECTOR_MODE_UNSET,
  RUNTIME_CODES.UNSUPPORTED_CONNECTOR_MODE,
  RUNTIME_CODES.REMOTE_HERMES_TARGET,
  RUNTIME_CODES.INBOUND_PORT_CONFIGURED,
  RUNTIME_CODES.LOCAL_STATE_UPLOAD,
]);

/**
 * What the browser is entitled to say about the runtime.
 *
 * `describeRuntimeMismatch` is written for a process that can read the whole
 * environment, and against an empty value it correctly concludes "unset". In a
 * browser that conclusion is wrong in a specific and damaging way: a clean
 * production sign-in, before any connector has ever run, showed a red
 * `BIBI_CONNECTOR_MODE 미설정` card next to a full list of unreported profiles.
 * Nothing was misconfigured. The connector simply had not reported yet, which
 * the surface already says, neutrally, as UNKNOWN.
 *
 * So a heartbeat is the precondition for judging the connector at all. Before
 * one arrives, connector-derived findings are withheld — not softened, and not
 * restated as a warning, because there is no evidence either way. Findings
 * about the browser's own configuration are untouched: those it can see.
 *
 * @param {object} environment
 * @param {boolean} [options.connectorReported] true only once a connector has a
 *   real heartbeat timestamp. Defaults to false, so a caller that forgets to
 *   pass it withholds rather than accuses.
 */
export function describeBrowserRuntimeMismatch(environment, { connectorReported = false } = {}) {
  const report = describeRuntimeMismatch(environment);
  if (connectorReported) return { ...report, connectorReported: true };

  const withheld = new Set(CONNECTOR_DERIVED_CODES);
  const warnings = report.warnings.filter((item) => !withheld.has(item.code));
  return {
    ok: warnings.length === 0,
    blocking: warnings.some((item) => item.severity === SEVERITY.BLOCKING),
    warnings,
    connectorReported: false,
  };
}

export function runtimeSummaryText(report) {
  if (!report || report.ok) return "";
  const codes = new Set(report.warnings.map((item) => item.code));
  const parts = [];
  if (codes.has(RUNTIME_CODES.REMOTE_HERMES_TARGET) || codes.has(RUNTIME_CODES.UNSUPPORTED_CONNECTOR_MODE)) {
    parts.push("원본 앱은 VPS(원격 서버)에 상주하는 전제로 만들어졌지만, 이 워크스페이스의 Hermes는 사용자의 로컬 Mac에서 실행됩니다.");
  }
  if (codes.has(RUNTIME_CODES.INBOUND_PORT_CONFIGURED)) {
    parts.push("로컬 커넥터는 외부에서 들어오는 포트를 열지 않습니다.");
  }
  if (codes.has(RUNTIME_CODES.SERVICE_ROLE_EXPOSED)) {
    parts.push("권한이 큰 Supabase 키가 브라우저에 노출될 수 있는 이름으로 설정되어 있습니다.");
  }
  if (codes.has(RUNTIME_CODES.LOCAL_STATE_UPLOAD)) {
    parts.push("로컬 원본 상태 파일을 클라우드로 올리려는 설정이 켜져 있습니다.");
  }
  if (codes.has(RUNTIME_CODES.CLOUD_CONFIG_INCOMPLETE)) {
    parts.push("클라우드 연결 설정이 아직 완료되지 않았습니다.");
  }
  return parts.join(" ");
}
