/**
 * The Bibi roster, and the mapping between two identifier spaces that look
 * alike and must never be confused.
 *
 *  - **Organisational role slot** — `bibi-01` .. `bibi-18`. This is what the user
 *    sees, what work is assigned to, and what owns a conversation. Eighteen
 *    slots, exactly.
 *  - **Physical execution profile** — `default`, `bibi-02` .. `bibi-18`. This is
 *    a real Hermes profile directory on the Mac. The CEO does not run on a
 *    profile called `bibi-01`: CEO비비 executes on the `default` profile at
 *    `~/.hermes`.
 *
 * Roles and mandates are canonical, transcribed from the read-only bibi-world
 * profile declarations (`bibi-NN/profile.json`). `tests/bibiRoster.test.js`
 * re-reads those files and fails if this table ever drifts from them.
 *
 * The trap this module exists to close: a physical directory named `bibi-01`
 * also exists, and it is a **rollback original**, not a runtime. So the mapping
 * is deliberately asymmetric —
 *
 *     toExecutionProfileId("bibi-01")   === "default"   (role slot → runtime)
 *     toOrganizationProfileId("default")=== "bibi-01"   (runtime → role slot)
 *     toOrganizationProfileId("bibi-01")=== null        (rollback original)
 *
 * — so that observing the rollback directory on disk can never be mistaken for
 * observing the CEO. Every translation here is explicit and total: an
 * unrecognised identifier returns null rather than a plausible substitute.
 */

export const BIBI_PROFILE_COUNT = 18;

export const ROLE_CONFIRMED = "CONFIRMED";
export const ROLE_UNCONFIRMED = "UNCONFIRMED";

/** Organisational role slot for the CEO. */
export const CEO_PROFILE_ID = "bibi-01";
/** The physical profile the CEO actually runs on: `~/.hermes`. */
export const CEO_EXECUTION_PROFILE_ID = "default";
/**
 * The physical `profiles/bibi-01` directory. It is a rollback original kept for
 * recovery and must never be auto-selected as the CEO runtime.
 */
export const ROLLBACK_PROFILE_ID = "bibi-01";

export const DEVELOPER_PROFILE_ID = "bibi-02";

export const RESOLUTION_CODES = Object.freeze({
  MISSING_PROFILE: "MISSING_PROFILE",
  UPSTREAM_GENERIC_PROFILE: "UPSTREAM_GENERIC_PROFILE",
  EXECUTION_PROFILE_NOT_ORGANIZATION_ID: "EXECUTION_PROFILE_NOT_ORGANIZATION_ID",
  UNKNOWN_PROFILE: "UNKNOWN_PROFILE",
});

/**
 * Profile identifiers from the upstream generic product. Listed so they can be
 * rejected by name with an actionable message, never so they can be mapped.
 * `default` is deliberately absent: here it is a real profile, not a generic one.
 */
export const UPSTREAM_GENERIC_PROFILE_IDS = Object.freeze([
  "hermes-director",
  "hermes-operations",
  "hermes-brand",
  "hermes-growth",
  "hermes-content",
  "hermes-creative",
  "hermes-customer",
  "hermes-finance",
  "hermes-technology",
]);

function ordinalSegment(ordinal) {
  return String(ordinal).padStart(2, "0");
}

export function bibiProfileId(ordinal) {
  return `bibi-${ordinalSegment(ordinal)}`;
}

/** The eighteen organisational role slots. */
export const BIBI_PROFILE_IDS = Object.freeze(
  Array.from({ length: BIBI_PROFILE_COUNT }, (_, index) => bibiProfileId(index + 1)),
);

/** The seventeen physical profiles that actually execute work. */
export const EXECUTION_PROFILE_IDS = Object.freeze([
  CEO_EXECUTION_PROFILE_ID,
  ...BIBI_PROFILE_IDS.slice(1),
]);

/**
 * Canonical roles from `/Users/siyoung/Documents/bibi-world/bibi-NN/profile.json`
 * (`official_role`, `purpose`, `reports_to`). Do not edit by hand: change the
 * declaration and re-transcribe, or the roster test will fail.
 */
const CANONICAL_ROLES = new Map([
  ["bibi-01", {
    displayName: "CEO비비",
    role: "CEO비비",
    mandate: "전사 총괄, 업무 배정·조정·종결, 사용자와 최상위 소통",
    reportsTo: "user",
  }],
  ["bibi-02", {
    displayName: "개발자비비",
    role: "개발자비비",
    mandate: "개발 천재 비비의 개발·자동화·기술 구현 책임",
    reportsTo: "bibi-01",
  }],
  ["bibi-03", {
    displayName: "업로더비비",
    role: "업로더비비",
    mandate: "블로그·SNS 편집·업로드·저장·발행 준비",
    reportsTo: "bibi-01",
  }],
  ["bibi-04", {
    displayName: "유튜버비비",
    role: "유튜버비비",
    mandate: "YouTube 제작 연계·업로드·공개 검증",
    reportsTo: "bibi-01",
  }],
  ["bibi-05", {
    displayName: "업로더2비비",
    role: "업로더2비비",
    mandate: "분리된 계정·브랜드의 블로그·SNS 업로드",
    reportsTo: "bibi-01",
  }],
  ["bibi-06", {
    displayName: "디자이너비비",
    role: "디자이너비비",
    mandate: "모든 디자인·이미지·시각 자산 제작",
    reportsTo: "bibi-01",
  }],
  ["bibi-07", {
    displayName: "김비서비비",
    role: "김비서비비",
    mandate: "개인 비서·Mac 실무·일정·일상 실행 지원",
    reportsTo: "bibi-01",
  }],
  ["bibi-08", {
    displayName: "마음비비",
    role: "마음비비",
    mandate: "심리·철학·회고·마인드 관리",
    reportsTo: "bibi-01",
  }],
  ["bibi-09", {
    displayName: "마케터비비",
    role: "마케터비비",
    mandate: "마케팅 기획·실행 방향·독립 피드백",
    reportsTo: "bibi-01",
  }],
  ["bibi-10", {
    displayName: "검수비비",
    role: "검수비비",
    mandate: "모든 주체의 독립 검수·승인·반려",
    reportsTo: "bibi-01",
  }],
  ["bibi-11", {
    displayName: "크론비비",
    role: "크론비비",
    mandate: "모든 예약·크론 업무 관리",
    reportsTo: "bibi-01",
  }],
  ["bibi-12", {
    displayName: "운영비비",
    role: "운영비비",
    mandate: "Mac mini·Hermes·프로필·비비 조직 운영",
    reportsTo: "bibi-01",
  }],
  ["bibi-13", {
    displayName: "학습비비",
    role: "학습비비",
    mandate: "사용자와 조직의 지식 학습·기억 큐레이션",
    reportsTo: "bibi-01",
  }],
  ["bibi-14", {
    displayName: "리서치비비",
    role: "리서치비비",
    mandate: "모든 전문 리서치·출처 검증",
    reportsTo: "bibi-01",
  }],
  ["bibi-15", {
    displayName: "서류비비",
    role: "서류비비",
    mandate: "회사·개인 서류 제작 전담",
    reportsTo: "bibi-01",
  }],
  ["bibi-16", {
    displayName: "사업개발비비",
    role: "사업개발비비",
    mandate: "전략기획·사업개발·컨설팅",
    reportsTo: "bibi-01",
  }],
  ["bibi-17", {
    displayName: "문제해결사비비",
    role: "문제해결사비비",
    mandate: "모든 반복 실패·정체·장애의 독립 복구",
    reportsTo: "bibi-01",
  }],
  ["bibi-18", {
    displayName: "일상비비",
    role: "일상비비",
    mandate: "사용자의 일상·직관적 명령을 수행하고 CEO비비의 전사 우선순위와 조정에 따른다",
    reportsTo: "bibi-01",
  }],
]);

function rosterEntry(ordinal) {
  const id = bibiProfileId(ordinal);
  const canonical = CANONICAL_ROLES.get(id);
  // Every one of the eighteen slots has a declared role. A missing entry is a
  // transcription bug, not a profile awaiting a name, so fail loudly rather
  // than shipping a positional placeholder.
  if (!canonical) throw new Error(`Canonical role missing for ${id}.`);

  return Object.freeze({
    id,
    ordinal,
    isCeo: id === CEO_PROFILE_ID,
    isPrimarySurface: id === CEO_PROFILE_ID,
    // Carried on the entry so that no caller has to remember the CEO exception.
    executionProfileId: id === CEO_PROFILE_ID ? CEO_EXECUTION_PROFILE_ID : id,
    displayName: canonical.displayName,
    role: canonical.role,
    mandate: canonical.mandate,
    reportsTo: canonical.reportsTo,
    roleSource: ROLE_CONFIRMED,
  });
}

export const BIBI_ROSTER = Object.freeze(
  Array.from({ length: BIBI_PROFILE_COUNT }, (_, index) => rosterEntry(index + 1)),
);

const ROSTER_BY_ID = new Map(BIBI_ROSTER.map((entry) => [entry.id, entry]));
const EXECUTION_SET = new Set(EXECUTION_PROFILE_IDS);
const UPSTREAM_GENERIC_SET = new Set(UPSTREAM_GENERIC_PROFILE_IDS);

const ORGANIZATION_BY_EXECUTION = new Map(
  BIBI_ROSTER.map((entry) => [entry.executionProfileId, entry.id]),
);

/** True for an organisational role slot, `bibi-01` .. `bibi-18`. */
export function isBibiProfileId(value) {
  return typeof value === "string" && ROSTER_BY_ID.has(value);
}

/** True for a physical profile that may execute work. */
export function isExecutionProfileId(value) {
  return typeof value === "string" && EXECUTION_SET.has(value);
}

export function isUpstreamGenericProfileId(value) {
  return typeof value === "string" && UPSTREAM_GENERIC_SET.has(value);
}

/** Role slot → physical profile. Returns null for anything not a role slot. */
export function toExecutionProfileId(value) {
  return ROSTER_BY_ID.get(typeof value === "string" ? value : "")?.executionProfileId ?? null;
}

/**
 * Physical profile → role slot. Returns null for the rollback original
 * `profiles/bibi-01`, which is not any Bibi's runtime.
 */
export function toOrganizationProfileId(value) {
  if (typeof value !== "string") return null;
  return ORGANIZATION_BY_EXECUTION.get(value) ?? null;
}

/**
 * Resolve an organisational role slot. No fallback: a caller that receives
 * `ok: false` must surface the code rather than substitute a profile.
 */
export function resolveBibiProfile(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) return { ok: false, profile: null, code: RESOLUTION_CODES.MISSING_PROFILE };

  const entry = ROSTER_BY_ID.get(id);
  if (entry) return { ok: true, profile: entry, code: null };

  if (UPSTREAM_GENERIC_SET.has(id)) {
    return { ok: false, profile: null, code: RESOLUTION_CODES.UPSTREAM_GENERIC_PROFILE };
  }
  // A physical profile is not wrong, just in the other identifier space.
  if (EXECUTION_SET.has(id)) {
    return { ok: false, profile: null, code: RESOLUTION_CODES.EXECUTION_PROFILE_NOT_ORGANIZATION_ID };
  }
  return { ok: false, profile: null, code: RESOLUTION_CODES.UNKNOWN_PROFILE };
}

export function bibiProfile(id) {
  return ROSTER_BY_ID.get(id) ?? null;
}

/**
 * The roster in the order the UI must present it: bibi-01 leads because the CEO
 * is the governing surface, then physical ordinal order.
 */
export function ceoFirstRoster() {
  const ceo = ROSTER_BY_ID.get(CEO_PROFILE_ID);
  return [ceo, ...BIBI_ROSTER.filter((entry) => entry.id !== CEO_PROFILE_ID)];
}

export function unconfirmedRoleIds() {
  return BIBI_ROSTER.filter((entry) => entry.roleSource === ROLE_UNCONFIRMED).map((entry) => entry.id);
}
