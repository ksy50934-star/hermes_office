import { createMeetingFollowup, deleteConversation, loadMessages } from "../cloud/workspaceClient.js";
import {
  completedCloudMeetings,
  describeMeetingRecord,
  meetingFollowupCandidates,
} from "./meetingLifecycle.js";

function timestampSeconds(value) {
  const millis = Date.parse(value ?? "");
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : 0;
}

/**
 * The reader's transcript for a completed meeting: one entry per persisted
 * result and per evidence excerpt, in the order they were written.
 *
 * A result's summary and detail are both carried, separately, because they are
 * two things the profile wrote and neither one is a stand-in for the other.
 * Nothing is added for a participant that produced nothing — the record panel
 * says so in its own right, and inventing a placeholder statement would put an
 * empty result on screen as if it were an answer.
 */
function meetingEntries(record) {
  const entries = [];
  for (const participant of record.participants) {
    for (const result of participant.results) {
      const text = result.detail || result.summary;
      if (!text) continue;
      entries.push({
        id: result.id,
        profile: participant.profileId,
        kind: "statement",
        text,
        summary: result.summary,
        detail: result.detail,
        pending: false,
        time: result.createdAt,
        timestamp: timestampSeconds(result.createdAt),
      });
    }
    for (const item of participant.evidence) {
      if (!item.excerpt) continue;
      entries.push({
        id: `${item.id}:evidence`,
        profile: participant.profileId,
        kind: "evidence",
        text: item.excerpt,
        label: item.label,
        pending: false,
        time: item.createdAt,
        timestamp: timestampSeconds(item.createdAt),
      });
    }
  }
  return entries.sort((left, right) => left.timestamp - right.timestamp);
}

/**
 * The archive holds completed meetings only.
 *
 * A running meeting is on the meeting surface, where it can still be joined and
 * ended; listing it here as well would make one meeting look like two records
 * and would offer a follow-up button over work that has not finished.
 */
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
    meetings: completedCloudMeetings(meetings).map((meeting) => {
      const record = describeMeetingRecord(meeting);
      return {
        id: record.id,
        topic: record.topic,
        status: record.status,
        completionMode: record.completionMode,
        participants: record.participants.map((participant) => participant.profileId),
        round: 1,
        updatedAt: record.updatedAt,
        entries: meetingEntries(record),
        record,
        followupCandidates: meetingFollowupCandidates(record),
        // Null, and not derived from anything. A cloud meeting produces results
        // and evidence; it does not produce a decision summary, and this
        // adapter will not write one on its behalf.
        outcome: null,
        cloud: true,
      };
    }),
  };
}

export function createCloudArchiveAdapter({
  archive = [],
  meetings = [],
  ownerId = null,
  followups = new Map(),
  loadMessagesFn = loadMessages,
  deleteConversationFn = deleteConversation,
  createFollowupFn = createMeetingFollowup,
} = {}) {
  return {
    backend: "bibi-cloud",
    /** Follow-ups already filed, keyed by their intake idempotency key. */
    followups,
    async list() {
      return cloudArchiveView({ archive, meetings });
    },
    /**
     * File a follow-up from a span the user picked out of the record.
     *
     * The key is deterministic, so a second call for the same selection returns
     * the work item the first one created and reports it as a duplicate rather
     * than filing the same sentence twice.
     */
    async createFollowup(meeting, candidate) {
      return createFollowupFn({ ownerId, meetingId: meeting?.id, candidate });
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
