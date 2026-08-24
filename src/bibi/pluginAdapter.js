export function createCloudPluginAdapter({ runtime = { inventory: [], health: [] } } = {}) {
  const inventoryByProfile = new Map((runtime.inventory ?? []).map((row) => [row.profile_id, row]));
  const healthByProfile = new Map((runtime.health ?? []).map((row) => [row.profile_id, row]));
  return {
    backend: "bibi-cloud",
    readOnly: true,
    async load(profileId) {
      const row = inventoryByProfile.get(profileId);
      const health = healthByProfile.get(profileId) ?? null;
      if (!row) return { catalog: [], servers: [], toolsets: [], health, collectedAt: null, errors: [] };
      return {
        catalog: row.catalog ?? [],
        servers: row.servers ?? [],
        toolsets: row.toolsets ?? [],
        health,
        collectedAt: row.collected_at,
        errors: row.collection_errors ?? [],
      };
    },
  };
}
