import { fileWork, loadWorkItems, transitionWork } from "../cloud/workspaceClient.js";

const COLUMNS = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"];
const CLOUD_TO_BOARD = Object.freeze({
  intake: "triage",
  assigned: "todo",
  leased: "ready",
  running: "running",
  blocked: "blocked",
  succeeded: "done",
  failed: "review",
  cancelled: "done",
});

function toTask(item) {
  return {
    id: item.id,
    title: item.title,
    body: item.brief || item.error || item.blocked_reason || "",
    status: CLOUD_TO_BOARD[item.status] ?? "triage",
    assignee: item.profile_id || "bibi-01",
    priority: ["blocked", "failed"].includes(item.status) ? 1 : 0,
    created_at: item.created_at,
    updated_at: item.updated_at,
    metadata: {
      cloud: true,
      cloud_status: item.status,
      attempt: item.attempt,
      blocked_reason: item.blocked_reason,
      error: item.error,
      completed_at: ["succeeded", "failed", "cancelled"].includes(item.status) ? item.updated_at : null,
      task_events: [],
      checklist: [],
    },
  };
}

export function cloudBoard(workItems) {
  const tasks = workItems.map(toTask);
  return {
    columns: COLUMNS.map((name) => ({ name, tasks: tasks.filter((task) => task.status === name) })),
  };
}

export function createBibiKanbanAdapter({ ownerId, onRefresh }) {
  const read = async () => loadWorkItems({ limit: 300 });
  return {
    async loadBoard() {
      const items = await read();
      const active = items.filter((item) => ["leased", "running"].includes(item.status));
      const stats = {
        total: items.length,
        active: active.length,
        blocked: items.filter((item) => item.status === "blocked").length,
        completed: items.filter((item) => item.status === "succeeded").length,
      };
      return [cloudBoard(items), { source: "bibi-cloud", ok: true }, stats, { workers: active }];
    },
    async createTask({ title, assignee }) {
      await fileWork({ ownerId, profileId: assignee || "bibi-01", title, brief: "업무 보드에서 생성" });
      await onRefresh?.();
    },
    async dispatch() {
      await onRefresh?.();
    },
    async patchTask(task, patch, metadataForTask) {
      const items = await read();
      const current = items.find((item) => item.id === task.id);
      if (!current) throw new Error("Bibi Cloud에서 최신 업무를 찾지 못했습니다.");
      if (["succeeded", "failed", "cancelled"].includes(current.status)) {
        throw new Error("종료된 실제 업무는 보드에서 다시 이동할 수 없습니다.");
      }

      const target = patch.status ?? task.status;
      const nextAssignee = patch.assignee || current.profile_id || "bibi-01";
      if (target === "done" || target === "review") {
        throw new Error("완료와 검토 상태는 Hermes worker의 실제 결과로만 전환됩니다.");
      }
      if (target === "scheduled") {
        throw new Error("예약 실행은 크론비비의 실제 예약 계약으로 연결한 뒤 사용할 수 있습니다.");
      }
      if (target === "blocked") {
        await transitionWork({ workItemId: current.id, type: "block", reason: patch.metadata?.blocked_reason || patch.metadata?.status_note || "업무 보드에서 보류" });
      } else {
        if (current.status === "blocked") await transitionWork({ workItemId: current.id, type: "unblock" });
        if (current.status === "intake" || nextAssignee !== current.profile_id || current.status === "blocked") {
          await transitionWork({ workItemId: current.id, type: "assign", profileId: nextAssignee });
        }
      }
      await onRefresh?.();
      const refreshed = (await read()).find((item) => item.id === current.id) ?? current;
      const nextTask = toTask(refreshed);
      nextTask.metadata = metadataForTask ? metadataForTask(nextTask) : nextTask.metadata;
      return { task: nextTask, payload: patch };
    },
  };
}
