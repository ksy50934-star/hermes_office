/**
 * The store interface the connector handlers use, implemented over the
 * service-role Supabase client.
 *
 * Every method takes an ownerId and filters on it even though the service role
 * bypasses row level security. RLS protects the browser; this filtering is what
 * protects one account from another on the server side, where there is no
 * policy left to catch a mistake.
 */

import { createHash } from "node:crypto";
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

/**
 * Turn a binding RPC failure into a code the handlers can map to a status.
 *
 * The database is where these rules actually live — the guard trigger, the
 * identity match, the owner scoping — so the error text it raises is the
 * authority. Anything unrecognised keeps its message and becomes a 500 rather
 * than being reported as a client mistake.
 */
function mapBindingError(error) {
  const message = String(error?.message ?? "");
  const mapped = new Error(message);
  if (/no_data_found|not found for owner/i.test(message)) mapped.code = "BINDING_NOT_FOUND";
  else if (/already bound to another conversation/i.test(message)) mapped.code = "BINDING_CONFLICT";
  else if (/identity mismatch/i.test(message)) mapped.code = "BINDING_IDENTITY_MISMATCH";
  else if (/requires the authenticated connector|may only be created pending|requires connector proof/i.test(message)) {
    mapped.code = "BINDING_VERIFICATION_FORBIDDEN";
  } else if (/only a pending binding|identity is incomplete|only telegram bindings|needs a reason code/i.test(message)) {
    mapped.code = "BINDING_INVALID_REQUEST";
  } else if (/duplicate key|unique/i.test(message)) mapped.code = "BINDING_CONFLICT";
  return mapped;
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

    async upsertRuntimeProjection({ ownerId, connectorNodeId, profileId, inventory, health, documentTree, collectedAt }) {
      const [inventoryRows, healthRows, documentRows] = await Promise.all([
        supabase.from("bibi_plugin_inventory").upsert({
          owner_id: ownerId,
          node_id: connectorNodeId,
          profile_id: profileId,
          catalog: inventory.catalog,
          servers: inventory.servers,
          toolsets: inventory.toolsets,
          collection_errors: inventory.errors,
          collected_at: collectedAt,
          updated_at: collectedAt,
        }, { onConflict: "owner_id,profile_id" }).select("profile_id"),
        supabase.from("bibi_runtime_health").upsert({
          owner_id: ownerId,
          node_id: connectorNodeId,
          profile_id: profileId,
          hermes_version: health.hermesVersion,
          model: health.model,
          provider: health.provider,
          gateway_status: health.gatewayStatus,
          active_sessions: health.activeSessions,
          enabled_toolsets: health.enabledToolsets,
          disabled_toolsets: health.disabledToolsets,
          health_error: health.error,
          collected_at: collectedAt,
          updated_at: collectedAt,
        }, { onConflict: "owner_id,profile_id" }).select("profile_id"),
        supabase.from("bibi_document_trees").upsert({
          owner_id: ownerId,
          node_id: connectorNodeId,
          profile_id: profileId,
          directories: documentTree.directories,
          collection_error: documentTree.collectionError,
          collected_at: collectedAt,
          updated_at: collectedAt,
        }, { onConflict: "owner_id,profile_id" }).select("profile_id"),
      ]);
      unwrap(inventoryRows, "upsertRuntimeProjection.inventory");
      unwrap(healthRows, "upsertRuntimeProjection.health");
      unwrap(documentRows, "upsertRuntimeProjection.documents");
    },

    async listProjectionTargets({ ownerId }) {
      const bindings = unwrap(
        await supabase
          .from("conversation_bindings")
          .select("id, conversation_id, organization_profile_id, execution_profile_id, hermes_session_id, channel")
          .eq("owner_id", ownerId)
          .eq("channel", "telegram")
          .eq("binding_state", "verified")
          .not("verified_at", "is", null)
          .not("verified_by_node_id", "is", null),
        "listProjectionTargets.bindings",
      ) ?? [];
      if (!bindings.length) return [];
      const checkpoints = unwrap(
        await supabase
          .from("projection_checkpoints")
          .select("binding_id, last_source_message_id, last_lifecycle_scan_message_id")
          .eq("owner_id", ownerId)
          .in("binding_id", bindings.map((binding) => binding.id)),
        "listProjectionTargets.checkpoints",
      ) ?? [];
      const checkpointByBinding = new Map(checkpoints.map((row) => [row.binding_id, {
        message: Number(row.last_source_message_id ?? 0),
        lifecycle: Number(row.last_lifecycle_scan_message_id ?? 0),
      }]));
      const workLinks = unwrap(
        await supabase
          .from("work_items")
          .select("id, binding_id, request_message_id, brief, created_at")
          .eq("owner_id", ownerId)
          .eq("continuation_status", "bound")
          .in("binding_id", bindings.map((binding) => binding.id))
          .not("request_message_id", "is", null)
          .order("created_at", { ascending: true })
          .limit(500),
        "listProjectionTargets.workLinks",
      ) ?? [];
      const linksByBinding = new Map();
      for (const work of workLinks) {
        const links = linksByBinding.get(work.binding_id) ?? [];
        links.push({
          workItemId: work.id,
          requestMessageId: work.request_message_id,
          bodySha256: createHash("sha256").update(String(work.brief ?? "")).digest("hex"),
        });
        linksByBinding.set(work.binding_id, links);
      }
      return bindings.map((binding) => ({
        bindingId: binding.id,
        conversationId: binding.conversation_id,
        organizationProfileId: binding.organization_profile_id,
        executionProfileId: binding.execution_profile_id,
        hermesSessionId: binding.hermes_session_id,
        channel: binding.channel,
        checkpoint: checkpointByBinding.get(binding.id)?.message ?? 0,
        lifecycleCheckpoint: checkpointByBinding.get(binding.id)?.lifecycle ?? 0,
        canonicalLinks: linksByBinding.get(binding.id) ?? [],
      }));
    },

    /**
     * The bindings waiting on proof, with the identity the connector has to
     * confirm. Owner-scoped like everything else here, and restricted to
     * `pending`: a verified binding needs nothing, and a blocked one is waiting
     * on the owner to retry rather than on the Mac.
     */
    async listPendingBindings({ ownerId }) {
      const rows = unwrap(
        await supabase
          .from("conversation_bindings")
          .select("id, conversation_id, organization_profile_id, execution_profile_id, channel, channel_account_id, external_conversation_id, hermes_session_id, created_at")
          .eq("owner_id", ownerId)
          .eq("channel", "telegram")
          .eq("binding_state", "pending")
          .order("created_at", { ascending: true })
          .limit(100),
        "listPendingBindings",
      ) ?? [];
      return rows.map((row) => ({
        bindingId: row.id,
        conversationId: row.conversation_id,
        organizationProfileId: row.organization_profile_id,
        executionProfileId: row.execution_profile_id,
        channel: row.channel,
        channelAccountId: row.channel_account_id,
        externalConversationId: row.external_conversation_id,
        hermesSessionId: row.hermes_session_id,
        createdAt: row.created_at,
      }));
    },

    /**
     * Ask for a binding. The RPC creates it `pending` and nothing else; there is
     * no argument here that could make it verified.
     */
    async requestConversationBinding({
      ownerId, conversationId, channel, channelAccountId,
      externalConversationId, hermesSessionId, clientRequestId,
    }) {
      const { data, error } = await supabase.rpc("bibi_request_conversation_binding", {
        p_owner_id: ownerId,
        p_conversation_id: conversationId,
        p_channel: channel,
        p_channel_account_id: channelAccountId,
        p_external_conversation_id: externalConversationId,
        p_hermes_session_id: hermesSessionId,
        p_client_request_id: clientRequestId ?? null,
      });
      if (error) throw mapBindingError(error);
      const row = Array.isArray(data) ? data[0] : data;
      return {
        bindingId: row?.binding_id ?? null,
        bindingState: row?.binding_state ?? null,
        duplicate: Boolean(row?.duplicate),
        retried: Boolean(row?.retried),
      };
    },

    async cancelConversationBinding({ ownerId, bindingId, reason }) {
      const { data, error } = await supabase.rpc("bibi_cancel_conversation_binding", {
        p_owner_id: ownerId,
        p_binding_id: bindingId,
        p_reason: reason ?? null,
      });
      if (error) throw mapBindingError(error);
      const row = Array.isArray(data) ? data[0] : data;
      return {
        bindingId: row?.binding_id ?? null,
        bindingState: row?.binding_state ?? null,
        alreadyUnbound: Boolean(row?.already_unbound),
      };
    },

    async verifyConversationBinding({
      ownerId, connectorNodeId, bindingId, channelAccountId,
      externalConversationId, hermesSessionId, executionProfileId, evidence,
    }) {
      const { data, error } = await supabase.rpc("bibi_verify_conversation_binding", {
        p_owner_id: ownerId,
        p_connector_node_id: connectorNodeId,
        p_binding_id: bindingId,
        p_channel_account_id: channelAccountId,
        p_external_conversation_id: externalConversationId,
        p_hermes_session_id: hermesSessionId,
        p_execution_profile_id: executionProfileId,
        p_evidence: evidence ?? {},
      });
      if (error) throw mapBindingError(error);
      const row = Array.isArray(data) ? data[0] : data;
      return {
        bindingId: row?.binding_id ?? null,
        bindingState: row?.binding_state ?? null,
        duplicate: Boolean(row?.duplicate),
      };
    },

    async failConversationBinding({ ownerId, connectorNodeId, bindingId, code, detail }) {
      const { data, error } = await supabase.rpc("bibi_fail_conversation_binding", {
        p_owner_id: ownerId,
        p_connector_node_id: connectorNodeId,
        p_binding_id: bindingId,
        p_code: code,
        p_detail: detail ?? null,
      });
      if (error) throw mapBindingError(error);
      const row = Array.isArray(data) ? data[0] : data;
      return { bindingId: row?.binding_id ?? null, bindingState: row?.binding_state ?? null };
    },

    async recordTelegramSessionScan({
      ownerId, connectorNodeId, organizationProfileId, executionProfileId,
      sessions, scanError, scannedAt,
    }) {
      const { data, error } = await supabase.rpc("bibi_record_telegram_session_scan", {
        p_owner_id: ownerId,
        p_connector_node_id: connectorNodeId,
        p_organization_profile_id: organizationProfileId,
        p_execution_profile_id: executionProfileId,
        p_sessions: sessions,
        p_scan_error: scanError ?? null,
        p_scanned_at: scannedAt,
      });
      if (error) throw new Error(`recordTelegramSessionScan: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      return {
        sessionCount: Number(row?.session_count ?? 0),
        eligibleCount: Number(row?.eligible_count ?? 0),
      };
    },

    async applyProjection({ ownerId, target, messages }) {
      const data = unwrap(
        await supabase.rpc("bibi_apply_message_projection_v2", {
          p_owner_id: ownerId,
          p_binding_id: target.bindingId,
          p_conversation_id: target.conversationId,
          p_organization_profile_id: target.organizationProfileId,
          p_execution_profile_id: target.executionProfileId,
          p_hermes_session_id: target.hermesSessionId,
          p_channel: target.channel,
          p_messages: messages,
          p_lifecycle_scan_cursor: target.nextLifecycleCheckpoint,
        }),
        "applyProjection",
      );
      const row = Array.isArray(data) ? data[0] : data;
      return {
        accepted: Number(row?.accepted ?? 0),
        duplicates: Number(row?.duplicates ?? 0),
        checkpoint: Number(row?.checkpoint ?? target.checkpoint),
        lifecycleCheckpoint: Number(row?.lifecycle_checkpoint ?? target.nextLifecycleCheckpoint),
      };
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
        bindingId: row.binding_id,
        hermesSessionId: row.hermes_session_id,
        channelOrigin: row.channel_origin,
        continuationStatus: row.continuation_status,
        resumeLeaseId: row.resume_lease_id,
        turnIdempotencyKey: row.turn_idempotency_key,
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
      unwrap(
        await supabase.rpc("bibi_renew_resume_lease", {
          p_owner_id: ownerId,
          p_work_item_id: workItemId,
          p_expires_at: data[0].expires_at,
        }),
        "renewLease.resume",
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
        bindingId: data.binding_id,
        hermesSessionId: data.hermes_session_id,
        channelOrigin: data.channel_origin,
        continuationStatus: data.continuation_status,
        turnIdempotencyKey: data.turn_idempotency_key,
        executionStartedAt: data.execution_started_at,
        executionCompletedAt: data.execution_completed_at,
        reconciliationStatus: data.reconciliation_status,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        // The lifecycle reducer needs an applied-event list. Replay protection
        // itself lives in the unique constraint on work_events, so an empty
        // list here is correct rather than a gap.
        appliedEventIds: [],
      };
    },

    async applyReportAtomically({
      ownerId, connectorNodeId, workItemId, eventId, type, attempt,
      turnIdempotencyKey, summary, detail, error, reason, evidence, payload, at,
    }) {
      const { data, error: rpcError } = await supabase.rpc("bibi_apply_work_report", {
        p_owner_id: ownerId,
        p_connector_node_id: connectorNodeId,
        p_work_item_id: workItemId,
        p_event_id: eventId,
        p_event_type: type,
        p_attempt: attempt,
        p_turn_idempotency_key: turnIdempotencyKey,
        p_summary: summary,
        p_detail: detail,
        p_error: error,
        p_reason: reason,
        p_evidence: evidence,
        p_payload: payload,
        p_at: at,
      });
      if (rpcError) {
        const mapped = new Error(rpcError.message);
        if (/work item not found/i.test(rpcError.message)) mapped.code = "WORK_ITEM_NOT_FOUND";
        else if (/report identity mismatch/i.test(rpcError.message)) mapped.code = "REPORT_IDENTITY_MISMATCH";
        else if (/reason is required/i.test(rpcError.message)) mapped.code = "MISSING_REASON";
        else if (/invalid transition/i.test(rpcError.message)) mapped.code = "INVALID_TRANSITION";
        throw mapped;
      }
      const row = Array.isArray(data) ? data[0] : data;
      return { duplicate: Boolean(row?.duplicate), status: row?.status, resultId: row?.result_id ?? null };
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
      unwrap(
        await supabase.rpc("bibi_release_resume_lease", {
          p_owner_id: ownerId,
          p_work_item_id: workItemId,
          p_reason: reason,
        }),
        "releaseLease.resume",
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
