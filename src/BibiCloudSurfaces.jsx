import { useCallback, useEffect, useMemo, useState } from "react";
import { loadConversationArchive, loadDataRoomArtifacts, startMeeting } from "./cloud/workspaceClient.js";
import BibiMeetingRecord from "./BibiMeetingRecord.jsx";
import {
  describeMeetingRecord,
  isMeetingParticipantTerminal,
  meetingFollowupCandidates,
  partitionCloudMeetings,
} from "./bibi/meetingLifecycle.js";

function when(value) {
  if (!value) return "기록 없음";
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function rosterMap(roster) {
  return new Map(roster.map((profile) => [profile.id, profile]));
}

export function BibiRosterSurface({ roster, availabilityFor, onSelect }) {
  return (
    <section className="bibi-cloud-page" data-surface="roster">
      <header className="bibi-cloud-intro">
        <div><span>LIVE ORGANIZATION</span><h2>실제 비비 조직</h2><p>Supabase 정본과 Mac connector가 함께 확인한 실행 조직입니다.</p></div>
        <strong>18 / 18</strong>
      </header>
      <div className="bibi-cloud-roster-grid">
        {roster.map((profile) => {
          const availability = availabilityFor(profile.id);
          return (
            <button type="button" key={profile.id} className="bibi-cloud-profile" onClick={() => onSelect?.(profile.id)}>
              <span>{profile.id}</span><h3>{profile.display_name}</h3><p>{profile.mandate}</p>
              <small>실행 프로필 <code>{profile.execution_profile}</code></small>
              <b className={`bibi-badge bibi-badge-${availability.dispatch}`}>{availability.label}</b>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The meeting surface.
 *
 * `meetings` is the workspace snapshot's own array — the same owner-scoped rows
 * the archive and the console read — rather than a list this component polls
 * for on its own. One source means the active list and the archive cannot
 * disagree about whether a meeting is over, and a realtime readback updates all
 * three at once.
 */
export function BibiMeetingSurface({ roster, availabilityFor, meetings = [], onRefresh, onCompleteMeeting, onCreateFollowup, followups = new Map() }) {
  const [topic, setTopic] = useState("");
  const [selected, setSelected] = useState(() => new Set(["bibi-01", "bibi-02"]));
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState("");
  const [error, setError] = useState("");
  const [openRecordId, setOpenRecordId] = useState("");
  const profiles = useMemo(() => rosterMap(roster), [roster]);
  const profileName = useCallback(
    (profileId) => profiles.get(profileId)?.display_name ?? profileId,
    [profiles],
  );
  const { active, completed } = useMemo(() => partitionCloudMeetings(meetings), [meetings]);

  const toggle = (id) => setSelected((current) => {
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });

  const submit = async (event) => {
    event.preventDefault();
    if (!topic.trim() || !selected.size || busy) return;
    setBusy(true);
    try { await startMeeting({ topic, profileIds: [...selected] }); setTopic(""); setError(""); await onRefresh?.(); }
    catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  };

  const end = async (meeting) => {
    if (!onCompleteMeeting || closing) return;
    const allTerminal = meeting.participants.length > 0 && meeting.participants.every(isMeetingParticipantTerminal);
    if (!allTerminal && !window.confirm("아직 실행이 끝나지 않은 참여자가 있습니다. 회의를 지금 종료할까요?")) return;
    setClosing(meeting.id);
    try { await onCompleteMeeting(meeting); setError(""); }
    catch (reason) { setError(reason.message); }
    finally { setClosing(""); }
  };

  return (
    <section className="bibi-cloud-page" data-surface="meeting">
      <header className="bibi-cloud-intro"><div><span>REAL PROFILE MEETING</span><h2>비비 회의실</h2><p>선택한 각 Bibi profile에 실제 회의 work item을 배정하고 결과를 영속화합니다.</p></div><strong>18 / 18</strong></header>
      <form className="bibi-meeting-create" onSubmit={submit}>
        <label>회의 주제<input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="논의할 주제와 기대 결론" /></label>
        <fieldset><legend>참가 비비 · {selected.size}명</legend><div className="bibi-participant-grid">
          {roster.map((profile) => <label key={profile.id}>
            <input type="checkbox" checked={selected.has(profile.id)} onChange={() => toggle(profile.id)} />
            <span><b>{profile.display_name}</b><small>{profile.id} · {availabilityFor(profile.id).label}</small></span>
          </label>)}
        </div></fieldset>
        <button type="submit" disabled={busy || !topic.trim() || !selected.size}>{busy ? "회의 배정 중…" : "실제 회의 시작"}</button>
      </form>
      {error ? <p className="bibi-error" role="alert">{error}</p> : null}

      <div className="bibi-meeting-list" data-meeting-list="active">
        <h3 className="bibi-meeting-list-title">진행 중 회의 · {active.length}</h3>
        {active.map((meeting) => {
          const terminal = meeting.participants.filter(isMeetingParticipantTerminal).length;
          const ready = meeting.participants.length > 0 && terminal === meeting.participants.length;
          return <article key={meeting.id} className="bibi-meeting-record">
            <header><div><small>MEETING <code>{meeting.id}</code></small><h3>{meeting.topic}</h3><p>{when(meeting.created_at)}</p></div><b>{ready ? "종료 가능" : "진행 중"}</b></header>
            <div className="bibi-meeting-responses">{meeting.participants.map((participant) => (
              <section key={participant.id}>
                <h4>{profileName(participant.profile_id)}</h4>
                <small>profile_id <code>{participant.profile_id}</code> · work_item_id <code>{participant.work_item_id}</code> · {participant.work?.status ?? "queued"}</small>
                {participant.result?.summary ? <p>{participant.result.summary}</p> : <p className="bibi-muted">실제 profile 응답 대기 중</p>}
              </section>
            ))}</div>
            <footer className="bibi-meeting-actions">
              <small>{terminal} / {meeting.participants.length} 실행 종료</small>
              <button type="button" onClick={() => end(meeting)} disabled={closing === meeting.id}>
                {closing === meeting.id ? "회의 종료 중…" : "회의 종료"}
              </button>
            </footer>
          </article>;
        })}
        {!active.length ? <p className="bibi-empty">진행 중인 회의가 없습니다.</p> : null}
      </div>

      <div className="bibi-meeting-list" data-meeting-list="archive">
        <h3 className="bibi-meeting-list-title">완료 회의 아카이브 · {completed.length}</h3>
        {completed.map((meeting) => {
          const record = describeMeetingRecord(meeting);
          const open = openRecordId === meeting.id;
          return <article key={meeting.id} className="bibi-meeting-record">
            <header>
              <div><small>MEETING <code>{meeting.id}</code></small><h3>{meeting.topic}</h3><p>{when(meeting.completed_at || meeting.created_at)}</p></div>
              <b>{record.status === "cancelled" ? "취소" : "완료"}</b>
            </header>
            <button type="button" className="bibi-meeting-record-toggle" onClick={() => setOpenRecordId(open ? "" : meeting.id)}>
              {open ? "기록 접기" : `기록 열기 · 결과 ${record.resultCount}개 · 증거 ${record.evidenceCount}개`}
            </button>
            {open ? (
              <BibiMeetingRecord
                record={record}
                candidates={meetingFollowupCandidates(record)}
                followups={followups}
                profileName={profileName}
                onCreateFollowup={onCreateFollowup ? (candidate) => onCreateFollowup(meeting, candidate) : undefined}
              />
            ) : null}
          </article>;
        })}
        {!completed.length ? <p className="bibi-empty">완료된 회의 기록이 아직 없습니다.</p> : null}
      </div>
    </section>
  );
}

export function BibiDataRoomSurface({ roster, refreshKey = 0 }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const profiles = useMemo(() => rosterMap(roster), [roster]);
  const refresh = useCallback(async () => {
    try { setItems(await loadDataRoomArtifacts()); setError(""); }
    catch (reason) { setError(reason.message); }
  }, []);
  useEffect(() => {
    const initial = setTimeout(refresh, 0);
    const timer = setInterval(refresh, 10000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [refresh, refreshKey]);
  return <section className="bibi-cloud-page" data-surface="data-room">
    <header className="bibi-cloud-intro"><div><span>DURABLE OUTPUT PROVENANCE</span><h2>실제 데이터룸</h2><p>Hermes 실행이 cloud에 반환한 결과와 증거만 표시합니다. 데모 파일과 로컬 폴더 추정은 없습니다.</p></div><button type="button" onClick={refresh}>새로고침</button></header>
    {error ? <p className="bibi-error" role="alert">{error}</p> : null}
    <div className="bibi-artifact-grid">{items.map((item) => <article key={item.id} className="bibi-artifact-card">
      <header><div><small>{item.kind.toUpperCase()} · {item.status}</small><h3>{item.title}</h3></div><b>{profiles.get(item.profile_id)?.display_name ?? item.profile_id}</b></header>
      <dl><div><dt>profile_id</dt><dd><code>{item.profile_id}</code></dd></div><div><dt>work_item_id</dt><dd><code>{item.id}</code></dd></div>{item.meeting_id ? <div><dt>meeting_id</dt><dd><code>{item.meeting_id}</code></dd></div> : null}</dl>
      {item.results.map((result) => <section key={result.id}><small>RESULT <code>{result.id}</code></small><p>{result.summary}</p>{result.detail ? <pre>{result.detail}</pre> : null}</section>)}
      {item.evidence.map((evidence) => <section key={evidence.id} className="bibi-artifact-evidence"><b>{evidence.label}</b><small>{evidence.kind} · execution_profile_id <code>{evidence.execution_profile_id ?? "unknown"}</code></small>{evidence.sha256 ? <code>sha256:{evidence.sha256}</code> : null}{evidence.inline_excerpt ? <pre>{evidence.inline_excerpt}</pre> : null}</section>)}
    </article>)}</div>
    {!items.length ? <p className="bibi-empty">실제 Hermes 결과가 아직 없습니다.</p> : null}
  </section>;
}

export function BibiArchiveSurface({ roster, refreshKey = 0 }) {
  const [conversations, setConversations] = useState([]);
  const [error, setError] = useState("");
  const profiles = useMemo(() => rosterMap(roster), [roster]);
  useEffect(() => { loadConversationArchive().then(setConversations).catch((reason) => setError(reason.message)); }, [refreshKey]);
  return <section className="bibi-cloud-page" data-surface="archive">
    <header className="bibi-cloud-intro"><div><span>CLOUD CONVERSATION ARCHIVE</span><h2>실제 대화 기록</h2><p>로그인한 owner의 Supabase 대화만 표시합니다.</p></div></header>
    {error ? <p className="bibi-error">{error}</p> : null}
    <div className="bibi-archive-list">{conversations.map((conversation) => <article key={conversation.id}>
      <header><h3>{profiles.get(conversation.profile_id)?.display_name ?? conversation.profile_id}</h3><code>{conversation.id}</code></header>
      {conversation.messages.map((message) => <p key={message.id}><b>{message.role === "user" ? "나" : profiles.get(message.profile_id)?.display_name}</b> {message.body}</p>)}
    </article>)}</div>
    {!conversations.length ? <p className="bibi-empty">저장된 실제 대화가 없습니다.</p> : null}
  </section>;
}
