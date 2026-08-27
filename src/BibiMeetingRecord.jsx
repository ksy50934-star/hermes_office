import { useState } from "react";
import { meetingFollowupKey } from "./bibi/meetingLifecycle.js";

/**
 * What a completed cloud meeting actually produced.
 *
 * One component, used by every Bibi Cloud view that shows a finished meeting,
 * so that "what a meeting record is allowed to claim" is decided once.
 *
 * The rules it exists to hold:
 *
 *  * Every line rendered here was persisted by a worker — a `work_results` row
 *    or a `work_evidence` row. There is no summary field, because there is no
 *    summary row; a participant that produced nothing is shown as having
 *    produced nothing, with the work state that explains why.
 *  * A follow-up is created from one span the user picked, verbatim. The button
 *    is disabled until something is selected, so nothing can be filed from text
 *    this screen chose on the user's behalf.
 *  * Filing is idempotent by key, and a selection that has already been filed
 *    says so instead of offering to file it again.
 */
export default function BibiMeetingRecord({
  record,
  candidates = [],
  followups = new Map(),
  onCreateFollowup,
  profileName = (profileId) => profileId,
}) {
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const selected = candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;
  const selectedKey = selected ? meetingFollowupKey({ meetingId: record.id, candidate: selected }) : null;
  const alreadyFiled = selectedKey ? followups.get(selectedKey) ?? null : null;

  const file = async () => {
    if (!selected || busy || !onCreateFollowup) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await onCreateFollowup(selected);
      setNotice(result?.duplicate
        ? "같은 결과로 만든 후속 업무가 이미 있어 그 업무를 그대로 씁니다."
        : "선택한 결과 문장 그대로 후속 업무를 등록했습니다.");
    } catch (reason) {
      setError(reason.message || "후속 업무를 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bibi-meeting-record-panel" data-meeting-record={record.id}>
      <dl className="bibi-meeting-record-meta">
        <div><dt>상태</dt><dd>{record.status === "complete" ? "완료" : record.status === "cancelled" ? "취소" : "진행 중"}</dd></div>
        <div><dt>종료 방식</dt><dd>{record.completionMode === "manual" ? "직접 종료" : record.completionMode === "automatic" ? "참여자 실행 종료" : "기록 없음"}</dd></div>
        <div><dt>종료 시각</dt><dd>{record.completedAt ?? "기록 없음"}</dd></div>
        <div><dt>실행 종료 참여자</dt><dd>{record.terminalCount} / {record.participantCount}</dd></div>
        <div><dt>결과 · 증거</dt><dd>{record.resultCount}개 · {record.evidenceCount}개</dd></div>
      </dl>

      <div className="bibi-meeting-record-participants">
        {record.participants.map((participant) => (
          <section key={participant.id ?? participant.profileId}>
            <header>
              <h4>{profileName(participant.profileId)}</h4>
              <small>
                profile_id <code>{participant.profileId}</code>
                {" · "}work_item_id <code>{participant.workItemId ?? "없음"}</code>
                {" · "}{participant.workStatus ?? "기록 없음"}
              </small>
            </header>
            {participant.workError ? <p className="bibi-error">{participant.workError}</p> : null}
            {participant.results.map((result) => (
              <article key={result.id} className="bibi-meeting-result">
                <small>WORK_RESULT <code>{result.id}</code></small>
                {result.summary ? <p>{result.summary}</p> : null}
                {result.detail && result.detail !== result.summary ? <pre>{result.detail}</pre> : null}
              </article>
            ))}
            {participant.evidence.map((item) => (
              <article key={item.id} className="bibi-meeting-evidence">
                <small>EVIDENCE · {item.kind} · execution_profile_id <code>{item.executionProfileId ?? "unknown"}</code></small>
                <b>{item.label}</b>
                {item.sha256 ? <code>sha256:{item.sha256}</code> : null}
                {item.excerpt ? <pre>{item.excerpt}</pre> : null}
              </article>
            ))}
            {!participant.results.length && !participant.evidence.length
              ? <p className="bibi-muted">이 참여자가 남긴 결과나 증거가 없습니다.</p>
              : null}
          </section>
        ))}
        {!record.participants.length ? <p className="bibi-muted">참여자 기록이 없습니다.</p> : null}
      </div>

      <section className="bibi-meeting-followup">
        <h4>후속 업무 만들기</h4>
        <p className="bibi-muted">회의가 만든 실제 결과 문장을 하나 고르면 그 문장 그대로 후속 업무로 등록합니다. 요약이나 새로운 문장은 만들지 않습니다.</p>
        {candidates.length ? (
          <>
            <div className="bibi-meeting-followup-options">
              {candidates.map((candidate) => {
                const key = meetingFollowupKey({ meetingId: record.id, candidate });
                const filed = key ? followups.get(key) : null;
                return (
                  <label key={candidate.id}>
                    <input
                      type="radio"
                      name={`followup-${record.id}`}
                      value={candidate.id}
                      checked={selectedCandidateId === candidate.id}
                      onChange={() => { setSelectedCandidateId(candidate.id); setNotice(""); setError(""); }}
                    />
                    <span>
                      <small>{profileName(candidate.profileId)} · {candidate.sourceKind}{filed ? " · 등록됨" : ""}</small>
                      <b>{candidate.text}</b>
                    </span>
                  </label>
                );
              })}
            </div>
            {alreadyFiled ? <p className="bibi-muted">이미 등록된 후속 업무: <code>{alreadyFiled.id}</code></p> : null}
            <button type="button" onClick={file} disabled={!selected || busy}>
              {busy ? "등록 중…" : "선택한 결과로 후속 업무 등록"}
            </button>
          </>
        ) : (
          <p className="bibi-empty">후속 업무로 만들 수 있는 결과 문장이 아직 없습니다.</p>
        )}
        {notice ? <p className="bibi-meeting-followup-notice">{notice}</p> : null}
        {error ? <p className="bibi-error" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
