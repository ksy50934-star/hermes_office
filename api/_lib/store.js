/**
 * The store interface the connector handlers use, implemented over the
 * service-role Supabase client.
 *
 * Every method takes an ownerId and filters on it even though the service role
 * bypasses row level security. RLS protects the browser; this filtering is what
 * protects one account from another on the server side, where there is no
 * policy left to catch a mistake.
 */

import { createClient } from "@supabase/supabase-js";
import { loadServerEnv } from "./serverEnv.js";

export function createServiceRoleClient(env = process.env) {
  const { supabaseUrl, supabaseServiceRoleKey } = loadServerEnv(env);
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Bibi-Server": "connector-api" } },
  });
}

function unwrap(result, context) {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  return result.data;
}

export function createWorkspaceStore(supabase) {
  return {
    async findConnectorCredential(tokenHash) {
      const { data, error } = await supabase
        .from("connector_credentials")
        .select("id, owner_id, connector_node_id, token_hash, revoked_at")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (error) throw new Error(`findConnectorCredential: ${error.message}`);
      return data ?? null;
    },

    async recordHeartbeat({ ownerId, connectorNodeId, label, reportedProfileIds, localRuntimeReachable, at }) {
      unwrap(
        await supabase
          .from("connector_nodes")
          .update({
            label,
            reported_profile_ids: reportedProfileIds,
            // A connector that cannot reach the local runtime is not online,
            // however healthy its own network is.
            status: localRuntimeReachable ? "online" : "stale",
            last_heartbeat_at: at,
            updated_at: at,
          })
          .eq("id", connectorNodeId)
          .eq("owner_id", ownerId)
          .select("id"),
        "recordHeartbeat",
      );
    },

    async claimWork({ ownerId, connectorNodeId, max, leaseTtlMs }) {
      const data = unwrap(
        await supabase.rpc("bibi_claim_work", {
          p_owner_id: ownerId,
          p_connector_node_id: connectorNodeId,
          p_max: max,
          p_lease_ttl_ms: leaseTtlMs,
        }),
        "claimWork",
      );
      return (data ?? []).map((row) => ({
        workItemId: row.work_item_id,
        profileId: row.profile_id,
        kind: row.kind,
        conversationId: row.conversation_id,
        title: row.title,
        brief: row.brief,
        attempt: row.attempt,
        leaseId: row.lease_id,
        leaseExpiresAt: row.lease_expires_at,
      }));
    },

    async renewLease({ ownerId, connectorNodeId, leaseId, workItemId, expiresAt }) {
      const data = unwrap(
        await supabase
          .from("command_leases")
          .update({ expires_at: expiresAt })
          .eq("owner_id", ownerId)
          .eq("work_item_id", workItemId)
          .eq("connector_node_id", connectorNodeId)
          .is("released_at", null)
          .select("id, expires_at"),
        "renewLease",
      );
      if (!data?.length) return null;

      unwrap(
        await supabase
          .from("work_items")
          .update({ lease_expires_at: expiresAt })
          .eq("owner_id", ownerId)
          .eq("id", workItemId)
          .eq("lease_id", leaseId)
          .select("id"),
        "renewLease.workItem",
      );
      return { expiresAt: data[0].expires_at };
    },

    async loadWorkItem({ ownerId, workItemId }) {
      const { data, error } = await supabase
        .from("work_items")
        .select("*")
        .eq("owner_id", ownerId)
        .eq("id", workItemId)
        .maybeSingle();
      if (error) throw new Error(`loadWorkItem: ${error.message}`);
      if (!data) return null;
      return {
        id: data.id,
        ownerId: data.owner_id,
        clientRequestId: data.client_request_id,
        title: data.title,
        brief: data.brief,
        status: data.status,
        profileId: data.profile_id,
        leaseId: data.lease_id,
        nodeId: data.node_id,
        leaseExpiresAt: data.lease_expires_at,
        attempt: data.attempt,
        resultId: data.result_id,
        error: data.error,
        blockedReason: data.blocked_reason,
        kind: data.kind,
        conversationId: data.conversation_id,
        requestMessageId: data.request_message_id,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        // The lifecycle reducer needs an applied-event list. Replay protection
        // itself lives in the unique constraint on work_events, so an empty
        // list here is correct rather than a gap.
        appliedEventIds: [],
      };
    },

    async recordEvent({ ownerId, workItemId, eventId, eventType, payload, at }) {
      const { error } = await supabase.from("work_events").insert({
        owner_id: ownerId,
        work_item_id: workItemId,
        event_id: eventId,
        event_type: eventType,
        payload,
        created_at: at,
      });
      // 23505 is unique_violation: this exact event was already recorded, so
      // the report is a redelivery rather than a new transition.
      if (error?.code === "23505") return { duplicate: true };
      if (error) throw new Error(`recordEvent: ${error.message}`);
      return { duplicate: false };
    },

    async insertResult({ ownerId, workItemId, summary, detail, at }) {
      const data = unwrap(
        await supabase
          .from("work_results")
          .insert({ owner_id: ownerId, work_item_id: workItemId, summary, detail, created_at: at })
          .select("id")
          .single(),
        "insertResult",
      );
      return { id: data.id };
    },

    async insertEvidence({ ownerId, workItemId, executionProfileId = null, evidence, at }) {
      unwrap(
        await supabase.from("work_evidence").insert(evidence.map((item) => ({
          owner_id: ownerId,
          work_item_id: workItemId,
          execution_profile_id: executionProfileId,
          kind: item.kind,
          label: item.label,
          sha256: item.sha256 ?? null,
          byte_size: item.byteSize ?? null,
          storage_path: item.storagePath ?? null,
          inline_excerpt: item.inlineExcerpt ?? null,
          created_at: at,
        }))).select("id"),
        "insertEvidence",
      );
    },

    /**
     * One atomic call creates the user's turn and the command that will answer
     * it. Returning `duplicate` lets a resend resolve to the original pair
     * instead of asking the same question twice.
     */
    async sendChatMessage({ ownerId, conversationId, clientMessageId, body }) {
      const { data, error } = await supabase.rpc("bibi_send_chat_message", {
        p_owner_id: ownerId,
        p_conversation_id: conversationId,
        p_client_message_id: clientMessageId,
        p_body: body,
      });
      if (error) {
        // The function raises no_data_found when the conversation does not
        // belong to this owner; surface that as "not found", not as a failure.
        if (/no_data_found|conversation not found/i.test(error.message)) {
          const notFound = new Error(error.message);
          notFound.code = "CONVERSATION_NOT_FOUND";
          throw notFound;
        }
        throw new Error(`sendChatMessage: ${error.message}`);
      }
      const row = Array.isArray(data) ? data[0] : data;
      return {
        duplicate: Boolean(row?.duplicate),
        messageId: row?.message_id ?? null,
        workItemId: row?.work_item_id ?? null,
      };
    },

    async insertAssistantMessage({ ownerId, workItemId, body }) {
      const { data, error } = await supabase.rpc("bibi_record_assistant_message", {
        p_owner_id: ownerId,
        p_work_item_id: workItemId,
        p_body: body,
      });
      if (error) throw new Error(`insertAssistantMessage: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      return { duplicate: Boolean(row?.duplicate), messageId: row?.message_id ?? null };
    },

    async releaseLease({ ownerId, workItemId, reason, at }) {
      unwrap(
        await supabase
          .from("command_leases")
          .update({ released_at: at, release_reason: reason })
          .eq("owner_id", ownerId)
          .eq("work_item_id", workItemId)
          .is("released_at", null)
          .select("id"),
        "releaseLease",
      );
    },

    async saveWorkItem({ ownerId, work }) {
      unwrap(
        await supabase
          .from("work_items")
          .update({
            status: work.status,
            profile_id: work.profileId,
            lease_id: work.leaseId,
            node_id: work.nodeId,
            lease_expires_at: work.leaseExpiresAt,
            attempt: work.attempt,
            result_id: work.resultId,
            error: work.error,
            blocked_reason: work.blockedReason,
            updated_at: work.updatedAt,
          })
          .eq("owner_id", ownerId)
          .eq("id", work.id)
          .select("id"),
        "saveWorkItem",
      );
    },
  };
}
