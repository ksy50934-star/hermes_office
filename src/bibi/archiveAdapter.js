import { deleteConversation, loadMessages } from "../cloud/workspaceClient.js";

function timestampSeconds(value) {
  const millis = Date.parse(value ?? "");
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : 0;
}

function meetingEntries(meeting) {
  return (meeting.participants ?? [])
    .filter((participant) => participant.result)
    .map((participant) => ({
      id: participant.result.id,
      profile: participant.profile_id,
      kind: "statement",
      text: participant.result.detail || participant.result.summary || "",
      pending: false,
      time: participant.result.created_at,
      timestamp: timestampSeconds(participant.result.created_at),
    }))
    .filter((entry) => entry.text)
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function cloudArchiveView({ archive = [], meetings = [] } = {}) {
  return {
    sessions: archive.map((conversation) => ({
      id: conversation.id,
      profile: conversation.profile_id,
      title: conversation.title || "새 대화",
      source: "Bibi Cloud",
      message_count: conversation.messages?.length ?? 0,
      last_active: timestampSeconds(conversation.last_message_at || conversation.created_at),
      created_at: conversation.created_at,
      archived: Boolean(conversation.archived_at),
      cloud: true,
    })),
    meetings: meetings.map((meeting) => ({
      id: meeting.id,
      topic: meeting.topic,
      status: meeting.status === "completed" ? "complete" : meeting.status,
      participants: (meeting.participants ?? []).map((participant) => participant.profile_id),
      round: 1,
      updatedAt: Date.parse(meeting.completed_at || meeting.created_at || "") || 0,
      entries: meetingEntries(meeting),
      cloud: true,
    })),
  };
}

export function createCloudArchiveAdapter({ archive = [], meetings = [], loadMessagesFn = loadMessages, deleteConversationFn = deleteConversation } = {}) {
  return {
    backend: "bibi-cloud",
    async list() {
      return cloudArchiveView({ archive, meetings });
    },
    async loadMessages(session) {
      const rows = await loadMessagesFn(session.id);
      return rows.map((message) => ({
        ...message,
        content: message.body ?? message.content ?? "",
        timestamp: timestampSeconds(message.timeline_at || message.source_timestamp || message.created_at),
      }));
    },
    async export(session) {
      const messages = await this.loadMessages(session);
      return {
        schema: "bibi-cloud-conversation-export/v1",
        exportedAt: new Date().toISOString(),
        conversation: {
          id: session.id,
          profileId: session.profile,
          title: session.title,
          source: session.source,
        },
        messages: messages.map(({ id, role, content, timestamp, provenance, channel }) => ({
          id, role, content, timestamp, provenance, channel,
        })),
      };
    },
    async remove(session) {
      await deleteConversationFn(session.id);
      return { id: session.id };
    },
  };
}
