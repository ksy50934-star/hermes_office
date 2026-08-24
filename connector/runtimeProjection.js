import { execFile } from "node:child_process";

import { EXECUTION_PROFILE_IDS } from "../src/bibi/roster.js";
import { redactSecrets } from "./evidence.js";
import { homeForExecutionProfile } from "./hermesCliExecutor.js";

const SAFE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "USER", "SHLVL"];

function safeEnv(home) {
  const env = { HERMES_HOME: home };
  for (const key of SAFE_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

export function organizationProfileId(executionProfileId) {
  return executionProfileId === "default" ? "bibi-01" : executionProfileId;
}

export function parseToolsets(text = "") {
  return String(text).split(/\r?\n/).flatMap((line) => {
    const match = /^\s*([✓✗])\s+(enabled|disabled)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) return [];
    return [{
      name: match[3],
      label: match[4].replace(/^\p{Extended_Pictographic}+\s*/u, "").trim() || match[3],
      description: "Hermes built-in toolset",
      enabled: match[2] === "enabled",
      available: true,
      configured: true,
      tools: [],
    }];
  });
}

function tableRows(text, marker) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(marker));
  if (start < 0) return [];
  return lines.slice(start + 1).flatMap((line) => {
    if (!line.trim() || /^\s*-{3,}/.test(line) || /^\s*(Name|Install:|Add one with:)/.test(line)) return [];
    const columns = line.trim().split(/\s{2,}/).filter(Boolean);
    return columns.length >= 2 ? [columns] : [];
  });
}

export function parseMcpCatalog(text = "") {
  return tableRows(text, "Name               Status").map(([name, status, ...description]) => ({
    name,
    label: name,
    description: description.join(" ").slice(0, 500),
    category: "MCP",
    provider: "Hermes catalog",
    needs_config: status !== "installed",
    installed: status === "installed",
  }));
}

export function parseMcpServers(text = "") {
  if (/No MCP servers configured\./.test(text)) return [];
  return tableRows(text, "Name").map(([name, status, ...transport]) => ({
    name,
    label: name,
    status: status || "unknown",
    transport: transport.join(" ").slice(0, 300),
    enabled: !/disabled|error/i.test(status || ""),
    tools: [],
  }));
}

export function parseRuntimeStatus(text = "") {
  const read = (label) => {
    const match = new RegExp(`^\\s*${label}:\\s*(.+)$`, "m").exec(text);
    return match?.[1]?.replace(/^[✓✗]\s*/, "").trim() || null;
  };
  const active = /Active:\s*(\d+)\s+session/.exec(text);
  const version = /Hermes Agent v([^\s]+)/.exec(text);
  const gateway = read("Status");
  return {
    hermesVersion: version?.[1] ?? null,
    model: read("Model"),
    provider: read("Provider"),
    gatewayStatus: gateway?.startsWith("running") ? "running" : gateway?.startsWith("stopped") ? "stopped" : "unknown",
    activeSessions: active ? Number(active[1]) : null,
  };
}

function createRunner(config, execFileImpl) {
  return (executionProfileId, args) => new Promise((resolve, reject) => {
    execFileImpl(config.hermesBin, args, {
      env: safeEnv(homeForExecutionProfile(executionProfileId, config)),
      timeout: Math.min(config.hermesTimeoutMs, 30_000),
      maxBuffer: Math.min(config.hermesMaxOutputBytes, 1_000_000),
      killSignal: "SIGKILL",
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(redactSecrets(stderr || error.message || "Hermes inventory command failed").slice(0, 500)));
        return;
      }
      resolve(String(stdout ?? ""));
    });
  });
}

export function createRuntimeProjectionCollector(config, { execFileImpl = execFile } = {}) {
  const run = createRunner(config, execFileImpl);
  return {
    async collect(executionProfileId) {
      if (!EXECUTION_PROFILE_IDS.includes(executionProfileId)) throw new Error("Invalid execution profile for runtime projection");
      const collectedAt = new Date().toISOString();
      const errors = [];
      const capture = async (label, args) => {
        try { return await run(executionProfileId, args); }
        catch (error) { errors.push({ source: label, message: redactSecrets(error.message).slice(0, 300) }); return ""; }
      };
      const [toolText, serverText, catalogText, statusText, versionText] = await Promise.all([
        capture("tools", ["tools", "list", "--platform", "cli"]),
        capture("mcp-list", ["mcp", "list"]),
        capture("mcp-catalog", ["mcp", "catalog"]),
        capture("status", ["status", "--all"]),
        capture("version", ["--version"]),
      ]);
      const toolsets = parseToolsets(toolText);
      const status = parseRuntimeStatus(`${versionText}\n${statusText}`);
      return {
        profileId: organizationProfileId(executionProfileId),
        executionProfileId,
        collectedAt,
        inventory: {
          catalog: parseMcpCatalog(catalogText),
          servers: parseMcpServers(serverText),
          toolsets,
          errors,
        },
        health: {
          ...status,
          enabledToolsets: toolsets.filter((item) => item.enabled).length,
          disabledToolsets: toolsets.filter((item) => !item.enabled).length,
          error: errors.length ? errors.map((item) => `${item.source}: ${item.message}`).join("; ").slice(0, 500) : null,
        },
      };
    },
  };
}

export function createRuntimeProjectionRunner({ transport, collector, listProfileIds, intervalMs = 300_000, now = () => Date.now() }) {
  let lastRunAt = 0;
  return {
    async runOnce({ force = false } = {}) {
      if (!force && now() - lastRunAt < intervalMs) return { skipped: true, projected: 0, failed: 0 };
      lastRunAt = now();
      const profileIds = await listProfileIds();
      let projected = 0;
      let failed = 0;
      for (const executionProfileId of profileIds) {
        try {
          const payload = await collector.collect(executionProfileId);
          await transport.uploadRuntimeProjection(payload);
          projected += 1;
        } catch {
          failed += 1;
        }
      }
      return { skipped: false, projected, failed };
    },
  };
}
