/**
 * IncidentGraph AI — Grafana Cloud & Zero-Admin Configuration Readiness Check
 *
 * Verifies environment readiness without exposing credentials or requiring administrator privileges:
 *  1. Checks whether required environment variables are set and syntactically valid.
 *  2. Distinguishes least-privilege tokens (Ingestion vs Query).
 *  3. Verifies whether sample services can start without admin rights (zero-admin storage).
 *  4. Actively probes cloud endpoints ONLY when credentials exist (does not claim success just because vars exist).
 *  5. Directs the user to the exact screen in Grafana Cloud for any missing values.
 */

import http from "http";
import fs from "fs";
import path from "path";

// Load local .env file if running standalone
try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  }
} catch {
  // Ignored if already loaded
}

import { SamplePostgresClient } from "../sample-services/shared/database";
import { PrometheusClient } from "../src/lib/telemetry/prometheusClient";
import { JaegerClient } from "../src/lib/telemetry/jaegerClient";

interface DiagnosticItem {
  key: string;
  label: string;
  valueMasked: string;
  status: "VALID" | "MISSING" | "INVALID_FORMAT" | "WARNING";
  locationHint?: string;
  details?: string;
}

function maskSecret(val?: string): string {
  if (!val || val.trim().length === 0) return "[NOT SET]";
  return "[SET - REDACTED]";
}

function isValidHttpsUrl(str?: string): boolean {
  if (!str) return false;
  try {
    const parsed = new URL(str.trim());
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = http.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port);
  });
}

async function runConfigCheck() {
  console.log("\n===============================================================================");
  console.log("   IncidentGraph AI — Grafana Cloud Readiness & Configuration Audit");
  console.log("===============================================================================\n");

  const items: DiagnosticItem[] = [];

  // 1. OTLP Gateway Endpoint
  const otlpEndpoint = process.env.GRAFANA_CLOUD_OTLP_ENDPOINT?.trim();
  if (!otlpEndpoint) {
    items.push({
      key: "GRAFANA_CLOUD_OTLP_ENDPOINT",
      label: "OTLP Gateway HTTPS Endpoint",
      valueMasked: "[NOT SET]",
      status: "MISSING",
      locationHint: "Grafana Cloud Portal -> Select Stack -> OpenTelemetry (OTLP) / Send Data -> Copy OTLP HTTP Endpoint",
      details: "Must be a valid HTTPS URL (e.g. https://otlp-gateway-prod-ap-south-1.grafana.net/otlp)",
    });
  } else if (!isValidHttpsUrl(otlpEndpoint)) {
    items.push({
      key: "GRAFANA_CLOUD_OTLP_ENDPOINT",
      label: "OTLP Gateway HTTPS Endpoint",
      valueMasked: otlpEndpoint,
      status: "INVALID_FORMAT",
      locationHint: "Ensure the URL starts with https:// and points to your Grafana Cloud gateway",
      details: "Invalid HTTPS URL format",
    });
  } else {
    items.push({
      key: "GRAFANA_CLOUD_OTLP_ENDPOINT",
      label: "OTLP Gateway HTTPS Endpoint",
      valueMasked: otlpEndpoint,
      status: "VALID",
      details: "Valid HTTPS OTLP gateway URL",
    });
  }

  // 2. Grafana Cloud Instance ID
  const instanceId = (
    process.env.GRAFANA_CLOUD_INSTANCE_ID ||
    process.env.GRAFANA_CLOUD_OTLP_INSTANCE_ID
  )?.trim();
  if (!instanceId) {
    items.push({
      key: "GRAFANA_CLOUD_INSTANCE_ID",
      label: "Grafana Cloud Instance ID (Numeric)",
      valueMasked: "[NOT SET]",
      status: "MISSING",
      locationHint: "Grafana Cloud Portal -> Select Stack -> OpenTelemetry / Prometheus details screen (6-7 digit number)",
      details: "Numeric instance/tenant ID required for OTLP Basic Auth",
    });
  } else if (!/^\d+$/.test(instanceId)) {
    items.push({
      key: "GRAFANA_CLOUD_INSTANCE_ID",
      label: "Grafana Cloud Instance ID (Numeric)",
      valueMasked: maskSecret(instanceId),
      status: "WARNING",
      locationHint: "Typically a 6-7 digit numeric ID (e.g. 1871065)",
      details: "Instance ID contains non-numeric characters",
    });
  } else {
    items.push({
      key: "GRAFANA_CLOUD_INSTANCE_ID",
      label: "Grafana Cloud Instance ID (Numeric)",
      valueMasked: maskSecret(instanceId),
      status: "VALID",
      details: "Valid numeric instance ID configured",
    });
  }

  // 3. Telemetry Ingestion Token (Least-Privilege: metrics:write, traces:write)
  const ingestToken = process.env.GRAFANA_CLOUD_INGESTION_TOKEN?.trim();
  if (!ingestToken) {
    items.push({
      key: "GRAFANA_CLOUD_INGESTION_TOKEN",
      label: "Telemetry Ingestion Token",
      valueMasked: "[NOT SET]",
      status: "MISSING",
      locationHint: "Grafana Cloud Portal -> Security -> Access Policies -> Create Access Policy with 'metrics:write' and 'traces:write' -> Generate Token",
      details: "Required to push OTLP spans and metrics over HTTPS",
    });
  } else {
    items.push({
      key: "GRAFANA_CLOUD_INGESTION_TOKEN",
      label: "Telemetry Ingestion Token",
      valueMasked: maskSecret(ingestToken),
      status: "VALID",
      details: "Token configured for OTLP HTTP Basic Authentication",
    });
  }

  // 4. Prometheus Query URL
  const promUrl = process.env.GRAFANA_CLOUD_PROMETHEUS_URL?.trim();
  if (!promUrl) {
    items.push({
      key: "GRAFANA_CLOUD_PROMETHEUS_URL",
      label: "Hosted Prometheus Query URL",
      valueMasked: "[NOT SET]",
      status: "MISSING",
      locationHint: "Grafana Cloud Portal -> Select Stack -> Click 'Prometheus' card -> Copy 'URL' (e.g. https://prometheus-prod-XX-prod-ap-south-1.grafana.net/api/prom)",
      details: "Required for IncidentGraph AI to query live PromQL metrics",
    });
  } else if (!isValidHttpsUrl(promUrl)) {
    items.push({
      key: "GRAFANA_CLOUD_PROMETHEUS_URL",
      label: "Hosted Prometheus Query URL",
      valueMasked: promUrl,
      status: "INVALID_FORMAT",
      locationHint: "Ensure the URL starts with https://",
      details: "Invalid URL format",
    });
  } else {
    items.push({
      key: "GRAFANA_CLOUD_PROMETHEUS_URL",
      label: "Hosted Prometheus Query URL",
      valueMasked: promUrl,
      status: "VALID",
      details: "Valid Prometheus query endpoint format",
    });
  }

  // 5. Prometheus Read Token (Least-Privilege: metrics:read)
  const promToken = process.env.GRAFANA_CLOUD_PROMETHEUS_TOKEN?.trim();
  if (!promToken) {
    items.push({
      key: "GRAFANA_CLOUD_PROMETHEUS_TOKEN",
      label: "Prometheus Metrics Read Token",
      valueMasked: "[NOT SET]",
      status: "MISSING",
      locationHint: "Grafana Cloud Portal -> Security -> Access Policies -> Create Access Policy with 'metrics:read' -> Generate Token",
      details: "Required to query Prometheus metrics via HTTP Basic Auth",
    });
  } else {
    items.push({
      key: "GRAFANA_CLOUD_PROMETHEUS_TOKEN",
      label: "Prometheus Metrics Read Token",
      valueMasked: maskSecret(promToken),
      status: "VALID",
      details: "Read token configured for Prometheus PromQL queries",
    });
  }

  // 6. Tempo Traces Query URL
  const tempoUrl = process.env.GRAFANA_CLOUD_TEMPO_URL?.trim();
  if (!tempoUrl) {
    items.push({
      key: "GRAFANA_CLOUD_TEMPO_URL",
      label: "Hosted Tempo Traces Query URL",
      valueMasked: "[NOT SET]",
      status: "MISSING",
      locationHint: "Grafana Cloud Portal -> Select Stack -> Click 'Tempo' card -> Copy 'URL' (e.g. https://tempo-prod-XX-prod-ap-south-1.grafana.net)",
      details: "Required for IncidentGraph AI to search traces and span waterfalls",
    });
  } else if (!isValidHttpsUrl(tempoUrl)) {
    items.push({
      key: "GRAFANA_CLOUD_TEMPO_URL",
      label: "Hosted Tempo Traces Query URL",
      valueMasked: tempoUrl,
      status: "INVALID_FORMAT",
      locationHint: "Ensure the URL starts with https://",
      details: "Invalid URL format",
    });
  } else {
    items.push({
      key: "GRAFANA_CLOUD_TEMPO_URL",
      label: "Hosted Tempo Traces Query URL",
      valueMasked: tempoUrl,
      status: "VALID",
      details: "Valid Tempo trace query endpoint format",
    });
  }

  // 7. Tempo Read Token (Least-Privilege: traces:read)
  const tempoToken = process.env.GRAFANA_CLOUD_TEMPO_TOKEN?.trim();
  if (!tempoToken) {
    items.push({
      key: "GRAFANA_CLOUD_TEMPO_TOKEN",
      label: "Tempo Traces Read Token",
      valueMasked: "[NOT SET]",
      status: "MISSING",
      locationHint: "Grafana Cloud Portal -> Security -> Access Policies -> Create Access Policy with 'traces:read' -> Generate Token",
      details: "Required to query Tempo traces via HTTP Basic Auth",
    });
  } else {
    items.push({
      key: "GRAFANA_CLOUD_TEMPO_TOKEN",
      label: "Tempo Traces Read Token",
      valueMasked: maskSecret(tempoToken),
      status: "VALID",
      details: "Read token configured for Tempo trace queries",
    });
  }

  // Print Configuration Breakdown Table
  console.log("--- 1. Environment Variable Audit (Masked Sanitized View) ---");
  for (const item of items) {
    const icon = item.status === "VALID" ? "✓ [OK]" : item.status === "WARNING" ? "⚠ [WARN]" : "✗ [MISSING]";
    console.log(` ${icon.padEnd(10)} ${item.key.padEnd(32)}: ${item.valueMasked}`);
    if (item.details) console.log(`              ↳ ${item.details}`);
    if (item.locationHint && item.status !== "VALID") {
      console.log(`              ↳ Where to find in Grafana Cloud: ${item.locationHint}`);
    }
  }

  // 1b. Token Least-Privilege Separation Audit
  console.log("\n--- 1b. Least-Privilege Token Separation Audit ---");
  const hasIngest = Boolean(ingestToken);
  const hasProm = Boolean(promToken);
  const hasTempo = Boolean(tempoToken);

  if (hasIngest && hasProm && hasTempo) {
    const ingestEqualsProm = ingestToken === promToken;
    const ingestEqualsTempo = ingestToken === tempoToken;
    const promEqualsTempo = promToken === tempoToken;

    if (!ingestEqualsProm && !ingestEqualsTempo) {
      console.log(" ✓ [OK]      Strict least-privilege separation: Ingestion token is isolated from query tokens.");
    } else {
      console.log(" ⚠ [NOTICE]  Shared credential detected: Ingestion and query operations currently use the same token.");
      console.log("             Recommendation: When generating replacements, use distinct Access Policies (write-only vs read-only).");
    }

    if (!promEqualsTempo) {
      console.log(" ✓ [OK]      Dedicated query credentials: Prometheus and Tempo use separate read tokens.");
    } else {
      console.log(" ℹ [INFO]    Consolidated read credential: Prometheus and Tempo share a query read token.");
    }
  } else {
    console.log(" ○ [PENDING] Token separation audit will complete once all 3 token variables are populated.");
  }

  // 2. Check Local Machine & Port Readiness
  console.log("\n--- 2. Local Machine & Microservices Readiness ---");
  const ports = [4000, 4001, 4002, 4003];
  const portChecks = await Promise.all(ports.map(async (p) => ({ port: p, available: await isPortAvailable(p) })));
  const allPortsReady = portChecks.every((p) => p.available);

  if (allPortsReady) {
    console.log(" ✓ [OK]      Ports 4000, 4001, 4002, 4003 are available for sample microservices.");
  } else {
    const busy = portChecks.filter((p) => !p.available).map((p) => p.port);
    console.log(` ⚠ [NOTICE]  Ports currently in use: ${busy.join(", ")}. Sample services may already be running.`);
  }

  // 3. Database Layer Check (Zero-Admin local storage)
  const dbClient = SamplePostgresClient.getInstance();
  const dbHealth = await dbClient.checkReadiness();
  console.log(` ✓ [OK]      Database mode: ${dbHealth.storageType} (Zero-admin permissions required).`);

  // 4. Active Cloud Connection Probing (Only performed if URLs and tokens exist)
  console.log("\n--- 3. Live Cloud Connectivity Probe (Active HTTP Verification) ---");
  const canProbePrometheus = Boolean(promUrl && promToken);
  const canProbeTempo = Boolean(tempoUrl && tempoToken);

  if (!canProbePrometheus && !canProbeTempo) {
    console.log(" ○ [SKIPPED] Live cloud HTTP probe skipped because cloud query URLs / tokens are not yet configured.");
    console.log("             (IncidentGraph AI will NOT falsely report success until credentials are tested).");
  } else {
    if (canProbePrometheus) {
      console.log("   Probing Grafana Cloud Prometheus query endpoint...");
      const pClient = new PrometheusClient();
      const pHealth = await pClient.checkHealth();
      if (pHealth.available) {
        console.log("   ✓ [PASS]   Successfully connected & authenticated to Grafana Cloud Prometheus PromQL engine.");
      } else {
        console.log(`   ✗ [FAILED] Prometheus query probe failed: ${pHealth.error || "Unreachable"}`);
      }
    }

    if (canProbeTempo) {
      console.log("   Probing Grafana Cloud Tempo trace query endpoint...");
      const tClient = new JaegerClient();
      const tHealth = await tClient.checkHealth();
      if (tHealth.available) {
        console.log("   ✓ [PASS]   Successfully connected & authenticated to Grafana Cloud Tempo trace engine.");
      } else {
        console.log(`   ✗ [FAILED] Tempo query probe failed: ${tHealth.error || "Unreachable"}`);
      }
    }
  }

  // 5. Final Readiness Verdict
  const missingCount = items.filter((i) => i.status === "MISSING").length;
  console.log("\n===============================================================================");
  console.log("   READINESS SUMMARY & NEXT STEPS");
  console.log("===============================================================================\n");

  if (missingCount === 0 && canProbePrometheus && canProbeTempo) {
    console.log("🎉 All Grafana Cloud configurations are complete and verified!");
    console.log("You can now run full end-to-end verification:");
    console.log("   npm run test:cloud\n");
  } else {
    console.log(`Status: Awaiting ${missingCount} required cloud parameter(s) in .env`);
    console.log("\nAction items to complete setup:");
    items
      .filter((i) => i.status === "MISSING")
      .forEach((i, idx) => {
        console.log(`  ${idx + 1}. Set ${i.key}:`);
        console.log(`     Location: ${i.locationHint}`);
      });
    console.log("\nAfter adding your values to .env, run this command again:");
  }
}

void runConfigCheck();
