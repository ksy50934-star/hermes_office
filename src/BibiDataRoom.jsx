import { useMemo, useState } from "react";
import { TEAM_META } from "./officeData.js";

function formatBytes(value = 0) {
  if (!value) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export default function BibiDataRoom({ artifacts = [], profiles = [], onStartChat, onStartMeeting }) {
  const [activeSpace, setActiveSpace] = useState("profiles");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const items = useMemo(() => artifacts.flatMap((work) => [
    ...work.results.map((result) => ({ id: result.id, work, type: "result", name: result.summary || work.title, preview: result.detail || result.summary, kind: "text", category: "outputs", modified: result.created_at })),
    ...work.evidence.map((evidence) => ({ id: evidence.id, work, type: "evidence", name: evidence.label || evidence.kind, preview: evidence.inline_excerpt || "", kind: evidence.kind || "file", category: "documents", size: evidence.byte_size, modified: evidence.created_at, sha256: evidence.sha256, path: evidence.storage_path })),
  ]), [artifacts]);
  const visible = items.filter((item) => {
    if (activeSpace === "profiles" && !item.work.profile_id) return false;
    if (activeSpace === "drive" && item.type !== "evidence") return false;
    const needle = query.trim().toLowerCase();
    return !needle || `${item.name} ${item.preview} ${item.work.title}`.toLowerCase().includes(needle);
  });
  const selected = items.find((item) => item.id === selectedId) ?? visible[0] ?? null;
  const spaces = [
    ["profiles", "구성원", "구성원 작업 공간", "각 Bibi가 실제로 만든 결과와 실행 근거"],
    ["workspace", "문서", "전체 문서", "업무·회의 결과에서 생성된 공식 산출물"],
    ["drive", "데이터", "데이터 공간", "connector가 보고한 파일·증거 자산"],
  ];

  const sendToChat = () => selected && onStartChat?.({ id: "data-room", label: selected.name, profile: selected.work.profile_id || "bibi-01", prompt: `[데이터룸 자료]\n${selected.name}\n${selected.preview}` });
  const review = () => selected && onStartMeeting?.({ topic: `자료 검토: ${selected.name}`, participants: ["bibi-01", selected.work.profile_id].filter(Boolean), source: "data-room" });

  return <section className="data-room-shell tree-mode compact-explorer">
    <header className="data-room-header compact"><div className="data-room-title"><span>DATA ROOM</span><strong>{spaces.find(([id]) => id === activeSpace)?.[2]}</strong><p>Hermes 실행 결과와 검증 가능한 provenance를 기존 탐색기 구조로 확인합니다.</p></div><div className="data-room-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="파일명, 결과, 키워드 검색" /><button type="button" onClick={() => setQuery("")}>초기화</button></div></header>
    <nav className="data-space-tabs" aria-label="데이터 공간">{spaces.map(([id, short, label, description]) => <button type="button" key={id} className={activeSpace === id ? "active" : ""} onClick={() => setActiveSpace(id)}><small>{short}</small><strong>{label}</strong><span>{description}</span></button>)}</nav>
    <div className="data-room-body tree-layout">
      <aside className="data-tree-panel"><div className="data-tree-title"><span>ARTIFACT TREE</span><strong>실제 산출물</strong></div><div className="data-tree-scroll"><div className="data-tree-node is-root"><button type="button"><span className="tree-caret">▾</span><span className="row-icon workspace" /><strong>{spaces.find(([id]) => id === activeSpace)?.[2]}</strong><small>{visible.length}</small></button></div>{profiles.map((profile) => { const member = TEAM_META[profile.name]; const count = visible.filter((item) => item.work.profile_id === profile.name).length; if (!count) return null; return <div className="data-tree-node" key={profile.name}><button type="button"><span className="tree-caret">▾</span><span className="row-icon folder" /><strong>{member.name}</strong><small>{count}</small></button>{visible.filter((item) => item.work.profile_id === profile.name).map((item) => <div className="data-tree-node" key={item.id}><button type="button" className={selected?.id === item.id ? "active" : ""} onClick={() => setSelectedId(item.id)}><span className="tree-caret" /><span className={`row-icon ${item.kind === "text" ? "file" : item.kind}`} /><strong>{item.name}</strong></button></div>)}</div>; })}</div></aside>
      <aside className="data-room-preview">{!selected ? <div className="data-room-empty"><strong>아직 생성된 산출물이 없습니다.</strong><p>실제 Hermes 결과나 evidence가 저장되면 이 탐색기에 나타납니다.</p></div> : <><header className="data-preview-toolbar"><div><span>{selected.type === "result" ? "실행 결과" : "검증 근거"}</span><h3>{selected.name}</h3><p>{selected.work.title} · {selected.work.profile_id || "공용"}</p></div><div className="data-room-meta compact"><span>{selected.kind}</span><span>{formatBytes(selected.size)}</span><span>{selected.modified ? new Date(selected.modified).toLocaleString("ko") : "기록 없음"}</span></div><div className="data-room-actions compact"><button type="button" onClick={sendToChat}>Hermes</button><button type="button" onClick={review}>회의</button></div></header><section className="data-room-viewer"><pre>{selected.preview || "미리보기 텍스트가 없습니다."}{selected.sha256 ? `\n\nSHA-256\n${selected.sha256}` : ""}{selected.path ? `\n\n저장 경로\n${selected.path}` : ""}</pre></section></>}</aside>
    </div>
  </section>;
}
