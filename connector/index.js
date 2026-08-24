#!/usr/bin/env node
/**
 * Bibi Workspace local Mac connector.
 *
 * Run this on the Mac where Hermes lives:
 *
 *   BIBI_CONNECTOR_MODE=outbound-local-mac \
 *   BIBI_CONTROL_PLANE_URL=https://<your-vercel-domain> \
 *   BIBI_CONNECTOR_TOKEN=<token issued by the workspace> \
 *   node connector/index.js
 *
 * It opens no port. It polls, executes leased work, and reports results. Stop it
 * with Ctrl-C; any lease it holds expires on its own and the work returns to the
 * queue rather than being lost.
 */

import { loadConnectorConfig } from "./config.js";
import { createHermesCliExecutor, homeForExecutionProfile } from "./hermesCliExecutor.js";
import { createLeaseRunner } from "./leaseRunner.js";
import { createProjectionRunner, createSqliteProjectionReader } from "./messageProjection.js";
import { createOutboundTransport } from "./outboundTransport.js";
import { createRuntimeProjectionCollector, createRuntimeProjectionRunner } from "./runtimeProjection.js";

function log(message, detail = {}) {
  // The config object is safe to spread into a log line: its token is
  // non-enumerable, so only the prefix can appear here.
  process.stdout.write(`${new Date().toISOString()} ${message} ${JSON.stringify(detail)}\n`);
}

export async function main(env = process.env) {
  const config = loadConnectorConfig(env);
  const transport = createOutboundTransport(config);
  const executor = createHermesCliExecutor(config);
  const runner = createLeaseRunner({ config, transport, executor });
  const projectionRunner = createProjectionRunner({
    transport,
    reader: createSqliteProjectionReader({
      homeForProfile: (executionProfileId) => homeForExecutionProfile(executionProfileId, config),
    }),
  });
  const runtimeProjectionRunner = createRuntimeProjectionRunner({
    transport,
    collector: createRuntimeProjectionCollector(config),
    listProfileIds: () => executor.listProfileIds(),
  });

  log("connector started", {
    node: config.nodeLabel,
    mode: config.mode,
    controlPlane: config.controlPlaneUrl,
    hermesBin: config.hermesBin || "(dry run)",
    hermesDefaultHome: config.hermesDefaultHome || "(dry run)",
    dryRun: config.dryRun,
    tokenPrefix: config.tokenPrefix,
  });

  if (config.dryRun) {
    log("dry run mode: local profiles will not execute work", {
      enableWith: "BIBI_CONNECTOR_ALLOW_LOCAL_EXECUTION=true",
    });
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    log("connector stopping", {});
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopped) {
    const projection = await projectionRunner.runOnce();
    if (projection.projected || projection.failed) log("projection cycle", projection);
    if (!config.dryRun) {
      const runtimeProjection = await runtimeProjectionRunner.runOnce();
      if (runtimeProjection.projected || runtimeProjection.failed) log("runtime projection cycle", runtimeProjection);
    }
    const summary = await runner.runOnce();
    if (!summary.online) {
      log("control plane unreachable", { error: summary.error });
    } else if (summary.accepted || summary.suppressed) {
      log("cycle complete", summary);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }

  return 0;
}

// Only run when invoked directly, so tests can import this module safely.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`connector failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
