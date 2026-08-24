import { useEffect, useMemo, useRef, useState } from "react";

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

const STATUS_COPY = {
  queued: "대기", leased: "할당", running: "실행 중", succeeded: "완료", failed: "실패", blocked: "차단",
};

function CloudHermesConsole({ adapter, onStatusChange }) {
  const [profileId, setProfileId] = useState(adapter.profiles[0]?.id ?? "bibi-01");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState(null);
  const connectorHealth = adapter.connector?.health?.status ?? "unknown";

  useEffect(() => {
    onStatusChange?.(connectorHealth === "online" ? "online" : connectorHealth === "offline" ? "error" : "connecting");
  }, [connectorHealth, onStatusChange]);

  const submit = async (event) => {
    event.preventDefault();
    if (!title.trim() || !brief.trim() || busy) return;
    setBusy(true);
    try {
      const response = await adapter.submit({ profileId, title: title.trim(), brief: brief.trim() });
      setTitle("");
      setBrief("");
      setNotice(response?.duplicate ? "동일한 요청이 이미 queue에 있습니다." : "Cloud queue에 기록했습니다. connector가 실행 결과와 evidence를 되돌려 보냅니다.");
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

  return (
    <section className="hermes-dashboard-shell cloud-execution-console" aria-label="Hermes Cloud 실행 콘솔">
      <header className="cloud-console-header">
        <div>
          <span>DURABLE EXECUTION</span>
          <h2>Hermes 실행 콘솔</h2>
          <p>브라우저가 로컬 Gateway에 접속하지 않습니다. 요청은 Cloud queue에 영속화되고 outbound connector가 지정 프로필에서 실행합니다.</p>
        </div>
        <strong className={`cloud-console-health is-${connectorHealth}`}>{connectorHealth}</strong>
      </header>

      <form className="cloud-console-composer" onSubmit={submit}>
        <label>실행 프로필
          <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            {adapter.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.id} · {profile.label}</option>)}
          </select>
        </label>
        <label>작업 이름
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: Plugin 상태 감사" maxLength={180} />
        </label>
        <label className="cloud-console-brief">실행 지시
          <textarea value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="실행 목적, 산출물, 검증 기준을 적어주세요." maxLength={8000} />
        </label>
        <button type="submit" disabled={busy || !title.trim() || !brief.trim()}>{busy ? "기록 중…" : "Cloud queue에 실행 등록"}</button>
      </form>

      {notice && <p className="cloud-console-notice" role="status">{notice}</p>}

      <div className="cloud-console-grid">
        <section aria-label="최근 실행">
          <h3>최근 실행</h3>
          <div className="cloud-console-list">
            {adapter.commands.length === 0 && <p className="cloud-console-empty">아직 영속화된 실행이 없습니다.</p>}
            {adapter.commands.slice(0, 30).map((command) => (
              <button type="button" key={command.id} className="cloud-console-row" onClick={() => openDetail(command.id)}>
                <span>{command.profile_id}</span>
                <strong>{command.title}</strong>
                <em className={`is-${command.status}`}>{STATUS_COPY[command.status] ?? command.status}</em>
                <time>{command.updated_at ? new Date(command.updated_at).toLocaleString("ko-KR") : ""}</time>
              </button>
            ))}
          </div>
        </section>
        <section className="cloud-console-detail" aria-label="실행 상세">
          <h3>실행 결과 · Evidence</h3>
          {!detail && <p className="cloud-console-empty">왼쪽 실행을 선택하면 event, result, evidence를 읽습니다.</p>}
          {detail && (
            <>
              <h4>{detail.item?.title}</h4>
              <p>{detail.item?.brief}</p>
              <dl>
                <div><dt>상태</dt><dd>{STATUS_COPY[detail.item?.status] ?? detail.item?.status}</dd></div>
                <div><dt>프로필</dt><dd>{detail.item?.profile_id}</dd></div>
              </dl>
              {(detail.results ?? []).map((result) => <article key={result.id}><strong>RESULT</strong><pre>{result.summary ?? result.output ?? JSON.stringify(result, null, 2)}</pre></article>)}
              {(detail.evidence ?? []).map((item) => <article key={item.id}><strong>EVIDENCE · {item.kind}</strong><pre>{item.content ?? item.uri ?? JSON.stringify(item, null, 2)}</pre></article>)}
              <ol>{(detail.events ?? []).map((event) => <li key={event.id}><b>{event.event_type}</b><span>{event.created_at}</span></li>)}</ol>
            </>
          )}
        </section>
      </div>
    </section>
  );
}

export default function HermesDashboard({ adapter = null, ...props }) {
  return adapter ? <CloudHermesConsole adapter={adapter} {...props} /> : <LegacyHermesDashboard {...props} />;
}
