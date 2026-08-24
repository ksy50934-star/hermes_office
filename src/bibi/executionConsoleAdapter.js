import { fileWork, loadWorkDetail } from "../cloud/workspaceClient.js";

export function createCloudExecutionConsoleAdapter({ ownerId, roster = [], workItems = [], runtime = { health: [] }, connector = null } = {}) {
  return {
    backend: "bibi-cloud",
    ownerId,
    profiles: roster.map((profile) => ({
      id: profile.id,
      label: profile.display_name ?? profile.id,
      executionProfile: profile.execution_profile,
    })),
    health: runtime.health ?? [],
    connector,
    commands: workItems,
    async submit({ profileId, title, brief }) {
      if (!ownerId) throw new Error("인증된 owner가 없습니다.");
      return fileWork({ ownerId, profileId, title, brief });
    },
    async loadDetail(workItemId) {
      return {
        item: workItems.find((item) => item.id === workItemId) ?? null,
        ...await loadWorkDetail(workItemId),
      };
    },
  };
}
