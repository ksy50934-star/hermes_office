import { TEAM_META } from "./officeData.js";

function rowState(row) {
  const status = row.work?.status ?? "intake";
  if (status === "succeeded") return ["spoken", "발언 완료"];
  if (["failed", "blocked"].includes(status)) return ["", status === "blocked" ? "보류" : "실패"];
  if (["running", "leased"].includes(status)) return ["speaking", "발언 준비 중"];
  return ["", "대기"];
}

export default function BibiCloudMeetingConsole({ meeting, onExit }) {
  const rows = meeting.participantRows ?? [];
  const entries = rows.filter((row) => row.result).map((row) => ({
    id: row.result.id,
    profile: row.profile_id,
    text: row.result.detail || row.result.summary,
    time: row.result.created_at ? new Date(row.result.created_at).toLocaleString("ko") : "방금",
  }));
  const complete = rows.length > 0 && rows.every((row) => ["succeeded", "failed", "cancelled"].includes(row.work?.status));
  const summary = entries.map((entry) => entry.text).filter(Boolean).join("\n\n");

  return (
    <div className="meeting-console">
      <header className="meeting-console-header"><div><span>LIVE AI MEETING · CLOUD</span><h2>{meeting.topic}</h2><p>{complete ? "참여자 실행이 완료되었습니다." : "각 Bibi profile의 실제 실행 결과를 기다리고 있습니다."}</p></div><div className="meeting-console-actions"><div className="meeting-live-badge"><i className={complete ? "complete" : "discussion"} />{complete ? "COMPLETE" : "LIVE"}</div></div></header>
      <div className="meeting-console-body">
        <aside className="meeting-participants"><span>참여자</span>{rows.map((row) => { const meta = TEAM_META[row.profile_id]; const [tone, label] = rowState(row); return <article key={row.id} className={tone}><b style={{ "--avatar": meta.color }}>{meta.initials}</b><div><strong>{meta.name}</strong><small>{label}</small></div><i /></article>; })}<div className="meeting-progress"><small>회의 진행률</small><div><i style={{ width: `${rows.length ? (entries.length / rows.length) * 100 : 0}%` }} /></div></div></aside>
        <main className="meeting-transcript">{!entries.length && <div className="meeting-waiting"><i /><strong>회의를 준비하고 있습니다</strong><span>참여 Bibi의 Hermes profile을 연결하는 중입니다.</span></div>}{entries.map((entry) => { const meta = TEAM_META[entry.profile]; return <article key={entry.id} className="meeting-entry statement"><span style={{ "--avatar": meta.color }}>{meta.initials}</span><div><header><strong>{meta.name}</strong><small>{meta.role} · {entry.time}</small></header><p>{entry.text}</p></div></article>; })}</main>
        <aside className="meeting-notes"><span>회의 보드</span><section><small>안건</small><strong>{meeting.topic}</strong></section><section><small>진행 상태</small><strong>{complete ? "완료" : `${entries.length} / ${rows.length} 발언`}</strong></section><section className="meeting-summary-preview"><small>요약</small><p>{summary || "모든 참여자의 실행이 끝나면 결과가 표시됩니다."}</p></section><section className="meeting-outcome-panel"><small>실행 근거</small><p>각 발언은 owner-scoped work item과 execution profile 결과에서 읽었습니다.</p></section></aside>
      </div>
      <footer className="meeting-console-footer"><button type="button" className="secondary-button" onClick={onExit}>오피스로 돌아가기</button><span>{entries.length}개 회의 발언</span><div className="meeting-footer-actions"><button type="button" className="primary-button" disabled={!complete}>회의 결과 확인</button></div></footer>
    </div>
  );
}
