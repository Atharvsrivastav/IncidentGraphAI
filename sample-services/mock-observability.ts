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

export interface StoredObservation {
  serviceName: string;
  instance: string;
  timestampMs: number;
  latencyMs: number;
  isError: boolean;
  requestCount: number;
}

export interface HistogramBucketCount {
  le: string;
  bound: number;
  count: number;
}

export const PROMETHEUS_LATENCY_BUCKETS = [
  0.005, 0.010, 0.025, 0.050, 0.075, 0.100, 0.250, 0.500, 0.750, 1.000, 2.500, 5.000, 10.000, Infinity,
];
export const PROMETHEUS_LE_STRINGS = [
  "0.005", "0.010", "0.025", "0.050", "0.075", "0.100", "0.250", "0.500", "0.750", "1.000", "2.500", "5.000", "10.000", "+Inf",
];

export function computeHistogramBuckets(latenciesSec: number[]): HistogramBucketCount[] {
  const sorted = [...latenciesSec].sort((a, b) => a - b);
  const total = sorted.length;
  const result: HistogramBucketCount[] = [];

  for (let i = 0; i < PROMETHEUS_LATENCY_BUCKETS.length; i++) {
    const bound = PROMETHEUS_LATENCY_BUCKETS[i];
    const le = PROMETHEUS_LE_STRINGS[i];
    if (bound === Infinity) {
      result.push({ le, bound, count: total });
    } else {
      let count = 0;
      for (const lat of sorted) {
        if (lat <= bound) count++;
        else break;
      }
      result.push({ le, bound, count });
    }
  }
  return result;
}

export function calculateHistogramQuantile(q: number, buckets: HistogramBucketCount[]): number {
  if (buckets.length === 0) return 0;
  const infBucket = buckets.find((b) => b.bound === Infinity) || buckets[buckets.length - 1];
  const totalCount = infBucket.count;
  if (totalCount === 0) return 0;

  const rank = q * totalCount;

  let bucketIdx = 0;
  while (bucketIdx < buckets.length && buckets[bucketIdx].count < rank) {
    bucketIdx++;
  }
  if (bucketIdx >= buckets.length) {
    bucketIdx = buckets.length - 1;
  }

  const current = buckets[bucketIdx];
  const prevCount = bucketIdx === 0 ? 0 : buckets[bucketIdx - 1].count;
  const prevBound = bucketIdx === 0 ? 0 : buckets[bucketIdx - 1].bound;
  const currentBound = current.bound;

  if (currentBound === Infinity) {
    return prevBound;
  }
  if (current.count === prevCount) {
    return prevBound;
  }

  const fraction = (rank - prevCount) / (current.count - prevCount);
  const interpolated = prevBound + (currentBound - prevBound) * fraction;
  return Number(interpolated.toFixed(4));
}

class ObservabilityStore {
  private spans: StoredSpan[] = [];
  private observations: StoredObservation[] = [];

  constructor() {
    this.seedBaselineObservations();
  }

  public seedBaselineObservations() {
    this.observations = [];
    const nowMs = Date.now();
    const services = ["api-gateway", "order-service", "payment-service", "inventory-service"];

    // Seed 15 minutes of varying historical observations (now - 15m to now)
    // Every 15 seconds, generate observations for both inst-1 and inst-2
    for (let offsetSec = 900; offsetSec >= 0; offsetSec -= 15) {
      const tsMs = nowMs - offsetSec * 1000;

      for (const s of services) {
        // Vary latency and errors over time to produce realistic time-series variation:
        // Earlier traffic (offset 900-500s): calm, baseline latency ~25ms, 0 errors
        // Middle traffic (offset 500-200s): rising load, latency ~60ms
        // Recent traffic (offset 200-0s): spike, latency ~140ms for payment, error surge
        const isRecent = offsetSec < 240;
        const isMiddle = offsetSec >= 240 && offsetSec < 600;

        let baseLatency = 25;
        let isError = false;

        if (s === "payment-service") {
          baseLatency = isRecent ? 140 : (isMiddle ? 65 : 30);
          isError = isRecent && (offsetSec % 30 === 0);
        } else if (s === "order-service") {
          baseLatency = isRecent ? 95 : (isMiddle ? 45 : 28);
          isError = isRecent && (offsetSec % 45 === 0);
        } else if (s === "api-gateway") {
          baseLatency = isRecent ? 110 : 35;
          isError = isRecent && (offsetSec % 60 === 0);
        } else {
          baseLatency = isMiddle ? 40 : 20;
        }

        // Add instance 1
        this.observations.push({
          serviceName: s,
          instance: `${s}-inst-1`,
          timestampMs: tsMs,
          latencyMs: baseLatency + (offsetSec % 7),
          isError,
          requestCount: 5 + (offsetSec % 3),
        });

        // Add instance 2
        this.observations.push({
          serviceName: s,
          instance: `${s}-inst-2`,
          timestampMs: tsMs,
          latencyMs: baseLatency + (offsetSec % 5) + 2,
          isError,
          requestCount: 4 + (offsetSec % 4),
        });
      }
    }
  }

  public addObservation(obs: StoredObservation) {
    this.observations.push(obs);
    if (this.observations.length > 20000) this.observations.shift();
  }

  public addSpan(span: StoredSpan) {
    this.spans.unshift(span);
    if (this.spans.length > 2000) this.spans.pop();

    this.observations.push({
      serviceName: span.serviceName,
      instance: (span.attributes?.["service.instance.id"] as string) || `${span.serviceName}-inst-1`,
      timestampMs: Math.round(span.startTimeUnixNano / 1e6) || Date.now(),
      latencyMs: span.durationMs,
      isError: span.status.code === 2,
      requestCount: 1,
    });
    if (this.observations.length > 20000) this.observations.shift();
  }

  public getSpans(serviceName?: string, limit: number = 50): StoredSpan[] {
    if (!serviceName) return this.spans.slice(0, limit);
    return this.spans.filter((s) => s.serviceName === serviceName).slice(0, limit);
  }

  public getTrace(traceId: string): StoredSpan[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }

  public getObservations(serviceName?: string, startMs?: number, endMs?: number): StoredObservation[] {
    return this.observations.filter((o) => {
      if (serviceName && o.serviceName !== serviceName) return false;
      if (startMs !== undefined && o.timestampMs < startMs) return false;
      if (endMs !== undefined && o.timestampMs > endMs) return false;
      return true;
    });
  }

  public getMetricsSummary(serviceName: string, lookbackMinutes: number = 15) {
    const cutoff = Date.now() - lookbackMinutes * 60 * 1000;
    const filtered = this.observations.filter((m) => m.serviceName === serviceName && m.timestampMs >= cutoff);
    if (filtered.length === 0) {
      return { requestCount: 0, errorCount: 0, avgLatency: 0, p95Latency: 0, errorRate: 0 };
    }

    const totalRequests = filtered.reduce((acc, m) => acc + m.requestCount, 0);
    const totalErrors = filtered.filter((m) => m.isError).reduce((acc, m) => acc + m.requestCount, 0);
    const latenciesSec = filtered.map((m) => m.latencyMs / 1000);
    const avgLatency = Math.round(filtered.reduce((acc, m) => acc + m.latencyMs, 0) / filtered.length);
    const buckets = computeHistogramBuckets(latenciesSec);
    const p95Latency = Math.round(calculateHistogramQuantile(0.95, buckets) * 1000);
    const errorRate = totalRequests > 0 ? Number(((totalErrors / totalRequests) * 100).toFixed(2)) : 0;

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
    for (const o of this.observations) {
      if (o.serviceName) set.add(o.serviceName);
    }
    for (const s of this.spans) {
      if (s.serviceName) set.add(s.serviceName);
    }
    return Array.from(set);
  }

  public clear() {
    this.spans = [];
    this.observations = [];
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

export interface MockMatrixPoint {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

export function evaluateMockPromQl(query: string, nowSec: number): MockSeriesPoint[] | null {
  const q = query.trim();
  const rawServices = obsStore.getObservedServices();
  if (rawServices.length === 0) return [];

  const services = rawServices;
  const windowSec = 60;
  const wStart = (nowSec - windowSec) * 1000;
  const wEnd = nowSec * 1000;

  // Strict 1-minute lookback without falling back to stale observations
  const observationsInWindow = obsStore.getObservations(undefined, wStart, wEnd);
  if (q !== "up" && q !== "vector(1)" && observationsInWindow.length === 0) {
    return [];
  }

  const getObs = (s: string) => {
    return obsStore.getObservations(s, wStart, wEnd);
  };

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
      const obs = getObs(s);
      const totalReq = obs.reduce((sum, o) => sum + o.requestCount, 0);
      const rate = totalReq / windowSec;
      return { metric: { service: s }, value: [nowSec, String(Number(rate.toFixed(2)))] };
    });
  }
  if (q === "rate(http_requests_total[1m])") {
    const points: MockSeriesPoint[] = [];
    for (const s of services) {
      for (const inst of [`${s}-inst-1`, `${s}-inst-2`]) {
        const obs = getObs(s).filter((o) => o.instance === inst);
        const totalReq = obs.reduce((sum, o) => sum + o.requestCount, 0);
        const rate = totalReq / windowSec;
        points.push({ metric: { service: s, instance: inst }, value: [nowSec, String(Number(rate.toFixed(2)))] });
      }
    }
    return points;
  }

  // 3. Error rate
  if (q === "sum by (service) (rate(http_request_errors_total[1m]))") {
    return services.map((s) => {
      const obs = getObs(s);
      const errReq = obs.filter((o) => o.isError).reduce((sum, o) => sum + o.requestCount, 0);
      const rate = errReq / windowSec;
      return { metric: { service: s }, value: [nowSec, String(Number(rate.toFixed(2)))] };
    });
  }
  if (q === "rate(http_request_errors_total[1m])") {
    const points: MockSeriesPoint[] = [];
    for (const s of services) {
      for (const inst of [`${s}-inst-1`, `${s}-inst-2`]) {
        const obs = getObs(s).filter((o) => o.instance === inst);
        const errReq = obs.filter((o) => o.isError).reduce((sum, o) => sum + o.requestCount, 0);
        const rate = errReq / windowSec;
        points.push({ metric: { service: s, instance: inst }, value: [nowSec, String(Number(rate.toFixed(2)))] });
      }
    }
    return points;
  }

  // 4. Histogram sum/count average latency
  if (
    q === "sum by (service) (rate(http_request_duration_seconds_sum[1m])) / sum by (service) (rate(http_request_duration_seconds_count[1m]))" ||
    q === "rate(http_request_duration_seconds_sum[1m]) / rate(http_request_duration_seconds_count[1m])"
  ) {
    return services.map((s) => {
      const obs = getObs(s);
      const latObs = obs.filter((o) => o.latencyMs > 0);
      const totalReq = latObs.reduce((sum, o) => sum + o.requestCount, 0);
      const totalLatencyMs = latObs.reduce((sum, o) => sum + o.latencyMs * o.requestCount, 0);
      const avgLatencySec = totalReq > 0 ? totalLatencyMs / totalReq / 1000 : 0;
      return { metric: { service: s }, value: [nowSec, String(Number(avgLatencySec.toFixed(4)))] };
    });
  }

  if (q === "sum by (service) (rate(http_request_duration_seconds_sum[1m]))") {
    return services.map((s) => {
      const obs = getObs(s);
      const latObs = obs.filter((o) => o.latencyMs > 0);
      const sumSec = latObs.reduce((sum, o) => sum + (o.latencyMs / 1000) * o.requestCount, 0) / windowSec;
      return { metric: { service: s }, value: [nowSec, String(Number(sumSec.toFixed(4)))] };
    });
  }

  if (q === "sum by (service) (rate(http_request_duration_seconds_count[1m]))") {
    return services.map((s) => {
      const obs = getObs(s);
      const totalReq = obs.reduce((sum, o) => sum + o.requestCount, 0);
      const rate = totalReq / windowSec;
      return { metric: { service: s }, value: [nowSec, String(Number(rate.toFixed(2)))] };
    });
  }

  // 5. P95 Histogram Quantile
  if (q === "histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[1m])))") {
    return services.map((s) => {
      const obs = getObs(s);
      const inst1Obs = obs.filter((o) => o.instance === `${s}-inst-1`);
      const inst2Obs = obs.filter((o) => o.instance === `${s}-inst-2`);
      const b1 = computeHistogramBuckets(inst1Obs.map((o) => o.latencyMs / 1000));
      const b2 = computeHistogramBuckets(inst2Obs.map((o) => o.latencyMs / 1000));
      const aggBuckets: HistogramBucketCount[] = b1.map((bucket, idx) => ({
        le: bucket.le,
        bound: bucket.bound,
        count: bucket.count + (b2[idx]?.count || 0),
      }));
      const p95Sec = calculateHistogramQuantile(0.95, aggBuckets);
      return { metric: { service: s }, value: [nowSec, String(Number(p95Sec.toFixed(4)))] };
    });
  }

  // 6. Histogram buckets
  if (
    q === "sum by (le, service) (rate(http_request_duration_seconds_bucket[1m]))" ||
    q === "rate(http_request_duration_seconds_bucket[1m])"
  ) {
    const points: MockSeriesPoint[] = [];
    for (const s of services) {
      const obs = getObs(s);
      const inst1Obs = obs.filter((o) => o.instance === `${s}-inst-1`);
      const inst2Obs = obs.filter((o) => o.instance === `${s}-inst-2`);
      const b1 = computeHistogramBuckets(inst1Obs.map((o) => o.latencyMs / 1000));
      const b2 = computeHistogramBuckets(inst2Obs.map((o) => o.latencyMs / 1000));
      for (let idx = 0; idx < b1.length; idx++) {
        const count = b1[idx].count + (b2[idx]?.count || 0);
        points.push({ metric: { service: s, le: b1[idx].le }, value: [nowSec, String(count)] });
      }
    }
    return points;
  }

  // Unsupported expression
  return null;
}

export function evaluateMockPromQlRange(
  query: string,
  startSec: number,
  endSec: number,
  stepSec: number
): MockMatrixPoint[] | null {
  const q = query.trim();
  const rawServices = obsStore.getObservedServices();
  if (rawServices.length === 0) return [];

  // Check if there are any observations in the requested time range
  const observationsInRange = obsStore.getObservations(undefined, (startSec - 60) * 1000, endSec * 1000);
  if (observationsInRange.length === 0) {
    // If there is insufficient stored history in the range, represent that honestly
    return [];
  }

  const services = rawServices;
  const timestamps: number[] = [];
  for (let t = startSec; t <= endSec; t += stepSec) {
    timestamps.push(t);
  }

  // PromQL [1m] range vector specifies a fixed 60-second lookback window.
  // stepSec controls evaluation timestamps, NOT the 60s lookback window.
  const lookbackSec = 60;

  // 1. Health checks
  if (q === "up") {
    const results: MockMatrixPoint[] = [];
    for (const s of services) {
      results.push({
        metric: { service: s, instance: `${s}-inst-1` },
        values: timestamps.map((t) => [t, "1"]),
      });
      results.push({
        metric: { service: s, instance: `${s}-inst-2` },
        values: timestamps.map((t) => [t, "1"]),
      });
    }
    return results;
  }
  if (q === "vector(1)") {
    return [{ metric: {}, values: timestamps.map((t) => [t, "1"]) }];
  }

  // 2. Request rate: sum by (service) (rate(http_requests_total[1m]))
  if (q === "sum by (service) (rate(http_requests_total[1m]))") {
    return services.map((s) => {
      const values: Array<[number, string]> = timestamps.map((t) => {
        const obs = obsStore.getObservations(s, (t - lookbackSec) * 1000, t * 1000);
        const totalReq = obs.reduce((sum, o) => sum + o.requestCount, 0);
        const rate = totalReq / lookbackSec;
        return [t, String(Number(rate.toFixed(2)))];
      });
      return { metric: { service: s }, values };
    });
  }
  if (q === "rate(http_requests_total[1m])") {
    const results: MockMatrixPoint[] = [];
    for (const s of services) {
      for (const inst of [`${s}-inst-1`, `${s}-inst-2`]) {
        const values: Array<[number, string]> = timestamps.map((t) => {
          const obs = obsStore.getObservations(s, (t - lookbackSec) * 1000, t * 1000).filter((o) => o.instance === inst);
          const totalReq = obs.reduce((sum, o) => sum + o.requestCount, 0);
          const rate = totalReq / lookbackSec;
          return [t, String(Number(rate.toFixed(2)))];
        });
        results.push({ metric: { service: s, instance: inst }, values });
      }
    }
    return results;
  }

  // 3. Error rate: sum by (service) (rate(http_request_errors_total[1m]))
  if (q === "sum by (service) (rate(http_request_errors_total[1m]))") {
    return services.map((s) => {
      const values: Array<[number, string]> = timestamps.map((t) => {
        const obs = obsStore.getObservations(s, (t - lookbackSec) * 1000, t * 1000);
        const errReq = obs.filter((o) => o.isError).reduce((sum, o) => sum + o.requestCount, 0);
        const rate = errReq / lookbackSec;
        return [t, String(Number(rate.toFixed(2)))];
      });
      return { metric: { service: s }, values };
    });
  }
  if (q === "rate(http_request_errors_total[1m])") {
    const results: MockMatrixPoint[] = [];
    for (const s of services) {
      for (const inst of [`${s}-inst-1`, `${s}-inst-2`]) {
        const values: Array<[number, string]> = timestamps.map((t) => {
          const obs = obsStore.getObservations(s, (t - lookbackSec) * 1000, t * 1000).filter((o) => o.instance === inst);
          const errReq = obs.filter((o) => o.isError).reduce((sum, o) => sum + o.requestCount, 0);
          const rate = errReq / lookbackSec;
          return [t, String(Number(rate.toFixed(2)))];
        });
        results.push({ metric: { service: s, instance: inst }, values });
      }
    }
    return results;
  }

  // 4. Histogram sum/count average latency
  if (
    q === "sum by (service) (rate(http_request_duration_seconds_sum[1m])) / sum by (service) (rate(http_request_duration_seconds_count[1m]))" ||
    q === "rate(http_request_duration_seconds_sum[1m]) / rate(http_request_duration_seconds_count[1m])"
  ) {
    return services.map((s) => {
      const values: Array<[number, string]> = timestamps.map((t) => {
        const obs = obsStore.getObservations(s, (t - lookbackSec) * 1000, t * 1000);
        const latObs = obs.filter((o) => o.latencyMs > 0);
        const totalReq = latObs.reduce((sum, o) => sum + o.requestCount, 0);
        const totalLatencyMs = latObs.reduce((sum, o) => sum + o.latencyMs * o.requestCount, 0);
        const avgLatencySec = totalReq > 0 ? totalLatencyMs / totalReq / 1000 : 0;
        return [t, String(Number(avgLatencySec.toFixed(4)))];
      });
      return { metric: { service: s }, values };
    });
  }

  if (q === "sum by (service) (rate(http_request_duration_seconds_sum[1m]))") {
    return services.map((s) => {
      const values: Array<[number, string]> = timestamps.map((t) => {
        const obs = obsStore.getObservations(s, (t - lookbackSec) * 1000, t * 1000);
        const latObs = obs.filter((o) => o.latencyMs > 0);
        const sumSec = latObs.reduce((sum, o) => sum + (o.latencyMs / 1000) * o.requestCount, 0) / lookbackSec;
        return [t, String(Number(sumSec.toFixed(4)))];
      });
      return { metric: { service: s }, values };
    });
  }

  if (q === "sum by (service) (rate(http_request_duration_seconds_count[1m]))") {
    return services.map((s) => {
      const values: Array<[number, string]> = timestamps.map((t) => {
        const obs = obsStore.getObservations(s, (t - lookbackSec) * 1000, t * 1000);
        const totalReq = obs.reduce((sum, o) => sum + o.requestCount, 0);
        const rate = totalReq / lookbackSec;
        return [t, String(Number(rate.toFixed(2)))];
      });
      return { metric: { service: s }, values };
    });
  }

  // 5. P95 Histogram Quantile
  if (q === "histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[1m])))") {
    return services.map((s) => {
      const values: Array<[number, string]> = timestamps.map((t) => {
        const obs = obsStore.getObservations(s, (t - lookbackSec) * 1000, t * 1000);
        const inst1Obs = obs.filter((o) => o.instance === `${s}-inst-1`);
        const inst2Obs = obs.filter((o) => o.instance === `${s}-inst-2`);
        const b1 = computeHistogramBuckets(inst1Obs.map((o) => o.latencyMs / 1000));
        const b2 = computeHistogramBuckets(inst2Obs.map((o) => o.latencyMs / 1000));
        const aggBuckets: HistogramBucketCount[] = b1.map((bucket, idx) => ({
          le: bucket.le,
          bound: bucket.bound,
          count: bucket.count + (b2[idx]?.count || 0),
        }));
        const p95Sec = calculateHistogramQuantile(0.95, aggBuckets);
        return [t, String(Number(p95Sec.toFixed(4)))];
      });
      return { metric: { service: s }, values };
    });
  }

  // 6. Histogram buckets
  if (
    q === "sum by (le, service) (rate(http_request_duration_seconds_bucket[1m]))" ||
    q === "rate(http_request_duration_seconds_bucket[1m])"
  ) {
    const results: MockMatrixPoint[] = [];
    for (const s of services) {
      for (const le of PROMETHEUS_LE_STRINGS) {
        const values: Array<[number, string]> = timestamps.map((t) => {
          const obs = obsStore.getObservations(s, (t - lookbackSec) * 1000, t * 1000);
          const inst1Obs = obs.filter((o) => o.instance === `${s}-inst-1`);
          const inst2Obs = obs.filter((o) => o.instance === `${s}-inst-2`);
          const b1 = computeHistogramBuckets(inst1Obs.map((o) => o.latencyMs / 1000));
          const b2 = computeHistogramBuckets(inst2Obs.map((o) => o.latencyMs / 1000));
          const count1 = b1.find((b) => b.le === le)?.count || 0;
          const count2 = b2.find((b) => b.le === le)?.count || 0;
          return [t, String(count1 + count2)];
        });
        results.push({ metric: { service: s, le }, values });
      }
    }
    return results;
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

      const matrixResult = evaluateMockPromQlRange(query, startSec, endSec, stepSec);
      if (matrixResult === null) {
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
