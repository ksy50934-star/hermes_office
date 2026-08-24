/**
 * Structural mismatch contract between what the Mac actually has and what this
 * workspace expects.
 *
 * The connector reports **physical** profiles. This module translates them into
 * the eighteen **organisational** role slots the user works with, and reports
 * every discrepancy rather than papering over it.
 *
 * Three cases are worth stating out loud, because each one is a way the mapping
 * could silently go wrong:
 *
 *  - `default` is the CEO's runtime. Seeing it is what satisfies bibi-01.
 *  - A physical `bibi-01` directory is a **rollback original**. It is reported,
 *    and it explicitly does *not* satisfy bibi-01. Letting it stand in for the
 *    CEO would run the recovery copy as if it were the live profile.
 *  - `hermes-*` identifiers belong to the upstream generic product. They are
 *    blocked by name, never mapped onto a Bibi.
 */

import {
  BIBI_PROFILE_IDS,
  CEO_EXECUTION_PROFILE_ID,
  CEO_PROFILE_ID,
  ROLLBACK_PROFILE_ID,
  bibiProfile,
  isUpstreamGenericProfileId,
  toOrganizationProfileId,
} from "./roster.js";

export const SEVERITY = Object.freeze({
  BLOCKING: "blocking",
  WARNING: "warning",
});

export const MISMATCH_CODES = Object.freeze({
  ROSTER_UNAVAILABLE: "ROSTER_UNAVAILABLE",
  UPSTREAM_GENERIC_PROFILE: "UPSTREAM_GENERIC_PROFILE",
  ROLLBACK_PROFILE_PRESENT: "ROLLBACK_PROFILE_PRESENT",
  CEO_PROFILE_MISSING: "CEO_PROFILE_MISSING",
  MISSING_BIBI_PROFILE: "MISSING_BIBI_PROFILE",
  UNKNOWN_PROFILE: "UNKNOWN_PROFILE",
  DUPLICATE_PROFILE: "DUPLICATE_PROFILE",
});

function observedId(entry) {
  if (typeof entry === "string") return entry.trim();
  if (!entry || typeof entry !== "object") return "";
  return String(entry.id ?? entry.name ?? entry.profile ?? "").trim();
}

function warning(code, severity, profileId, message, remedy) {
  return { code, severity, profileId, message, remedy };
}

/**
 * @param {Array<string|object>} observedPhysicalProfiles physical profiles the
 *   connector observed on the Mac.
 */
export function describeProfileMismatch(observedPhysicalProfiles) {
  if (!Array.isArray(observedPhysicalProfiles)) {
    return {
      ok: false,
      blocking: true,
      warnings: [warning(
        MISMATCH_CODES.ROSTER_UNAVAILABLE,
        SEVERITY.BLOCKING,
        null,
        "프로필 목록을 확인할 수 없습니다. 로컬 Mac 커넥터가 아직 명단을 보고하지 않았습니다.",
        "커넥터를 실행해 프로필 명단을 보고한 뒤 다시 확인하세요. 명단이 없는 상태를 정상으로 간주하지 마세요.",
      )],
      resolved: [],
      missing: [...BIBI_PROFILE_IDS],
      unexpected: [],
    };
  }

  const warnings = [];
  const resolved = [];
  const seenOrganizationIds = new Set();
  const duplicated = new Set();
  const unexpected = [];

  for (const entry of observedPhysicalProfiles) {
    const physicalId = observedId(entry);
    if (!physicalId) continue;

    // The rollback original is checked before translation, because its name
    // collides with the CEO's organisational id.
    if (physicalId === ROLLBACK_PROFILE_ID) {
      warnings.push(warning(
        MISMATCH_CODES.ROLLBACK_PROFILE_PRESENT,
        SEVERITY.WARNING,
        ROLLBACK_PROFILE_ID,
        `물리 프로필 'profiles/${ROLLBACK_PROFILE_ID}'이(가) 있습니다. 이것은 롤백 원본이며 CEO비비의 실행 프로필이 아닙니다.`,
        `CEO비비는 '${CEO_EXECUTION_PROFILE_ID}'(~/.hermes)에서 실행됩니다. 롤백 원본은 실행 대상으로 선택하지 마세요.`,
      ));
      continue;
    }

    if (isUpstreamGenericProfileId(physicalId)) {
      unexpected.push(physicalId);
      warnings.push(warning(
        MISMATCH_CODES.UPSTREAM_GENERIC_PROFILE,
        SEVERITY.BLOCKING,
        physicalId,
        `원본 앱의 일반 프로필 '${physicalId}'이(가) 감지되었습니다. 이 워크스페이스의 실제 구조는 조직 역할 bibi-01~bibi-18과 실행 프로필 default·bibi-02~bibi-18입니다.`,
        `'${physicalId}'을(를) 실제 실행 프로필로 명시적으로 다시 매핑하거나 연결에서 제외하세요.`,
      ));
      continue;
    }

    const organizationId = toOrganizationProfileId(physicalId);
    if (!organizationId) {
      unexpected.push(physicalId);
      warnings.push(warning(
        MISMATCH_CODES.UNKNOWN_PROFILE,
        SEVERITY.WARNING,
        physicalId,
        `알 수 없는 프로필 '${physicalId}'이(가) 보고되었습니다.`,
        "이 식별자가 실제 실행 프로필이라면 로스터에 명시적으로 추가하고, 아니라면 커넥터 설정에서 제거하세요.",
      ));
      continue;
    }

    if (seenOrganizationIds.has(organizationId)) {
      if (!duplicated.has(organizationId)) {
        duplicated.add(organizationId);
        warnings.push(warning(
          MISMATCH_CODES.DUPLICATE_PROFILE,
          SEVERITY.WARNING,
          physicalId,
          `'${physicalId}' 프로필이 명단에 두 번 이상 보고되었습니다.`,
          "커넥터가 같은 프로필을 중복 등록하고 있지 않은지 확인하세요. 중복은 병합되지만 원인은 남습니다.",
        ));
      }
      continue;
    }

    seenOrganizationIds.add(organizationId);
    const profile = bibiProfile(organizationId);
    // Both identities travel together from here on, so no downstream caller has
    // to re-derive one from the other.
    resolved.push({ ...profile, executionProfileId: physicalId });
  }

  resolved.sort((left, right) => left.ordinal - right.ordinal);

  const missing = BIBI_PROFILE_IDS.filter((id) => !seenOrganizationIds.has(id));

  for (const id of missing) {
    if (id === CEO_PROFILE_ID) {
      warnings.push(warning(
        MISMATCH_CODES.CEO_PROFILE_MISSING,
        SEVERITY.BLOCKING,
        id,
        `CEO비비(${CEO_PROFILE_ID})의 실행 프로필 '${CEO_EXECUTION_PROFILE_ID}'이(가) 명단에 없습니다. CEO비비는 사용자 주 소통·업무 총괄 표면이라 대체할 수 없습니다.`,
        `로컬 Mac에서 '${CEO_EXECUTION_PROFILE_ID}' 프로필(~/.hermes)이 존재하고 커넥터가 접근할 수 있는지 확인하세요.`,
      ));
      continue;
    }
    warnings.push(warning(
      MISMATCH_CODES.MISSING_BIBI_PROFILE,
      SEVERITY.WARNING,
      id,
      `${bibiProfile(id)?.displayName ?? id}(${id}) 프로필이 명단에 없습니다.`,
      "해당 프로필은 대체되지 않습니다. 로컬에서 프로필을 확인한 뒤 다시 보고하세요.",
    ));
  }

  return {
    ok: warnings.length === 0,
    blocking: warnings.some((item) => item.severity === SEVERITY.BLOCKING),
    warnings,
    resolved,
    missing,
    unexpected,
  };
}

/**
 * The report for a connector that has not reported.
 *
 * `describeProfileMismatch(null)` says ROSTER_UNAVAILABLE and blocks, and an
 * empty array says all eighteen profiles are missing. Both are true statements
 * about the data and both are the wrong thing to put on screen before any
 * connector has ever checked in: the surface already reports that state, once,
 * as UNKNOWN. Repeating it as a blocking card plus seventeen warnings reads as
 * eighteen faults where there is one fact.
 *
 * `missing` still lists the full roster, because that is what has not been
 * observed. `warnings` is empty and `reported` is false, so a caller can tell
 * "nothing is wrong" apart from "nothing is known".
 */
export function pendingProfileMismatch() {
  return {
    ok: true,
    blocking: false,
    reported: false,
    warnings: [],
    resolved: [],
    missing: [...BIBI_PROFILE_IDS],
    unexpected: [],
  };
}

/**
 * The gate the workspace uses: judge the reported roster only once there is a
 * heartbeat proving something reported it.
 *
 * @param {object} options
 * @param {Array<string|object>} [options.reportedProfileIds]
 * @param {boolean} [options.connectorReported] true only once a connector has a
 *   real heartbeat timestamp. Defaults to false, so a caller that forgets to
 *   pass it withholds rather than accuses.
 */
export function describeConnectorProfileMismatch({ reportedProfileIds, connectorReported = false } = {}) {
  if (!connectorReported) return pendingProfileMismatch();
  return { ...describeProfileMismatch(reportedProfileIds ?? []), reported: true };
}

export function mismatchSummaryText(report) {
  if (!report || report.ok) return "";
  const parts = [];

  const generic = report.warnings
    .filter((item) => item.code === MISMATCH_CODES.UPSTREAM_GENERIC_PROFILE)
    .map((item) => item.profileId);
  if (generic.length) {
    parts.push(`원본 앱 일반 프로필 ${generic.length}개(${generic.join(", ")})가 감지되었습니다.`);
  }

  if (report.warnings.some((item) => item.code === MISMATCH_CODES.ROLLBACK_PROFILE_PRESENT)) {
    parts.push(`롤백 원본 'profiles/${ROLLBACK_PROFILE_ID}'은 CEO 실행 대상이 아닙니다.`);
  }

  if (report.missing.includes(CEO_PROFILE_ID)) {
    parts.push(`CEO비비(${CEO_PROFILE_ID})의 실행 프로필 '${CEO_EXECUTION_PROFILE_ID}'이 없습니다.`);
  }

  const otherMissing = report.missing.filter((id) => id !== CEO_PROFILE_ID);
  if (otherMissing.length) {
    parts.push(`bibi 프로필 ${otherMissing.length}개가 보고되지 않았습니다.`);
  }

  parts.push(
    `이 워크스페이스가 기대하는 구조는 조직 역할 ${BIBI_PROFILE_IDS.length}개(bibi-01~bibi-18)이며, `
    + `bibi-01은 실행 프로필 '${CEO_EXECUTION_PROFILE_ID}'에 매핑됩니다.`,
  );
  return parts.join(" ");
}
