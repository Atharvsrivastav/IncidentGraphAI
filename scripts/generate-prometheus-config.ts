/**
 * IncidentGraph AI — Prometheus Configuration & Remote-Write Helper
 *
 * Generates or validates Prometheus configuration for Docker Compose and local development:
 * - Scrapes sample microservices (ports 4000-4003)
 * - Scrapes Next.js application (/api/metrics on port 3000)
 * - Scrapes OpenTelemetry Collector (port 8889)
 * - Configures secure Grafana Cloud Prometheus remote_write with strict credential separation
 */

import fs from "fs";
import path from "path";
import YAML from "yaml";

// Load .env if present
try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  }
} catch {
  // Ignored if already loaded
}

export interface PrometheusConfigOptions {
  remoteWriteUrl?: string;
  remoteWriteUser?: string;
  remoteWriteToken?: string;
  targets?: {
    services?: string[];
    nextApp?: string;
    otelCollector?: string;
  };
}

export interface RemoteWriteValidationResult {
  valid: boolean;
  reason?: string;
  url?: string;
  user?: string;
  hasDedicatedToken?: boolean;
}

/**
 * Validates remote-write configuration with strict credential separation:
 * - Remote-write URL must be present and valid HTTP/HTTPS URL
 * - Dedicated write token (GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_TOKEN) must be present (read-only query token GRAFANA_CLOUD_PROMETHEUS_TOKEN is rejected)
 * - OTLP ingestion token (GRAFANA_CLOUD_INGESTION_TOKEN) must NOT automatically count as remote-write credentials
 * - Username (GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_USER or GRAFANA_CLOUD_INSTANCE_ID) must be present
 * - Never prints or leaks token contents
 */
export function validateRemoteWriteConfig(
  input: Record<string, string | undefined> | PrometheusConfigOptions = process.env
): RemoteWriteValidationResult {
  const isOptions =
    "remoteWriteUrl" in input ||
    "remoteWriteUser" in input ||
    "remoteWriteToken" in input;

  const rawUrl = isOptions
    ? (input as PrometheusConfigOptions).remoteWriteUrl
    : (input as Record<string, string | undefined>).GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL;

  if (!rawUrl || rawUrl.trim().length === 0) {
    return { valid: false, reason: "URL absent (GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL is not set)" };
  }

  const url = rawUrl.trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, reason: `Invalid URL protocol: "${parsed.protocol}". Must be http: or https:` };
    }
  } catch {
    return { valid: false, reason: `Invalid URL: "${url}" is malformed` };
  }

  // Dedicated write token: only GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_TOKEN authorizes remote-write
  const writeToken = isOptions
    ? (input as PrometheusConfigOptions).remoteWriteToken
    : (input as Record<string, string | undefined>).GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_TOKEN;

  const readToken = !isOptions
    ? (input as Record<string, string | undefined>).GRAFANA_CLOUD_PROMETHEUS_TOKEN
    : undefined;

  const otlpToken = !isOptions
    ? (input as Record<string, string | undefined>).GRAFANA_CLOUD_INGESTION_TOKEN
    : undefined;

  if (!writeToken || writeToken.trim().length === 0) {
    if (readToken && readToken.trim().length > 0) {
      return {
        valid: false,
        reason: "URL present with read-only Prometheus token (Read-only query token GRAFANA_CLOUD_PROMETHEUS_TOKEN cannot be used for Prometheus remote-write; dedicated write token GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_TOKEN required)",
      };
    }
    if (otlpToken && otlpToken.trim().length > 0) {
      return {
        valid: false,
        reason: "URL present with only OTLP ingestion token (OTLP ingestion credentials do not count as Prometheus remote-write credentials; dedicated write token GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_TOKEN required)",
      };
    }
    return { valid: false, reason: "URL present but token absent (Dedicated write token GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_TOKEN required)" };
  }

  // Username: dedicated remote-write user or instance ID (never fall back to read-only query user)
  const user = isOptions
    ? (input as PrometheusConfigOptions).remoteWriteUser
    : ((input as Record<string, string | undefined>).GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_USER ||
       (input as Record<string, string | undefined>).GRAFANA_CLOUD_INSTANCE_ID);

  if (!user || user.trim().length === 0) {
    return { valid: false, reason: "Missing username (Remote-write username GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_USER or instance ID required)" };
  }

  return {
    valid: true,
    url,
    user: user.trim(),
    hasDedicatedToken: true,
  };
}

/**
 * Validates that generated Prometheus YAML is structurally valid using real YAML parsing
 */
export function validateGeneratedYaml(yaml: string): { valid: boolean; error?: string } {
  if (!yaml || yaml.trim().length === 0) {
    return { valid: false, error: "Empty YAML string" };
  }
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Reject tab characters in YAML indentation
    if (/^\t+/.test(line)) {
      return { valid: false, error: `YAML tab indentation error at line ${i + 1}` };
    }
  }
  try {
    const parsed = YAML.parse(yaml);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { valid: false, error: "YAML must parse to a root configuration mapping" };
    }
    if (!Array.isArray(parsed.scrape_configs) || parsed.scrape_configs.length === 0) {
      return { valid: false, error: "Missing required non-empty 'scrape_configs' array in Prometheus YAML" };
    }
    if (parsed.remote_write !== undefined) {
      if (!Array.isArray(parsed.remote_write)) {
        return { valid: false, error: "'remote_write' must be an array when specified" };
      }
      for (const rw of parsed.remote_write) {
        if (!rw || typeof rw !== "object" || !rw.url || typeof rw.url !== "string") {
          return { valid: false, error: "remote_write entry must have a valid string 'url'" };
        }
      }
    }
    return { valid: true };
  } catch (err: unknown) {
    return { valid: false, error: `YAML parse error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function generatePrometheusConfig(options: PrometheusConfigOptions = {}): string {
  const remoteWriteUrl = options.remoteWriteUrl !== undefined
    ? options.remoteWriteUrl
    : process.env.GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL;

  const remoteWriteUser = options.remoteWriteUser !== undefined
    ? options.remoteWriteUser
    : (process.env.GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_USER || process.env.GRAFANA_CLOUD_INSTANCE_ID);

  const remoteWriteToken = options.remoteWriteToken !== undefined
    ? options.remoteWriteToken
    : process.env.GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_TOKEN;

  const isRemoteWriteRequested = Boolean(remoteWriteUrl && remoteWriteUrl.trim().length > 0);

  if (isRemoteWriteRequested) {
    const validation = validateRemoteWriteConfig({
      remoteWriteUrl,
      remoteWriteUser,
      remoteWriteToken,
    });
    if (!validation.valid) {
      throw new Error(`Incomplete or invalid remote_write configuration: ${validation.reason}`);
    }
  }

  const lines: string[] = [
    "global:",
    "  scrape_interval: 5s",
    "  evaluation_interval: 5s",
    "",
    "scrape_configs:",
    "  # Scrape metrics exported by OpenTelemetry Collector",
    "  - job_name: 'otel-collector'",
    "    static_configs:",
    "      - targets: ['otel-collector:8889']",
    "        labels:",
    "          environment: 'development'",
    "          cluster: 'local-sample-mesh'",
    "",
    "  # Scrape sample microservices exposing standard Prometheus /metrics",
    "  - job_name: 'incidentgraph-services'",
    "    scrape_interval: 5s",
    "    static_configs:",
    "      - targets:",
    "          - 'host.docker.internal:4000'",
    "          - 'host.docker.internal:4001'",
    "          - 'host.docker.internal:4002'",
    "          - 'host.docker.internal:4003'",
    "        labels:",
    "          environment: 'development'",
    "          cluster: 'local-sample-mesh'",
    "",
    "  # Scrape Next.js application control-plane metrics",
    "  - job_name: 'incidentgraph-app'",
    "    scrape_interval: 5s",
    "    metrics_path: '/api/metrics'",
    "    static_configs:",
    "      - targets: ['host.docker.internal:3000']",
    "        labels:",
    "          environment: 'development'",
    "          cluster: 'local-sample-mesh'",
    "",
    "  # Self-scrape Prometheus health metrics",
    "  - job_name: 'prometheus'",
    "    static_configs:",
    "      - targets: ['localhost:9090']",
  ];

  if (isRemoteWriteRequested && remoteWriteUrl && remoteWriteToken) {
    lines.push(
      "",
      "# -----------------------------------------------------------------------------",
      "# Active Grafana Cloud Remote-Write Integration",
      "# -----------------------------------------------------------------------------",
      "remote_write:",
      `  - url: ${JSON.stringify(remoteWriteUrl.trim())}`,
      "    basic_auth:",
      `      username: ${JSON.stringify((remoteWriteUser || "").trim())}`,
      `      password: ${JSON.stringify(remoteWriteToken.trim())}`,
      "    queue_config:",
      "      max_samples_per_send: 500",
      "      max_shards: 4",
      "      batch_send_deadline: 5s"
    );
  }

  const generated = lines.join("\n") + "\n";
  const validation = validateGeneratedYaml(generated);
  if (!validation.valid) {
    throw new Error(`Generated invalid Prometheus YAML: ${validation.error}`);
  }
  return generated;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const validation = validateRemoteWriteConfig();
  console.log("=== IncidentGraph AI: Prometheus Configuration Status ===");
  console.log(`Remote Write URL : ${validation.url ? validation.url : "[NOT SET - Local Only]"}`);
  console.log(`Remote Write Auth: ${validation.hasDedicatedToken ? "[CONFIGURED - DEDICATED TOKEN SET]" : "[NOT SET]"}`);
  console.log(`Validation Status: ${validation.valid ? "VALID" : `INACTIVE / LOCAL ONLY (${validation.reason})`}`);
  console.log("Targets          : otel-collector:8889, services:4000-4003, app:3000/api/metrics, localhost:9090");
}
