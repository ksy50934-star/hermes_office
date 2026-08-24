import { useEffect, useMemo, useRef, useState } from "react";
import { resolveProfileMeta } from "./officeData.js";
import { loadMessages, sendUserMessage, startConversation } from "./cloud/workspaceClient.js";

function formatTime(value) {
  if (!value) return "방금";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "방금";
  return new Intl.DateTimeFormat("ko", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export default function BibiDirectChat({ snapshot, profiles = [], initialProfile = "bibi-01", initialConversationId = "" }) {
  const [activeProfile, setActiveProfile] = useState(() => profiles.some((item) => item.name === initialProfile) ? initialProfile : profiles[0]?.name ?? "bibi-01");
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [loadedMessages, setLoadedMessages] = useState({ conversationId: "", items: [] });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mobileStage, setMobileStage] = useState("people");
  const bottomRef = useRef(null);

  const profile = profiles.find((item) => item.name === activeProfile) ?? profiles[0];
  const meta = resolveProfileMeta(profile ?? activeProfile);
  const conversations = useMemo(
    () => (snapshot?.archive ?? []).filter((item) => item.profile_id === activeProfile),
    [snapshot?.archive, activeProfile],
  );
  const selected = conversations.find((item) => item.id === conversationId) ?? conversations[0] ?? null;
  const messages = loadedMessages.conversationId === selected?.id
    ? loadedMessages.items
    : selected?.messages ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const openConversation = (conversation) => {
    setConversationId(conversation.id);
    setLoadedMessages({ conversationId: conversation.id, items: conversation.messages ?? [] });
    setMobileStage("chat");
  };

  const newConversation = async () => {
    if (!snapshot?.ownerId) return;
    setBusy(true);
    try {
      const created = await startConversation({ ownerId: snapshot.ownerId, profileId: activeProfile });
      setConversationId(created.id);
      setLoadedMessages({ conversationId: created.id, items: [] });
      setMobileStage("chat");
      setError("");
    } catch (createError) {
      setError(createError.message);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || busy || !snapshot?.ownerId) return;
    setBusy(true);
    try {
      let id = conversationId || selected?.id;
      if (!id) {
        const created = await startConversation({ ownerId: snapshot.ownerId, profileId: activeProfile });
        id = created.id;
        setConversationId(id);
      }
      setDraft("");
      await sendUserMessage({ conversationId: id, body });
      setLoadedMessages({ conversationId: id, items: await loadMessages(id) });
      setError("");
    } catch (sendError) {
      setDraft((current) => current || body);
      setError(sendError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`profile-chat-layout mobile-stage-${mobileStage}`}>
      <section className="mobile-chat-start">
        {mobileStage === "people" ? (
          <>
            <header><span>DIRECT MESSAGES</span><strong>누구와 대화할까요?</strong><small>실제 Bibi profile과 연결된 대화를 선택합니다.</small></header>
            <div className="mobile-chat-people">
              {profiles.map((item) => {
                const member = resolveProfileMeta(item);
                return <button type="button" key={item.name} onClick={() => { setActiveProfile(item.name); setMobileStage("sessions"); }}><span style={{ "--avatar": member.color }}>{member.initials}</span><div><strong>{member.name}</strong><small>{member.role}</small></div><i className={item.gateway_running ? "online" : ""} /></button>;
              })}
            </div>
          </>
        ) : mobileStage === "sessions" ? (
          <>
            <header><button type="button" onClick={() => setMobileStage("people")}>← 구성원</button><span>{meta.name}</span><strong>대화 선택</strong><small>저장된 대화를 이어가거나 새 대화를 시작하세요.</small></header>
            <div className="mobile-session-list"><button type="button" className="new-mobile-session" onClick={newConversation}><strong>새 대화 시작</strong><small>{meta.name}에게 새 업무를 요청합니다.</small></button>{conversations.map((item) => <article key={item.id} className="chat-session-item"><button type="button" className="chat-session-open" onClick={() => openConversation(item)}><strong>{item.title || item.messages?.[0]?.body || "제목 없는 대화"}</strong><small>{item.messages?.length || 0}개 · {formatTime(item.last_message_at)}</small></button></article>)}</div>
          </>
        ) : null}
      </section>

      <aside className="profile-chat-roster">
        <header><span>DIRECT MESSAGES</span><strong>AI 구성원</strong></header>
        {profiles.map((item) => {
          const member = resolveProfileMeta(item);
          return <button type="button" key={item.name} className={activeProfile === item.name ? "active" : ""} onClick={() => { setActiveProfile(item.name); setConversationId(""); }}><span style={{ "--avatar": member.color }}>{member.initials}</span><div><strong>{member.name}</strong><small>{member.role}</small></div><i className={item.gateway_running ? "online" : ""} /></button>;
        })}
      </aside>

      <aside className="chat-session-rail">
        <header><span>CONVERSATIONS</span><div><button type="button" onClick={newConversation}>+ 새 대화</button></div></header>
        {conversations.map((item) => <article key={item.id} className={`chat-session-item ${conversationId === item.id ? "active" : ""}`}><button type="button" className="chat-session-open" onClick={() => openConversation(item)}><strong>{item.title || item.messages?.[0]?.body || "제목 없는 대화"}</strong><small>{item.messages?.length || 0}개 · {formatTime(item.last_message_at)}</small></button></article>)}
        {!conversations.length && <p>저장된 대화가 없습니다.</p>}
      </aside>

      <section className="profile-chat-panel">
        <header className="profile-chat-header"><button type="button" className="mobile-chat-back" onClick={() => setMobileStage("sessions")}>← 대화 선택</button><span className="profile-chat-hero" style={{ "--avatar": meta.color }}>{meta.initials}</span><div><small>{meta.role}</small><h3>{meta.name}과 대화</h3></div><span className={`chat-connection ${profile?.gateway_running ? "open" : "error"}`}><i /> {profile?.gateway_running ? "실시간 연결" : "대기열 연결"}</span></header>
        <div className="profile-chat-feed">
          {!messages.length && <div className="profile-chat-empty"><span style={{ "--avatar": meta.color }}>{meta.initials}</span><h4>{meta.name}에게 새 업무를 요청하세요</h4><p>이 대화는 <b>{activeProfile}</b> 조직 ID에만 연결됩니다.</p></div>}
          {messages.map((message) => <article key={message.id} className={`chat-message ${message.role === "user" ? "user" : "assistant"}`}><div className="chat-message-copy"><small>{message.role === "user" ? "나" : meta.name} · {formatTime(message.created_at)}</small><p>{message.body}</p></div></article>)}
          {busy && <div className="chat-thinking"><i /><span>{meta.name}이 요청을 처리하고 있습니다.</span></div>}
          {error && <p className="profile-chat-error">{error}</p>}
          <div ref={bottomRef} />
        </div>
        <footer className="profile-chat-composer"><div className="chat-status-line"><span>{busy ? `${meta.name}이 답변을 준비 중` : `${meta.name} 준비됨`}</span><small>Supabase 대화 · {activeProfile}</small></div><div className="chat-composer-row"><textarea name="chat-message" aria-label={`${meta.name}에게 메시지 보내기`} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder={`${meta.name}에게 메시지 보내기`} /><div className="chat-composer-actions"><button type="button" onClick={send} disabled={!draft.trim() || busy}>전송</button></div></div></footer>
      </section>
    </div>
  );
}
