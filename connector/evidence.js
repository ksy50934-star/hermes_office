/**
 * Evidence capture for work the connector executed locally.
 *
 * Evidence exists so the owner can check a claim instead of trusting it, which
 * means two things have to be true at once: the hash must cover the whole
 * artifact, and nothing secret may ride along in the excerpt. The hash is taken
 * over the raw bytes; the excerpt is redacted and truncated separately.
 *
 * The connector also refuses, structurally, to treat a local profile state
 * file, a credential store or a cookie jar as an artifact. Those are the exact
 * files that must never leave the Mac.
 */

import { createHash } from "node:crypto";

export const EVIDENCE_KINDS = Object.freeze(["command", "artifact", "log", "screenshot", "link"]);

/** Long enough to be useful in the UI, short enough not to become a data channel. */
const MAX_EXCERPT_LENGTH = 4_000;

export class EvidenceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "EvidenceError";
    this.code = code;
  }
}

export function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

const REDACTIONS = [
  // Header-scoped first: the whole value goes, not just a recognised shape.
  [/(authorization\s*:\s*bearer\s+)\S+/gi, "$1[redacted]"],
  [/(cookie\s*:\s*).+/gi, "$1[redacted]"],
  // KEY / SECRET / TOKEN / PASSWORD assignments.
  [/\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)\s*[=:]\s*)\S+/g, "$1[redacted]"],
  // Bare JWTs, which is what a Supabase access token looks like in a log.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted]"],
  // Common provider token shapes.
  [/\b(?:sbp|sb|sk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, "[redacted]"],
];

export function redactSecrets(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

const FORBIDDEN_SOURCES = [
  [/(^|\/)state\.(?:db|sqlite|sqlite3)$/i, "프로필 원본 상태 파일"],
  [/(^|\/)cookies?\.(?:db|sqlite|sqlite3|binarycookies)$/i, "쿠키 저장소"],
  [/(^|\/)Cookies\.binarycookies$/i, "쿠키 저장소"],
  [/\/Library\/Cookies\//i, "쿠키 저장소"],
  [/(^|\/)profiles\/bibi-\d{2}\//i, "프로필 내부 디렉터리"],
  [/(^|\/)credentials?\.json$/i, "자격증명 파일"],
  [/(^|\/)\.ssh\//, "SSH 키 디렉터리"],
  [/(^|\/)\.env(?:\.|$)/, "환경 변수 파일"],
  [/\.(?:pem|key|p12|pfx|keychain)$/i, "키 파일"],
];

/**
 * Throw if a path names something that must stay on the Mac. Called before any
 * file is read for evidence.
 */
export function assertNoLocalStateSource(sourcePath) {
  const value = String(sourcePath ?? "");
  for (const [pattern, label] of FORBIDDEN_SOURCES) {
    if (pattern.test(value)) {
      throw new EvidenceError(
        `${label}는 증거로 업로드할 수 없습니다: ${value}`,
        "LOCAL_STATE_SOURCE",
      );
    }
  }
  return value;
}

export function buildEvidence({ kind, label, content = "", storagePath = null } = {}) {
  if (!EVIDENCE_KINDS.includes(kind)) {
    throw new EvidenceError(
      `증거 종류 '${kind}'을(를) 인식할 수 없습니다. 허용: ${EVIDENCE_KINDS.join(", ")}`,
      "INVALID_KIND",
    );
  }
  const evidenceLabel = String(label ?? "").trim();
  if (!evidenceLabel) {
    throw new EvidenceError("증거 라벨이 필요합니다.", "MISSING_LABEL");
  }
  if (storagePath) assertNoLocalStateSource(storagePath);

  const raw = typeof content === "string" || Buffer.isBuffer(content) ? content : String(content);
  const byteSize = Buffer.byteLength(raw);
  const redacted = redactSecrets(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
  const truncated = redacted.length > MAX_EXCERPT_LENGTH;

  return {
    kind,
    label: evidenceLabel,
    // The hash covers the whole artifact so the owner can verify the original,
    // not the excerpt shown in the UI.
    sha256: sha256Hex(raw),
    byteSize,
    storagePath,
    inlineExcerpt: truncated ? redacted.slice(0, MAX_EXCERPT_LENGTH) : redacted,
    truncated,
  };
}
