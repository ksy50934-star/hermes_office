export function createCloudSystemAdapter({ roster = [], runtime = { health: [] }, connector = null } = {}) {
  // `describeConnectorHealth` reports `state`. Reading `.status` here always
  // produced "unknown", so the system page claimed no connector even when the
  // Mac was online.
  const connectorState = connector?.health?.state ?? "unknown";
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
    connection: connectorState,
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
        connector: connectorState,
        projected_at: primary?.collected_at ?? null,
      },
    },
  };
}
