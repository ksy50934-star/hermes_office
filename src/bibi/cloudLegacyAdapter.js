/**
 * The seam between the cloud snapshot and the upstream Office surfaces.
 *
 * Everything about *work* here comes out of `officeProjection`, which reads only
 * `kind = "work"` rows and refuses to invent a stage, a percentage or a due
 * date. This module's own job is narrow: rename the projection's fields into
 * the shape the upstream Office components already consume, and say nothing the
 * projection did not.
 */

import { CONNECTOR_STATE, describeProfileAvailability } from "./connectionState.js";
import {
  WORK_STATUS_LABELS,
  describeProfileWork,
  projectOfficeWork,
} from "./officeProjection.js";
import { WORK_STATUS } from "./workLifecycle.js";
import { ceoFirstRoster } from "./roster.js";

/**
 * The tone class the Office stylesheet already knows, per canonical status.
 * This is presentation only — the status itself is never renamed or merged.
 */
export const STATUS_TONE = Object.freeze({
  [WORK_STATUS.INTAKE]: "queued",
  [WORK_STATUS.ASSIGNED]: "queued",
  [WORK_STATUS.LEASED]: "working",
  [WORK_STATUS.RUNNING]: "working",
  [WORK_STATUS.BLOCKED]: "approval",
  [WORK_STATUS.SUCCEEDED]: "done",
  [WORK_STATUS.FAILED]: "approval",
  [WORK_STATUS.CANCELLED]: "done",
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

/**
 * The canonical projection, built once per snapshot. Every other export here
 * reads from it, so the Office, the right-hand panel and the board can never be
 * looking at differently-filtered work.
 */
export function cloudWorkProjection(snapshot = {}, { now = Date.now() } = {}) {
  return projectOfficeWork({
    // `null` and `[]` are different: the first means "not read yet", which is
    // what the projection turns into an explicit loading state.
    workItems: snapshot.ownerId ? snapshot.workItems ?? null : null,
    meetings: snapshot.meetings ?? [],
    connectorHealth: snapshot.connector?.health ?? null,
    roster: normalizedCloudRoster(snapshot.roster),
    loaded: Boolean(snapshot.ownerId) && Array.isArray(snapshot.workItems),
    error: snapshot.error ?? "",
    lastSyncAt: snapshot.syncedAt ?? null,
    now,
  });
}

/**
 * Projection cards in the field names the upstream Office components read.
 *
 * `due` is absent on purpose. There is no due date anywhere in the work schema,
 * and the previous version of this function formatted `updated_at` into a date
 * and labelled it 기한 — a last-modified timestamp presented as a deadline.
 */
export function cloudMissions(projection) {
  return (projection?.cards ?? []).map((card) => ({
    id: card.id,
    title: card.title,
    titleMissing: card.titleMissing,
    objective: card.brief,
    owner: card.profileId,
    ownerLabel: card.assigneeLabel,
    room: "operations",
    status: card.status,
    statusLabel: card.statusLabel,
    statusMeaning: card.statusMeaning,
    statusTone: STATUS_TONE[card.status] ?? "queued",
    officialStatus: card.status,
    terminal: card.terminal,
    active: card.active,
    // No checklist exists on a cloud work item, so there is no evidence from
    // which a percentage could be computed. The lifecycle stage is what is
    // actually known.
    progress: null,
    stage: card.stage,
    stageLabel: card.stage.label,
    updatedAt: card.updatedAt,
    createdAt: card.createdAt,
    attempt: card.attempt,
    blockedReason: card.blockedReason,
    error: card.error,
    hasResult: card.hasResult,
    actions: card.actions,
    navigation: card.navigation,
    priority: card.status === WORK_STATUS.BLOCKED || card.status === WORK_STATUS.FAILED ? "high" : "normal",
    steps: [],
    metadata: { cloud: true, kind: card.kind, attempt: card.attempt, result_id: card.resultId },
  }));
}

/**
 * What each profile is doing, from work rows alone.
 *
 * A profile with no work reports `text: null`. Callers must render their own
 * explanation of the absence; there is no stock activity sentence to hand out.
 */
export function cloudActivities(profiles = [], projection = null) {
  return Object.fromEntries(profiles.map((profile) => {
    const work = describeProfileWork(projection, profile.name);
    return [profile.name, {
      state: work.current
        ? work.current.status === WORK_STATUS.BLOCKED ? "approval" : "working"
        : "idle",
      text: work.headline,
      meaning: work.headlineMeaning,
      status: work.state,
      statusLabel: work.state ? WORK_STATUS_LABELS[work.state] : null,
      updatedAt: work.current?.updatedAt ?? work.lastFinished?.updatedAt ?? null,
      workItemId: work.current?.id ?? null,
      activeCount: work.counts.active,
      assignedCount: work.counts.assigned,
    }];
  }));
}

export function cloudWorkspace(snapshot = {}, projection = null) {
  const profiles = cloudProfiles(snapshot);
  const sessions = (snapshot.archive ?? []).map((conversation) => ({
    id: conversation.id,
    profile: conversation.profile_id,
    title: conversation.title || conversation.messages?.[0]?.body || null,
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
      active_work: projection?.counts.active ?? 0,
    },
    source: "bibi-cloud",
  };
}

export function cloudOfficeState(snapshot = {}, { now = Date.now() } = {}) {
  const projection = cloudWorkProjection(snapshot, { now });
  const workspace = cloudWorkspace(snapshot, projection);
  return {
    projection,
    workspace,
    profiles: workspace.profiles,
    missions: cloudMissions(projection),
    activities: cloudActivities(workspace.profiles, projection),
  };
}
