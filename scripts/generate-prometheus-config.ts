/**
 * IncidentGraph AI — Prometheus Configuration & Remote-Write Helper
 *
 * Generates or validates Prometheus configuration for Docker Compose and local development:
 * - Scrapes sample microservices (ports 4000-4003)
 * - Scrapes Next.js application (/api/metrics on port 3000)
 * - Scrapes OpenTelemetry Collector (port 8889)
 * - Optionally configures secure Grafana Cloud Prometheus remote_write
 */

import fs from "fs";
import path from "path";

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

export function generatePrometheusConfig(options: PrometheusConfigOptions = {}): string {
  const remoteWriteUrl = options.remoteWriteUrl || process.env.GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL;
  const remoteWriteUser = options.remoteWriteUser || process.env.GRAFANA_CLOUD_PROMETHEUS_USER || process.env.GRAFANA_CLOUD_INSTANCE_ID;
  const remoteWriteToken = options.remoteWriteToken || process.env.GRAFANA_CLOUD_PROMETHEUS_TOKEN;

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

  if (remoteWriteUrl && remoteWriteToken) {
    lines.push(
      "",
      "# -----------------------------------------------------------------------------",
      "# Active Grafana Cloud Remote-Write Integration",
      "# -----------------------------------------------------------------------------",
      "remote_write:",
      `  - url: "${remoteWriteUrl.trim()}"`,
      "    basic_auth:",
      `      username: "${(remoteWriteUser || "").trim()}"`,
      `      password: "${remoteWriteToken.trim()}"`,
      "    queue_config:",
      "      max_samples_per_send: 500",
      "      max_shards: 4",
      "      batch_send_deadline: 5s"
    );
  }

  return lines.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const remoteWriteUrl = process.env.GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL;
  const hasToken = Boolean(process.env.GRAFANA_CLOUD_PROMETHEUS_TOKEN);
  console.log("=== IncidentGraph AI: Prometheus Configuration Status ===");
  console.log(`Remote Write URL : ${remoteWriteUrl ? remoteWriteUrl : "[NOT SET - Local Only]"}`);
  console.log(`Remote Write Auth: ${hasToken ? "[CONFIGURED - TOKEN SET]" : "[NOT SET]"}`);
  console.log("Targets          : otel-collector:8889, services:4000-4003, app:3000/api/metrics, localhost:9090");
}
