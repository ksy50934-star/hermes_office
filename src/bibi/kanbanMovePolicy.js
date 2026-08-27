function taskStatus(task) {
  return task?.status ?? task?.metadata?.status ?? "todo";
}

/**
 * Pure movement policy shared by the rendered board and behavioral tests.
 * Legacy review cards remain terminal. Canonical Cloud cards may move only
 * through explicit owner actions exposed by the adapter.
 */
export function canMoveBoardTask(task, targetStatus, { column, canonical = false } = {}) {
  if (!task || task.terminal || taskStatus(task) === targetStatus || !column?.manual) return false;
  if (!canonical) return taskStatus(task) !== "review" && targetStatus !== "review";
  if (targetStatus === "assigned") return Boolean(task.actions?.assign || task.actions?.unblock);
  if (targetStatus === "blocked") return Boolean(task.actions?.block);
  if (targetStatus === "cancelled") return Boolean(task.actions?.cancel);
  return false;
}
