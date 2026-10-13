export interface PrometheusMetricResult {
  service: string;
  value: number;
  timestamp: number;
}

export class PrometheusClient {
  private baseUrl: string;
  private timeoutMs: number;
  private isCloud: boolean;
  private authHeader: string | null = null;

  constructor(
    customUrl?: string,
    customTimeoutMs?: number
  ) {
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
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }
    return headers;
  }

  public async checkHealth(): Promise<{ available: boolean; isMock?: boolean; isCloud?: boolean; error?: string }> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      // In Prometheus and Grafana Cloud, query=1 or query=up verifies query engine availability
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
          error: `Grafana Cloud Prometheus authentication failed (${res.status} ${res.statusText}). Verify GRAFANA_CLOUD_PROMETHEUS_USER (instance ID) and read token permission ('metrics:read').`,
        };
      }

      const isMock = res.headers.get("x-observability-provider") === "mock-observability-server";
      return { available: res.ok, isMock, isCloud: this.isCloud };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, isMock: false, isCloud: this.isCloud, error: msg };
    }
  }

  public async queryInstant(query: string): Promise<PrometheusMetricResult[]> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      const url = `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: this.getRequestHeaders(),
      });
      clearTimeout(timeout);

      if (!res.ok) return [];

      const data = await res.json();
      if (data.status !== "success" || !data.data?.result) return [];

      return data.data.result.map((r: { metric?: Record<string, string>; value?: [number, string] }) => {
        const service = r.metric?.service || r.metric?.job || r.metric?.service_name || r.metric?.instance || "unknown";
        const val = parseFloat(r.value?.[1] || "0");
        const ts = (r.value?.[0] || 0) * 1000;
        return {
          service,
          value: isNaN(val) ? 0 : val,
          timestamp: ts,
        };
      });
    } catch {
      return [];
    }
  }

  public async getServiceMetrics(): Promise<Map<string, { latencyMs: number; errorRate: number; requestRate: number }>> {
    const results = new Map<string, { latencyMs: number; errorRate: number; requestRate: number }>();

    const [latencyMetrics, errorMetrics, requestMetrics] = await Promise.all([
      this.queryInstant("http_request_duration_seconds"),
      this.queryInstant("http_request_errors_total"),
      this.queryInstant("http_requests_total"),
    ]);

    for (const m of latencyMetrics) {
      const existing = results.get(m.service) || { latencyMs: 0, errorRate: 0, requestRate: 0 };
      existing.latencyMs = Math.round(m.value * 1000); // convert seconds to ms
      results.set(m.service, existing);
    }

    for (const m of errorMetrics) {
      const existing = results.get(m.service) || { latencyMs: 0, errorRate: 0, requestRate: 0 };
      existing.errorRate = Number(m.value.toFixed(2));
      results.set(m.service, existing);
    }

    for (const m of requestMetrics) {
      const existing = results.get(m.service) || { latencyMs: 0, errorRate: 0, requestRate: 0 };
      existing.requestRate = Math.round(m.value);
      results.set(m.service, existing);
    }

    return results;
  }
}

export const prometheusClient = new PrometheusClient();
