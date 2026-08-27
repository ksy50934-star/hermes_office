import { toUiProfileId } from "./src/profileIds.js";
import {
  BIBI_PROFILE_IDS,
  CEO_PROFILE_ID,
  toOrganizationProfileId,
} from "./src/bibi/roster.js";

/**
 * v1 filed members under the upstream generic departments (리더십, 운영, 브랜드 …).
 * v2 is the confirmed Bibi contract: exactly the five departments below. A
 * chart persisted under v1 is repaired by `migrateOrganizationDepartment` on
 * the way in, so a stored `leadership`/`general` never reaches the UI as a
 * department that no longer has a filter, a label or a count.
 */
export const ORGANIZATION_VERSION = 2;
export const ORGANIZATION_MAX_NODES = 100;

export const ORGANIZATION_DEPARTMENTS = [
  { id: "management", label: "관리부서" },
  { id: "execution", label: "실무부서" },
  { id: "review", label: "검수부서" },
  { id: "support", label: "지원부서" },
  { id: "recurring", label: "반복부서(크론잡)" },
];

/**
 * Where a member lands when nothing else identifies them. 지원부서 is the
 * generalist department in the contract, so it is the honest bucket for a
 * profile the chart cannot classify — it claims no authority and no delivery.
 */
export const ORGANIZATION_DEFAULT_DEPARTMENT = "support";

/**
 * The rooms a member can actually be seated in. Every entry is a real zone on
 * the calibrated floor plan (`OFFICE_FLOOR_ZONES` in `src/officeData.js`) and
 * carries that zone's id, so a chart assignment resolves to a real place on the
 * map instead of a label with nowhere to stand.
 *
 * 관제센터 and 자료실 were on the floor plan from the start but were missing
 * here, which is why work that belongs in them had nowhere to go. Their seats
 * come from the zone's own bounds, so adding them moves no coordinate.
 *
 * 회의실 and 내 책상 are deliberately absent: 회의실 is where a member goes for
 * the length of a meeting, and 내 책상 is the user's own seat. Neither is a
 * standing desk assignment, so neither can be picked in the org chart.
 */
export const ORGANIZATION_ROOMS = [
  { id: "executive", label: "대표실" },
  { id: "operations", label: "운영실" },
  { id: "control", label: "관제센터" },
  { id: "brand", label: "브랜드룸" },
  { id: "content", label: "콘텐츠룸" },
  { id: "creative", label: "크리에이티브룸" },
  { id: "library", label: "자료실" },
  { id: "customer", label: "고객 데스크" },
  { id: "tech", label: "기술실" },
  { id: "finance", label: "재무실" },
];

/**
 * Where a member lands when nothing else places them. 운영실 is the shared
 * execution floor, so it is the honest fallback for a profile the chart cannot
 * place — it claims no specialism.
 */
export const ORGANIZATION_DEFAULT_ROOM = "operations";

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
const departmentIds = new Set(ORGANIZATION_DEPARTMENTS.map((item) => item.id));
const roomIds = new Set(ORGANIZATION_ROOMS.map((item) => item.id));

/**
 * The confirmed 2/7/3/5/1 partition (BIBI-ORG-20260825-01). Each of the
 * eighteen role slots belongs to exactly one department — no member is listed
 * twice and none is left out.
 *
 * bibi-09 마케터비비 is filed under 검수부서 deliberately: on this chart the
 * marketing seat reviews and gives independent feedback on other members' work.
 * It is not a production seat, which is why it does not sit in 실무부서.
 */
export const BIBI_DEPARTMENT_ASSIGNMENTS = Object.freeze({
  // 관리부서 — 2
  "bibi-01": "management",
  "bibi-12": "management",
  // 실무부서 — 7
  "bibi-02": "execution",
  "bibi-03": "execution",
  "bibi-04": "execution",
  "bibi-05": "execution",
  "bibi-06": "execution",
  "bibi-15": "execution",
  "bibi-16": "execution",
  // 검수부서 — 3
  "bibi-09": "review",
  "bibi-10": "review",
  "bibi-14": "review",
  // 지원부서 — 5
  "bibi-07": "support",
  "bibi-08": "support",
  "bibi-13": "support",
  "bibi-17": "support",
  "bibi-18": "support",
  // 반복부서(크론잡) — 1
  "bibi-11": "recurring",
});

/**
 * Which real room each of the eighteen members sits in.
 *
 * v1 had no seating contract at all: it put the CEO in 대표실 and dropped the
 * other seventeen into 운영실, so the map showed one crowded room and eight
 * empty ones, and a member's location said nothing about their work. Each
 * assignment below is made from the member's mandate in `src/bibi/roster.js`
 * against the room's own purpose in `src/officeData.js`:
 *
 *   대표실 결정과 우선순위        bibi-01 전사 총괄
 *   운영실 일정과 실행            bibi-07 비서 실무 · bibi-18 일상 실행
 *   관제센터 시스템 상태·장애     bibi-12 런타임 운영 · bibi-17 장애 복구 · bibi-11 예약 실행
 *   브랜드룸 정체성과 메시지      bibi-09 마케팅 기획·검토
 *   콘텐츠룸 캠페인과 발행        bibi-03 · bibi-04 · bibi-05 업로드·발행
 *   크리에이티브룸 제작과 품질    bibi-06 시각 제작 · bibi-10 독립 검수
 *   자료실 문서와 산출물          bibi-13 지식 · bibi-14 리서치 · bibi-15 서류
 *   고객 데스크 상담과 경험       bibi-08 심리·회고 상담
 *   기술실 자동화와 개발          bibi-02 개발·자동화
 *   재무실 매출과 KPI             bibi-16 사업개발·전략
 *
 * Every room in `ORGANIZATION_ROOMS` receives at least one member and no room
 * is given more members than it has seats, so the office map can place all
 * eighteen without borrowing a seat from another room.
 */
export const BIBI_ROOM_ASSIGNMENTS = Object.freeze({
  "bibi-01": "executive",
  "bibi-07": "operations",
  "bibi-18": "operations",
  "bibi-12": "control",
  "bibi-17": "control",
  "bibi-11": "control",
  "bibi-09": "brand",
  "bibi-03": "content",
  "bibi-04": "content",
  "bibi-05": "content",
  "bibi-06": "creative",
  "bibi-10": "creative",
  "bibi-13": "library",
  "bibi-14": "library",
  "bibi-15": "library",
  "bibi-08": "customer",
  "bibi-02": "tech",
  "bibi-16": "finance",
});

/**
 * Chart wording the roster title alone would get wrong. Only bibi-09 needs it:
 * the roster names them 마케터비비, but the organisation runs that seat as the
 * marketing reviewer, so the card must not read as a production assignment.
 * The roster mandate in `src/bibi/roster.js` stays the canonical transcription
 * of `profile.json`; this overrides only how the org chart labels the function.
 */
export const ORGANIZATION_MEMBER_FUNCTIONS = Object.freeze({
  "bibi-09": "마케팅 검토·피드백 전문 · 제작 담당 아님",
});

/**
 * v1 department id → v2 department. Explicit and total: every id v1 could
 * persist has a declared destination, so a migrated chart never falls back to
 * a guess for a value this product actually shipped.
 */
export const LEGACY_DEPARTMENT_MIGRATION = Object.freeze({
  leadership: "management",
  operations: "management",
  brand: "execution",
  content: "execution",
  creative: "execution",
  growth: "execution",
  technology: "execution",
  customer: "support",
  finance: "support",
  general: "support",
});

/**
 * Resolve the department a persisted node must be filed under.
 *
 *  - a v2 department is already correct and is kept, so a department the user
 *    chose by hand survives the migration instead of being overwritten;
 *  - one of the eighteen role slots falls back to its contract department;
 *  - anything else follows the v1 → v2 table, then 지원부서.
 */
export function migrateOrganizationDepartment(id, department) {
  if (departmentIds.has(department)) return department;
  const slot = toUiProfileId(String(id ?? "").trim());
  return BIBI_DEPARTMENT_ASSIGNMENTS[slot]
    ?? LEGACY_DEPARTMENT_MIGRATION[department]
    ?? ORGANIZATION_DEFAULT_DEPARTMENT;
}

/**
 * Resolve the room a single node is seated in. A room that still exists is
 * kept, so a seat the user chose by hand survives; anything else falls back to
 * the member's contract room, then to 운영실.
 *
 * This alone cannot undo the v1 collapse, because v1 stored `operations` and
 * `operations` is still a real room — it is indistinguishable from a deliberate
 * choice one node at a time. `migrateOrganizationRooms` looks at the whole
 * chart to tell the two apart.
 */
export function migrateOrganizationRoom(id, roomId) {
  if (roomIds.has(roomId)) return roomId;
  const slot = toUiProfileId(String(id ?? "").trim());
  return BIBI_ROOM_ASSIGNMENTS[slot] ?? ORGANIZATION_DEFAULT_ROOM;
}

/**
 * True when the chart still carries the exact seating v1 produced: the CEO in
 * 대표실 and every other Bibi member in 운영실, with no one anywhere else.
 *
 * That shape is what `buildCanonicalBibiOrganizationNodes` used to emit, so
 * recognising it is what lets the seating contract be applied to charts that
 * never had one — without touching a chart the user has actually arranged. One
 * member moved out of 운영실 is enough to make this false, and from then on the
 * arrangement is treated as the user's and left alone.
 */
export function organizationHasCollapsedRooms(nodes) {
  if (!Array.isArray(nodes)) return false;
  const members = nodes
    .map((node) => ({ id: toUiProfileId(String(node?.id ?? "").trim()), roomId: node?.roomId }))
    .filter((node) => BIBI_ROOM_ASSIGNMENTS[node.id]);
  const others = members.filter((node) => node.id !== CEO_PROFILE_ID);
  if (others.length === 0) return false;
  return others.every((node) => node.roomId === ORGANIZATION_DEFAULT_ROOM)
    && members.every((node) => node.id !== CEO_PROFILE_ID || node.roomId === "executive");
}

/**
 * Seat a chart that never had a seating contract. Returns the same nodes
 * untouched unless the v1 collapse is present, in which case every Bibi member
 * takes its contract room. Non-Bibi nodes are never moved: they have no
 * contract room to move to.
 */
export function migrateOrganizationRooms(nodes) {
  if (!organizationHasCollapsedRooms(nodes)) return nodes;
  return nodes.map((node) => {
    const room = BIBI_ROOM_ASSIGNMENTS[toUiProfileId(String(node?.id ?? "").trim())];
    return room ? { ...node, roomId: room } : node;
  });
}

/** The label to show for a department id, including one already migrated away. */
export function organizationDepartmentLabel(id) {
  const department = ORGANIZATION_DEPARTMENTS.find((item) => item.id === id)
    ?? ORGANIZATION_DEPARTMENTS.find((item) => item.id === ORGANIZATION_DEFAULT_DEPARTMENT);
  return department.label;
}

/** The chart-specific function line for a member, or "" to use the roster role. */
export function organizationMemberFunction(id) {
  return ORGANIZATION_MEMBER_FUNCTIONS[toUiProfileId(String(id ?? "").trim())] ?? "";
}

function profileId(profile) {
  return toUiProfileId(String(typeof profile === "string" ? profile : profile?.name ?? profile?.id ?? "").trim());
}

function defaultMetadata(id) {
  // Reporting lines and office rooms are unchanged from v1; only the department
  // each generic Hermes profile is filed under moves onto the five-department
  // contract, using the same v1 → v2 mapping a persisted chart gets.
  const presets = {
    default: { parentId: null, department: "management", roomId: "executive", order: 0 },
    "hermes-operations": { parentId: "default", department: "management", roomId: "operations", order: 0 },
    "hermes-technology": { parentId: "default", department: "execution", roomId: "tech", order: 1 },
    "hermes-brand": { parentId: "hermes-operations", department: "execution", roomId: "brand", order: 0 },
    "hermes-growth": { parentId: "hermes-operations", department: "execution", roomId: "content", order: 1 },
    "hermes-customer": { parentId: "hermes-operations", department: "support", roomId: "customer", order: 2 },
    "hermes-finance": { parentId: "hermes-operations", department: "support", roomId: "finance", order: 3 },
    "hermes-creative": { parentId: "hermes-brand", department: "execution", roomId: "creative", order: 0 },
    "hermes-content": { parentId: "hermes-growth", department: "execution", roomId: "content", order: 0 },
  };
  return presets[id] ?? { parentId: "default", department: ORGANIZATION_DEFAULT_DEPARTMENT, roomId: "operations", order: 99 };
}

export function buildDefaultOrganizationNodes(profiles = []) {
  const ids = [...new Set(profiles.map(profileId).filter(Boolean))];
  if (!ids.length) return [];
  const rootId = ids.includes("default") ? "default" : ids[0];
  return ids.map((id, index) => {
    const preset = defaultMetadata(id);
    const configuredParent = preset.parentId && ids.includes(preset.parentId) ? preset.parentId : rootId;
    return {
      id,
      parentId: id === rootId ? null : (configuredParent === id ? rootId : configuredParent),
      department: preset.department,
      roomId: preset.roomId,
      order: preset.order === 99 ? index : preset.order,
    };
  });
}

/**
 * Build the authoritative Bibi chart with organizational role IDs. The CEO's
 * physical executor is `default`, but the visible and durable role is bibi-01.
 * A partial connector report is rejected rather than becoming a truncated
 * organization chart. Departments come from the confirmed 2/7/3/5/1 contract,
 * reporting lines stay flat under the CEO as `profile.json` declares.
 */
export function buildCanonicalBibiOrganizationNodes(profiles = []) {
  if (!Array.isArray(profiles) || profiles.length !== BIBI_PROFILE_IDS.length) {
    throw new Error("Canonical Bibi organization requires exactly bibi-01 through bibi-18.");
  }
  const ids = profiles.map((profile) => {
    const raw = String(typeof profile === "string" ? profile : profile?.name ?? profile?.id ?? "").trim();
    return toOrganizationProfileId(raw) ?? (BIBI_PROFILE_IDS.includes(raw) ? raw : null);
  });
  const complete = ids.every(Boolean)
    && new Set(ids).size === BIBI_PROFILE_IDS.length
    && BIBI_PROFILE_IDS.every((id) => ids.includes(id));
  if (!complete) {
    throw new Error("Canonical Bibi organization requires exactly bibi-01 through bibi-18.");
  }

  return BIBI_PROFILE_IDS.map((id, index) => ({
    id,
    parentId: id === CEO_PROFILE_ID ? null : CEO_PROFILE_ID,
    department: BIBI_DEPARTMENT_ASSIGNMENTS[id],
    roomId: BIBI_ROOM_ASSIGNMENTS[id],
    order: index,
  }));
}

function canonicalNode(raw, index) {
  const id = String(raw?.id ?? "").trim();
  if (!PROFILE_ID_PATTERN.test(id)) throw new Error(`Invalid Hermes profile id at node ${index}.`);
  const parentId = raw?.parentId == null || raw.parentId === "" ? null : String(raw.parentId).trim();
  if (parentId !== null && !PROFILE_ID_PATTERN.test(parentId)) throw new Error(`Invalid parent profile id for ${id}.`);
  const department = migrateOrganizationDepartment(id, raw?.department);
  const roomId = migrateOrganizationRoom(id, raw?.roomId);
  const order = Number.isInteger(raw?.order) ? Math.max(0, Math.min(999, raw.order)) : index;
  return { id, parentId, department, roomId, order };
}

export function validateOrganizationNodes(nodes, { allowEmpty = true } = {}) {
  if (!Array.isArray(nodes)) throw new Error("Organization nodes must be an array.");
  if (!allowEmpty && nodes.length === 0) throw new Error("Organization must contain at least one profile.");
  if (nodes.length > ORGANIZATION_MAX_NODES) throw new Error(`Organization supports up to ${ORGANIZATION_MAX_NODES} profiles.`);
  // Seating is decided across the whole chart, not node by node: only the chart
  // can tell v1's "everyone in 운영실" apart from a room the user chose.
  const seated = migrateOrganizationRooms(nodes);
  const parsed = seated.map((raw, index) => ({ node: canonicalNode(raw, index), sourceId: String(raw?.id ?? "").trim() }));
  const exactIds = new Set();
  for (const { sourceId } of parsed) {
    if (exactIds.has(sourceId)) throw new Error(`Duplicate organization profile: ${sourceId}`);
    exactIds.add(sourceId);
  }
  const normalized = new Map();
  for (const { node, sourceId } of parsed) {
    const id = toUiProfileId(node.id);
    const mappedParentId = node.parentId ? toUiProfileId(node.parentId) : null;
    const candidate = { ...node, id, parentId: mappedParentId === id ? null : mappedParentId };
    const existing = normalized.get(id);
    if (!existing || sourceId === id) normalized.set(id, { node: candidate, sourceId });
  }
  const canonical = [...normalized.values()].map(({ node }) => node);
  const byId = new Map();
  for (const node of canonical) {
    byId.set(node.id, node);
  }
  for (const node of canonical) {
    if (node.parentId === node.id) throw new Error(`${node.id} cannot report to itself.`);
    if (node.parentId && !byId.has(node.parentId)) throw new Error(`Unknown parent ${node.parentId} for ${node.id}.`);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error("Organization hierarchy cannot contain a reporting cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    const parentId = byId.get(id)?.parentId;
    if (parentId) visit(parentId);
    visiting.delete(id);
    visited.add(id);
  };
  canonical.forEach((node) => visit(node.id));
  return canonical.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/**
 * True when what is stored is not what `validateOrganizationNodes` produces —
 * a v1 department, a stale profile alias, a dropped parent link. Callers use
 * it to decide whether the migrated chart has to be written back, so a stored
 * chart is repaired once rather than re-normalised on every single load.
 *
 * An unusable chart returns false: that is a load failure to surface, not a
 * migration to persist over the only copy of the structure.
 */
export function organizationRequiresMigration(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return false;
  let canonical;
  try {
    canonical = validateOrganizationNodes(nodes);
  } catch {
    return false;
  }
  if (canonical.length !== nodes.length) return true;
  const signature = (node) => [node.id, node.parentId ?? "", node.department, node.roomId, node.order].join("|");
  const stored = nodes
    .map((raw) => ({
      id: String(raw?.id ?? "").trim(),
      parentId: raw?.parentId == null || raw.parentId === "" ? null : String(raw.parentId).trim(),
      department: raw?.department,
      roomId: raw?.roomId,
      order: raw?.order,
    }))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map(signature);
  return canonical.map(signature).join("\n") !== stored.join("\n");
}

export function organizationDescendants(nodes, profileIdValue) {
  const children = new Map();
  for (const node of nodes) {
    const items = children.get(node.parentId) ?? [];
    items.push(node.id);
    children.set(node.parentId, items);
  }
  const descendants = new Set();
  const visit = (id) => {
    for (const child of children.get(id) ?? []) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      visit(child);
    }
  };
  visit(toUiProfileId(profileIdValue));
  return descendants;
}

export function organizationReportingContext(nodes, profileIdValue) {
  const current = validateOrganizationNodes(nodes);
  const byId = new Map(current.map((node) => [node.id, node]));
  const selected = byId.get(toUiProfileId(profileIdValue));
  if (!selected) {
    return { managerId: null, directReportIds: [], escalationPathIds: [], depth: 0 };
  }

  const escalationPathIds = [];
  let cursor = selected;
  while (cursor) {
    escalationPathIds.unshift(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
  }

  return {
    managerId: selected.parentId,
    directReportIds: current
      .filter((node) => node.parentId === selected.id)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map((node) => node.id),
    escalationPathIds,
    depth: Math.max(0, escalationPathIds.length - 1),
  };
}

export function organizationVisibleNodeIds(nodes, department = "all") {
  const current = validateOrganizationNodes(nodes);
  if (department === "all") return new Set(current.map((node) => node.id));

  const byId = new Map(current.map((node) => [node.id, node]));
  const visible = new Set();
  for (const node of current.filter((item) => item.department === department)) {
    let cursor = node;
    while (cursor && !visible.has(cursor.id)) {
      visible.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
    }
  }
  return visible;
}

export function moveOrganizationNode(nodes, id, parentId) {
  const current = validateOrganizationNodes(nodes);
  id = toUiProfileId(id);
  parentId = parentId ? toUiProfileId(parentId) : null;
  if (!current.some((node) => node.id === id)) throw new Error(`Unknown profile: ${id}`);
  if (parentId && !current.some((node) => node.id === parentId)) throw new Error(`Unknown parent: ${parentId}`);
  if (parentId === id || organizationDescendants(current, id).has(parentId)) {
    throw new Error("하위 구성원 아래로 이동하면 순환 보고선이 만들어집니다.");
  }
  return validateOrganizationNodes(current.map((node) => node.id === id ? { ...node, parentId } : node));
}

export function addOrganizationNode(nodes, id, options = {}) {
  const current = validateOrganizationNodes(nodes);
  id = toUiProfileId(id);
  if (current.some((node) => node.id === id)) throw new Error("이미 조직도에 포함된 구성원입니다.");
  return validateOrganizationNodes([...current, {
    id,
    parentId: options.parentId ? toUiProfileId(options.parentId) : current.find((node) => node.parentId === null)?.id ?? null,
    department: options.department ?? ORGANIZATION_DEFAULT_DEPARTMENT,
    roomId: options.roomId ?? "operations",
    order: options.order ?? current.length,
  }]);
}

export function removeOrganizationNode(nodes, id) {
  const current = validateOrganizationNodes(nodes);
  id = toUiProfileId(id);
  const removed = current.find((node) => node.id === id);
  if (!removed) return current;
  return validateOrganizationNodes(current
    .filter((node) => node.id !== id)
    .map((node) => node.parentId === id ? { ...node, parentId: removed.parentId } : node));
}

export function organizationRoomAssignments(nodes = []) {
  return Object.fromEntries(validateOrganizationNodes(nodes).map((node) => [node.id, node.roomId]));
}
