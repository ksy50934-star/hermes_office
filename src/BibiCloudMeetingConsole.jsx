import { useState } from "react";
import { TEAM_META } from "./officeData.js";
import { describeMeetingRecord, isMeetingParticipantTerminal } from "./bibi/meetingLifecycle.js";

function rowState(row) {
  const status = row.work?.status ?? "intake";
  if (status === "succeeded") return ["spoken", "발언 완료"];
  if (["failed", "blocked"].includes(status)) return ["", status === "blocked" ? "보류" : "실패"];
  if (["running", "leased"].includes(status)) return ["speaking", "발언 준비 중"];
  if (status === "cancelled") return ["", "취소"];
  return ["", "대기"];
}

/**
 * The live cloud meeting.
 *
 * What is on screen is what the participants' work items and result rows say,
 * and nothing else. The panel on the right used to join every statement into a
 * field labelled 요약; it no longer does. A meeting produces the text its
 * profiles wrote, and presenting a concatenation of that text as a summary
 * would be this component's own words wearing eighteen names.
 *
 * Ending is a persisted act, not a tab being closed: the button calls the
 * completion RPC and the parent only removes the meeting once the database has
 * been read back.
 */
export default function BibiCloudMeetingConsole({ meeting, onExit, onComplete }) {
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  const rows = meeting.participantRows ?? [];
  const record = describeMeetingRecord({
    id: meeting.id,
    topic: meeting.topic,
    status: meeting.status === "complete" ? "complete" : "running",
    participants: rows,
  });
  const entries = record.participants.flatMap((participant) => participant.results
    .filter((result) => result.detail || result.summary)
    .map((result) => ({
      id: result.id,
      profile: participant.profileId,
      summary: result.summary,
      detail: result.detail,
      time: result.createdAt ? new Date(result.createdAt).toLocaleString("ko") : "방금",
    })));
  const complete = meeting.status === "complete";
  const allTerminal = rows.length > 0 && rows.every(isMeetingParticipantTerminal);

  const end = async () => {
    if (closing || !onComplete) return;
    if (!allTerminal && !window.confirm("아직 실행이 끝나지 않은 참여자가 있습니다. 회의를 지금 종료할까요?")) return;
    setClosing(true);
    setError("");
    try {
      await onComplete(meeting);
    } catch (reason) {
      setError(reason.message || "회의를 종료하지 못했습니다.");
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="meeting-console">
      <header className="meeting-console-header"><div><span>LIVE AI MEETING · CLOUD</span><h2>{meeting.topic}</h2><p>{complete ? "이 회의는 종료되어 아카이브에 보관됩니다." : allTerminal ? "참여자 실행이 모두 끝났습니다. 회의를 종료할 수 있습니다." : "각 Bibi profile의 실제 실행 결과를 기다리고 있습니다."}</p></div><div className="meeting-console-actions"><div className="meeting-live-badge"><i className={allTerminal ? "complete" : "discussion"} />{complete ? "COMPLETE" : allTerminal ? "READY" : "LIVE"}</div></div></header>
      <div className="meeting-console-body">
        <aside className="meeting-participants"><span>참여자</span>{rows.map((row) => { const meta = TEAM_META[row.profile_id] ?? TEAM_META.default; const [tone, label] = rowState(row); return <article key={row.id} className={tone}><b style={{ "--avatar": meta.color }}>{meta.initials}</b><div><strong>{meta.name}</strong><small>{label}</small></div><i /></article>; })}<div className="meeting-progress"><small>실행 종료 참여자</small><div><i style={{ width: `${rows.length ? (record.terminalCount / rows.length) * 100 : 0}%` }} /></div></div></aside>
        <main className="meeting-transcript">{!entries.length && <div className="meeting-waiting"><i /><strong>회의를 준비하고 있습니다</strong><span>참여 Bibi의 Hermes profile을 연결하는 중입니다.</span></div>}{entries.map((entry) => { const meta = TEAM_META[entry.profile] ?? TEAM_META.default; return <article key={entry.id} className="meeting-entry statement"><span style={{ "--avatar": meta.color }}>{meta.initials}</span><div><header><strong>{meta.name}</strong><small>{meta.role} · {entry.time}</small></header>{entry.summary ? <p>{entry.summary}</p> : null}{entry.detail && entry.detail !== entry.summary ? <pre>{entry.detail}</pre> : null}</div></article>; })}</main>
        <aside className="meeting-notes"><span>회의 보드</span><section><small>안건</small><strong>{meeting.topic}</strong></section><section><small>진행 상태</small><strong>{complete ? "완료" : `${record.terminalCount} / ${rows.length} 실행 종료`}</strong></section><section className="meeting-outcome-panel"><small>기록된 결과</small><p>{record.resultCount}개 결과 · {record.evidenceCount}개 증거</p></section><section className="meeting-outcome-panel"><small>실행 근거</small><p>이 화면의 모든 문장은 owner-scoped work item과 work_result 행에서 그대로 읽었습니다. 별도의 회의 요약은 만들지 않습니다.</p></section></aside>
      </div>
      <footer className="meeting-console-footer"><button type="button" className="secondary-button" onClick={onExit}>오피스로 돌아가기</button><span>{record.resultCount}개 회의 결과</span><div className="meeting-footer-actions">{error ? <span className="meeting-console-error" role="alert">{error}</span> : null}{!complete && onComplete ? <button type="button" className="primary-button" onClick={end} disabled={closing}>{closing ? "회의 종료 중…" : "회의 종료"}</button> : null}</div></footer>
    </div>
  );
}
