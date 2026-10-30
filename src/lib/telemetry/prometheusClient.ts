import {
  NormalizedMetricRecord,
  ProviderDiagnostic,
  TelemetryErrorCode,
} from "./normalization";

export interface PrometheusMetricResult {
  service: string;
  value: number;
  timestamp: number;
}

export interface PrometheusDetailedResult {
  success: boolean;
  records: NormalizedMetricRecord[];
  diagnostic: ProviderDiagnostic;
}

export class PrometheusClient {
  private baseUrl: string;
  private timeoutMs: number;
  private isCloud: boolean;
  private authHeader: string | null = null;

  constructor(customUrl?: string, customTimeoutMs?: number) {
    const cloudUrl = process.env.GRAFANA_CLOUD_PROMETHEUS_URL;
    const cloudUser = process.env.GRAFANA_CLOUD_PROMETHEUS_USER || process.env.GRAFANA_CLOUD_INSTANCE_ID;
    const cloudToken = process.env.GRAFANA_CLOUD_PROMETHEUS_TOKEN;

    if (customUrl) {
      this.baseUrl = customUrl.replace(/\/$/, "");
      this.isCloud = false;
    } else if (cloudUrl && cloudUrl.trim().length > 0) {
      let trimmed = cloudUrl.trim().replace(/\/$/, "");
      if (trimmed.includes("grafana.net") && !trimmed.includes("/api/prom")) {
        trimmed = `${trimmed}/api/prom`;
      }
      this.baseUrl = trimmed;
      this.isCloud = true;
      if (cloudUser && cloudToken) {
        this.authHeader = `Basic ${Buffer.from(`${cloudUser.trim()}:${cloudToken.trim()}`).toString("base64")}`;
      }
    } else {
      this.baseUrl = (process.env.PROMETHEUS_URL || "http://localhost:9090").replace(/\/$/, "");
      this.isCloud = false;
    }

    this.timeoutMs = customTimeoutMs || Number(process.env.TELEMETRY_QUERY_TIMEOUT_MS) || 4000;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public isCloudBackend(): boolean {
    return this.isCloud;
  }

  private getRequestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }
    return headers;
  }

  public async checkHealth(): Promise<{ available: boolean; isMock?: boolean; isCloud?: boolean; error?: string; errorCode?: TelemetryErrorCode }> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const testQuery = this.isCloud ? "vector(1)" : "up";
      const url = `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(testQuery)}`;

      const res = await fetch(url, {
        signal: controller.signal,
        headers: this.getRequestHeaders(),
      });
      clearTimeout(timeout);

      if (res.status === 401 || res.status === 403) {
        return {
          available: false,
          isCloud: this.isCloud,
          errorCode: "AUTH_FAILURE",
          error: `Authentication failed (${res.status}). Verify credentials and read permissions.`,
        };
      }

      if (res.status === 429) {
        return {
          available: false,
          isCloud: this.isCloud,
          errorCode: "RATE_LIMITED",
          error: "Prometheus endpoint rate limited (429 Too Many Requests).",
        };
      }

      if (!res.ok) {
        return {
          available: false,
          isCloud: this.isCloud,
          errorCode: res.status >= 500 ? "UNAVAILABLE" : "BAD_REQUEST",
          error: `Health probe failed with HTTP status ${res.status}.`,
        };
      }

      const isMock = res.headers.get("x-observability-provider") === "mock-observability-server";
      return { available: true, isMock, isCloud: this.isCloud };
    } catch (err: unknown) {
      const elapsed = Date.now() - start;
      const isTimeout = elapsed >= this.timeoutMs || (err instanceof Error && err.name === "AbortError");
      return {
        available: false,
        isMock: false,
        isCloud: this.isCloud,
        errorCode: isTimeout ? "TIMEOUT" : "UNAVAILABLE",
        error: isTimeout ? `Connection timed out after ${this.timeoutMs}ms` : "Endpoint unreachable or network connection failed",
      };
    }
  }

  public async queryInstantDetailed(query: string, metricType: NormalizedMetricRecord["metricType"] = "CUSTOM"): Promise<PrometheusDetailedResult> {
    const start = Date.now();
    const nowIso = new Date().toISOString();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const url = `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`;

      const res = await fetch(url, {
        signal: controller.signal,
        headers: this.getRequestHeaders(),
      });
      clearTimeout(timeout);
      const latencyMs = Date.now() - start;

      if (res.status === 401 || res.status === 403) {
        return this.createFailureResult(latencyMs, nowIso, "AUTH_FAILURE", `Authentication failed (${res.status})`);
      }
      if (res.status === 429) {
        return this.createFailureResult(latencyMs, nowIso, "RATE_LIMITED", "Query rate limited (429)");
      }
      if (!res.ok) {
        const code: TelemetryErrorCode = res.status >= 500 ? "UNAVAILABLE" : "BAD_REQUEST";
        return this.createFailureResult(latencyMs, nowIso, code, `Query failed with HTTP status ${res.status}`);
      }

      let json: { status?: string; data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> } };
      try {
        json = await res.json();
      } catch {
        return this.createFailureResult(latencyMs, nowIso, "MALFORMED_RESPONSE", "Invalid JSON payload in Prometheus response");
      }

      if (json.status !== "success" || !Array.isArray(json.data?.result)) {
        return this.createFailureResult(latencyMs, nowIso, "MALFORMED_RESPONSE", "Prometheus response missing success status or result array");
      }

      const records: NormalizedMetricRecord[] = json.data.result.map((r, idx) => {
        const labels: Record<string, string> = {};
        if (r.metric) {
          for (const [k, v] of Object.entries(r.metric)) {
            labels[k] = String(v);
          }
        }
        const service = labels["service"] || labels["job"] || labels["service_name"] || labels["instance"] || "unknown-service";
        const val = parseFloat(r.value?.[1] || "0");
        const tsMs = (r.value?.[0] || Date.now() / 1000) * 1000;

        return {
          id: `prom-${metricType.toLowerCase()}-${service}-${idx}-${Date.now()}`,
          provider: this.isCloud ? "GRAFANA_CLOUD" : "PROMETHEUS",
          serviceName: service,
          metricType,
          metricName: query,
          timestamp: new Date(tsMs).toISOString(),
          value: isNaN(val) ? 0 : val,
          unit: this.resolveUnit(metricType),
          labels,
          hasAnomaly: false,
        };
      });

      return {
        success: true,
        records,
        diagnostic: {
          provider: "PROMETHEUS",
          endpoint: this.baseUrl,
          status: "OK",
          message: `Query resolved ${records.length} metric series in ${latencyMs}ms`,
          latencyMs,
          timestamp: nowIso,
        },
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      const isTimeout = latencyMs >= this.timeoutMs || (err instanceof Error && err.name === "AbortError");
      const errorCode: TelemetryErrorCode = isTimeout ? "TIMEOUT" : "UNAVAILABLE";
      return this.createFailureResult(latencyMs, nowIso, errorCode, isTimeout ? `Query timed out after ${this.timeoutMs}ms` : "Network request failed");
    }
  }

  private resolveUnit(type: NormalizedMetricRecord["metricType"]): string {
    switch (type) {
      case "LATENCY_AVG":
      case "LATENCY_P95":
        return "ms";
      case "ERROR_RATE":
      case "CPU_UTILIZATION":
      case "MEMORY_UTILIZATION":
        return "%";
      case "REQUEST_RATE":
        return "req/s";
      case "DB_CONNECTION_PRESSURE":
        return "connections";
      default:
        return "count";
    }
  }

  private createFailureResult(
    latencyMs: number,
    timestamp: string,
    errorCode: TelemetryErrorCode,
    message: string
  ): PrometheusDetailedResult {
    return {
      success: false,
      records: [],
      diagnostic: {
        provider: "PROMETHEUS",
        endpoint: this.baseUrl,
        status: "ERROR",
        errorCode,
        message,
        latencyMs,
        timestamp,
      },
    };
  }

  public async queryInstant(query: string): Promise<PrometheusMetricResult[]> {
    const detailed = await this.queryInstantDetailed(query);
    if (!detailed.success) return [];
    return detailed.records.map((r) => ({
      service: r.serviceName,
      value: r.value,
      timestamp: new Date(r.timestamp).getTime(),
    }));
  }

  public async getServiceMetrics(): Promise<Map<string, { latencyMs: number; errorRate: number; requestRate: number }>> {
    const results = new Map<string, { latencyMs: number; errorRate: number; requestRate: number }>();

    // Query standard metrics with fallback to rate expressions if available
    const [latencyDetailed, errorDetailed, requestDetailed] = await Promise.all([
      this.queryInstantDetailed("http_request_duration_seconds", "LATENCY_AVG"),
      this.queryInstantDetailed("http_request_errors_total", "ERROR_RATE"),
      this.queryInstantDetailed("http_requests_total", "REQUEST_RATE"),
    ]);

    for (const m of latencyDetailed.records) {
      const existing = results.get(m.serviceName) || { latencyMs: 0, errorRate: 0, requestRate: 0 };
      existing.latencyMs = Math.round(m.value > 10 ? m.value : m.value * 1000); // handle seconds or ms
      results.set(m.serviceName, existing);
    }

    for (const m of errorDetailed.records) {
      const existing = results.get(m.serviceName) || { latencyMs: 0, errorRate: 0, requestRate: 0 };
      existing.errorRate = Number(m.value.toFixed(2));
      results.set(m.serviceName, existing);
    }

    for (const m of requestDetailed.records) {
      const existing = results.get(m.serviceName) || { latencyMs: 0, errorRate: 0, requestRate: 0 };
      existing.requestRate = Math.round(m.value);
      results.set(m.serviceName, existing);
    }

    return results;
  }
}

export const prometheusClient = new PrometheusClient();
