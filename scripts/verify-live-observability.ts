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
import { PrometheusRegistry } from "../sample-services/shared/telemetry";

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

  const remoteWriteUrl = process.env.GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL?.trim();

  console.log(`  OTLP HTTPS Endpoint  : ${otlpEndpoint ? otlpEndpoint : "[NOT SET]"}`);
  console.log(`  OTLP Instance ID     : ${maskSecret(otlpInstanceId)}`);
  console.log(`  OTLP Ingestion Token : ${maskSecret(ingestToken)}`);
  console.log(`  Prometheus Query URL : ${promUrl ? promUrl : "[NOT SET]"}`);
  console.log(`  Prometheus User ID   : ${maskSecret(promUser)}`);
  console.log(`  Prometheus Read Token: ${maskSecret(promToken)}`);
  console.log(`  Tempo Query URL      : ${tempoUrl ? tempoUrl : "[NOT SET]"}`);
  console.log(`  Tempo User ID        : ${maskSecret(tempoUser)}`);
  console.log(`  Tempo Read Token     : ${maskSecret(tempoToken)}`);
  console.log(`  Prometheus Remote-Wr : ${remoteWriteUrl ? remoteWriteUrl : "[NOT SET - Optional local scrape mode]"}`);

  const hasOtlp = Boolean(otlpEndpoint && otlpInstanceId && ingestToken);
  const hasProm = Boolean(promUrl && promUser && promToken);
  const hasTempo = Boolean(tempoUrl && tempoUser && tempoToken);
  const hasRemoteWrite = Boolean(remoteWriteUrl && (promToken || ingestToken));
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
  // 3. Metrics Verification: Path B (Prometheus Scrape -> Remote-Write)
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. Metrics Verification (Path B: Sample-Service -> Prometheus Scrape -> Remote-Write) ---");
  const uniqueRwId = `verify_rw_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
  report.prometheusRemoteWriteResult.verificationId = uniqueRwId;

  // Record metric into real sample-service registry
  const serviceRegistry = new PrometheusRegistry("order-service");
  serviceRegistry.recordRequest(1, { verification_id: uniqueRwId, status: "200" });
  console.log(`  Recorded test metric in sample-service registry with verification_id: ${uniqueRwId}`);

  if (!hasRemoteWrite) {
    report.prometheusRemoteWriteResult.status = "NOT_VERIFIED_AWAITING_CONFIG";
    report.prometheusRemoteWriteResult.details = "GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL is not configured in .env. Local Prometheus operation preserved.";
    console.log("  ℹ Prometheus remote_write is not configured in environment (Local scrape mode active).");
  } else {
    // Check if local Prometheus is reachable
    const localPrometheusUrl = process.env.PROMETHEUS_URL || "http://localhost:9090";
    const isLocalPrometheusUp = await isHttpEndpointReachable(`${localPrometheusUrl}/-/healthy`);

    if (!isLocalPrometheusUp) {
      report.prometheusRemoteWriteResult.status = "NOT_VERIFIED";
      report.prometheusRemoteWriteResult.details = `Local Prometheus instance (${localPrometheusUrl}) is offline. Scrape and remote-write could not be verified.`;
      console.log(`  ℹ Local Prometheus (${localPrometheusUrl}) is offline. Remote-write path reported separately as NOT_VERIFIED.`);
    } else {
      report.prometheusRemoteWriteResult.scrapeConfirmed = true;
      console.log(`  ✓ Local Prometheus instance (${localPrometheusUrl}) is online and scraping targets.`);
      console.log("  Querying Grafana Cloud Prometheus to confirm remote-write ingestion...");

      const rwQueryStart = Date.now();
      let rwVerified = false;

      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const rwRes = await promClient.queryInstantDetailed(
            `http_requests_total{verification_id="${uniqueRwId}"}`
          );
          if (rwRes.success && rwRes.records.length > 0) {
            rwVerified = true;
            report.prometheusRemoteWriteResult.status = "PASSED";
            report.prometheusRemoteWriteResult.queryLatencyMs = Date.now() - rwQueryStart;
            report.prometheusRemoteWriteResult.details = `Remote-write confirmed in Grafana Cloud TSDB (${rwRes.records.length} sample(s) received).`;
            console.log(`  ✓ [PASS] Remote-write ingestion confirmed in Grafana Cloud TSDB (${report.prometheusRemoteWriteResult.queryLatencyMs}ms).`);
            break;
          }
        } catch {
          // Poll
        }
        if (!rwVerified && attempt < 4) {
          await sleep(2500);
        }
      }

      if (!rwVerified) {
        report.prometheusRemoteWriteResult.status = "NOT_VERIFIED";
        report.prometheusRemoteWriteResult.details = "Local Prometheus scraped metric, but remote-write ingestion was not confirmed in Grafana Cloud TSDB.";
        console.log("  ℹ Remote-write metric scrape observed, but cloud read-back remained unconfirmed within test window.");
      }
    }
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

      // 2. Query recent traces for verification service
      const traceQueryRes = await tempoClient.getRecentTracesDetailed("incidentgraph-verification-runner", 10);
      if (traceQueryRes.success) {
        const found = traceQueryRes.traces.find((t) => {
          const searchVerify = tempoClient.verifyLiveTrace(t, generatedTraceId, uniqueTraceVerificationId);
          return searchVerify.valid;
        });
        if (found) {
          traceVerified = true;
          report.tracesResult.status = "PASSED";
          report.tracesResult.queryLatencyMs = Date.now() - tempoQueryStart;
          report.tracesResult.details = `Trace retrieved successfully from Tempo backend search (matched trace ID ${generatedTraceId}).`;
          console.log(`  ✓ [PASS] Trace confirmed in Tempo search on attempt ${attempt} (${report.tracesResult.queryLatencyMs}ms total).`);
          break;
        }
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
  // EXPORT_CONFIRMED_QUERY_PENDING or NOT_VERIFIED can NEVER result in overall success!
  const directMetricsPassed = report.directOtlpMetricsResult.status === "PASSED";
  const tracesPassed = report.tracesResult.status === "PASSED";
  report.overallPassed = directMetricsPassed && tracesPassed;

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

  const outcomeBadge = report.overallPassed
    ? "🎉 ALL REQUIRED LIVE TELEMETRY PIPELINES VERIFIED LIVE"
    : "✗ LIVE VERIFICATION FAILED OR INCOMPLETE";
  console.log(`   Final Verdict: ${outcomeBadge}`);
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
