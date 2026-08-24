function archiveSession(row) {
  return {
    id: row.id,
    title: row.title || "새 대화",
    preview: row.messages?.at(-1)?.body || "",
    message_count: row.messages?.length ?? 0,
    last_active: row.last_message_at || row.created_at,
  };
}

export function createCloudTeamAdapter({ runtime = { inventory: [], health: [] }, archive = [] } = {}) {
  const inventoryByProfile = new Map((runtime.inventory ?? []).map((row) => [row.profile_id, row]));
  const sessionsByProfile = new Map();
  for (const conversation of archive ?? []) {
    const current = sessionsByProfile.get(conversation.profile_id) ?? [];
    current.push(archiveSession(conversation));
    sessionsByProfile.set(conversation.profile_id, current);
  }

  return {
    backend: "bibi-cloud",
    readOnly: true,
    async load(profileId) {
      const inventory = inventoryByProfile.get(profileId);
      return {
        capabilities: {
          skills: [],
          toolsets: inventory?.toolsets ?? [],
          plugins: inventory?.catalog ?? [],
          mcp: inventory?.servers ?? [],
          cron: [],
        },
        sessions: (sessionsByProfile.get(profileId) ?? []).slice(0, 6),
      };
    },
  };
}
