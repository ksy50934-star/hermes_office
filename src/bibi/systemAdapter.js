export function createCloudSystemAdapter({ roster = [], runtime = { health: [] }, connector = null } = {}) {
  const healthByProfile = new Map((runtime.health ?? []).map((row) => [row.profile_id, row]));
  const primary = healthByProfile.get("bibi-01") ?? runtime.health?.[0] ?? null;
  const profiles = roster.map((profile) => {
    const health = healthByProfile.get(profile.id);
    return {
      name: profile.execution_profile,
      display_name: profile.display_name,
      description: profile.role,
      role: profile.role,
      model: health?.model ?? "",
      provider: health?.provider ?? "",
      gateway_running: health?.gateway_status === "running",
      collected_at: health?.collected_at ?? null,
    };
  });
  return {
    backend: "bibi-cloud",
    readOnly: true,
    connection: connector?.health?.status ?? "unknown",
    workspace: {
      profiles,
      model: {
        provider: primary?.provider ?? "",
        model: primary?.model ?? "",
        effective_context_length: null,
      },
      stats: {
        total: (runtime.health ?? []).reduce((sum, row) => sum + (Number.isInteger(row.active_sessions) ? row.active_sessions : 0), 0),
        messages: null,
      },
      services: {
        connector: connector?.health?.status ?? "unknown",
        projected_at: primary?.collected_at ?? null,
      },
    },
  };
}
