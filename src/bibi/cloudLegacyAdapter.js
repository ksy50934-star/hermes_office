import { CONNECTOR_STATE, describeProfileAvailability } from "./connectionState.js";
import { ceoFirstRoster } from "./roster.js";

const STATUS_TO_MISSION = Object.freeze({
  intake: "queued",
  assigned: "queued",
  leased: "working",
  running: "working",
  blocked: "approval",
  succeeded: "done",
  failed: "approval",
  cancelled: "done",
});

const STATUS_TO_PROGRESS = Object.freeze({
  intake: 5,
  assigned: 15,
  leased: 35,
  running: 65,
  blocked: 55,
  succeeded: 100,
  failed: 100,
  cancelled: 100,
});

const STATUS_TO_ACTIVITY = Object.freeze({
  intake: ["idle", "업무 접수 대기"],
  assigned: ["working", "배정된 업무 확인 중"],
  leased: ["working", "실행 준비 중"],
  running: ["working", "업무 실행 중"],
  blocked: ["approval", "결정 또는 지원 대기"],
  succeeded: ["idle", "최근 업무 완료"],
  failed: ["approval", "실패 원인 확인 필요"],
  cancelled: ["idle", "업무 취소됨"],
});

function localRosterRows() {
  return ceoFirstRoster().map((entry) => ({
    id: entry.id,
    ordinal: entry.ordinal,
    execution_profile: entry.executionProfileId,
    display_name: entry.displayName,
    role: entry.role,
    mandate: entry.mandate,
    reports_to: entry.reportsTo,
    is_primary_surface: entry.isPrimarySurface,
  }));
}

export function normalizedCloudRoster(rows = []) {
  return rows.length ? rows : localRosterRows();
}

export function cloudProfiles(snapshot = {}) {
  const roster = normalizedCloudRoster(snapshot.roster);
  const connector = snapshot.connector ?? {};
  return roster.map((entry) => {
    const availability = describeProfileAvailability({
      profileId: entry.id,
      health: connector.health,
      reportedProfileIds: connector.reportedProfileIds,
    });
    return {
      name: entry.id,
      id: entry.id,
      display_name: entry.display_name,
      description: entry.mandate || entry.role,
      role: entry.role,
      model: `Hermes · ${entry.execution_profile}`,
      execution_profile: entry.execution_profile,
      gateway_running: availability.available,
      available: availability.available,
      status: availability.available ? "online" : connector.health?.state ?? CONNECTOR_STATE.UNKNOWN,
      availability,
    };
  });
}

export function cloudMissions(workItems = []) {
  return workItems.map((item) => ({
    id: item.id,
    title: item.title || "제목 없는 업무",
    objective: item.brief || item.error || item.blocked_reason || "Bibi Workspace에서 접수된 실제 업무입니다.",
    owner: item.profile_id || "bibi-01",
    room: item.kind === "meeting" ? "meeting" : "operations",
    status: STATUS_TO_MISSION[item.status] ?? "queued",
    officialStatus: item.status,
    progress: STATUS_TO_PROGRESS[item.status] ?? 0,
    due: item.updated_at ? new Intl.DateTimeFormat("ko", { month: "short", day: "numeric" }).format(new Date(item.updated_at)) : "기한 미정",
    priority: item.status === "blocked" || item.status === "failed" ? "high" : "normal",
    steps: [],
    metadata: {
      cloud: true,
      kind: item.kind,
      attempt: item.attempt,
      result_id: item.result_id,
      blocked_reason: item.blocked_reason,
      error: item.error,
    },
  }));
}

export function cloudActivities(profiles = [], workItems = []) {
  const latest = new Map();
  for (const item of workItems) {
    if (!item.profile_id || latest.has(item.profile_id)) continue;
    latest.set(item.profile_id, item);
  }
  return Object.fromEntries(profiles.map((profile) => {
    const item = latest.get(profile.name);
    const [state, fallback] = STATUS_TO_ACTIVITY[item?.status] ?? ["idle", "새 업무 대기 중"];
    return [profile.name, {
      state,
      text: item?.title || fallback,
      updatedAt: item?.updated_at || item?.created_at || null,
      workItemId: item?.id || null,
    }];
  }));
}

export function cloudWorkspace(snapshot = {}) {
  const profiles = cloudProfiles(snapshot);
  const sessions = (snapshot.archive ?? []).map((conversation) => ({
    id: conversation.id,
    profile: conversation.profile_id,
    title: conversation.title || conversation.messages?.[0]?.body || "제목 없는 대화",
    preview: conversation.messages?.at(-1)?.body || "",
    message_count: conversation.messages?.length || 0,
    last_active: Date.parse(conversation.last_message_at || conversation.created_at || 0) / 1000,
    source: "bibi-cloud",
  }));
  return {
    profiles,
    sessions,
    stats: {
      profiles: profiles.length,
      online: profiles.filter((profile) => profile.gateway_running).length,
      sessions: sessions.length,
      active_work: (snapshot.workItems ?? []).filter((item) => !["succeeded", "failed", "cancelled"].includes(item.status)).length,
    },
    source: "bibi-cloud",
  };
}

export function cloudOfficeState(snapshot = {}) {
  const workspace = cloudWorkspace(snapshot);
  const missions = cloudMissions(snapshot.workItems ?? []);
  const activities = cloudActivities(workspace.profiles, snapshot.workItems ?? []);
  return { workspace, profiles: workspace.profiles, missions, activities };
}
