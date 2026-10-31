/**
 * IncidentGraph AI — Genuine Live Observability Smoke-Test Workflow (Phase 2.1 Hardened)
 *
 * Verifies live telemetry ingestion against external backends (Grafana Cloud Prometheus & Tempo):
 *  1. Sanitized Configuration Audit (never prints secrets)
 *  2. Direct OTLP Metrics Path:
 *     - Generates unique synthetic test metric
 *     - Exports via OTLP HTTPS to Grafana Cloud OTLP Gateway
 *     - Strictly verifies PromQL read-back (exact metric, verification ID, and value)
 *  3. Prometheus Remote-Write Path:
 *     - Generates unique synthetic metric through sample-service registry
 *     - Verifies scrape and remote_write status
 *     - Reports status independently from Direct OTLP
 *  4. Strict Tempo Trace Path:
 *     - Generates real trace with unique verification.id
 *     - Exports via OTLP HTTPS to Grafana Cloud Tempo
 *     - Strictly verifies exact trace ID, real non-fallback spans, and verification attribute
 *  5. Strict Telemetry Provenance:
 *     - EXPORT_CONFIRMED_QUERY_PENDING can NEVER result in overall success or exit code 0
 *     - Exits non-zero when live verification cannot be completed
 */

import fs from "fs";
import path from "path";
import http from "http";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

// Load .env if running standalone
try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  }
} catch {
  // Ignored if already loaded
}

import { PrometheusClient } from "../src/lib/telemetry/prometheusClient";
import { JaegerClient } from "../src/lib/telemetry/jaegerClient";
import { validateRemoteWriteConfig } from "./generate-prometheus-config";

function maskSecret(val?: string): string {
  if (!val || val.trim().length === 0) return "[NOT SET]";
  return `[SET - REDACTED (${val.length} chars)]`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isHttpEndpointReachable(urlStr: string, timeoutMs: number = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname,
          method: "GET",
          timeout: timeoutMs,
        },
        (res) => {
          resolve(res.statusCode !== undefined && res.statusCode < 500);
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

export type LivePipelineStatus = "PASSED" | "FAILED" | "NOT_VERIFIED" | "NOT_VERIFIED_AWAITING_CONFIG";

export interface LiveVerificationReport {
  timestamp: string;
  configAudit: {
    hasOtlp: boolean;
    hasPrometheus: boolean;
    hasTempo: boolean;
    hasRemoteWrite: boolean;
    isFullyConfigured: boolean;
  };
  directOtlpMetricsResult: {
    status: LivePipelineStatus;
    metricName: string;
    verificationId: string;
    exportLatencyMs: number;
    queryLatencyMs: number;
    details: string;
  };
  prometheusRemoteWriteResult: {
    status: LivePipelineStatus;
    metricName: string;
    verificationId: string;
    scrapeConfirmed: boolean;
    remoteWriteConfigured: boolean;
    queryLatencyMs: number;
    details: string;
  };
  // Backward-compatible alias for directOtlpMetricsResult
  metricsResult: {
    status: LivePipelineStatus;
    metricName: string;
    verificationId: string;
    exportLatencyMs: number;
    queryLatencyMs: number;
    details: string;
  };
  tracesResult: {
    status: LivePipelineStatus;
    traceId: string;
    verificationId: string;
    exportLatencyMs: number;
    queryLatencyMs: number;
    details: string;
  };
  overallPassed: boolean;
}

import { spawn, ChildProcess } from "child_process";

export interface DisposableServiceInstance {
  process?: ChildProcess;
  server?: import("http").Server;
  port: number;
  baseUrl: string;
  token: string;
  targetFilePath?: string;
  stop: () => Promise<void>;
}

export async function startDisposableOrderService(options?: {
  port?: number;
  token?: string;
  registerPrometheusTarget?: boolean;
}): Promise<DisposableServiceInstance> {
  const token = options?.token || `verify_token_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
  const preferredPort = options?.port ?? 0;

  // Real Process Isolation: parent process.env is NEVER modified.
  // Ephemeral credentials and endpoint enablement are passed ONLY to the isolated child process.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(preferredPort),
    SAMPLE_ORDER_PORT: String(preferredPort),
    ENABLE_TEST_METRIC_ENDPOINT: "true",
    TEST_METRIC_ENDPOINT_TOKEN: token,
    NODE_ENV: "test",
  };

  const projectRoot = path.resolve(__dirname, "..");
  const childScript = `
    import { createOrderServer } from "./sample-services/order/server.ts";
    const server = createOrderServer();
    const tryListen = (targetPort, isFallback) => {
      server.once("error", (err) => {
        if (!isFallback && err && (err.code === "EADDRINUSE" || err.code === "EACCES")) {
          server.removeAllListeners("error");
          tryListen(0, true);
        } else {
          process.stderr.write("[ERROR:" + (err ? err.message : "unknown") + "]\\n");
          process.exit(1);
        }
      });
      server.listen(targetPort, () => {
        const addr = server.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        process.stdout.write("[DISPOSABLE_ORDER_SERVICE_PORT:" + p + "]\\n");
      });
    };
    tryListen(${preferredPort}, false);
  `;

  const tsxCliPath = path.resolve(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const spawnArgs = fs.existsSync(tsxCliPath)
    ? [tsxCliPath, "-e", childScript]
    : ["--input-type=module", "--import", "tsx", "-e", childScript];

  const child = spawn(
    process.execPath,
    spawnArgs,
    {
      cwd: projectRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let targetFilePath: string | undefined;

  const cleanupChild = (): void => {
    if (targetFilePath && fs.existsSync(targetFilePath)) {
      try {
        fs.unlinkSync(targetFilePath);
      } catch {
        // Ignore
      }
    }
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) {
            try {
              child.kill("SIGKILL");
            } catch {
              // Ignore
            }
          }
        }, 1000).unref();
      } catch {
        // Ignore
      }
    }
  };

  let boundPort: number;
  try {
    boundPort = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanupChild();
        reject(new Error("Timeout waiting for disposable order-service child process to start"));
      }, 10000);

      let stdoutBuffer = "";
      let stderrBuffer = "";

      const onData = (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        const match = stdoutBuffer.match(/\[DISPOSABLE_ORDER_SERVICE_PORT:(\d+)\]/);
        if (match) {
          clearTimeout(timeout);
          child.stdout?.removeListener("data", onData);
          resolve(Number(match[1]));
        }
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString("utf8");
      });

      child.once("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn disposable order-service child process: ${err.message}`));
      });

      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        const detail = stderrBuffer.trim() ? ` Stderr: ${stderrBuffer.trim()}` : "";
        reject(new Error(`Disposable order-service child process exited prematurely with code ${code}, signal ${signal}.${detail}`));
      });
    });
  } catch (err) {
    cleanupChild();
    throw err;
  }

  const baseUrl = `http://localhost:${boundPort}`;

  // File-based Service Discovery: register dynamic target for Prometheus
  if (options?.registerPrometheusTarget !== false) {
    try {
      const fileSdDir = path.resolve(projectRoot, "docker", "file_sd");
      if (!fs.existsSync(fileSdDir)) {
        fs.mkdirSync(fileSdDir, { recursive: true });
      }
      targetFilePath = path.join(fileSdDir, `disposable-order-${boundPort}.json`);
      const targetPayload = [
        {
          targets: [
            `host.docker.internal:${boundPort}`,
            `127.0.0.1:${boundPort}`,
          ],
          labels: {
            job: "order-service-dynamic",
            service: "order-service",
            instance: `order-service-${boundPort}`,
          },
        },
      ];
      fs.writeFileSync(targetFilePath, JSON.stringify(targetPayload, null, 2), "utf8");
    } catch {
      // Non-fatal if directory is readonly
    }
  }

  const stop = async () => {
    cleanupChild();
    if (!child.killed) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, 500);
      });
    }
  };

  return {
    process: child,
    port: boundPort,
    baseUrl,
    token,
    targetFilePath,
    stop,
  };
}

export async function runLiveObservabilityVerification(): Promise<LiveVerificationReport> {
  console.log("\n===============================================================================");
  console.log("   IncidentGraph AI — Genuine Live Observability Verification Suite (v2.1)");
  console.log("===============================================================================");
  console.log("   (Strict verification against configured external telemetry backends)\n");

  const startTime = Date.now();

  // ---------------------------------------------------------------------------
  // 1. Sanitized Configuration Audit (Zero secrets printed)
  // ---------------------------------------------------------------------------
  console.log("--- 1. Secure Configuration Audit (Sanitized) ---");
  const otlpEndpoint = process.env.GRAFANA_CLOUD_OTLP_ENDPOINT?.trim();
  const otlpInstanceId = process.env.GRAFANA_CLOUD_INSTANCE_ID?.trim() || process.env.GRAFANA_CLOUD_OTLP_INSTANCE_ID?.trim();
  const ingestToken = process.env.GRAFANA_CLOUD_INGESTION_TOKEN?.trim();

  const promUrl = process.env.GRAFANA_CLOUD_PROMETHEUS_URL?.trim();
  const promUser = process.env.GRAFANA_CLOUD_PROMETHEUS_USER?.trim() || otlpInstanceId;
  const promToken = process.env.GRAFANA_CLOUD_PROMETHEUS_TOKEN?.trim();

  const tempoUrl = process.env.GRAFANA_CLOUD_TEMPO_URL?.trim();
  const tempoUser = process.env.GRAFANA_CLOUD_TEMPO_USER?.trim() || otlpInstanceId;
  const tempoToken = process.env.GRAFANA_CLOUD_TEMPO_TOKEN?.trim();

  const rwValidation = validateRemoteWriteConfig();

  console.log(`  OTLP HTTPS Endpoint  : ${otlpEndpoint ? otlpEndpoint : "[NOT SET]"}`);
  console.log(`  OTLP Instance ID     : ${maskSecret(otlpInstanceId)}`);
  console.log(`  OTLP Ingestion Token : ${maskSecret(ingestToken)}`);
  console.log(`  Prometheus Query URL : ${promUrl ? promUrl : "[NOT SET]"}`);
  console.log(`  Prometheus User ID   : ${maskSecret(promUser)}`);
  console.log(`  Prometheus Read Token: ${maskSecret(promToken)}`);
  console.log(`  Tempo Query URL      : ${tempoUrl ? tempoUrl : "[NOT SET]"}`);
  console.log(`  Tempo User ID        : ${maskSecret(tempoUser)}`);
  console.log(`  Tempo Read Token     : ${maskSecret(tempoToken)}`);
  console.log(`  Prometheus Remote-Wr : ${rwValidation.valid ? "[CONFIGURED - DEDICATED WRITE TOKEN SET]" : `[NOT CONFIGURED - ${rwValidation.reason}]`}`);

  const hasOtlp = Boolean(otlpEndpoint && otlpInstanceId && ingestToken);
  const hasProm = Boolean(promUrl && promUser && promToken);
  const hasTempo = Boolean(tempoUrl && tempoUser && tempoToken);
  const hasRemoteWrite = rwValidation.valid;
  const isFullyConfigured = hasOtlp && hasProm && hasTempo;

  const directOtlpResult = {
    status: "NOT_VERIFIED_AWAITING_CONFIG" as LivePipelineStatus,
    metricName: "incidentgraph_live_verification_total",
    verificationId: "",
    exportLatencyMs: 0,
    queryLatencyMs: 0,
    details: "",
  };

  const prometheusRemoteWriteResult = {
    status: "NOT_VERIFIED_AWAITING_CONFIG" as LivePipelineStatus,
    metricName: "http_requests_total",
    verificationId: "",
    scrapeConfirmed: false,
    remoteWriteConfigured: hasRemoteWrite,
    queryLatencyMs: 0,
    details: "",
  };

  const tracesResult = {
    status: "NOT_VERIFIED_AWAITING_CONFIG" as LivePipelineStatus,
    traceId: "",
    verificationId: "",
    exportLatencyMs: 0,
    queryLatencyMs: 0,
    details: "",
  };

  const report: LiveVerificationReport = {
    timestamp: new Date().toISOString(),
    configAudit: {
      hasOtlp,
      hasPrometheus: hasProm,
      hasTempo,
      hasRemoteWrite,
      isFullyConfigured,
    },
    directOtlpMetricsResult: directOtlpResult,
    prometheusRemoteWriteResult,
    metricsResult: directOtlpResult,
    tracesResult,
    overallPassed: false,
  };

  if (!isFullyConfigured) {
    console.log("\n⚠  NOT VERIFIED — CREDENTIALS/BACKEND UNAVAILABLE");
    console.log("   Missing required Grafana Cloud environment variables in .env.");
    console.log("   Follow docs/GRAFANA_CLOUD_SETUP.md to configure external credentials.\n");
    report.directOtlpMetricsResult.details = "NOT VERIFIED — CREDENTIALS/BACKEND UNAVAILABLE: Missing Grafana Cloud credentials";
    report.prometheusRemoteWriteResult.details = "NOT VERIFIED — CREDENTIALS/BACKEND UNAVAILABLE: Missing Grafana Cloud credentials";
    report.tracesResult.details = "NOT VERIFIED — CREDENTIALS/BACKEND UNAVAILABLE: Missing Grafana Cloud credentials";
    return report;
  }

  const otlpHeaders: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${otlpInstanceId}:${ingestToken}`).toString("base64")}`,
  };

  // ---------------------------------------------------------------------------
  // 2. Metrics Verification: Path A (Direct OTLP Ingestion)
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Metrics Verification (Path A: Direct OpenTelemetry -> Grafana Cloud OTLP) ---");
  const uniqueMetricId = `verify_otlp_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
  const metricName = "incidentgraph_live_verification_total";
  report.directOtlpMetricsResult.verificationId = uniqueMetricId;

  console.log(`  Generating unique synthetic test metric: ${metricName}`);
  console.log(`  Verification Identifier: ${uniqueMetricId}`);

  const metricResource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "incidentgraph-verification-runner",
    [ATTR_SERVICE_VERSION]: "1.0.0",
    "deployment.environment": "live-verification",
  });

  const metricUrl = otlpEndpoint!.endsWith("/v1/metrics") ? otlpEndpoint! : `${otlpEndpoint}/v1/metrics`;
  const metricExporter = new OTLPMetricExporter({
    url: metricUrl,
    headers: otlpHeaders,
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 1000,
  });

  const meterProvider = new MeterProvider({
    resource: metricResource,
    readers: [metricReader],
  });

  const meter = meterProvider.getMeter("live-verification-meter", "1.0.0");
  const verificationCounter = meter.createCounter(metricName, {
    description: "Synthetic metric to verify live ingestion against Grafana Cloud Prometheus",
    unit: "1",
  });

  const metricExportStart = Date.now();
  verificationCounter.add(1, {
    verification_id: uniqueMetricId,
    service: "incidentgraph-verification-runner",
    test_path: "direct_otlp",
  });

  try {
    await meterProvider.forceFlush();
    report.directOtlpMetricsResult.exportLatencyMs = Date.now() - metricExportStart;
    console.log(`  ✓ Metric successfully dispatched via OTLP HTTPS to external backend (${report.directOtlpMetricsResult.exportLatencyMs}ms).`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    report.directOtlpMetricsResult.status = "FAILED";
    report.directOtlpMetricsResult.details = `Metric OTLP export failed: ${msg}`;
    console.error(`  ✗ Metric export failed: ${msg}`);
  }

  // Strict Read-back PromQL query: must match exact metric name, verification ID, and value >= 1
  const promClient = new PrometheusClient();
  const promQueryStart = Date.now();
  console.log("  Querying Grafana Cloud Prometheus PromQL engine to confirm ingestion receipt...");

  let metricVerified = false;
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const queryRes = await promClient.queryInstantDetailed(
        `${metricName}{verification_id="${uniqueMetricId}"}`
      );
      if (queryRes.success && queryRes.records.length > 0) {
        const record = queryRes.records[0];
        const actualMetricName = record.labels["__name__"] || record.metricName;
        if ((actualMetricName === metricName || actualMetricName.startsWith(metricName)) && Number(record.value) >= 1) {
          metricVerified = true;
          report.directOtlpMetricsResult.status = "PASSED";
          report.directOtlpMetricsResult.queryLatencyMs = Date.now() - promQueryStart;
          report.directOtlpMetricsResult.details = `Ingestion confirmed: received ${queryRes.records.length} sample(s) with matching verification ID and value ${record.value}.`;
          console.log(`  ✓ [PASS] Direct OTLP ingestion confirmed in Prometheus on attempt ${attempt} (${report.directOtlpMetricsResult.queryLatencyMs}ms total).`);
          break;
        }
      }

      if (attempt === 1) {
        const generalHealth = await promClient.checkHealth();
        if (!generalHealth.available) {
          throw new Error(`Prometheus endpoint query error: ${generalHealth.error}`);
        }
      }
    } catch (err: unknown) {
      if (attempt === maxAttempts) {
        report.directOtlpMetricsResult.status = "FAILED";
        report.directOtlpMetricsResult.details = `Prometheus read-back failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (!metricVerified && attempt < maxAttempts) {
      console.log(`    ↳ Indexing in progress... waiting for ingestion propagation (attempt ${attempt}/${maxAttempts})`);
      await sleep(3000);
    }
  }

  // If read-back timed out or pending, strictly mark as NOT_VERIFIED (never passed!)
  if (!metricVerified && report.directOtlpMetricsResult.status !== "FAILED") {
    report.directOtlpMetricsResult.status = "NOT_VERIFIED";
    report.directOtlpMetricsResult.details = "Export to OTLP gateway succeeded; ingestion read-back timed out or query indexing remained pending.";
    console.log(`  ✗ [NOT VERIFIED] Metric export succeeded, but PromQL read-back confirmation was not received within polling window.`);
  }

  // ---------------------------------------------------------------------------
  // 3. Metrics Verification: Path B (Sample-Service -> Prometheus Scrape -> Remote-Write)
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. Metrics Verification (Path B: Sample-Service -> Prometheus Scrape -> Remote-Write) ---");
  const uniqueRwId = `verify_rw_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
  report.prometheusRemoteWriteResult.verificationId = uniqueRwId;

  let disposableService: DisposableServiceInstance | null = null;

  try {
    const testAuthToken = `verify_test_token_${uniqueRwId}`;
    console.log("  Starting isolated disposable order-service instance with dynamic port allocation...");
    disposableService = await startDisposableOrderService({ token: testAuthToken });
    const orderServiceBase = disposableService.baseUrl;
    const orderServicePort = disposableService.port;
    console.log(`  ✓ Disposable order-service bound to isolated port ${disposableService.port}.`);

    // Record synthetic metric via actual running sample-service HTTP endpoint with test authentication
    console.log(`  Emitting synthetic metric to ${orderServiceBase}/test/record-metric with verification_id: ${uniqueRwId}`);
    const postRes = await fetch(`${orderServiceBase}/test/record-metric`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-token": testAuthToken,
      },
      body: JSON.stringify({
        verification_id: uniqueRwId,
        count: 1,
        status: "test_verified",
      }),
    });

    if (!postRes.ok) {
      throw new Error(`Failed to record metric via order-service HTTP endpoint: status ${postRes.status}`);
    }

    // Confirm that the real /metrics endpoint exposes the metric
    const metricsRes = await fetch(`${orderServiceBase}/metrics`);
    const metricsText = await metricsRes.text();
    if (!metricsText.includes(`verification_id="${uniqueRwId}"`)) {
      throw new Error("Synthetic metric was not exposed by order-service /metrics endpoint");
    }
    console.log("  ✓ Confirmed synthetic metric is exposed on order-service /metrics endpoint.");

    // Check local Prometheus availability
    const localPrometheusUrl = process.env.PROMETHEUS_URL || "http://localhost:9090";
    const isLocalPrometheusUp = await isHttpEndpointReachable(`${localPrometheusUrl}/-/healthy`, 2000);

    if (!isLocalPrometheusUp) {
      report.prometheusRemoteWriteResult.status = "NOT_VERIFIED";
      report.prometheusRemoteWriteResult.scrapeConfirmed = false;
      report.prometheusRemoteWriteResult.details = `Local Prometheus instance (${localPrometheusUrl}) is offline. Scrape and remote-write could not be verified. State: Prometheus unavailable.`;
      console.log(`  ℹ [Prometheus unavailable] Local Prometheus (${localPrometheusUrl}) is offline.`);
    } else {
      console.log(`  ✓ Local Prometheus instance (${localPrometheusUrl}) is online.`);

      // Verify target scrape health using Prometheus targets API (poll up to 5s for file_sd refresh)
      let targetUp = false;
      for (let tAttempt = 1; tAttempt <= 5; tAttempt++) {
        try {
          const targetsRes = await fetch(`${localPrometheusUrl}/api/v1/targets`);
          if (targetsRes.ok) {
            const targetsJson = await targetsRes.json() as { data?: { activeTargets?: Array<{ discoveredLabels?: Record<string, string>; health?: string; scrapeUrl?: string }> } };
            const activeTargets = targetsJson.data?.activeTargets || [];
            targetUp = activeTargets.some(
              (t) => (t.scrapeUrl?.includes(`:${orderServicePort}`) || t.discoveredLabels?.["__address__"]?.includes(`:${orderServicePort}`)) && t.health === "up"
            );
            if (targetUp) break;
          }
        } catch {
          // non-fatal
        }
        if (!targetUp && tAttempt < 5) await sleep(1000);
      }

      // Confirm local Prometheus has actually scraped the exact verification ID
      console.log("  Querying local Prometheus to confirm actual scrape of verification ID...");
      let localScraped = false;
      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          const promLocalRes = await fetch(
            `${localPrometheusUrl}/api/v1/query?query=${encodeURIComponent(`http_requests_total{verification_id="${uniqueRwId}"}`)}`
          );
          if (promLocalRes.ok) {
            const promJson = await promLocalRes.json() as { data?: { result?: Array<{ value?: [number, string] }> } };
            const results = promJson.data?.result || [];
            if (results.length > 0 && Number(results[0].value?.[1]) >= 1) {
              localScraped = true;
              break;
            }
          }
        } catch {
          // Retry
        }
        if (attempt < 6) await sleep(2000);
      }

      if (!localScraped) {
        report.prometheusRemoteWriteResult.status = "NOT_VERIFIED";
        report.prometheusRemoteWriteResult.scrapeConfirmed = false;
        report.prometheusRemoteWriteResult.details = `Target scrape unconfirmed: local Prometheus has not scraped verification ID within polling window (target health: ${targetUp ? "UP" : "PENDING/DOWN"}). State: Target not scraped.`;
        console.log(`  ℹ [Target not scraped] Metric exposed on /metrics, but local Prometheus scrape was not observed within window.`);
      } else {
        report.prometheusRemoteWriteResult.scrapeConfirmed = true;
        console.log(`  ✓ [Local scrape succeeded] Local Prometheus confirmed scrape of verification ID.`);

        // Now evaluate remote-write
        if (!hasRemoteWrite) {
          report.prometheusRemoteWriteResult.status = "NOT_VERIFIED";
          report.prometheusRemoteWriteResult.details = `NOT VERIFIED — CREDENTIALS/BACKEND UNAVAILABLE: Local Prometheus scrape confirmed, but remote-write is not configured: ${rwValidation.reason}. State: Remote-write not configured.`;
          console.log(`  ℹ [Remote-write not configured] NOT VERIFIED — CREDENTIALS/BACKEND UNAVAILABLE: ${rwValidation.reason}.`);
        } else {
          console.log("  Querying Grafana Cloud Prometheus to confirm remote-write delivery...");
          const rwQueryStart = Date.now();
          let rwVerified = false;
          let rwFailed = false;
          let rwErrorMsg = "";

          for (let attempt = 1; attempt <= 6; attempt++) {
            try {
              const rwRes = await promClient.queryInstantDetailed(
                `http_requests_total{verification_id="${uniqueRwId}",service="order-service"}`
              );
              if (rwRes.success && rwRes.records.length > 0) {
                const record = rwRes.records[0];
                if (Number(record.value) >= 1) {
                  rwVerified = true;
                  report.prometheusRemoteWriteResult.status = "PASSED";
                  report.prometheusRemoteWriteResult.queryLatencyMs = Date.now() - rwQueryStart;
                  report.prometheusRemoteWriteResult.details = `External Grafana Cloud read-back confirmed: matched exact metric, verification ID ${uniqueRwId}, service order-service, and value ${record.value}.`;
                  console.log(`  ✓ [External Grafana Cloud read-back confirmed] Remote-write verified in Grafana Cloud TSDB (${report.prometheusRemoteWriteResult.queryLatencyMs}ms).`);
                  break;
                }
              }
            } catch (err: unknown) {
              rwFailed = true;
              rwErrorMsg = err instanceof Error ? err.message : String(err);
            }
            if (!rwVerified && attempt < 6) {
              await sleep(2500);
            }
          }

          if (!rwVerified) {
            if (rwFailed) {
              report.prometheusRemoteWriteResult.status = "FAILED";
              report.prometheusRemoteWriteResult.details = `Remote-write delivery failed: ${rwErrorMsg}. State: Remote-write delivery failed.`;
              console.log(`  ✗ [Remote-write delivery failed] Query to Grafana Cloud TSDB failed: ${rwErrorMsg}`);
            } else {
              report.prometheusRemoteWriteResult.status = "NOT_VERIFIED";
              report.prometheusRemoteWriteResult.details = "Remote-write delivery pending: local Prometheus scraped metric, but remote-written metric was not confirmed in Grafana Cloud TSDB within window. State: Remote-write delivery pending.";
              console.log("  ℹ [Remote-write delivery pending] Awaiting Grafana Cloud TSDB ingestion confirmation.");
            }
          }
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    report.prometheusRemoteWriteResult.status = "NOT_VERIFIED";
    report.prometheusRemoteWriteResult.details = `Path B execution error: ${msg}`;
    console.warn(`  Warning in Path B: ${msg}`);
  } finally {
    if (disposableService) {
      try {
        await disposableService.stop();
        console.log("  Cleaned up disposable order-service instance and ephemeral credentials.");
      } catch {
        // Ignore
      }
    }
    delete process.env.ENABLE_TEST_METRIC_ENDPOINT;
    delete process.env.TEST_METRIC_ENDPOINT_TOKEN;
  }

  // ---------------------------------------------------------------------------
  // 4. Traces Verification: Strict Tempo Trace Verification
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. Distributed Trace Ingestion Verification (Strict Tempo) ---");
  const uniqueTraceVerificationId = `verify_trace_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
  report.tracesResult.verificationId = uniqueTraceVerificationId;

  const traceResource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "incidentgraph-verification-runner",
    [ATTR_SERVICE_VERSION]: "1.0.0",
    "deployment.environment": "live-verification",
  });

  const traceUrl = otlpEndpoint!.endsWith("/v1/traces") ? otlpEndpoint! : `${otlpEndpoint}/v1/traces`;
  const traceExporter = new OTLPTraceExporter({
    url: traceUrl,
    headers: otlpHeaders,
  });

  const tracerProvider = new NodeTracerProvider({
    resource: traceResource,
    spanProcessors: [new SimpleSpanProcessor(traceExporter)],
  });
  tracerProvider.register();

  const tracer = trace.getTracer("live-verification-tracer", "1.0.0");
  const span = tracer.startSpan("live-verification-span");
  span.setAttribute("verification.id", uniqueTraceVerificationId);
  span.setAttribute("service.name", "incidentgraph-verification-runner");
  span.setAttribute("test.type", "external-ingestion-smoke-test");
  span.setStatus({ code: SpanStatusCode.OK });

  const generatedTraceId = span.spanContext().traceId;
  report.tracesResult.traceId = generatedTraceId;
  console.log(`  Generated test trace with ID: ${generatedTraceId}`);
  console.log(`  Verification Identifier: ${uniqueTraceVerificationId}`);

  const traceExportStart = Date.now();
  span.end();

  try {
    await tracerProvider.forceFlush();
    report.tracesResult.exportLatencyMs = Date.now() - traceExportStart;
    console.log(`  ✓ Trace successfully exported via OTLP HTTPS to Grafana Cloud Tempo (${report.tracesResult.exportLatencyMs}ms).`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    report.tracesResult.status = "FAILED";
    report.tracesResult.details = `Trace OTLP export failed: ${msg}`;
    console.error(`  ✗ Trace export failed: ${msg}`);
  }

  // Read-back query through JaegerClient (Strict Tempo API - No fallbacks accepted)
  const tempoClient = new JaegerClient();
  const tempoQueryStart = Date.now();
  console.log("  Querying Grafana Cloud Tempo API (Strict mode: Fallbacks rejected, exact trace ID & verification ID required)...");

  let traceVerified = false;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      // 1. Direct fetch by Trace ID with allowFallback: false
      const directTrace = await tempoClient.getTraceById(generatedTraceId, { allowFallback: false });
      const verifyOutcome = tempoClient.verifyLiveTrace(directTrace, generatedTraceId, uniqueTraceVerificationId);

      if (verifyOutcome.valid && directTrace) {
        traceVerified = true;
        report.tracesResult.status = "PASSED";
        report.tracesResult.queryLatencyMs = Date.now() - tempoQueryStart;
        report.tracesResult.details = `Trace retrieved directly via Tempo Trace ID API (matched trace ID ${generatedTraceId}, ${directTrace.allSpans.length} verified real span(s)).`;
        console.log(`  ✓ [PASS] Trace confirmed in Tempo via Trace ID on attempt ${attempt} (${report.tracesResult.queryLatencyMs}ms total).`);
        break;
      }

      // 2. Query recent traces as candidate discovery only
      const traceQueryRes = await tempoClient.getRecentTracesDetailed("incidentgraph-verification-runner", 10);
      if (traceQueryRes.success && traceQueryRes.traces.length > 0) {
        // Extract candidate trace IDs matching the generated trace ID
        const candidateTraces = traceQueryRes.traces.filter((t) => {
          const normCandidate = t.traceId.toLowerCase().replace(/^0+/, "");
          const normGen = generatedTraceId.toLowerCase().replace(/^0+/, "");
          return normCandidate === normGen || t.traceId.toLowerCase() === generatedTraceId.toLowerCase();
        });

        for (const candidate of candidateTraces) {
          // Fetch full backend trace detail using exact candidate ID with allowFallback: false
          const fullDetailTrace = await tempoClient.getTraceById(candidate.traceId, { allowFallback: false });
          const fullVerify = tempoClient.verifyLiveTrace(fullDetailTrace, generatedTraceId, uniqueTraceVerificationId);
          if (fullVerify.valid && fullDetailTrace) {
            traceVerified = true;
            report.tracesResult.status = "PASSED";
            report.tracesResult.queryLatencyMs = Date.now() - tempoQueryStart;
            report.tracesResult.details = `Trace retrieved via candidate discovery followed by full Tempo detail verification (matched trace ID ${generatedTraceId}, ${fullDetailTrace.allSpans.length} verified real span(s)).`;
            console.log(`  ✓ [PASS] Trace candidate retrieved and verified via full backend detail on attempt ${attempt} (${report.tracesResult.queryLatencyMs}ms total).`);
            break;
          }
        }
        if (traceVerified) break;
      }

      if (attempt === 1) {
        const tempoHealth = await tempoClient.checkHealth();
        if (!tempoHealth.available) {
          throw new Error(`Tempo endpoint query error: ${tempoHealth.error}`);
        }
      }
    } catch (err: unknown) {
      if (attempt === 6) {
        report.tracesResult.status = "FAILED";
        report.tracesResult.details = `Tempo read-back failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (!traceVerified && attempt < 6) {
      console.log(`    ↳ Propagating in Tempo block storage... waiting (attempt ${attempt}/6)`);
      await sleep(2500);
    }
  }

  // If trace was not verified by the backend, strictly mark as NOT_VERIFIED (never passed!)
  if (!traceVerified && report.tracesResult.status !== "FAILED") {
    report.tracesResult.status = "NOT_VERIFIED";
    report.tracesResult.details = "Trace export succeeded, but Tempo backend read-back confirmation was not received within polling window.";
    console.log(`  ✗ [NOT VERIFIED] Trace export acknowledged, but actual matching spans were not retrieved from Tempo.`);
  }

  // ---------------------------------------------------------------------------
  // 5. Verification Summary & Final Status Decision
  // ---------------------------------------------------------------------------
  const directMetricsPassed = report.directOtlpMetricsResult.status === "PASSED";
  const tracesPassed = report.tracesResult.status === "PASSED";
  const remoteWritePassed = report.prometheusRemoteWriteResult.status === "PASSED";
  const remoteWriteConfigured = report.prometheusRemoteWriteResult.remoteWriteConfigured;

  let finalVerdictBadge = "";
  if (directMetricsPassed && tracesPassed && remoteWritePassed) {
    report.overallPassed = true;
    finalVerdictBadge = "🎉 ALL CONFIGURED PIPELINES EXTERNALLY VERIFIED (Paths A, B, and C)";
  } else if (directMetricsPassed && tracesPassed && !remoteWriteConfigured) {
    report.overallPassed = false;
    finalVerdictBadge = "✓ CORE DIRECT OTLP & TEMPO PATHS VERIFIED (Paths A & C) — PROMETHEUS REMOTE-WRITE NOT CONFIGURED";
  } else if (directMetricsPassed && tracesPassed && remoteWriteConfigured && !remoteWritePassed) {
    report.overallPassed = false;
    finalVerdictBadge = "⚠ CORE DIRECT OTLP & TEMPO PATHS VERIFIED (Paths A & C), BUT PROMETHEUS REMOTE-WRITE (PATH B) UNVERIFIED — INTEGRATION INCOMPLETE";
  } else {
    report.overallPassed = false;
    finalVerdictBadge = "✗ LIVE VERIFICATION FAILED OR INCOMPLETE";
  }

  console.log("\n===============================================================================");
  console.log("   LIVE OBSERVABILITY VERIFICATION REPORT");
  console.log("===============================================================================");
  console.log(`   Total Duration: ${Date.now() - startTime}ms\n`);

  console.log("   [PATH A: DIRECT OTLP METRICS INGESTION]");
  console.log(`     Status           : ${report.directOtlpMetricsResult.status}`);
  console.log(`     Metric Name      : ${report.directOtlpMetricsResult.metricName}`);
  console.log(`     Verification ID  : ${report.directOtlpMetricsResult.verificationId}`);
  console.log(`     Export Latency   : ${report.directOtlpMetricsResult.exportLatencyMs}ms`);
  console.log(`     Query Latency    : ${report.directOtlpMetricsResult.queryLatencyMs}ms`);
  console.log(`     Details          : ${report.directOtlpMetricsResult.details}\n`);

  console.log("   [PATH B: PROMETHEUS SCRAPE & REMOTE-WRITE INGESTION]");
  console.log(`     Status           : ${report.prometheusRemoteWriteResult.status}`);
  console.log(`     Metric Name      : ${report.prometheusRemoteWriteResult.metricName}`);
  console.log(`     Verification ID  : ${report.prometheusRemoteWriteResult.verificationId}`);
  console.log(`     Scrape Confirmed : ${report.prometheusRemoteWriteResult.scrapeConfirmed ? "YES" : "NO"}`);
  console.log(`     Remote-Write Cfg : ${report.prometheusRemoteWriteResult.remoteWriteConfigured ? "YES" : "NO"}`);
  console.log(`     Details          : ${report.prometheusRemoteWriteResult.details}\n`);

  console.log("   [DISTRIBUTED TRACES INGESTION PIPELINE (TEMPO)]");
  console.log(`     Status           : ${report.tracesResult.status}`);
  console.log(`     Trace ID         : ${report.tracesResult.traceId}`);
  console.log(`     Verification ID  : ${report.tracesResult.verificationId}`);
  console.log(`     Export Latency   : ${report.tracesResult.exportLatencyMs}ms`);
  console.log(`     Query Latency    : ${report.tracesResult.queryLatencyMs}ms`);
  console.log(`     Details          : ${report.tracesResult.details}\n`);

  try {
    await meterProvider.shutdown();
  } catch {
    // Ignore shutdown error
  }
  try {
    await tracerProvider.shutdown();
  } catch {
    // Ignore shutdown error
  }

  console.log(`   Final Verdict: ${finalVerdictBadge}`);
  console.log("===============================================================================\n");

  return report;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  void runLiveObservabilityVerification().then((res) => {
    if (!res.configAudit.isFullyConfigured) {
      console.log("Exit code 1: Required live configuration missing or unconfigured.");
      process.exitCode = 1;
      return;
    }
    if (!res.overallPassed) {
      console.log("Exit code 1: Live telemetry verification did not pass all required checks.");
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
  });
}
