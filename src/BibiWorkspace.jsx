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
import { AUTH_GATE } from "./bibi/surface.js";
import {
  CONNECTOR_STATE,
  DISPATCH_MODE,
  describeConnectorHealth,
  describeProfileAvailability,
} from "./bibi/connectionState.js";
import { SEVERITY, describeConnectorProfileMismatch, mismatchSummaryText } from "./bibi/profileMismatch.js";
import { describeBrowserRuntimeMismatch, runtimeSummaryText } from "./bibi/runtimeEnvironment.js";
import { resetScrollOnAuthTransition } from "./bibi/authTransitionScroll.js";
import { WORK_STATUS, isTerminalStatus } from "./bibi/workLifecycle.js";
import { describeAuthError, problemFor, validateCredentials } from "./bibi/authForm.js";
import {
  AUTH_CALLBACK,
  CALLBACK_INTENT,
  describeCallbackError,
  describeCallbackFailure,
  isAuthCallback,
  parseAuthCallback,
  requiresPasswordSetup,
  strippedUrl,
} from "./bibi/authCallback.js";
import {
  PASSWORD_MIN_LENGTH,
  describePasswordUpdateError,
  validateNewPassword,
} from "./bibi/passwordPolicy.js";
import {
  clearPasswordSetupPending,
  isPasswordSetupPending,
  markPasswordSetupPending,
} from "./bibi/pendingPasswordSetup.js";
import { getCloudConfig } from "./cloud/supabaseBrowser.js";
import {
  BibiArchiveSurface,
  BibiDataRoomSurface,
  BibiMeetingSurface,
  BibiRosterSurface,
} from "./BibiCloudSurfaces.jsx";
import {
  establishSessionFromCallback,
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
  updatePassword,
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
 * its own client configuration.
 *
 * The connector mode is only filled in once a heartbeat has proved the row is
 * a report rather than a placeholder. Before that it is empty, and
 * `describeBrowserRuntimeMismatch` withholds the connector-derived findings
 * instead of reading the empty value as "misconfigured" — which is what put a
 * red `BIBI_CONNECTOR_MODE 미설정` card in front of an owner whose connector had
 * simply never been started.
 */
function browserRuntimeEnvironment(cloud, connectorNode, connectorReported) {
  return {
    BIBI_CONNECTOR_MODE: connectorReported ? connectorNode?.connector_mode ?? "" : "",
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
  const messagesRef = useRef(null);

  useEffect(() => {
    const list = messagesRef.current;
    if (list) list.scrollTop = list.scrollHeight;
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

      <ol className="bibi-messages" ref={messagesRef}>
        {messages.map((message) => (
          <li key={message.id} className={`bibi-message is-${message.role}`}>
            <span className="bibi-message-role">{message.role === "user" ? "나" : profile?.display_name ?? "비비"}</span>
            <p>{message.body}</p>
          </li>
        ))}
        <li aria-hidden="true" />
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
function SignInPanel({ onSignIn, notice }) {
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

      {/* A link that failed is explained here rather than on a dead-end screen,
          so the one useful next action — sign in, or ask for a new invite — is
          already in front of the user. */}
      {notice ? <p className="bibi-notice" role="status">{notice}</p> : null}

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

        {/* Always rendered, so a failed submit fills a space that was already
            there instead of pushing the button out from under the cursor. */}
        <div className="bibi-error-slot">
          {error ? <p className="bibi-error" role="alert">{error}</p> : null}
        </div>

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

/**
 * Where an invited user chooses their own password.
 *
 * Reached only by following an official invite (or a recovery link), and only
 * after that link has already produced a session — so the person filling this
 * in has proven they hold the mailbox. Nobody else sets this value: it is typed
 * here, sent straight to Supabase, and never travels through a chat, a log or
 * an environment file on the way.
 */
function PasswordSetupPanel({ email, intent, onDone, onAbandon }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problems, setProblems] = useState([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const passwordProblem = problemFor(problems, "password");
  const confirmProblem = problemFor(problems, "confirm");
  const returning = intent === CALLBACK_INTENT.RECOVERY;

  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;

    const validation = validateNewPassword({ password, confirm, email });
    setProblems(validation.problems);
    setError("");
    if (!validation.valid) return;

    setSaving(true);
    try {
      const { error: updateError } = await updatePassword(password);
      if (updateError) {
        setError(describePasswordUpdateError(updateError));
        return;
      }
      // Cleared before anything else so the secret does not sit in component
      // state while the workspace loads behind it.
      setPassword("");
      setConfirm("");
      onDone?.();
    } catch (thrown) {
      setError(describePasswordUpdateError(thrown));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bibi-setup">
      <h2>{returning ? "새 비밀번호 설정" : "환영합니다 — 비밀번호를 설정하세요"}</h2>
      <p>
        {returning
          ? "새 비밀번호를 정하면 다음부터 이 비밀번호로 로그인합니다."
          : "초대가 확인되었습니다. 사용할 비밀번호를 직접 정하세요. 다음 방문부터는 이메일과 이 비밀번호로 로그인합니다."}
      </p>
      {email ? <p className="bibi-identity-line">{email}</p> : null}

      <form className="bibi-signin" onSubmit={submit} noValidate>
        <label htmlFor="bibi-new-password">새 비밀번호</label>
        <input
          id="bibi-new-password"
          type="password"
          value={password}
          autoComplete="new-password"
          autoFocus
          aria-invalid={passwordProblem ? "true" : undefined}
          aria-describedby={passwordProblem ? "bibi-new-password-problem" : "bibi-new-password-hint"}
          onChange={(event) => setPassword(event.target.value)}
        />
        {passwordProblem ? (
          <span className="bibi-field-problem" id="bibi-new-password-problem">{passwordProblem.message}</span>
        ) : (
          <span className="bibi-field-hint" id="bibi-new-password-hint">
            {PASSWORD_MIN_LENGTH}자 이상, 영문·숫자·기호 중 두 종류 이상.
          </span>
        )}

        <label htmlFor="bibi-confirm-password">새 비밀번호 확인</label>
        <input
          id="bibi-confirm-password"
          type="password"
          value={confirm}
          autoComplete="new-password"
          aria-invalid={confirmProblem ? "true" : undefined}
          aria-describedby={confirmProblem ? "bibi-confirm-password-problem" : undefined}
          onChange={(event) => setConfirm(event.target.value)}
        />
        {confirmProblem ? (
          <span className="bibi-field-problem" id="bibi-confirm-password-problem">{confirmProblem.message}</span>
        ) : null}

        {/* Always rendered — see the sign-in form. A password rejected by the
            server must not move the save button. */}
        <div className="bibi-error-slot">
          {error ? <p className="bibi-error" role="alert">{error}</p> : null}
        </div>

        <button type="submit" disabled={saving}>
          {saving ? "저장 중…" : "비밀번호 저장하고 시작하기"}
        </button>
      </form>

      {/* An escape hatch. Without it, a half-finished invite would be a screen
          with no way out but clearing site data. */}
      <button type="button" className="bibi-signout bibi-abandon" onClick={onAbandon}>
        로그아웃
      </button>

      <p className="bibi-signin-note">
        비밀번호는 본인만 알고 있어야 합니다. 누구에게도, 어떤 대화창에도 입력해 전달하지 마세요.
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

/**
 * Take whatever the invite link left in the address bar, exactly once per page
 * load, and clear the address bar before anything gets a chance to read it.
 *
 * Once, because React re-renders and re-runs effects — in development it mounts
 * every component twice on purpose — and a token can only be redeemed one time.
 * Before, because until the URL is scrubbed the credential is in the address
 * bar, in the history entry, and in whatever the user copies out of it.
 */
let capturedCallback;

function consumeAuthCallback() {
  if (capturedCallback !== undefined) return capturedCallback;
  capturedCallback = null;
  if (typeof window === "undefined") return capturedCallback;

  const parsed = parseAuthCallback(window.location.href);
  if (!isAuthCallback(parsed)) return capturedCallback;

  try {
    window.history.replaceState(null, "", strippedUrl(window.location.href));
  } catch {
    // A blocked history API is not a reason to abandon the invite. The token is
    // about to be spent and will not be redeemable a second time regardless.
  }
  capturedCallback = parsed;
  return capturedCallback;
}

export default function BibiWorkspace({ surface = "ceo", onAuthGateChange }) {
  const cloud = useMemo(() => getCloudConfig(), []);
  const callback = useMemo(() => consumeAuthCallback(), []);
  const [session, setSession] = useState(null);
  const [authNotice, setAuthNotice] = useState("");
  const [callbackPending, setCallbackPending] = useState(
    () => Boolean(callback) && callback.kind !== AUTH_CALLBACK.ERROR,
  );
  const [passwordSetup, setPasswordSetup] = useState(false);

  // A link that arrived already failed needs no round trip to explain, so its
  // wording is derived rather than stored. `authNotice` holds only the failures
  // that Supabase reports back asynchronously.
  const signInNotice = callback?.kind === AUTH_CALLBACK.ERROR
    ? describeCallbackError(callback)
    : authNotice;
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
  const [cloudRevision, setCloudRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The signed-in workspace's own root, so the scroll reset below can find the
  // container that actually scrolls by walking up from something real.
  const workspaceRef = useRef(null);

  const ownerId = session?.user?.id ?? null;

  // ---- invite callback -----------------------------------------------------
  // Runs before the ordinary session lookup can matter: an arriving invite has
  // no stored session yet, and the link is the only thing that knows whether a
  // password is still owed.
  useEffect(() => {
    if (!cloud.configured || !callback) return undefined;
    // A link that came back as a failure has nothing to redeem. Its wording is
    // derived during render, not stored, so there is no state to set here.
    if (callback.kind === AUTH_CALLBACK.ERROR) return undefined;

    let active = true;
    establishSessionFromCallback(callback)
      .then(({ data, error: callbackError }) => {
        if (!active) return;
        const next = data?.session ?? null;
        if (callbackError || !next) {
          setAuthNotice(describeCallbackFailure());
          return;
        }
        if (requiresPasswordSetup(callback)) {
          // Written down before the screen renders, so a reload mid-setup comes
          // back to the same obligation rather than to a workspace the user has
          // no password for.
          markPasswordSetupPending(next.user?.id);
          setPasswordSetup(true);
        }
        setSession(next);
      })
      .catch(() => { if (active) setAuthNotice(describeCallbackFailure()); })
      .finally(() => { if (active) setCallbackPending(false); });

    return () => { active = false; };
  }, [cloud.configured, callback]);

  // ---- session -------------------------------------------------------------
  useEffect(() => {
    if (!cloud.configured) return undefined;
    let active = true;
    getSession().then((current) => {
      if (!active || !current) return;
      // Never over-writes a session the callback just established, which may
      // still be settling into storage when this resolves.
      setSession((existing) => existing ?? current);
      if (isPasswordSetupPending(current.user?.id)) setPasswordSetup(true);
    }).catch(() => {});
    const unsubscribe = onAuthStateChange((next) => {
      setSession(next);
      if (!next) setPasswordSetup(false);
    });
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
        setCloudRevision((current) => current + 1);
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
        if (!row?.id) return;
        setCloudRevision((current) => current + 1);
        if (row.conversation_id !== conversation?.id) return;
        setMessages((current) => (current.some((message) => message.id === row.id) ? current : [...current, row]));
      },
      onMeeting: () => setCloudRevision((current) => current + 1),
      onMeetingParticipant: () => setCloudRevision((current) => current + 1),
      onResult: () => setCloudRevision((current) => current + 1),
      onEvidence: () => setCloudRevision((current) => current + 1),
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

  // A heartbeat is the one thing that distinguishes "the connector reported and
  // this is what it said" from "no connector has ever run". Everything the
  // surface claims about the Mac is gated on it: without one there is a neutral
  // UNKNOWN badge and nothing else, and the mismatch cards stay off the screen
  // rather than reporting an absence of evidence as a fault.
  const connectorReported = connector.health.lastHeartbeatAt !== null;

  const mismatch = useMemo(
    () => describeConnectorProfileMismatch({
      reportedProfileIds: connector.reportedProfileIds,
      connectorReported,
    }),
    [connector.reportedProfileIds, connectorReported],
  );

  const runtime = useMemo(
    () => describeBrowserRuntimeMismatch(
      browserRuntimeEnvironment(cloud, connector.node, connectorReported),
      { connectorReported },
    ),
    [cloud, connector.node, connectorReported],
  );

  const activeProfile = roster.find((profile) => profile.id === activeProfileId) ?? roster[0];

  // ---- auth transition -----------------------------------------------------
  // Every screen before this one is a short card and this one is a long
  // three-pane layout, rendered into the same shell container. The container
  // keeps its offset across the swap, so on a phone the first signed-in view
  // starts wherever the user had scrolled to — measured at 390px as scrollTop
  // 1679, around bibi-13. Declared here, above the early returns, because hooks
  // cannot be conditional; the guard inside is what makes it a transition.
  const signedInWorkspace = cloud.configured && !callbackPending && Boolean(session) && !passwordSetup;

  useEffect(() => {
    if (!signedInWorkspace) return undefined;
    return resetScrollOnAuthTransition(workspaceRef.current);
  }, [signedInWorkspace]);

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

  const handlePasswordSet = useCallback(() => {
    // The obligation is discharged only here, once Supabase has accepted the
    // new password. Clearing it any earlier would strand a user who closed the
    // tab a moment too soon.
    clearPasswordSetupPending(ownerId);
    setPasswordSetup(false);
    setAuthNotice("");
  }, [ownerId]);

  const handleSignOut = useCallback(async () => {
    // The pending marker deliberately survives a sign-out: someone who walks
    // away mid-setup still has no password, and that stays true next time.
    setPasswordSetup(false);
    try {
      await signOut();
    } catch {
      // The local session is discarded either way; there is nothing the user
      // could do with a failure here.
    }
    setSession(null);
  }, []);

  // ---- auth gate -----------------------------------------------------------
  /**
   * Whether this surface is currently showing a gate rather than the workspace.
   *
   * The shell around this component advertises a whole application — a profile
   * roster, an office, meetings, a work board. None of that is reachable while
   * the visitor is still proving who they are, so the shell has to be told, and
   * only this component knows. Every gate counts: an unconfigured cloud, an
   * invite mid-redemption, a signed-out visitor, and a signed-in one who still
   * owes a password.
   */
  const authLocked = !cloud.configured || callbackPending || !session || passwordSetup;

  useEffect(() => {
    onAuthGateChange?.(authLocked ? AUTH_GATE.LOCKED : AUTH_GATE.OPEN);
  }, [authLocked, onAuthGateChange]);

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

  // An invite is mid-redemption. Showing the sign-in form here would ask an
  // invited user for a password they have not chosen yet.
  if (callbackPending) {
    return (
      <div className="bibi-workspace is-auth">
        <div className="bibi-auth">
          <section className="bibi-setup">
            <h2>초대 링크를 확인하는 중입니다</h2>
            <p>잠시만 기다려 주세요.</p>
          </section>
        </div>
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
          <SignInPanel notice={signInNotice} />
        </div>
      </div>
    );
  }

  // Authenticated, but the account still has no password of its own. Nothing
  // else on the surface is reachable until it does.
  if (passwordSetup) {
    return (
      <div className="bibi-workspace is-auth">
        <div className="bibi-auth">
          <PasswordSetupPanel
            email={session.user?.email ?? ""}
            intent={callback?.intent ?? CALLBACK_INTENT.INVITE}
            onDone={handlePasswordSet}
            onAbandon={handleSignOut}
          />
        </div>
      </div>
    );
  }

  const surfaceCopy = {
    ceo: ["Bibi Workspace", "CEO비비와 이야기하고, 열여덟 개 프로필에 업무를 맡깁니다."],
    chat: ["실제 비비 대화", "선택한 조직 ID가 정확한 로컬 Hermes profile로 실행됩니다."],
    meeting: ["비비 회의실", "참가자별 실제 실행 결과가 하나의 회의 기록으로 영속화됩니다."],
    data: ["실제 데이터룸", "Hermes 결과와 검증 가능한 provenance만 표시합니다."],
    sessions: ["대화 기록", "Supabase에 저장된 owner 전용 대화 기록입니다."],
    office: ["실제 비비 오피스", "connector가 확인한 열여덟 개 실행 역할을 봅니다."],
    team: ["AI 조직", "정본 역할과 실제 실행 profile을 함께 봅니다."],
    kanban: ["실제 업무 보드", "cloud queue부터 Hermes 결과까지 실제 lifecycle만 표시합니다."],
    command: ["지휘 센터", "실제 Bibi 업무 배정과 상태 전환을 관리합니다."],
  }[surface] ?? ["Bibi Workspace", "실제 Bibi 조직 워크스페이스입니다."];

  const surfaceBody = (() => {
    if (surface === "meeting") return <BibiMeetingSurface roster={roster} availabilityFor={availabilityFor} refreshKey={cloudRevision} />;
    if (surface === "data") return <BibiDataRoomSurface roster={roster} refreshKey={cloudRevision} />;
    if (surface === "sessions") return <BibiArchiveSurface roster={roster} refreshKey={cloudRevision} />;
    if (surface === "office" || surface === "team") {
      return <BibiRosterSurface roster={roster} availabilityFor={availabilityFor} onSelect={setActiveProfileId} />;
    }
    if (surface === "chat") {
      return (
        <div className="bibi-layout bibi-layout-chat">
          <RosterRail roster={roster} activeProfileId={activeProfileId} availabilityFor={availabilityFor} onSelect={setActiveProfileId} />
          <ChatPanel profile={activeProfile} availability={availabilityFor(activeProfileId)} messages={messages} dispatch={chatDispatch} onSend={handleSend} busy={busy} error={error} />
        </div>
      );
    }
    if (surface === "kanban" || surface === "command") {
      return (
        <div className="bibi-layout bibi-layout-work">
          <RosterRail roster={roster} activeProfileId={activeProfileId} availabilityFor={availabilityFor} onSelect={setActiveProfileId} />
          <WorkIntake roster={roster} defaultProfileId={activeProfileId} availabilityFor={availabilityFor} onFile={handleFile} busy={busy} />
          <WorkBoard workItems={workItems} detail={openWorkDetail} openId={openWorkId} onOpen={setOpenWorkId} onCancel={handleCancel} />
        </div>
      );
    }
    return (
      <div className="bibi-layout">
        <RosterRail roster={roster} activeProfileId={activeProfileId} availabilityFor={availabilityFor} onSelect={setActiveProfileId} />
        <ChatPanel profile={activeProfile} availability={availabilityFor(activeProfileId)} messages={messages} dispatch={chatDispatch} onSend={handleSend} busy={busy} error={error} />
        <aside className="bibi-side">
          <WorkIntake roster={roster} defaultProfileId={activeProfileId} availabilityFor={availabilityFor} onFile={handleFile} busy={busy} />
          <WorkBoard workItems={workItems} detail={openWorkDetail} openId={openWorkId} onOpen={setOpenWorkId} onCancel={handleCancel} />
        </aside>
      </div>
    );
  })();

  return (
    <div className={`bibi-workspace is-surface-${surface}`} ref={workspaceRef}>
      <header className="bibi-header">
        <div>
          <h1>{surfaceCopy[0]}</h1>
          <p>{surfaceCopy[1]}</p>
        </div>
        <div className="bibi-header-actions">
          <span className={`bibi-badge bibi-connector-${connector.health.state}`}>{connector.health.label}</span>
          <span className="bibi-identity">{session.user?.email}</span>
          <button type="button" className="bibi-signout" onClick={handleSignOut}>로그아웃</button>
        </div>
      </header>

      <WarningList title="프로필 구조" warnings={mismatch.warnings} summary={mismatchSummaryText(mismatch)} />
      <WarningList title="실행 환경" warnings={runtime.warnings} summary={runtimeSummaryText(runtime)} />

      {surfaceBody}
    </div>
  );
}

export { CONNECTOR_STATE };
