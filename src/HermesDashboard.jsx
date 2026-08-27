import { useEffect, useMemo, useRef, useState } from "react";

import { CONNECTOR_STATE } from "./bibi/connectionState.js";
import { summarizeExecutionControl, workStatusLabel } from "./bibi/executionControl.js";

function dashboardUrl(resumeSessionId) {
  const params = new URLSearchParams();
  if (resumeSessionId) params.set("resume", resumeSessionId);
  const query = params.toString();
  return `/hermes/chat${query ? `?${query}` : ""}`;
}

function LegacyHermesDashboard({ resumeSessionId, onStatusChange }) {
  const shellRef = useRef(null);
  const [frameKey, setFrameKey] = useState(0);
  const [loadedFrame, setLoadedFrame] = useState("");
  const [failure, setFailure] = useState(null);
  const [dashboardScale, setDashboardScale] = useState(1);
  const src = useMemo(() => dashboardUrl(resumeSessionId), [resumeSessionId]);
  const frameId = `${src}:${frameKey}`;
  const error = failure?.frameId === frameId ? failure.message : "";
  const loading = loadedFrame !== frameId && !error;

  useEffect(() => {
    const controller = new AbortController();
    onStatusChange?.("connecting");

    fetch("/hermes/api/status", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Hermes 상태 확인 실패 (${response.status})`);
        onStatusChange?.("online");
      })
      .catch((requestError) => {
        if (requestError.name === "AbortError") return;
        setFailure({
          frameId,
          message: requestError.message || "Hermes Dashboard에 연결할 수 없습니다.",
        });
        onStatusChange?.("error");
      });

    return () => controller.abort();
  }, [frameId, onStatusChange]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return undefined;
    const fitDashboard = () => {
      const { width, height } = shell.getBoundingClientRect();
      const nextScale = width < 900
        ? 1
        : Math.min(1, Math.max(0.74, height / 920));
      setDashboardScale((current) => (
        Math.abs(current - nextScale) < 0.005 ? current : nextScale
      ));
    };
    const observer = new ResizeObserver(fitDashboard);
    observer.observe(shell);
    fitDashboard();
    return () => observer.disconnect();
  }, []);

  const reload = () => {
    setFrameKey((value) => value + 1);
  };

  return (
    <section ref={shellRef} className="hermes-dashboard-shell" aria-label="Hermes 공식 운영 대시보드">
      {loading && !error && (
        <div className="hermes-dashboard-loading" role="status" aria-live="polite">
          <i aria-hidden="true" />
          <span>Hermes Dashboard를 불러오는 중입니다.</span>
        </div>
      )}
      {error && (
        <div className="hermes-dashboard-error" role="alert">
          <strong>대시보드를 열지 못했습니다.</strong>
          <span>{error}</span>
          <button type="button" onClick={reload}>다시 불러오기</button>
        </div>
      )}
      <iframe
        key={frameId}
        className="hermes-dashboard-frame"
        src={src}
        title="Hermes Agent Dashboard"
        allow="clipboard-read; clipboard-write"
        referrerPolicy="same-origin"
        style={dashboardScale < 1 ? {
          width: `${100 / dashboardScale}%`,
          height: `${100 / dashboardScale}%`,
          transform: `scale(${dashboardScale})`,
          transformOrigin: "top left",
        } : undefined}
        onLoad={() => {
          setLoadedFrame(frameId);
          setFailure(null);
          onStatusChange?.("online");
        }}
      />
    </section>
  );
}

/**
 * 실행 관제 — the operator's view of whether the office can run work right now.
 *
 * What this replaced was a "Hermes 실행 콘솔": a form, a list of rows, and a
 * health badge wired to `connector.health.status`, a field that does not exist
 * (`describeConnectorHealth` returns `state`), so it read UNKNOWN forever.
 * Every number here is derived in `summarizeExecutionControl` from state the
 * connector actually reports, and each one is paired with what it means for the
 * user's work and the single action that clears it.
 */
function ExecutionControl({ adapter, onStatusChange }) {
  const [profileId, setProfileId] = useState(adapter.profiles[0]?.id ?? "bibi-01");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState(null);

  const control = useMemo(() => summarizeExecutionControl({
    connector: adapter.connector,
    workItems: adapter.commands,
    runtime: { health: adapter.health },
  }), [adapter.connector, adapter.commands, adapter.health]);

  const connectorState = control.connector.state;
  useEffect(() => {
    onStatusChange?.(
      connectorState === CONNECTOR_STATE.ONLINE
        ? "online"
        : connectorState === CONNECTOR_STATE.STALE
          ? "connecting"
          : "error",
    );
  }, [connectorState, onStatusChange]);

  const submit = async (event) => {
    event.preventDefault();
    if (!title.trim() || !brief.trim() || busy) return;
    setBusy(true);
    try {
      const response = await adapter.submit({ profileId, title: title.trim(), brief: brief.trim() });
      setTitle("");
      setBrief("");
      setNotice(response?.duplicate
        ? "같은 요청이 이미 대기 중입니다. 중복 실행하지 않았습니다."
        : `실행을 맡겼습니다. ${control.dispatchNotice}`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (id) => {
    try {
      setDetail(await adapter.loadDetail(id));
    } catch (error) {
      setNotice(error.message);
    }
  };

  const heartbeat = control.connector.lastHeartbeatAt
    ? new Date(control.connector.lastHeartbeatAt).toLocaleString("ko-KR")
    : "보고 없음";
  const collected = control.runtime.collectedAt
    ? new Date(control.runtime.collectedAt).toLocaleString("ko-KR")
    : "수집 전";

  return (
    <section className="hermes-dashboard-shell execution-control" aria-label="실행 관제">
      <header className="execution-control-header">
        <div>
          <span>실행 관제</span>
          <h2>지금 비비 조직이 일을 실행할 수 있는 상태인가</h2>
          <p>{control.purpose}</p>
        </div>
        <strong className={`execution-control-health is-${connectorState}`} title={`마지막 heartbeat ${heartbeat}`}>
          {control.connector.label}
        </strong>
      </header>

      <div className="execution-control-metrics">
        <article>
          <span>로컬 Mac 연결</span>
          <strong>{control.connector.canDispatchLive ? "실행 가능" : "실행 대기"}</strong>
          <small>마지막 heartbeat {heartbeat}</small>
        </article>
        <article>
          <span>실행 대기</span>
          <strong>{control.work.waiting}건</strong>
          <small>실행 중 {control.work.running}건 · 차단 {control.work.blocked}건</small>
        </article>
        <article>
          <span>실패</span>
          <strong>{control.work.failed}건</strong>
          <small>완료 {control.work.succeeded}건 · 전체 {control.work.total}건</small>
        </article>
        <article>
          <span>런타임 보고</span>
          <strong>{control.runtime.reporting}/{control.runtime.expected}</strong>
          <small>gateway 실행 {control.runtime.gatewayRunning}개 · {collected}</small>
        </article>
      </div>

      <section className="execution-control-actions" aria-label="지금 할 일">
        <h3>지금 할 일</h3>
        <ul>
          {control.actions.map((action) => (
            <li key={action.id} className={`is-${action.tone}`}>
              <strong>{action.title}</strong>
              <span>{action.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <form className="execution-control-composer" onSubmit={submit}>
        <h3>새 실행 맡기기</h3>
        <p className="execution-control-dispatch">{control.dispatchNotice}</p>
        <label>맡길 비비
          <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            {adapter.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.id} · {profile.label}</option>)}
          </select>
        </label>
        <label>업무 이름
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: Plugin 상태 감사" maxLength={180} />
        </label>
        <label className="execution-control-brief">실행 지시
          <textarea value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="실행 목적, 산출물, 검증 기준을 적어주세요." maxLength={8000} />
        </label>
        <button type="submit" disabled={busy || !title.trim() || !brief.trim()}>{busy ? "맡기는 중…" : "실행 맡기기"}</button>
      </form>

      {notice && <p className="execution-control-notice" role="status">{notice}</p>}

      <div className="execution-control-grid">
        <section aria-label="실행 목록">
          <h3>실행 목록</h3>
          <div className="execution-control-list">
            {adapter.commands.length === 0 && <p className="execution-control-empty">아직 맡긴 실행이 없습니다.</p>}
            {adapter.commands.slice(0, 30).map((command) => (
              <button type="button" key={command.id} className="execution-control-row" onClick={() => openDetail(command.id)}>
                <span>{command.profile_id}</span>
                <strong>{command.title}</strong>
                <em className={`is-${command.status}`}>{workStatusLabel(command.status)}</em>
                <time>{command.updated_at ? new Date(command.updated_at).toLocaleString("ko-KR") : ""}</time>
              </button>
            ))}
          </div>
        </section>
        <section className="execution-control-detail" aria-label="실행 상세">
          <h3>실행 결과 · 근거</h3>
          {!detail && <p className="execution-control-empty">왼쪽에서 실행을 선택하면 진행 기록, 결과, 근거를 읽습니다.</p>}
          {detail && (
            <>
              <h4>{detail.item?.title}</h4>
              <p>{detail.item?.brief}</p>
              <dl>
                <div><dt>상태</dt><dd>{workStatusLabel(detail.item?.status)}</dd></div>
                <div><dt>맡은 비비</dt><dd>{detail.item?.profile_id}</dd></div>
                {detail.item?.blocked_reason && <div><dt>차단 사유</dt><dd>{detail.item.blocked_reason}</dd></div>}
                {detail.item?.error && <div><dt>오류</dt><dd>{detail.item.error}</dd></div>}
              </dl>
              {(detail.results ?? []).map((result) => <article key={result.id}><strong>결과</strong><pre>{result.summary ?? result.output ?? JSON.stringify(result, null, 2)}</pre></article>)}
              {(detail.evidence ?? []).map((item) => <article key={item.id}><strong>근거 · {item.kind}</strong><pre>{item.content ?? item.uri ?? JSON.stringify(item, null, 2)}</pre></article>)}
              <ol>{(detail.events ?? []).map((event) => <li key={event.id}><b>{event.event_type}</b><span>{event.created_at}</span></li>)}</ol>
            </>
          )}
        </section>
      </div>
    </section>
  );
}

export default function HermesDashboard({ adapter = null, ...props }) {
  return adapter ? <ExecutionControl adapter={adapter} {...props} /> : <LegacyHermesDashboard {...props} />;
}
