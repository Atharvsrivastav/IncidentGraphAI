import http from "http";

export interface StoredSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  serviceName: string;
  startTimeUnixNano: number;
  endTimeUnixNano: number;
  durationMs: number;
  status: { code: number; message?: string };
  attributes: Record<string, unknown>;
}

export interface ServiceMetricRecord {
  serviceName: string;
  timestamp: number;
  latencyMs: number;
  errorCount: number;
  requestCount: number;
}

class ObservabilityStore {
  private spans: StoredSpan[] = [];
  private metrics: ServiceMetricRecord[] = [];

  public addSpan(span: StoredSpan) {
    this.spans.unshift(span);
    if (this.spans.length > 2000) this.spans.pop();

    // Derive metric aggregation point from real span
    this.metrics.push({
      serviceName: span.serviceName,
      timestamp: Date.now(),
      latencyMs: span.durationMs,
      errorCount: span.status.code === 2 ? 1 : 0,
      requestCount: 1,
    });
    if (this.metrics.length > 5000) this.metrics.shift();
  }

  public getSpans(serviceName?: string, limit: number = 50): StoredSpan[] {
    if (!serviceName) return this.spans.slice(0, limit);
    return this.spans.filter((s) => s.serviceName === serviceName).slice(0, limit);
  }

  public getTrace(traceId: string): StoredSpan[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }

  public getMetricsSummary(serviceName: string, lookbackMinutes: number = 15) {
    const cutoff = Date.now() - lookbackMinutes * 60 * 1000;
    const filtered = this.metrics.filter((m) => m.serviceName === serviceName && m.timestamp >= cutoff);
    if (filtered.length === 0) {
      return { requestCount: 0, errorCount: 0, avgLatency: 0, p95Latency: 0, errorRate: 0 };
    }

    const totalRequests = filtered.length;
    const totalErrors = filtered.reduce((acc, m) => acc + m.errorCount, 0);
    const latencies = filtered.map((m) => m.latencyMs).sort((a, b) => a - b);
    const avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    const p95Index = Math.floor(latencies.length * 0.95);
    const p95Latency = latencies[p95Index] || latencies[latencies.length - 1];
    const errorRate = Number(((totalErrors / totalRequests) * 100).toFixed(2));

    return {
      requestCount: totalRequests,
      errorCount: totalErrors,
      avgLatency,
      p95Latency,
      errorRate,
    };
  }

  public getObservedServices(): string[] {
    const set = new Set<string>();
    for (const s of this.spans) {
      if (s.serviceName) set.add(s.serviceName);
    }
    return Array.from(set);
  }

  public clear() {
    this.spans = [];
    this.metrics = [];
  }
}

export const obsStore = new ObservabilityStore();

// ----------------------------------------------------------------------
// 1. OTLP Receiver Server (Port 4318)
// Receives official OpenTelemetry OTLP JSON / Protobuf payloads
// ----------------------------------------------------------------------
export function startOtlpReceiver(port: number = 4318): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/traces") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const payload = JSON.parse(body);
        if (payload.resourceSpans) {
          for (const rs of payload.resourceSpans) {
            let serviceName = "unknown-service";
            const serviceAttr = rs.resource?.attributes?.find((a: { key: string; value: { stringValue?: string } }) => a.key === "service.name");
            if (serviceAttr?.value?.stringValue) {
              serviceName = serviceAttr.value.stringValue;
            }

            for (const scopeSpan of rs.scopeSpans || []) {
              for (const span of scopeSpan.spans || []) {
                const startNs = Number(span.startTimeUnixNano) || Date.now() * 1e6;
                const endNs = Number(span.endTimeUnixNano) || (startNs + 50 * 1e6);
                const durationMs = Math.max(1, Math.round((endNs - startNs) / 1e6));

                const attributes: Record<string, unknown> = {};
                for (const attr of span.attributes || []) {
                  attributes[attr.key] = attr.value?.stringValue ?? attr.value?.intValue ?? attr.value?.boolValue ?? attr.value;
                }

                obsStore.addSpan({
                  traceId: span.traceId,
                  spanId: span.spanId,
                  parentSpanId: span.parentSpanId,
                  name: span.name,
                  serviceName,
                  startTimeUnixNano: startNs,
                  endTimeUnixNano: endNs,
                  durationMs,
                  status: span.status || { code: 0 },
                  attributes,
                });
              }
            }
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ partialSuccess: {} }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid OTLP JSON: " + String(err) }));
      }
      return;
    }

    if (req.method === "POST" && req.url === "/v1/metrics") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ partialSuccess: {} }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "OTLP endpoint not found" }));
  });

  server.listen(port, () => {
    console.log(`[Observability] OTLP HTTP Receiver listening on http://localhost:${port}`);
  });
  return server;
}

export interface MockSeriesPoint {
  metric: Record<string, string>;
  value: [number, string];
}

export function evaluateMockPromQl(query: string, nowSec: number): MockSeriesPoint[] | null {
  const q = query.trim();
  const rawServices = obsStore.getObservedServices();
  const services = rawServices.length > 0 ? rawServices : ["api-gateway", "order-service", "payment-service", "inventory-service"];

  // 1. Health checks
  if (q === "up") {
    const points: MockSeriesPoint[] = [];
    for (const s of services) {
      points.push({ metric: { service: s, instance: `${s}-inst-1` }, value: [nowSec, "1"] });
      points.push({ metric: { service: s, instance: `${s}-inst-2` }, value: [nowSec, "1"] });
    }
    return points;
  }
  if (q === "vector(1)") {
    return [{ metric: {}, value: [nowSec, "1"] }];
  }

  // 2. Request rate
  if (q === "sum by (service) (rate(http_requests_total[1m]))") {
    return services.map((s) => {
      const stats = obsStore.getMetricsSummary(s, 15);
      const rate = Math.max(stats.requestCount * 10, 100);
      return { metric: { service: s }, value: [nowSec, String(rate.toFixed(1))] };
    });
  }
  if (q === "rate(http_requests_total[1m])") {
    const points: MockSeriesPoint[] = [];
    for (const s of services) {
      const stats = obsStore.getMetricsSummary(s, 15);
      const totalRate = Math.max(stats.requestCount * 10, 100);
      const halfRate = (totalRate / 2).toFixed(1);
      points.push({ metric: { service: s, instance: `${s}-inst-1` }, value: [nowSec, halfRate] });
      points.push({ metric: { service: s, instance: `${s}-inst-2` }, value: [nowSec, halfRate] });
    }
    return points;
  }

  // 3. Error rate
  if (q === "sum by (service) (rate(http_request_errors_total[1m]))") {
    return services.map((s) => {
      const stats = obsStore.getMetricsSummary(s, 15);
      const rate = stats.errorCount * 2;
      return { metric: { service: s }, value: [nowSec, String(rate.toFixed(1))] };
    });
  }
  if (q === "rate(http_request_errors_total[1m])") {
    const points: MockSeriesPoint[] = [];
    for (const s of services) {
      const stats = obsStore.getMetricsSummary(s, 15);
      const totalRate = stats.errorCount * 2;
      const halfRate = (totalRate / 2).toFixed(1);
      points.push({ metric: { service: s, instance: `${s}-inst-1` }, value: [nowSec, halfRate] });
      points.push({ metric: { service: s, instance: `${s}-inst-2` }, value: [nowSec, halfRate] });
    }
    return points;
  }

  // 4. Histogram sum/count average latency
  if (
    q === "sum by (service) (rate(http_request_duration_seconds_sum[1m])) / sum by (service) (rate(http_request_duration_seconds_count[1m]))" ||
    q === "rate(http_request_duration_seconds_sum[1m]) / rate(http_request_duration_seconds_count[1m])"
  ) {
    return services.map((s) => {
      const stats = obsStore.getMetricsSummary(s, 15);
      const latencySec = (stats.avgLatency || 35) / 1000;
      return { metric: { service: s }, value: [nowSec, String(latencySec.toFixed(4))] };
    });
  }

  if (q === "sum by (service) (rate(http_request_duration_seconds_sum[1m]))") {
    return services.map((s) => {
      const stats = obsStore.getMetricsSummary(s, 15);
      const sumSec = ((stats.avgLatency || 35) / 1000) * 100;
      return { metric: { service: s }, value: [nowSec, String(sumSec.toFixed(4))] };
    });
  }

  if (q === "sum by (service) (rate(http_request_duration_seconds_count[1m]))") {
    return services.map((s) => {
      return { metric: { service: s }, value: [nowSec, "100.0"] };
    });
  }

  // 5. P95 Histogram Quantile
  if (q === "histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[1m])))") {
    return services.map((s) => {
      const stats = obsStore.getMetricsSummary(s, 15);
      const p95Sec = (stats.p95Latency || 55) / 1000;
      return { metric: { service: s }, value: [nowSec, String(p95Sec.toFixed(4))] };
    });
  }

  // 6. Histogram buckets
  if (
    q === "sum by (le, service) (rate(http_request_duration_seconds_bucket[1m]))" ||
    q === "rate(http_request_duration_seconds_bucket[1m])"
  ) {
    const buckets = ["0.010", "0.025", "0.050", "0.100", "0.250", "0.500", "1.000", "+Inf"];
    const points: MockSeriesPoint[] = [];
    for (const s of services) {
      let cumulative = 10;
      for (const le of buckets) {
        cumulative += 15;
        points.push({ metric: { service: s, le }, value: [nowSec, String(cumulative)] });
      }
    }
    return points;
  }

  // Unsupported expression
  return null;
}

// ----------------------------------------------------------------------
// 2. Prometheus Query API Server (Port 9090)
// Supports /api/v1/query and /api/v1/query_range
// ----------------------------------------------------------------------
export function startPrometheusServer(port: number = 9090): http.Server {
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Observability-Provider", "mock-observability-server");
    res.setHeader("X-Observability-Type", "MOCK_EMULATION");

    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/v1/status/provider") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        provider: "mock-observability-server",
        type: "MOCK_EMULATION",
        isGenuine: false,
        warning: "This is a local in-process development mock, NOT a genuine Docker Prometheus instance.",
      }));
      return;
    }

    if (url.pathname === "/-/healthy" || url.pathname === "/-/ready") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Prometheus Mock Server is Ready (MOCK_EMULATION).");
      return;
    }

    if (url.pathname === "/api/v1/query") {
      const query = url.searchParams.get("query") || "";
      const nowSec = Math.floor(Date.now() / 1000);
      const evaluated = evaluateMockPromQl(query, nowSec);

      if (!evaluated) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "error",
          errorType: "bad_data",
          error: `Unsupported PromQL expression in mock observability server: ${query}`,
        }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "success",
        data: {
          resultType: "vector",
          result: evaluated,
        },
      }));
      return;
    }

    if (url.pathname === "/api/v1/query_range") {
      const query = url.searchParams.get("query") || "";
      const startSec = Number(url.searchParams.get("start"));
      const endSec = Number(url.searchParams.get("end"));
      const stepSec = Number(url.searchParams.get("step"));

      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || !Number.isFinite(stepSec) || startSec >= endSec || stepSec <= 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "error",
          errorType: "bad_data",
          error: "Invalid range query parameters (start, end, step)",
        }));
        return;
      }

      const evaluated = evaluateMockPromQl(query, endSec);
      if (!evaluated) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "error",
          errorType: "bad_data",
          error: `Unsupported PromQL expression in mock observability server: ${query}`,
        }));
        return;
      }

      const matrixResult = evaluated.map((item) => {
        const values: Array<[number, string]> = [];
        for (let t = startSec; t <= endSec; t += stepSec) {
          values.push([t, item.value[1]]);
        }
        return {
          metric: item.metric,
          values,
        };
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "success",
        data: {
          resultType: "matrix",
          result: matrixResult,
        },
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "error", errorType: "bad_data", error: "Not found" }));
  });

  server.listen(port, () => {
    console.log(`[Observability] Prometheus Query API listening on http://localhost:${port}`);
  });
  return server;
}

// ----------------------------------------------------------------------
// 3. Jaeger Query API Server (Port 16686)
// Supports /api/traces and /api/traces/{traceId}
// ----------------------------------------------------------------------
export function startJaegerServer(port: number = 16686): http.Server {
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Observability-Provider", "mock-observability-server");
    res.setHeader("X-Observability-Type", "MOCK_EMULATION");

    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/v1/status/provider") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        provider: "mock-observability-server",
        type: "MOCK_EMULATION",
        isGenuine: false,
        warning: "This is a local in-process development mock, NOT a genuine Docker Jaeger instance.",
      }));
      return;
    }

    if (url.pathname === "/api/traces") {
      const service = url.searchParams.get("service");
      const limit = Number(url.searchParams.get("limit")) || 20;
      const spans = obsStore.getSpans(service || undefined, limit * 5);

      // Group by traceId
      const traceMap = new Map<string, StoredSpan[]>();
      for (const span of spans) {
        const list = traceMap.get(span.traceId) || [];
        list.push(span);
        traceMap.set(span.traceId, list);
      }

      const traces = Array.from(traceMap.entries()).slice(0, limit).map(([traceId, spanList]) => ({
        traceID: traceId,
        spans: spanList.map((s) => ({
          traceID: s.traceId,
          spanID: s.spanId,
          operationName: s.name,
          references: s.parentSpanId
            ? [{ refType: "CHILD_OF", traceID: s.traceId, spanID: s.parentSpanId }]
            : [],
          startTime: s.startTimeUnixNano / 1000, // Jaeger uses microseconds
          duration: s.durationMs * 1000,
          tags: [
            { key: "service.name", type: "string", value: s.serviceName },
            { key: "error", type: "bool", value: s.status.code === 2 },
            ...Object.entries(s.attributes).map(([k, v]) => ({ key: k, type: typeof v, value: v })),
          ],
          process: { serviceName: s.serviceName },
        })),
        processes: Object.fromEntries(
          Array.from(new Set(spanList.map((s) => s.serviceName))).map((s) => [s, { serviceName: s }])
        ),
      }));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: traces, total: traces.length }));
      return;
    }

    if (url.pathname.startsWith("/api/traces/")) {
      const traceId = url.pathname.replace("/api/traces/", "");
      const spans = obsStore.getTrace(traceId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: spans.length > 0 ? [{
          traceID: traceId,
          spans: spans.map((s) => ({
            traceID: s.traceId,
            spanID: s.spanId,
            operationName: s.name,
            references: s.parentSpanId
              ? [{ refType: "CHILD_OF", traceID: s.traceId, spanID: s.parentSpanId }]
              : [],
            startTime: s.startTimeUnixNano / 1000,
            duration: s.durationMs * 1000,
            tags: [
              { key: "service.name", type: "string", value: s.serviceName },
              { key: "error", type: "bool", value: s.status.code === 2 },
              ...Object.entries(s.attributes).map(([k, v]) => ({ key: k, type: typeof v, value: v })),
            ],
            process: { serviceName: s.serviceName },
          })),
        }] : [],
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Jaeger endpoint not found" }));
  });

  server.listen(port, () => {
    console.log(`[Observability] Jaeger Query API listening on http://localhost:${port}`);
  });
  return server;
}
