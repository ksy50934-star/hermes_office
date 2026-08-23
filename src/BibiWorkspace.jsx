/**
 * The CEO-first workspace: the governing surface of the Bibi Workspace.
 *
 * bibi-01 is where the user talks and delegates, so it opens focused and stays
 * selected by default; the other seventeen profiles are one click away in the
 * roster rail. Work filed here is durable — it lands in Postgres before anything
 * tries to run it — and the board shows its real lifecycle state rather than an
 * optimistic one.
 *
 * When the Mac is not reachable this screen says OFFLINE and QUEUED. It never
 * renders a profile as working on the strength of a missing signal.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BIBI_PROFILE_IDS, CEO_PROFILE_ID, ceoFirstRoster } from "./bibi/roster.js";
import {
  CONNECTOR_STATE,
  DISPATCH_MODE,
  describeConnectorHealth,
  describeProfileAvailability,
} from "./bibi/connectionState.js";
import { SEVERITY, describeProfileMismatch, mismatchSummaryText } from "./bibi/profileMismatch.js";
import { describeRuntimeMismatch, runtimeSummaryText } from "./bibi/runtimeEnvironment.js";
import { WORK_STATUS, isTerminalStatus } from "./bibi/workLifecycle.js";
import { describeAuthError, problemFor, validateCredentials } from "./bibi/authForm.js";
import { getCloudConfig } from "./cloud/supabaseBrowser.js";
import {
  fileWork,
  loadChatDispatch,
  loadConnectorState,
  loadConversations,
  loadMessages,
  loadRoster,
  loadWorkDetail,
  loadWorkItems,
  onAuthStateChange,
  getSession,
  sendUserMessage,
  signInWithPassword,
  signOut,
  startConversation,
  subscribeToWorkspace,
  transitionWork,
} from "./cloud/workspaceClient.js";

const STATUS_LABELS = {
  [WORK_STATUS.INTAKE]: "접수됨",
  [WORK_STATUS.ASSIGNED]: "배정됨",
  [WORK_STATUS.LEASED]: "실행 준비",
  [WORK_STATUS.RUNNING]: "실행 중",
  [WORK_STATUS.BLOCKED]: "보류",
  [WORK_STATUS.SUCCEEDED]: "완료",
  [WORK_STATUS.FAILED]: "실패",
  [WORK_STATUS.CANCELLED]: "취소됨",
};

function localRoster() {
  return ceoFirstRoster().map((entry) => ({
    id: entry.id,
    ordinal: entry.ordinal,
    execution_profile: entry.executionProfileId,
    display_name: entry.displayName,
    role: entry.role,
    mandate: entry.mandate,
    reports_to: entry.reportsTo,
    role_source: entry.roleSource,
    is_primary_surface: entry.isPrimarySurface,
  }));
}

/**
 * What the browser can honestly say about the runtime. It cannot read the
 * connector's environment, so it reports on the connector row it can see plus
 * its own client configuration. An unregistered connector reads as "mode unset",
 * which is correct rather than reassuring.
 */
function browserRuntimeEnvironment(cloud, connectorNode) {
  return {
    BIBI_CONNECTOR_MODE: connectorNode?.connector_mode ?? "",
    BIBI_CONTROL_PLANE_URL: typeof window === "undefined" ? "" : window.location.origin,
    VITE_SUPABASE_URL: cloud.configured ? cloud.url : "",
    VITE_SUPABASE_ANON_KEY: cloud.configured ? "configured" : "",
  };
}

function WarningList({ title, warnings, summary }) {
  if (!warnings.length) return null;
  const blocking = warnings.some((warning) => warning.severity === SEVERITY.BLOCKING);
  return (
    <section className={`bibi-warning ${blocking ? "is-blocking" : "is-advisory"}`} aria-live="polite">
      <h3>{blocking ? "확인 필요" : "참고"} · {title}</h3>
      {summary ? <p className="bibi-warning-summary">{summary}</p> : null}
      <ul>
        {warnings.map((warning) => (
          <li key={`${warning.code}:${warning.profileId ?? ""}`}>
            <strong>{warning.message}</strong>
            {warning.remedy ? <span className="bibi-warning-remedy">{warning.remedy}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RosterRail({ roster, activeProfileId, availabilityFor, onSelect }) {
  return (
    <nav className="bibi-roster" aria-label="비비 프로필">
      <h2 className="bibi-roster-title">
        프로필 <span>{roster.length} / {BIBI_PROFILE_IDS.length}</span>
      </h2>
      <ul>
        {roster.map((profile) => {
          const availability = availabilityFor(profile.id);
          const active = profile.id === activeProfileId;
          return (
            <li key={profile.id}>
              <button
                type="button"
                className={`bibi-roster-item ${active ? "is-active" : ""} ${profile.is_primary_surface ? "is-primary" : ""}`}
                aria-current={active ? "true" : undefined}
                onClick={() => onSelect(profile.id)}
              >
                <span className="bibi-roster-id">{profile.id}</span>
                <span className="bibi-roster-name">{profile.display_name}</span>
                <span className="bibi-roster-role">
                  {profile.mandate}
                  {/* The organisational id and the profile that actually runs
                      differ for the CEO, so both are always shown. */}
                  {availability.executionProfileId && availability.executionProfileId !== profile.id
                    ? ` · 실행 ${availability.executionProfileId}`
                    : null}
                </span>
                <span className={`bibi-badge bibi-badge-${availability.dispatch}`}>{availability.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function ChatPanel({ profile, availability, messages, dispatch, onSend, busy, error }) {
  const [draft, setDraft] = useState("");
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const latestDispatch = dispatch?.[0] ?? null;

  const submit = (event) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setDraft("");
    onSend(body);
  };

  return (
    <section className="bibi-chat" aria-label={`${profile?.display_name ?? ""} 대화`}>
      <header className="bibi-chat-header">
        <div>
          <h2>{profile?.display_name ?? "프로필"}</h2>
          <p>{profile?.mandate ?? ""}</p>
          <p className="bibi-chat-identity">
            조직 ID <code>{profile?.id}</code>
            {" · "}
            실행 프로필 <code>{availability.executionProfileId ?? "미확인"}</code>
          </p>
        </div>
        <span className={`bibi-badge bibi-badge-${availability.dispatch}`}>{availability.label}</span>
      </header>

      {availability.dispatch !== DISPATCH_MODE.LIVE ? (
        <p className="bibi-chat-notice">{availability.detail}</p>
      ) : null}

      <ol className="bibi-messages">
        {messages.map((message) => (
          <li key={message.id} className={`bibi-message is-${message.role}`}>
            <span className="bibi-message-role">{message.role === "user" ? "나" : profile?.display_name ?? "비비"}</span>
            <p>{message.body}</p>
          </li>
        ))}
        <li ref={endRef} aria-hidden="true" />
      </ol>

      {/* The newest turn decides what to say: a command still running means a
          reply is coming, and a failed one means it is not. */}
      {latestDispatch && !isTerminalStatus(latestDispatch.status) ? (
        <p className="bibi-chat-pending" aria-live="polite">
          {availability.dispatch === DISPATCH_MODE.LIVE
            ? `${profile?.display_name ?? "비비"}가 답변을 준비하고 있습니다…`
            : "질문은 저장되었습니다. 로컬 Mac이 돌아오면 답변합니다."}
        </p>
      ) : null}
      {latestDispatch?.status === WORK_STATUS.FAILED ? (
        <p className="bibi-error" role="alert">
          답변을 만들지 못했습니다: {latestDispatch.error ?? "원인이 보고되지 않았습니다."}
        </p>
      ) : null}

      {error ? <p className="bibi-error" role="alert">{error}</p> : null}

      <form className="bibi-composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="bibi-chat-input">메시지</label>
        <textarea
          id="bibi-chat-input"
          value={draft}
          rows={3}
          placeholder={`${profile?.display_name ?? "비비"}에게 이야기하기`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
          }}
        />
        <button type="submit" disabled={busy || !draft.trim()}>보내기</button>
      </form>
    </section>
  );
}

function WorkIntake({ roster, defaultProfileId, availabilityFor, onFile, busy }) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [profileId, setProfileId] = useState(defaultProfileId);
  const [syncedDefault, setSyncedDefault] = useState(defaultProfileId);

  // Selecting a different profile in the roster retargets this form, while a
  // half-written title and brief survive the switch. Adjusting during render is
  // the supported way to derive state from a prop; an effect here would cost an
  // extra render pass on every roster click.
  if (defaultProfileId !== syncedDefault) {
    setSyncedDefault(defaultProfileId);
    setProfileId(defaultProfileId);
  }

  const availability = availabilityFor(profileId);

  const submit = (event) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    onFile({ title: title.trim(), brief: brief.trim(), profileId });
    setTitle("");
    setBrief("");
  };

  return (
    <form className="bibi-intake" onSubmit={submit}>
      <h2>업무 맡기기</h2>
      <label htmlFor="bibi-work-title">무엇을 맡길까요</label>
      <input
        id="bibi-work-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="예: 지난달 실행 결과 정리"
      />
      <label htmlFor="bibi-work-brief">배경과 기대 결과</label>
      <textarea
        id="bibi-work-brief"
        rows={3}
        value={brief}
        onChange={(event) => setBrief(event.target.value)}
      />
      <label htmlFor="bibi-work-profile">담당</label>
      <select id="bibi-work-profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
        {roster.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.id} · {profile.display_name}
          </option>
        ))}
      </select>

      {availability.dispatch === DISPATCH_MODE.QUEUED ? (
        <p className="bibi-intake-notice">지금 맡기면 대기열에 저장됩니다. {availability.detail}</p>
      ) : null}

      <button type="submit" disabled={busy || !title.trim()}>맡기기</button>
    </form>
  );
}

function WorkBoard({ workItems, detail, onOpen, onCancel, openId }) {
  if (!workItems.length) {
    return (
      <section className="bibi-board">
        <h2>업무 보드</h2>
        <p className="bibi-empty">아직 맡긴 업무가 없습니다.</p>
      </section>
    );
  }

  return (
    <section className="bibi-board">
      <h2>업무 보드</h2>
      <ul>
        {workItems.map((item) => {
          const open = item.id === openId;
          return (
            <li key={item.id} className={`bibi-work is-${item.status}`}>
              <button type="button" className="bibi-work-head" onClick={() => onOpen(open ? null : item.id)} aria-expanded={open}>
                <span className="bibi-work-title">{item.title}</span>
                <span className="bibi-work-profile">{item.profile_id ?? "미배정"}</span>
                <span className={`bibi-badge bibi-status-${item.status}`}>{STATUS_LABELS[item.status] ?? item.status}</span>
              </button>

              {item.status === WORK_STATUS.FAILED && item.error ? (
                <p className="bibi-error">{item.error}</p>
              ) : null}
              {item.status === WORK_STATUS.BLOCKED && item.blocked_reason ? (
                <p className="bibi-blocked">{item.blocked_reason}</p>
              ) : null}

              {open ? (
                <div className="bibi-work-detail">
                  {item.brief ? <p className="bibi-work-brief">{item.brief}</p> : null}

                  {detail?.results?.length ? (
                    <div className="bibi-work-results">
                      <h3>결과</h3>
                      {detail.results.map((result) => (
                        <p key={result.id}>{result.summary}</p>
                      ))}
                    </div>
                  ) : null}

                  {detail?.evidence?.length ? (
                    <div className="bibi-work-evidence">
                      <h3>증거</h3>
                      <ul>
                        {detail.evidence.map((evidence) => (
                          <li key={evidence.id}>
                            <span className="bibi-evidence-label">{evidence.label}</span>
                            <span className="bibi-evidence-kind">{evidence.kind}</span>
                            {evidence.execution_profile_id ? (
                              <span className="bibi-evidence-kind">실행 {evidence.execution_profile_id}</span>
                            ) : null}
                            {/* The hash is what makes the artifact checkable rather than merely claimed. */}
                            {evidence.sha256 ? <code>{evidence.sha256.slice(0, 12)}…</code> : null}
                            {evidence.inline_excerpt ? <pre>{evidence.inline_excerpt}</pre> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {detail?.events?.length ? (
                    <ol className="bibi-work-events">
                      {detail.events.map((event) => (
                        <li key={event.id}>
                          <span>{event.event_type}</span>
                          <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString("ko-KR")}</time>
                        </li>
                      ))}
                    </ol>
                  ) : null}

                  {!isTerminalStatus(item.status) ? (
                    <button type="button" className="bibi-cancel" onClick={() => onCancel(item.id)}>업무 취소</button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The only way into the workspace. There is no registration path: the owner's
 * account is provisioned in Supabase directly, so offering sign-up here would
 * be an invitation to create an account that owns nothing.
 */
function SignInPanel({ onSignIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [problems, setProblems] = useState([]);
  const [error, setError] = useState("");
  const [signingIn, setSigningIn] = useState(false);

  const emailProblem = problemFor(problems, "email");
  const passwordProblem = problemFor(problems, "password");

  const submit = async (event) => {
    event.preventDefault();
    if (signingIn) return;

    const validation = validateCredentials({ email, password });
    setProblems(validation.problems);
    setError("");
    if (!validation.valid) return;

    setSigningIn(true);
    try {
      const { error: signInError } = await signInWithPassword(validation.email, validation.password);
      if (signInError) setError(describeAuthError(signInError));
      else setPassword("");
    } catch (thrown) {
      setError(describeAuthError(thrown));
    } finally {
      setSigningIn(false);
    }
    onSignIn?.();
  };

  return (
    <section className="bibi-setup">
      <h2>Bibi Workspace 로그인</h2>
      <p>이 워크스페이스의 모든 대화와 업무는 로그인한 사용자 본인에게만 보입니다.</p>

      <form className="bibi-signin" onSubmit={submit} noValidate>
        <label htmlFor="bibi-signin-email">이메일</label>
        <input
          id="bibi-signin-email"
          type="email"
          value={email}
          autoComplete="email"
          autoFocus
          aria-invalid={emailProblem ? "true" : undefined}
          aria-describedby={emailProblem ? "bibi-signin-email-problem" : undefined}
          onChange={(event) => setEmail(event.target.value)}
        />
        {emailProblem ? (
          <span className="bibi-field-problem" id="bibi-signin-email-problem">{emailProblem.message}</span>
        ) : null}

        <label htmlFor="bibi-signin-password">비밀번호</label>
        <input
          id="bibi-signin-password"
          type="password"
          value={password}
          autoComplete="current-password"
          aria-invalid={passwordProblem ? "true" : undefined}
          aria-describedby={passwordProblem ? "bibi-signin-password-problem" : undefined}
          onChange={(event) => setPassword(event.target.value)}
        />
        {passwordProblem ? (
          <span className="bibi-field-problem" id="bibi-signin-password-problem">{passwordProblem.message}</span>
        ) : null}

        {error ? <p className="bibi-error" role="alert">{error}</p> : null}

        <button type="submit" disabled={signingIn}>
          {signingIn ? "로그인 중…" : "로그인"}
        </button>
      </form>

      <p className="bibi-signin-note">
        계정은 소유자가 직접 발급합니다. 이 화면에서는 새 계정을 만들 수 없습니다.
      </p>
    </section>
  );
}

function SetupPanel({ problems }) {
  return (
    <section className="bibi-setup">
      <h2>클라우드 워크스페이스가 아직 연결되지 않았습니다</h2>
      <p>
        아래 설정을 채우면 이 화면에서 CEO비비와 대화하고 업무를 맡길 수 있습니다.
        설정 전까지는 어떤 프로필도 온라인으로 표시하지 않습니다.
      </p>
      <ul>
        {problems.map((problem) => (
          <li key={problem.code}><code>{problem.code}</code> {problem.message}</li>
        ))}
      </ul>
    </section>
  );
}

export default function BibiWorkspace() {
  const cloud = useMemo(() => getCloudConfig(), []);
  const [session, setSession] = useState(null);
  const [roster, setRoster] = useState(localRoster);
  const [connector, setConnector] = useState(() => ({
    node: null,
    health: describeConnectorHealth({ lastHeartbeatAt: null }),
    reportedProfileIds: [],
  }));
  const [workItems, setWorkItems] = useState([]);
  const [openWorkId, setOpenWorkId] = useState(null);
  const [workDetail, setWorkDetail] = useState(null);
  const [activeProfileId, setActiveProfileId] = useState(CEO_PROFILE_ID);
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [chatDispatch, setChatDispatch] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ownerId = session?.user?.id ?? null;

  // ---- session -------------------------------------------------------------
  useEffect(() => {
    if (!cloud.configured) return undefined;
    let active = true;
    getSession().then((current) => { if (active) setSession(current); }).catch(() => {});
    const unsubscribe = onAuthStateChange((next) => setSession(next));
    return () => { active = false; unsubscribe?.(); };
  }, [cloud.configured]);

  // ---- workspace snapshot --------------------------------------------------
  const loadSnapshot = useCallback(async () => {
    if (!cloud.configured || !ownerId) return null;
    const [rosterRows, connectorState, items] = await Promise.all([
      loadRoster(),
      loadConnectorState(),
      loadWorkItems(),
    ]);
    return { rosterRows, connectorState, items };
  }, [cloud.configured, ownerId]);

  const applySnapshot = useCallback((snapshot) => {
    // An empty roster table means the migration has not run yet. The compiled
    // roster still names the eighteen physical profiles correctly, so the UI
    // stays truthful about who exists even before the seed lands.
    setRoster(snapshot.rosterRows.length ? snapshot.rosterRows : localRoster());
    setConnector(snapshot.connectorState);
    setWorkItems(snapshot.items);
    setError("");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await loadSnapshot();
      if (snapshot) applySnapshot(snapshot);
    } catch (loadError) {
      setError(loadError.message);
    }
  }, [loadSnapshot, applySnapshot]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const snapshot = await loadSnapshot();
        if (active && snapshot) applySnapshot(snapshot);
      } catch (loadError) {
        if (active) setError(loadError.message);
      }
    })();
    return () => { active = false; };
  }, [loadSnapshot, applySnapshot]);

  // ---- realtime ------------------------------------------------------------
  useEffect(() => {
    if (!cloud.configured || !ownerId) return undefined;
    return subscribeToWorkspace({
      onWorkItem: (row) => {
        if (!row?.id) return;
        // Chat dispatch and deliberate work share a table but not a surface.
        if (row.kind === "chat") {
          if (row.conversation_id !== conversation?.id) return;
          setChatDispatch((current) => {
            const index = current.findIndex((item) => item.id === row.id);
            if (index === -1) return [row, ...current];
            const next = [...current];
            next[index] = { ...next[index], ...row };
            return next;
          });
          return;
        }
        setWorkItems((current) => {
          const index = current.findIndex((item) => item.id === row.id);
          if (index === -1) return [row, ...current];
          const next = [...current];
          next[index] = { ...next[index], ...row };
          return next;
        });
      },
      onConnector: (row) => {
        if (!row?.id) return;
        setConnector({
          node: row,
          health: describeConnectorHealth({ lastHeartbeatAt: row.last_heartbeat_at ?? null }),
          reportedProfileIds: Array.isArray(row.reported_profile_ids) ? row.reported_profile_ids : [],
        });
      },
      onMessage: (row) => {
        if (!row?.id || row.conversation_id !== conversation?.id) return;
        setMessages((current) => (current.some((message) => message.id === row.id) ? current : [...current, row]));
      },
      // Realtime replays nothing that happened while the socket was down, so a
      // reconnect refetches instead of trusting the local cache.
      onResync: refresh,
    });
  }, [cloud.configured, ownerId, conversation?.id, refresh]);

  // ---- connector health ages even without a new event ----------------------
  useEffect(() => {
    if (!connector.node?.last_heartbeat_at) return undefined;
    const timer = setInterval(() => {
      setConnector((current) => ({
        ...current,
        health: describeConnectorHealth({ lastHeartbeatAt: current.node?.last_heartbeat_at ?? null }),
      }));
    }, 15_000);
    return () => clearInterval(timer);
  }, [connector.node?.last_heartbeat_at]);

  // ---- conversation for the selected profile -------------------------------
  useEffect(() => {
    if (!cloud.configured || !ownerId) return undefined;
    let active = true;
    (async () => {
      try {
        const conversations = await loadConversations(activeProfileId);
        const current = conversations[0]
          ?? await startConversation({ ownerId, profileId: activeProfileId });
        if (!active) return;
        setConversation(current);
        if (!current?.id) {
          setMessages([]);
          setChatDispatch([]);
          return;
        }
        const [nextMessages, nextDispatch] = await Promise.all([
          loadMessages(current.id),
          loadChatDispatch(current.id),
        ]);
        if (!active) return;
        setMessages(nextMessages);
        setChatDispatch(nextDispatch);
      } catch (conversationError) {
        if (active) setError(conversationError.message);
      }
    })();
    return () => { active = false; };
  }, [cloud.configured, ownerId, activeProfileId]);

  // ---- work detail ---------------------------------------------------------
  useEffect(() => {
    if (!openWorkId || !cloud.configured) return undefined;
    let active = true;
    (async () => {
      try {
        const detail = await loadWorkDetail(openWorkId);
        if (active) setWorkDetail({ workItemId: openWorkId, ...detail });
      } catch (detailError) {
        if (active) setError(detailError.message);
      }
    })();
    return () => { active = false; };
  }, [openWorkId, cloud.configured, workItems]);

  // Tagging the detail with its work item is what stops the previously opened
  // item's evidence from flashing under a newly opened one while it loads.
  const openWorkDetail = workDetail?.workItemId === openWorkId ? workDetail : null;

  // ---- derived state -------------------------------------------------------
  const availabilityFor = useCallback(
    (profileId) => describeProfileAvailability({
      profileId,
      health: connector.health,
      reportedProfileIds: connector.reportedProfileIds,
    }),
    [connector.health, connector.reportedProfileIds],
  );

  const mismatch = useMemo(
    // No connector report at all is not an empty roster; it is an unknown one.
    () => describeProfileMismatch(connector.node ? connector.reportedProfileIds : null),
    [connector.node, connector.reportedProfileIds],
  );

  const runtime = useMemo(
    () => describeRuntimeMismatch(browserRuntimeEnvironment(cloud, connector.node)),
    [cloud, connector.node],
  );

  const activeProfile = roster.find((profile) => profile.id === activeProfileId) ?? roster[0];

  // ---- actions -------------------------------------------------------------
  const handleSend = useCallback(async (body) => {
    if (!conversation?.id) return;
    setBusy(true);
    try {
      // The turn and the command that will answer it are created together, so
      // by the time this resolves the question is durable and already assigned.
      await sendUserMessage({ conversationId: conversation.id, body });
      const [nextMessages, nextDispatch] = await Promise.all([
        loadMessages(conversation.id),
        loadChatDispatch(conversation.id),
      ]);
      setMessages(nextMessages);
      setChatDispatch(nextDispatch);
      setError("");
    } catch (sendError) {
      setError(sendError.message);
    } finally {
      setBusy(false);
    }
  }, [conversation]);

  const handleFile = useCallback(async ({ title, brief, profileId }) => {
    if (!ownerId) return;
    setBusy(true);
    try {
      const { workItem, duplicate } = await fileWork({ ownerId, profileId, title, brief });
      if (workItem && !duplicate) setWorkItems((current) => [workItem, ...current]);
      setError("");
    } catch (fileError) {
      setError(fileError.message);
    } finally {
      setBusy(false);
    }
  }, [ownerId]);

  const handleCancel = useCallback(async (workItemId) => {
    setBusy(true);
    try {
      await transitionWork({ workItemId, type: "cancel", reason: "사용자 취소" });
      await refresh();
    } catch (cancelError) {
      setError(cancelError.message);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  // ---- render --------------------------------------------------------------
  if (!cloud.configured) {
    return (
      <div className="bibi-workspace">
        <SetupPanel problems={cloud.problems} />
        <WarningList
          title="실행 환경"
          warnings={runtime.warnings}
          summary={runtimeSummaryText(runtime)}
        />
        <RosterRail
          roster={roster}
          activeProfileId={activeProfileId}
          availabilityFor={availabilityFor}
          onSelect={setActiveProfileId}
        />
      </div>
    );
  }

  if (!session) {
    // Signed out there is one thing to do, so the card is centred at a reading
    // width instead of being stretched across the whole content column. The
    // signed-in workspace below keeps the full width for its three panes.
    return (
      <div className="bibi-workspace is-auth">
        <div className="bibi-auth">
          <SignInPanel />
        </div>
      </div>
    );
  }

  return (
    <div className="bibi-workspace">
      <header className="bibi-header">
        <div>
          <h1>Bibi Workspace</h1>
          <p>CEO비비와 이야기하고, 열여덟 개 프로필에 업무를 맡깁니다.</p>
        </div>
        <div className="bibi-header-actions">
          <span className={`bibi-badge bibi-connector-${connector.health.state}`}>{connector.health.label}</span>
          <span className="bibi-identity">{session.user?.email}</span>
          <button type="button" className="bibi-signout" onClick={() => signOut()}>로그아웃</button>
        </div>
      </header>

      <WarningList title="프로필 구조" warnings={mismatch.warnings} summary={mismatchSummaryText(mismatch)} />
      <WarningList title="실행 환경" warnings={runtime.warnings} summary={runtimeSummaryText(runtime)} />

      <div className="bibi-layout">
        <RosterRail
          roster={roster}
          activeProfileId={activeProfileId}
          availabilityFor={availabilityFor}
          onSelect={setActiveProfileId}
        />

        <ChatPanel
          profile={activeProfile}
          availability={availabilityFor(activeProfileId)}
          messages={messages}
          dispatch={chatDispatch}
          onSend={handleSend}
          busy={busy}
          error={error}
        />

        <aside className="bibi-side">
          <WorkIntake
            roster={roster}
            defaultProfileId={activeProfileId}
            availabilityFor={availabilityFor}
            onFile={handleFile}
            busy={busy}
          />
          <WorkBoard
            workItems={workItems}
            detail={openWorkDetail}
            openId={openWorkId}
            onOpen={setOpenWorkId}
            onCancel={handleCancel}
          />
        </aside>
      </div>
    </div>
  );
}

export { CONNECTOR_STATE };
