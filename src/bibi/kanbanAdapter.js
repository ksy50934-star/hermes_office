/**
 * The work board, backed by the canonical projection.
 *
 * Tasks carry their real canonical status — `intake`, `assigned`, `leased`,
 * `running`, `blocked`, `succeeded`, `failed`, `cancelled` — rather than being
 * remapped into the legacy Hermes board's vocabulary. The remapping was how
 * `failed` came to sit in a column labelled 검토 and how `leased` and `running`
 * were merged, and it made the board's copy describe transitions the work API
 * does not support.
 */

import { fileWork, loadWorkItems, transitionWork } from "../cloud/workspaceClient.js";
import {
  BOARD_COLUMNS,
  boardMovePlan,
  projectOfficeWork,
  projectWorkBoard,
} from "./officeProjection.js";
import { isTerminalStatus } from "./workLifecycle.js";

/** One projected card in the shape the board component renders. */
function toTask(card) {
  return {
    id: card.id,
    title: card.title,
    titleMissing: card.titleMissing,
    body: card.brief ?? "",
    status: card.status,
    statusLabel: card.statusLabel,
    statusMeaning: card.statusMeaning,
    assignee: card.profileId,
    assigneeLabel: card.assigneeLabel,
    terminal: card.terminal,
    priority: card.status === "blocked" || card.status === "failed" ? 1 : 0,
    created_at: card.createdAt,
    updated_at: card.updatedAt,
    stageLabel: card.stage.label,
    blockedReason: card.blockedReason,
    error: card.error,
    hasResult: card.hasResult,
    attempt: card.attempt,
    actions: card.actions,
    navigation: card.navigation,
    metadata: {
      cloud: true,
      cloud_status: card.status,
      attempt: card.attempt,
      blocked_reason: card.blockedReason,
      error: card.error,
      completed_at: card.terminal ? card.updatedAt : null,
      // Cloud work has no checklist and no board-local event log; the real
      // timeline is `work_events`, read on demand from the work detail.
      task_events: [],
      checklist: [],
    },
  };
}

/**
 * Board columns and cards from one already-read set of work items.
 *
 * Exported so a caller holding the workspace snapshot can render the board
 * without a second fetch — which is what makes a realtime event reach the board
 * immediately instead of on its next poll.
 */
export function cloudBoard(workItems, { connectorHealth = null, loaded = true, error = "", lastSyncAt = null, now = Date.now() } = {}) {
  const projection = projectOfficeWork({
    workItems,
    connectorHealth,
    loaded,
    error,
    lastSyncAt,
    now,
  });
  const board = projectWorkBoard(projection);
  return {
    projection,
    board,
    columns: board.columns.map((column) => ({
      name: column.status,
      tasks: column.cards.map(toTask),
    })),
  };
}

export function createBibiKanbanAdapter({ ownerId, onRefresh }) {
  const read = async () => loadWorkItems({ limit: 300 });

  return {
    /** The board renders these instead of the legacy Hermes column list. */
    canonical: true,
    columns: BOARD_COLUMNS,

    async loadBoard({ connectorHealth = null } = {}) {
      const items = await read();
      const { projection, columns } = cloudBoard(items, {
        connectorHealth,
        loaded: true,
        lastSyncAt: new Date().toISOString(),
      });
      const stats = {
        total: projection.counts.total,
        active: projection.counts.active,
        blocked: projection.counts.blocked,
        completed: projection.counts.succeeded,
      };
      return [
        { columns },
        { source: "bibi-cloud", ok: true, excluded: projection.excluded },
        stats,
        { workers: projection.running },
        projection,
      ];
    },

    async createTask({ title, assignee }) {
      await fileWork({ ownerId, profileId: assignee || "bibi-01", title, brief: "업무 보드에서 생성" });
      await onRefresh?.();
    },

    async dispatch() {
      // There is no owner-side dispatch. The connector leases assigned work on
      // its own schedule; pretending to push it would be a button that lies.
      await onRefresh?.();
    },

    /**
     * Move one card, through the owner-scoped transition API only.
     *
     * The current row is re-read first so a card the user has been looking at
     * for a minute cannot be moved on the strength of a stale status.
     */
    async patchTask(task, patch) {
      const items = await read();
      const current = items.find((item) => item.id === task.id);
      if (!current) throw new Error("Bibi Cloud에서 최신 업무를 찾지 못했습니다.");
      if (isTerminalStatus(current.status)) {
        throw new Error("종료된 실제 업무는 보드에서 다시 이동할 수 없습니다.");
      }

      const { projection } = cloudBoard(items, { loaded: true });
      const card = projection.byId.get(current.id);
      const plan = boardMovePlan(card, patch.status ?? current.status, {
        profileId: patch.assignee || current.profile_id,
        reason: patch.metadata?.blocked_reason ?? patch.metadata?.status_note ?? "",
      });

      await transitionWork({
        workItemId: current.id,
        type: plan.type,
        profileId: plan.profileId ?? null,
        reason: plan.reason ?? null,
      });
      await onRefresh?.();

      const refreshed = (await read()).find((item) => item.id === current.id) ?? current;
      const next = cloudBoard([refreshed], { loaded: true }).projection.byId.get(refreshed.id);
      return { task: next ? toTask(next) : task, payload: plan };
    },
  };
}
