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

export interface ServiceMetricsSummary {
  serviceName: string;
  latencyMs: number;
  hasValidLatency?: boolean;
  latencyP95Ms?: number;
  hasValidP95: boolean;
  errorRate: number; // 0 - 100%
  hasValidErrorRate?: boolean;
  requestRate: number; // req/sec
  hasValidRequestRate?: boolean;
  instanceCount: number;
}

export interface ServiceHistoryPoint {
  timestamp: string;
  latencyMs: number;
  hasValidLatency?: boolean;
  latencyP95Ms?: number;
  errorRate: number;
  hasValidErrorRate?: boolean;
  requestRate: number;
  hasValidRequestRate?: boolean;
}

export interface ServiceMetricsDetailedResult {
  success: boolean;
  metrics: Map<string, ServiceMetricsSummary>;
  diagnostics: ProviderDiagnostic[];
  p95Supported: boolean;
}

export interface ServiceMetricsHistoryResult {
  success: boolean;
  historyByService: Map<string, ServiceHistoryPoint[]>;
  records: NormalizedMetricRecord[];
  diagnostics: ProviderDiagnostic[];
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
      const isTimeout = latencyMs >= this.timeoutMs || controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
      const errorCode: TelemetryErrorCode = isTimeout ? "TIMEOUT" : "UNAVAILABLE";
      return this.createFailureResult(latencyMs, nowIso, errorCode, isTimeout ? `Range query timed out after ${this.timeoutMs}ms` : "Network request failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  private validateRangeParams(startSec: number, endSec: number, stepSec: number): string | null {
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || !Number.isFinite(stepSec)) {
      return "Range query parameters (start, end, step) must be finite numbers";
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
    // Prometheus range query with inclusive endpoints: floor((end - start) / step) + 1 points
    const pointCount = Math.floor((endSec - startSec) / stepSec) + 1;
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
        metricName: labels["__name__"] || query,
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
          metricName: labels["__name__"] || query,
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
      case "ERROR_THROUGHPUT":
        return "errors/s";
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
   * Evaluates service-level metrics with strict PromQL semantics and multi-instance aggregation:
   * 1. Request Rate: sum by (service) (rate(http_requests_total[1m]))
   * 2. Error Rate: sum by (service) (rate(http_request_errors_total[1m]))
   * 3. Average Latency: sum by (service) (rate(http_request_duration_seconds_sum[1m])) / sum by (service) (rate(http_request_duration_seconds_count[1m]))
   * 4. P95 Latency: histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[1m])))
   *
   * Zero fallbacks to cumulative counters.
   * Multi-instance series are summed across instances before percentage / latency calculations.
   */
  public async getServiceMetricsDetailed(): Promise<ServiceMetricsDetailedResult> {
    const diagnostics: ProviderDiagnostic[] = [];

    // Execute the 4 required PromQL queries in parallel
    const [requestRes, errorRes, latencyAvgRes, p95Res] = await Promise.all([
      this.queryInstantDetailed("sum by (service) (rate(http_requests_total[1m]))", "REQUEST_RATE"),
      this.queryInstantDetailed("sum by (service) (rate(http_request_errors_total[1m]))", "ERROR_THROUGHPUT"),
      this.queryInstantDetailed(
        "sum by (service) (rate(http_request_duration_seconds_sum[1m])) / sum by (service) (rate(http_request_duration_seconds_count[1m]))",
        "LATENCY_AVG"
      ),
      this.queryInstantDetailed(
        "histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[1m])))",
        "LATENCY_P95"
      ),
    ]);

    diagnostics.push(requestRes.diagnostic, errorRes.diagnostic, latencyAvgRes.diagnostic, p95Res.diagnostic);

    // If any required query failed, report failure and do NOT substitute raw counters or pretend healthy
    // Treat P95 availability separately only when the provider genuinely does not expose histogram buckets (p95Res.success is true but records is empty)
    // A failed P95 HTTP request (p95Res.success is false) must not silently become an unsupported-but-healthy result.
    if (!requestRes.success || !errorRes.success || !latencyAvgRes.success || !p95Res.success) {
      return {
        success: false,
        metrics: new Map(),
        diagnostics,
        p95Supported: false,
      };
    }

    // 1. Accumulate request rates across instances per service
    const requestRatesByService = new Map<string, { totalRate: number; instanceCount: number }>();
    for (const r of requestRes.records) {
      const existing = requestRatesByService.get(r.serviceName) || { totalRate: 0, instanceCount: 0 };
      existing.totalRate += Math.max(0, r.value);
      existing.instanceCount += 1;
      requestRatesByService.set(r.serviceName, existing);
    }

    // 2. Accumulate error counter rates across instances per service
    const errorRatesByService = new Map<string, number>();
    for (const e of errorRes.records) {
      const current = errorRatesByService.get(e.serviceName) || 0;
      errorRatesByService.set(e.serviceName, current + Math.max(0, e.value));
    }

    // 3. Accumulate average latencies across instances per service
    const latencyAvgByService = new Map<string, { sumMs: number; count: number }>();
    for (const l of latencyAvgRes.records) {
      const existing = latencyAvgByService.get(l.serviceName) || { sumMs: 0, count: 0 };
      existing.sumMs += Math.max(0, l.value);
      existing.count += 1;
      latencyAvgByService.set(l.serviceName, existing);
    }

    // 4. Map P95 latencies per service
    const p95ByService = new Map<string, number>();
    let p95Supported = false;
    if (p95Res.records.length > 0) {
      p95Supported = true;
      for (const p of p95Res.records) {
        if (!isNaN(p.value) && p.value > 0) {
          const current = p95ByService.get(p.serviceName);
          p95ByService.set(p.serviceName, current !== undefined ? Math.max(current, p.value) : p.value);
        }
      }
    }

    const results = new Map<string, ServiceMetricsSummary>();
    const allServices = new Set([
      ...requestRatesByService.keys(),
      ...errorRatesByService.keys(),
      ...latencyAvgByService.keys(),
    ]);

    for (const svc of allServices) {
      const hasReq = requestRatesByService.has(svc);
      const hasErr = errorRatesByService.has(svc);
      const hasLat = latencyAvgByService.has(svc);

      const reqData = requestRatesByService.get(svc);
      const errRate = errorRatesByService.get(svc);
      const latData = latencyAvgByService.get(svc);
      const p95Val = p95ByService.get(svc);

      const requestRate = reqData?.totalRate ?? 0;
      const hasValidRequestRate = hasReq;

      // Safe error rate percentage: only when BOTH request rate and error throughput series are present
      // If error metric is missing (absent instrumentation) or request metric is missing: NOT valid!
      let errorRate = 0;
      let hasValidErrorRate = false;

      if (hasReq && hasErr && reqData !== undefined && errRate !== undefined) {
        if (reqData.totalRate > 0) {
          const rawPct = (errRate / reqData.totalRate) * 100;
          if (Number.isFinite(rawPct)) {
            errorRate = Number(Math.min(100, Math.max(0, rawPct)).toFixed(2));
            hasValidErrorRate = true;
          }
        } else {
          // Zero request volume: explicit no-traffic condition, not a fabricated healthy measurement
          hasValidErrorRate = false;
        }
      }

      // Latency is in milliseconds (converted from seconds exactly once)
      let latencyMs = 0;
      let hasValidLatency = false;
      if (hasLat && latData !== undefined && latData.count > 0) {
        latencyMs = Number((latData.sumMs / latData.count).toFixed(2));
        hasValidLatency = true;
      }

      const hasValidP95 = p95Val !== undefined && !isNaN(p95Val) && p95Val > 0;

      results.set(svc, {
        serviceName: svc,
        requestRate,
        hasValidRequestRate,
        errorRate,
        hasValidErrorRate,
        latencyMs,
        hasValidLatency,
        latencyP95Ms: hasValidP95 ? Number(p95Val!.toFixed(2)) : undefined,
        hasValidP95,
        instanceCount: reqData?.instanceCount || 1,
      });
    }

    return {
      success: true,
      metrics: results,
      diagnostics,
      p95Supported,
    };
  }

  public async getServiceMetrics(): Promise<Map<string, ServiceMetricsSummary>> {
    const detailed = await this.getServiceMetricsDetailed();
    return detailed.metrics;
  }

  /**
   * Collects bounded range history using Prometheus /api/v1/query_range across all 4 key metric queries.
   * Preserves timestamps, validates parameter bounds, and correlates historical series per service.
   */
  public async getServiceMetricsHistory(options?: {
    lookbackSec?: number;
    stepSec?: number;
  }): Promise<ServiceMetricsHistoryResult> {
    const lookbackSec = options?.lookbackSec ?? 300; // default 5 minutes
    const stepSec = options?.stepSec ?? 60; // default 60s
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - lookbackSec;
    const endSec = nowSec;

    const [reqRange, errRange, latRange, p95Range] = await Promise.all([
      this.queryRange({
        query: "sum by (service) (rate(http_requests_total[1m]))",
        startSec,
        endSec,
        stepSec,
        metricType: "REQUEST_RATE",
      }),
      this.queryRange({
        query: "sum by (service) (rate(http_request_errors_total[1m]))",
        startSec,
        endSec,
        stepSec,
        metricType: "ERROR_THROUGHPUT",
      }),
      this.queryRange({
        query: "sum by (service) (rate(http_request_duration_seconds_sum[1m])) / sum by (service) (rate(http_request_duration_seconds_count[1m]))",
        startSec,
        endSec,
        stepSec,
        metricType: "LATENCY_AVG",
      }),
      this.queryRange({
        query: "histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[1m])))",
        startSec,
        endSec,
        stepSec,
        metricType: "LATENCY_P95",
      }),
    ]);

    const diagnostics = [reqRange.diagnostic, errRange.diagnostic, latRange.diagnostic, p95Range.diagnostic];

    // Track success independently for every required query.
    // If any required range query fails, return success: false and preserve diagnostics.
    if (!reqRange.success || !errRange.success || !latRange.success || !p95Range.success) {
      return {
        success: false,
        historyByService: new Map(),
        records: [
          ...reqRange.records,
          ...errRange.records,
          ...latRange.records,
          ...p95Range.records,
        ],
        diagnostics,
      };
    }

    // Group historical points by service and timestamp
    const historyMap = new Map<string, Map<string, ServiceHistoryPoint>>();

    const getOrCreatePoint = (service: string, timestamp: string): ServiceHistoryPoint => {
      let svcMap = historyMap.get(service);
      if (!svcMap) {
        svcMap = new Map();
        historyMap.set(service, svcMap);
      }
      let pt = svcMap.get(timestamp);
      if (!pt) {
        pt = {
          timestamp,
          latencyMs: 0,
          errorRate: 0,
          requestRate: 0,
          hasValidLatency: false,
          hasValidErrorRate: false,
          hasValidRequestRate: false,
        };
        svcMap.set(timestamp, pt);
      }
      return pt;
    };

    // Index request and error records by serviceName and timestamp
    const reqByServiceTime = new Map<string, NormalizedMetricRecord>();
    for (const r of reqRange.records) {
      reqByServiceTime.set(`${r.serviceName}::${r.timestamp}`, r);
    }
    const errByServiceTime = new Map<string, NormalizedMetricRecord>();
    for (const e of errRange.records) {
      errByServiceTime.set(`${e.serviceName}::${e.timestamp}`, e);
    }

    // 1. Request rate with full numeric precision (no premature Math.round)
    for (const r of reqRange.records) {
      const pt = getOrCreatePoint(r.serviceName, r.timestamp);
      pt.requestRate = r.value;
      pt.hasValidRequestRate = true;
    }

    // 2. Error rate percentage: only when BOTH request rate and error throughput exist and request volume > 0
    for (const e of errRange.records) {
      const pt = getOrCreatePoint(e.serviceName, e.timestamp);
      const reqRec = reqByServiceTime.get(`${e.serviceName}::${e.timestamp}`);
      if (reqRec && reqRec.value > 0) {
        const rawPct = (e.value / reqRec.value) * 100;
        pt.errorRate = Number.isFinite(rawPct)
          ? Number(Math.min(100, Math.max(0, rawPct)).toFixed(2))
          : 0;
        pt.hasValidErrorRate = true;
      } else {
        // Zero request traffic or missing request rate: do not fabricate healthy 0%
        pt.hasValidErrorRate = false;
      }
    }

    // 3. Average latency
    for (const l of latRange.records) {
      const pt = getOrCreatePoint(l.serviceName, l.timestamp);
      pt.latencyMs = Number(l.value.toFixed(2));
      pt.hasValidLatency = true;
    }

    // 4. P95 latency
    for (const p of p95Range.records) {
      const pt = getOrCreatePoint(p.serviceName, p.timestamp);
      if (!isNaN(p.value) && p.value > 0) {
        pt.latencyP95Ms = Number(p.value.toFixed(2));
      }
    }

    // 5. Generate normalized ERROR_RATE percentage records matching by (serviceName, timestamp)
    // Generate ERROR_RATE ONLY when both required observations are available and matched.
    // Do not silently create a 0% result from missing error throughput.
    // Treat zero request volume as an explicit no-traffic condition rather than a fabricated healthy measurement.

    const calculatedErrorRateRecords: NormalizedMetricRecord[] = [];

    for (const [key, reqRec] of reqByServiceTime.entries()) {
      const errRec = errByServiceTime.get(key);
      if (!errRec) {
        // Missing error series / absent error instrumentation -> do NOT generate ERROR_RATE
        continue;
      }

      const [serviceName, timestamp] = key.split("::");
      const reqPerSec = reqRec.value;
      const errPerSec = errRec.value;

      // Treat zero request volume as an explicit no-traffic condition rather than a fabricated healthy measurement
      if (reqPerSec <= 0) {
        continue;
      }

      // Both observations valid and traffic > 0:
      // If errPerSec === 0, errorPercentage is genuinely 0.0%
      // If errPerSec > 0, calculate percentage
      const rawPct = (errPerSec / reqPerSec) * 100;
      const errorPercentage = Number.isFinite(rawPct)
        ? Number(Math.min(100, Math.max(0, rawPct)).toFixed(2))
        : 0;

      const provider = reqRec.provider || errRec.provider || (this.isCloud ? "GRAFANA_CLOUD" : "PROMETHEUS");
      const labels = { ...(reqRec.labels || {}), ...(errRec.labels || {}) };

      calculatedErrorRateRecords.push({
        id: `prom-calc-error-rate-${serviceName}-${timestamp}`,
        provider,
        serviceName,
        metricType: "ERROR_RATE",
        metricName: "http_request_error_percentage",
        timestamp,
        value: errorPercentage,
        unit: "%",
        labels,
        hasAnomaly: errorPercentage > 5,
      });
    }

    const allRecords: NormalizedMetricRecord[] = [
      ...reqRange.records,
      ...errRange.records,
      ...calculatedErrorRateRecords,
      ...latRange.records,
      ...p95Range.records,
    ];

    const historyByService = new Map<string, ServiceHistoryPoint[]>();
    for (const [svc, ptsMap] of historyMap.entries()) {
      const sortedPts = Array.from(ptsMap.values()).sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      historyByService.set(svc, sortedPts);
    }

    return {
      success: true,
      historyByService,
      records: allRecords,
      diagnostics,
    };
  }
}

export const prometheusClient = new PrometheusClient();
