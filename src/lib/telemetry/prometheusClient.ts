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

export interface PrometheusRangeOptions {
  query: string;
  startSec: number;
  endSec: number;
  stepSec: number;
  metricType?: NormalizedMetricRecord["metricType"];
}

interface RawPromResult {
  metric?: Record<string, string>;
  value?: [number, string];
  values?: Array<[number, string]>;
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const testQuery = this.isCloud ? "vector(1)" : "up";
      const url = `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(testQuery)}`;

      const res = await fetch(url, {
        signal: controller.signal,
        headers: this.getRequestHeaders(),
      });

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

      await res.json();
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
    } finally {
      clearTimeout(timeout);
    }
  }

  public async queryInstantDetailed(query: string, metricType: NormalizedMetricRecord["metricType"] = "CUSTOM"): Promise<PrometheusDetailedResult> {
    const start = Date.now();
    const nowIso = new Date().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: this.getRequestHeaders(),
      });

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

      let json: { status?: string; data?: { result?: RawPromResult[] } };
      try {
        json = await res.json();
      } catch (err: unknown) {
        if (
          controller.signal.aborted ||
          (err instanceof Error && err.name === "AbortError") ||
          Date.now() - start >= this.timeoutMs
        ) {
          throw err;
        }
        return this.createFailureResult(latencyMs, nowIso, "MALFORMED_RESPONSE", "Invalid JSON payload in Prometheus response");
      }

      if (json.status !== "success" || !Array.isArray(json.data?.result)) {
        return this.createFailureResult(latencyMs, nowIso, "MALFORMED_RESPONSE", "Prometheus response missing success status or result array");
      }

      const records = this.parseInstantRecords(json.data.result, query, metricType);
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
      const isTimeout = latencyMs >= this.timeoutMs || controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
      const errorCode: TelemetryErrorCode = isTimeout ? "TIMEOUT" : "UNAVAILABLE";
      return this.createFailureResult(latencyMs, nowIso, errorCode, isTimeout ? `Query timed out after ${this.timeoutMs}ms` : "Network request failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  public async queryRange(options: PrometheusRangeOptions): Promise<PrometheusDetailedResult> {
    const { query, startSec, endSec, stepSec, metricType = "CUSTOM" } = options;
    const start = Date.now();
    const nowIso = new Date().toISOString();

    const validationError = this.validateRangeParams(startSec, endSec, stepSec);
    if (validationError) {
      return this.createFailureResult(0, nowIso, "BAD_REQUEST", validationError);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const params = new URLSearchParams({
        query,
        start: String(startSec),
        end: String(endSec),
        step: String(stepSec),
      });
      const url = `${this.baseUrl}/api/v1/query_range?${params.toString()}`;

      const res = await fetch(url, {
        signal: controller.signal,
        headers: this.getRequestHeaders(),
      });

      const latencyMs = Date.now() - start;
      if (res.status === 401 || res.status === 403) {
        return this.createFailureResult(latencyMs, nowIso, "AUTH_FAILURE", `Authentication failed (${res.status})`);
      }
      if (res.status === 429) {
        return this.createFailureResult(latencyMs, nowIso, "RATE_LIMITED", "Range query rate limited (429)");
      }
      if (!res.ok) {
        const code: TelemetryErrorCode = res.status >= 500 ? "UNAVAILABLE" : "BAD_REQUEST";
        return this.createFailureResult(latencyMs, nowIso, code, `Range query failed with HTTP status ${res.status}`);
      }

      let json: { status?: string; data?: { resultType?: string; result?: RawPromResult[] } };
      try {
        json = await res.json();
      } catch (err: unknown) {
        if (
          controller.signal.aborted ||
          (err instanceof Error && err.name === "AbortError") ||
          Date.now() - start >= this.timeoutMs
        ) {
          throw err;
        }
        return this.createFailureResult(latencyMs, nowIso, "MALFORMED_RESPONSE", "Invalid JSON payload in range response");
      }

      if (json.status !== "success" || !Array.isArray(json.data?.result)) {
        return this.createFailureResult(latencyMs, nowIso, "MALFORMED_RESPONSE", "Range response missing success status or result array");
      }

      const records = this.parseRangeMatrixRecords(json.data.result, query, metricType);
      return {
        success: true,
        records,
        diagnostic: {
          provider: "PROMETHEUS",
          endpoint: this.baseUrl,
          status: "OK",
          message: `Range query resolved ${records.length} metric points across series in ${latencyMs}ms`,
          latencyMs,
          timestamp: nowIso,
        },
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      const isTimeout = latencyMs >= this.timeoutMs || (err instanceof Error && err.name === "AbortError");
      const errorCode: TelemetryErrorCode = isTimeout ? "TIMEOUT" : "UNAVAILABLE";
      return this.createFailureResult(latencyMs, nowIso, errorCode, isTimeout ? `Range query timed out after ${this.timeoutMs}ms` : "Network request failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  private validateRangeParams(startSec: number, endSec: number, stepSec: number): string | null {
    if (isNaN(startSec) || isNaN(endSec) || isNaN(stepSec)) {
      return "Range query parameters (start, end, step) must be valid numbers";
    }
    if (startSec >= endSec) {
      return `Invalid time range: start (${startSec}) must be strictly less than end (${endSec})`;
    }
    if (stepSec <= 0) {
      return `Invalid step: step (${stepSec}) must be greater than 0`;
    }
    const maxLookbackSec = 86400; // 24 hours lookback bound
    if (endSec - startSec > maxLookbackSec) {
      return `Time range exceeds maximum permitted lookback of 24 hours (${endSec - startSec}s > ${maxLookbackSec}s)`;
    }
    const pointCount = Math.floor((endSec - startSec) / stepSec);
    if (pointCount > 11000) {
      return `Query exceeds standard point limit of 11,000 points (requested ${pointCount} points)`;
    }
    return null;
  }

  private parseInstantRecords(
    results: RawPromResult[],
    query: string,
    metricType: NormalizedMetricRecord["metricType"]
  ): NormalizedMetricRecord[] {
    return results.map((r, idx) => {
      const labels = this.extractLabels(r.metric);
      const service = labels["service"] || labels["job"] || labels["service_name"] || labels["instance"] || "unknown-service";
      const rawVal = parseFloat(r.value?.[1] || "0");
      const normalizedValue = this.convertMetricValue(rawVal, metricType, query);
      const tsMs = (r.value?.[0] || Date.now() / 1000) * 1000;

      return {
        id: `prom-${metricType.toLowerCase()}-${service}-${idx}-${Date.now()}`,
        provider: this.isCloud ? "GRAFANA_CLOUD" : "PROMETHEUS",
        serviceName: service,
        metricType,
        metricName: query,
        timestamp: new Date(tsMs).toISOString(),
        value: normalizedValue,
        unit: this.resolveUnit(metricType),
        labels,
        hasAnomaly: false,
      };
    });
  }

  private parseRangeMatrixRecords(
    results: RawPromResult[],
    query: string,
    metricType: NormalizedMetricRecord["metricType"]
  ): NormalizedMetricRecord[] {
    const records: NormalizedMetricRecord[] = [];
    for (const [seriesIdx, r] of results.entries()) {
      const labels = this.extractLabels(r.metric);
      const service = labels["service"] || labels["job"] || labels["service_name"] || labels["instance"] || "unknown-service";
      const points = r.values || (r.value ? [r.value] : []);

      for (const [ptIdx, [sec, valStr]] of points.entries()) {
        const rawVal = parseFloat(valStr || "0");
        const normalizedValue = this.convertMetricValue(rawVal, metricType, query);

        records.push({
          id: `prom-range-${service}-${seriesIdx}-${ptIdx}`,
          provider: this.isCloud ? "GRAFANA_CLOUD" : "PROMETHEUS",
          serviceName: service,
          metricType,
          metricName: query,
          timestamp: new Date(sec * 1000).toISOString(),
          value: normalizedValue,
          unit: this.resolveUnit(metricType),
          labels,
          hasAnomaly: false,
        });
      }
    }
    return records;
  }

  private extractLabels(metric?: Record<string, string>): Record<string, string> {
    const labels: Record<string, string> = {};
    if (metric) {
      for (const [k, v] of Object.entries(metric)) {
        labels[k] = String(v);
      }
    }
    return labels;
  }

  private convertMetricValue(rawVal: number, metricType: NormalizedMetricRecord["metricType"], query: string): number {
    if (isNaN(rawVal)) return 0;
    // Latency metrics in Prometheus are recorded in seconds (http_request_duration_seconds).
    // Normalize consistently to milliseconds: seconds * 1000.
    if (metricType === "LATENCY_AVG" || metricType === "LATENCY_P95" || query.includes("duration_seconds")) {
      return Number((rawVal * 1000).toFixed(2));
    }
    return Number(rawVal.toFixed(2));
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

  /**
   * Evaluates service-level metrics with correct Prometheus counter and histogram mathematics:
   * - Request Rate: rate(http_requests_total[1m]) in req/s.
   * - Error Rate: (rate(http_request_errors_total[1m]) / rate(http_requests_total[1m])) * 100 in %.
   * - Latency: rate(duration_sum[1m]) / rate(duration_count[1m]) converted to ms.
   */
  public async getServiceMetrics(): Promise<Map<string, { latencyMs: number; errorRate: number; requestRate: number }>> {
    const results = new Map<string, { latencyMs: number; errorRate: number; requestRate: number }>();

    // 1. Ingest rate-windowed requests (req/sec)
    const requestRes = await this.queryInstantDetailed("rate(http_requests_total[1m])", "REQUEST_RATE");
    const fallbackRequests = requestRes.records.length > 0
      ? requestRes
      : await this.queryInstantDetailed("http_requests_total", "REQUEST_RATE");

    // 2. Ingest rate-windowed error count (errors/sec)
    const errorRes = await this.queryInstantDetailed("rate(http_request_errors_total[1m])", "ERROR_RATE");
    const fallbackErrors = errorRes.records.length > 0
      ? errorRes
      : await this.queryInstantDetailed("http_request_errors_total", "ERROR_RATE");

    // 3. Ingest average latency from histogram sum/count in ms
    const latencyHistogramRes = await this.queryInstantDetailed(
      "rate(http_request_duration_seconds_sum[1m]) / rate(http_request_duration_seconds_count[1m])",
      "LATENCY_AVG"
    );
    const latencyDetailed = latencyHistogramRes.records.length > 0
      ? latencyHistogramRes
      : await this.queryInstantDetailed("http_request_duration_seconds", "LATENCY_AVG");

    // Build raw request rate map
    const requestRates = new Map<string, number>();
    for (const r of fallbackRequests.records) {
      requestRates.set(r.serviceName, Math.max(0, r.value));
      const existing = results.get(r.serviceName) || { latencyMs: 0, errorRate: 0, requestRate: 0 };
      existing.requestRate = Math.round(r.value);
      results.set(r.serviceName, existing);
    }

    // Compute error percentage: (errorRate / requestRate) * 100
    for (const e of fallbackErrors.records) {
      const existing = results.get(e.serviceName) || { latencyMs: 0, errorRate: 0, requestRate: 0 };
      const reqRate = requestRates.get(e.serviceName) || 0;
      if (reqRate > 0) {
        const errorPercent = (e.value / reqRate) * 100;
        existing.errorRate = Number(Math.min(100, Math.max(0, errorPercent)).toFixed(2));
      } else {
        existing.errorRate = 0.0;
      }
      results.set(e.serviceName, existing);
    }

    // Set latency (converted to ms)
    for (const l of latencyDetailed.records) {
      const existing = results.get(l.serviceName) || { latencyMs: 0, errorRate: 0, requestRate: 0 };
      existing.latencyMs = Math.round(l.value);
      results.set(l.serviceName, existing);
    }

    return results;
  }
}

export const prometheusClient = new PrometheusClient();
