function seconds(value) {
  const millis = Date.parse(value ?? "");
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : 0;
}

function roots() {
  return [
    { id: "profiles", label: "구성원 작업 공간" },
    { id: "workspace", label: "전체 문서" },
    { id: "drive", label: "데이터 공간" },
  ];
}

function artifactRows(artifacts) {
  return artifacts.flatMap((work) => [
    ...(work.results ?? []).map((result) => ({
      entityId: result.id,
      entityType: "result",
      profileId: work.profile_id,
      workId: work.id,
      workTitle: work.title,
      name: result.summary || work.title || "실행 결과",
      preview: result.detail || result.summary || "",
      kind: "text",
      category: "outputs",
      size: new TextEncoder().encode(result.detail || result.summary || "").byteLength,
      modified: seconds(result.created_at),
      sha256: null,
      storagePath: null,
    })),
    ...(work.evidence ?? []).map((evidence) => ({
      entityId: evidence.id,
      entityType: "evidence",
      profileId: work.profile_id || evidence.execution_profile_id,
      workId: work.id,
      workTitle: work.title,
      name: evidence.label || evidence.kind || "검증 근거",
      preview: evidence.inline_excerpt || "",
      kind: evidence.inline_excerpt ? "text" : "file",
      category: "documents",
      size: evidence.byte_size || 0,
      modified: seconds(evidence.created_at),
      sha256: evidence.sha256,
      storagePath: evidence.storage_path,
    })),
  ]);
}

function itemFor(row, rootId) {
  const folder = rootId === "profiles" ? `${row.profileId || "unassigned"}/` : "";
  return {
    id: `${rootId}:${row.entityType}:${row.entityId}`,
    type: "file",
    rootId,
    relativePath: `${folder}${row.name}`,
    name: row.name,
    kind: row.kind,
    category: row.category,
    size: row.size,
    modified: row.modified,
  };
}

function directoryItem(profileId, directory) {
  const name = directory.split("/").at(-1);
  return {
    id: `profiles:directory:${profileId}/${directory}`,
    type: "folder",
    rootId: "profiles",
    relativePath: `${profileId}/${directory}`,
    name,
    kind: "folder",
    category: "documents",
    size: 0,
    modified: 0,
  };
}

function directDirectories(tree, relativePath = "") {
  return (tree?.directories ?? [])
    .filter((directory) => {
      const index = directory.lastIndexOf("/");
      const parent = index < 0 ? "" : directory.slice(0, index);
      return parent === relativePath;
    })
    .map((directory) => directoryItem(tree.profile_id, directory));
}

export function createCloudDataRoomAdapter({ artifacts = [], connector = null, profileIds = [], documentTrees = [] } = {}) {
  const rows = artifactRows(artifacts);
  const treeByProfile = new Map(documentTrees.map((tree) => [tree.profile_id, tree]));
  const allProfileIds = [...new Set([
    ...profileIds,
    ...documentTrees.map((tree) => tree.profile_id),
    ...rows.map((row) => row.profileId),
  ].filter(Boolean))].sort();
  const byEntity = new Map(rows.map((row) => [`${row.entityType}:${row.entityId}`, row]));
  const rootRows = (rootId) => {
    if (rootId === "workspace") return rows.filter((row) => row.entityType === "result");
    if (rootId === "drive") return rows.filter((row) => row.entityType === "evidence");
    return rows;
  };

  const detail = (id) => {
    const [rootId, entityType, entityId] = String(id).split(":");
    const row = byEntity.get(`${entityType}:${entityId}`);
    if (!row) throw new Error("선택한 cloud artifact를 찾지 못했습니다.");
    return {
      ...itemFor(row, rootId),
      preview: [
        row.preview,
        row.sha256 ? `\n\nSHA-256\n${row.sha256}` : "",
        row.storagePath ? `\n\nCloud storage path\n${row.storagePath}` : "",
      ].join(""),
      truncated: false,
      editable: false,
      profileId: row.profileId,
      workId: row.workId,
      workTitle: row.workTitle,
    };
  };

  return {
    backend: "bibi-cloud",
    defaultRootId: "profiles",
    url() { return ""; },
    async request(path, params = {}, options = {}) {
      const method = String(options.method ?? "GET").toUpperCase();
      if (method !== "GET") throw new Error("실행 결과와 evidence는 불변 기록입니다. 새 산출물은 업무 실행을 통해 생성하세요.");
      if (path === "drive-status") {
        return {
          enabled: true,
          phase: connector?.health?.state === "online" ? "ready" : "idle",
          files: rows.filter((row) => row.entityType === "evidence").length,
          lastCompletedAt: connector?.health?.lastHeartbeatAt ?? null,
          message: "outbound connector가 보고한 검증 근거",
        };
      }
      if (path === "browse") {
        const rootId = String(params.root ?? "profiles");
        const relativePath = String(params.path ?? "");
        if (rootId === "profiles" && !relativePath) {
          return {
            roots: roots(), root: roots().find((root) => root.id === rootId), path: [], relativePath,
            items: allProfileIds.map((profileId) => ({
              id: `profiles:folder:${profileId}`,
              type: "folder",
              name: profileId,
              relativePath: profileId,
            })),
          };
        }
        if (rootId === "profiles") {
          const [profileId, ...parts] = relativePath.split("/").filter(Boolean);
          const profileRelativePath = parts.join("/");
          const folders = directDirectories(treeByProfile.get(profileId), profileRelativePath);
          const files = profileRelativePath ? [] : rows.filter((row) => row.profileId === profileId).map((row) => itemFor(row, rootId));
          return {
            roots: roots(), root: roots().find((root) => root.id === rootId),
            path: relativePath.split("/").filter(Boolean), relativePath,
            items: [...folders, ...files],
          };
        }
        const matches = rootRows(rootId);
        return {
          roots: roots(), root: roots().find((root) => root.id === rootId),
          path: relativePath ? [relativePath] : [], relativePath,
          items: matches.map((row) => itemFor(row, rootId)),
        };
      }
      if (path === "list") {
        const needle = String(params.q ?? "").trim().toLowerCase();
        const files = roots().flatMap((root) => rootRows(root.id).map((row) => itemFor(row, root.id)))
          .filter((item) => !needle || `${item.name} ${item.relativePath}`.toLowerCase().includes(needle));
        return { roots: roots(), files };
      }
      if (path === "item") return detail(params.id);
      throw new Error(`지원하지 않는 cloud data-room operation: ${path}`);
    },
  };
}
