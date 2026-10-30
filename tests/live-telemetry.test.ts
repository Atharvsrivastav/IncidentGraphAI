import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PrometheusClient } from "../src/lib/telemetry/prometheusClient";
import { JaegerClient } from "../src/lib/telemetry/jaegerClient";
import { TelemetryManager } from "../src/lib/telemetry/telemetryManager";
import {
  validateMetricRecord,
  validateTraceSpan,
  validateTelemetryBatch,
  NormalizedMetricRecord,
  NormalizedTraceSpan,
} from "../src/lib/telemetry/normalization";
import {
  createMultiServiceGraph,
  buildMultiServiceIncidentScenario,
  analyzeMultiServiceIncident,
  buildFailureTrace,
  buildHealthyTrace,
} from "../src/lib/telemetry/multiServiceIncident";
import { RootCauseEngine } from "../src/lib/algorithms/rootCauseEngine";
import { TelemetryPoint } from "../src/lib/algorithms/types";

describe("Phase 6: Live Telemetry Ingestion & Multi-Service RCA Suite", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // =========================================================================
  // 1. Prometheus / Grafana Cloud Metrics Ingestion & Diagnostics
  // =========================================================================
  describe("Prometheus Metrics Ingestion", () => {
    it("successfully queries instant metrics and normalizes seconds to milliseconds consistently", async () => {
      const mockPromPayload = {
        status: "success",
        data: {
          resultType: "vector",
          result: [
            {
              metric: { service: "order-service", env: "production", job: "order-api" },
              value: [1730000000, "0.045"], // 0.045 seconds
            },
            {
              metric: { service: "payment-service", env: "production", job: "payment-api" },
              value: [1730000000, "0.120"], // 0.120 seconds
            },
          ],
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => mockPromPayload,
      } as unknown as Response);

      const client = new PrometheusClient("http://mock-prometheus:9090", 2000);
      const detailed = await client.queryInstantDetailed("http_request_duration_seconds", "LATENCY_AVG");

      expect(detailed.success).toBe(true);
      expect(detailed.diagnostic.status).toBe("OK");
      expect(detailed.records.length).toBe(2);

      const orderMetric = detailed.records.find((r) => r.serviceName === "order-service");
      expect(orderMetric).toBeDefined();
      // 0.045 seconds MUST be converted to 45 milliseconds
      expect(orderMetric?.value).toBe(45);
      expect(orderMetric?.unit).toBe("ms");
      expect(orderMetric?.labels["env"]).toBe("production");

      const paymentMetric = detailed.records.find((r) => r.serviceName === "payment-service");
      expect(paymentMetric).toBeDefined();
      // 0.120 seconds MUST be converted to 120 milliseconds
      expect(paymentMetric?.value).toBe(120);
      expect(paymentMetric?.unit).toBe("ms");
    });

    it("evaluates service-level metrics with rate math, histogram latency derivation, and error percentage", async () => {
      // Mock Prometheus responses for the 3 sequential PromQL queries in getServiceMetrics()
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("rate(http_requests_total[1m])")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                result: [
                  { metric: { service: "order-service" }, value: [1730000000, "250.0"] },
                  { metric: { service: "zero-traffic-service" }, value: [1730000000, "0.0"] },
                ],
              },
            }),
          } as unknown as Response);
        }
        if (decoded.includes("rate(http_request_errors_total[1m])")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                result: [
                  { metric: { service: "order-service" }, value: [1730000000, "12.5"] },
                  { metric: { service: "zero-traffic-service" }, value: [1730000000, "0.0"] },
                ],
              },
            }),
          } as unknown as Response);
        }
        if (decoded.includes("duration_seconds_sum")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                result: [
                  // Sum / Count in seconds: 0.035 seconds
                  { metric: { service: "order-service" }, value: [1730000000, "0.035"] },
                  { metric: { service: "zero-traffic-service" }, value: [1730000000, "0.000"] },
                ],
              },
            }),
          } as unknown as Response);
        }

        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ status: "success", data: { result: [] } }),
        } as unknown as Response);
      });

      const client = new PrometheusClient("http://mock-prometheus:9090", 2000);
      const metricsMap = await client.getServiceMetrics();

      expect(metricsMap.size).toBe(2);

      const orderMetrics = metricsMap.get("order-service");
      expect(orderMetrics).toBeDefined();
      expect(orderMetrics?.requestRate).toBe(250); // 250 req/s
      // Error % = (12.5 / 250) * 100 = 5.0%
      expect(orderMetrics?.errorRate).toBe(5);
      // Latency derived from sum/count and converted to ms: 0.035s * 1000 = 35ms
      expect(orderMetrics?.latencyMs).toBe(35);

      const zeroTrafficMetrics = metricsMap.get("zero-traffic-service");
      expect(zeroTrafficMetrics).toBeDefined();
      expect(zeroTrafficMetrics?.requestRate).toBe(0);
      // Safe zero division handling: must yield 0.0% instead of NaN or Infinity
      expect(zeroTrafficMetrics?.errorRate).toBe(0);
      expect(zeroTrafficMetrics?.latencyMs).toBe(0);
    });

    it("executes bounded Prometheus range queries (/api/v1/query_range) and normalizes matrix points", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const startSec = nowSec - 300; // 5 min ago
      const endSec = nowSec;
      const stepSec = 60; // 1 min steps

      const mockMatrixPayload = {
        status: "success",
        data: {
          resultType: "matrix",
          result: [
            {
              metric: { service: "order-service", instance: "order-1" },
              values: [
                [startSec, "0.040"],
                [startSec + 60, "0.045"],
                [startSec + 120, "0.050"],
              ],
            },
          ],
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => mockMatrixPayload,
      } as unknown as Response);

      const client = new PrometheusClient("http://mock-prometheus:9090", 2000);
      const detailed = await client.queryRange({
        query: "http_request_duration_seconds",
        startSec,
        endSec,
        stepSec,
        metricType: "LATENCY_AVG",
      });

      expect(detailed.success).toBe(true);
      expect(detailed.diagnostic.status).toBe("OK");
      expect(detailed.records.length).toBe(3);

      // Verify each point normalized to ms
      expect(detailed.records[0].value).toBe(40); // 0.040s -> 40ms
      expect(detailed.records[0].unit).toBe("ms");
      expect(detailed.records[1].value).toBe(45); // 0.045s -> 45ms
      expect(detailed.records[2].value).toBe(50); // 0.050s -> 50ms
    });

    it("validates range query bounds: rejects invalid ranges, negative steps, lookback > 24h, and excessive points", async () => {
      const client = new PrometheusClient("http://mock-prometheus:9090", 1000);

      // 1. start >= end
      const invalidRange = await client.queryRange({
        query: "up",
        startSec: 2000,
        endSec: 1000,
        stepSec: 10,
      });
      expect(invalidRange.success).toBe(false);
      expect(invalidRange.diagnostic.errorCode).toBe("BAD_REQUEST");
      expect(invalidRange.diagnostic.message).toContain("must be strictly less than end");

      // 2. step <= 0
      const invalidStep = await client.queryRange({
        query: "up",
        startSec: 1000,
        endSec: 2000,
        stepSec: 0,
      });
      expect(invalidStep.success).toBe(false);
      expect(invalidStep.diagnostic.message).toContain("must be greater than 0");

      // 3. Lookback > 24h (86400s)
      const excessiveLookback = await client.queryRange({
        query: "up",
        startSec: 1000,
        endSec: 1000 + 86401,
        stepSec: 60,
      });
      expect(excessiveLookback.success).toBe(false);
      expect(excessiveLookback.diagnostic.message).toContain("exceeds maximum permitted lookback");

      // 4. Excessive point count > 11,000 points
      const excessivePoints = await client.queryRange({
        query: "up",
        startSec: 0,
        endSec: 12000,
        stepSec: 1, // 12,000 points > 11,000 limit
      });
      expect(excessivePoints.success).toBe(false);
      expect(excessivePoints.diagnostic.message).toContain("exceeds standard point limit");
    });

    it("enforces timeout covering response-body parsing rather than headers alone", async () => {
      // Mock fetch where headers return immediately 200 OK, but res.json() hangs until aborted
      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => {
            return new Promise((_, reject) => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              setTimeout(() => reject(err), 60);
            });
          },
        } as unknown as Response);
      });

      const client = new PrometheusClient("http://mock-prometheus:9090", 30);
      const detailed = await client.queryInstantDetailed("up");

      expect(detailed.success).toBe(false);
      expect(detailed.diagnostic.errorCode).toBe("TIMEOUT");
      expect(detailed.diagnostic.message).toContain("timed out");
    });

    it("handles 401 authentication failure with typed AUTH_FAILURE and zero secret leakage", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: new Headers(),
        text: async () => "Invalid API key or token",
      } as unknown as Response);

      const client = new PrometheusClient("https://prometheus-us-central1.grafana.net/api/prom", 1000);
      const detailed = await client.queryInstantDetailed("up");

      expect(detailed.success).toBe(false);
      expect(detailed.diagnostic.status).toBe("ERROR");
      expect(detailed.diagnostic.errorCode).toBe("AUTH_FAILURE");
      expect(detailed.diagnostic.message).toContain("401");
      // Credentials must never appear in diagnostics
      expect(detailed.diagnostic.message).not.toContain("Bearer");
      expect(detailed.diagnostic.message).not.toContain("Basic");
    });

    it("handles 429 rate limiting with typed RATE_LIMITED error code", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({ "retry-after": "30" }),
      } as unknown as Response);

      const client = new PrometheusClient("http://mock-prometheus:9090", 1000);
      const detailed = await client.queryInstantDetailed("http_requests_total", "REQUEST_RATE");

      expect(detailed.success).toBe(false);
      expect(detailed.diagnostic.errorCode).toBe("RATE_LIMITED");
      expect(detailed.records).toEqual([]);
    });

    it("handles request timeout with typed TIMEOUT diagnostic", async () => {
      global.fetch = vi.fn().mockImplementation(() => {
        return new Promise((_, reject) => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          setTimeout(() => reject(err), 50);
        });
      });

      const client = new PrometheusClient("http://mock-prometheus:9090", 25);
      const detailed = await client.queryInstantDetailed("up");

      expect(detailed.success).toBe(false);
      expect(detailed.diagnostic.errorCode).toBe("TIMEOUT");
      expect(detailed.diagnostic.message).toContain("timed out");
    });

    it("handles malformed JSON payload with typed MALFORMED_RESPONSE", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new SyntaxError("Unexpected token in JSON at position 0");
        },
      } as unknown as Response);

      const client = new PrometheusClient("http://mock-prometheus:9090", 1000);
      const detailed = await client.queryInstantDetailed("up");

      expect(detailed.success).toBe(false);
      expect(detailed.diagnostic.errorCode).toBe("MALFORMED_RESPONSE");
    });
  });

  // =========================================================================
  // 2. Grafana Tempo / Distributed Trace Ingestion & Diagnostics
  // =========================================================================
  describe("Tempo / Trace Ingestion", () => {
    it("parses Tempo search results into distributed traces and normalized spans", async () => {
      const mockTempoSearch = {
        traces: [
          {
            traceID: "4b82d91f2c418049a0a19e8c3b4a5d6e",
            rootServiceName: "api-gateway",
            rootTraceName: "GET /api/orders",
            startTimeUnixNano: "1730000000000000000",
            durationMs: 85,
            spanSet: {
              spans: [{ spanID: "span-gw-01", name: "GET /api/orders" }],
            },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => mockTempoSearch,
      } as unknown as Response);

      const client = new JaegerClient("http://mock-tempo:3200", 2000);
      const detailed = await client.getRecentTracesDetailed("api-gateway", 10);

      expect(detailed.success).toBe(true);
      expect(detailed.diagnostic.status).toBe("OK");
      expect(detailed.traces.length).toBe(1);
      expect(detailed.traces[0].rootServiceName).toBe("api-gateway");
      expect(detailed.traces[0].durationMs).toBe(85);
      expect(detailed.normalizedSpans.length).toBe(1);
      expect(detailed.normalizedSpans[0].traceId).toBe("4b82d91f2c418049a0a19e8c3b4a5d6e");
    });

    it("parses 4-tier OTLP trace batch hierarchy: calculates recursive depths 0 through 3 accurately", async () => {
      const traceId = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
      // 4-tier hierarchy:
      // api-gateway (span-root, depth 0)
      //  └── order-service (span-order, depth 1)
      //       └── payment-service (span-payment, depth 2)
      //            └── postgres-db (span-db, depth 3)
      const mockOtlpBatch = {
        batches: [
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: "api-gateway" } }],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId,
                    spanId: "span-root",
                    name: "GET /api/orders",
                    startTimeUnixNano: "1730000000000000000",
                    endTimeUnixNano: "1730000001000000000",
                    attributes: [{ key: "http.status_code", value: { intValue: 200 } }],
                  },
                ],
              },
            ],
          },
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: "order-service" } }],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId,
                    spanId: "span-order",
                    parentSpanId: "span-root",
                    name: "GET /orders/list",
                    startTimeUnixNano: "1730000000100000000",
                    endTimeUnixNano: "1730000000900000000",
                  },
                ],
              },
            ],
          },
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: "payment-service" } }],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId,
                    spanId: "span-payment",
                    parentSpanId: "span-order",
                    name: "GET /payment/verify",
                    startTimeUnixNano: "1730000000200000000",
                    endTimeUnixNano: "1730000000800000000",
                  },
                ],
              },
            ],
          },
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: "postgres-db" } }],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId,
                    spanId: "span-db",
                    parentSpanId: "span-payment",
                    name: "SELECT * FROM payments",
                    startTimeUnixNano: "1730000000300000000",
                    endTimeUnixNano: "1730000000700000000",
                    status: { code: 2, message: "Connection pool exhausted" },
                  },
                ],
              },
            ],
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => mockOtlpBatch,
      } as unknown as Response);

      const client = new JaegerClient("http://mock-tempo:3200", 2000);
      const trace = await client.getTraceById(traceId);

      expect(trace).not.toBeNull();
      expect(trace?.traceId).toBe(traceId);
      expect(trace?.allSpans.length).toBe(4);
      expect(trace?.hasErrors).toBe(true);

      const spanMap = new Map(trace?.allSpans.map((s) => [s.spanId, s]));
      expect(spanMap.get("span-root")?.depth).toBe(0);
      expect(spanMap.get("span-order")?.depth).toBe(1);
      expect(spanMap.get("span-payment")?.depth).toBe(2);
      expect(spanMap.get("span-db")?.depth).toBe(3);

      expect(spanMap.get("span-db")?.statusCode).toBe("ERROR");
      expect(spanMap.get("span-db")?.errorMessage).toBe("Connection pool exhausted");
    });

    it("handles missing parent span ID safely by treating child as root without crashing", async () => {
      const traceId = "missing-parent-trace";
      const mockBatch = {
        batches: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "orphan-service" } }] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId,
                    spanId: "span-orphan-01",
                    parentSpanId: "span-that-does-not-exist",
                    name: "GET /orphan",
                    startTimeUnixNano: "1730000000000000000",
                    endTimeUnixNano: "1730000000100000000",
                  },
                ],
              },
            ],
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => mockBatch,
      } as unknown as Response);

      const client = new JaegerClient("http://mock-tempo:3200", 1000);
      const trace = await client.getTraceById(traceId);

      expect(trace).not.toBeNull();
      expect(trace?.allSpans.length).toBe(1);
      // Orphan span must be assigned depth 0 and not throw
      expect(trace?.allSpans[0].depth).toBe(0);
    });

    it("detects and breaks cyclic parent-child span loops safely", () => {
      const client = new JaegerClient("http://mock-tempo:3200", 1000);
      const rawJaegerTrace = {
        traceID: "cycle-trace-001",
        spans: [
          {
            traceID: "cycle-trace-001",
            spanID: "span-A",
            operationName: "op-A",
            startTime: 1730000000000,
            duration: 50000,
            tags: [],
            references: [{ refType: "CHILD_OF", spanID: "span-B", traceID: "cycle-trace-001" }],
            processID: "p1",
          },
          {
            traceID: "cycle-trace-001",
            spanID: "span-B",
            operationName: "op-B",
            startTime: 1730000000000,
            duration: 50000,
            tags: [],
            references: [{ refType: "CHILD_OF", spanID: "span-A", traceID: "cycle-trace-001" }],
            processID: "p1",
          },
        ],
        processes: {
          p1: { serviceName: "cyclic-service", tags: [] },
        },
      };

      // Must not throw RangeError: Maximum call stack size exceeded
      expect(() => {
        const parsed = client.parseTrace(rawJaegerTrace);
        expect(parsed.allSpans.length).toBe(2);
      }).not.toThrow();
    });

    it("handles Tempo 401 authentication failure with typed AUTH_FAILURE", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: new Headers(),
        text: async () => "Invalid token",
      } as unknown as Response);

      const client = new JaegerClient("https://tempo-us-central1.grafana.net", 1000);
      const detailed = await client.getRecentTracesDetailed();

      expect(detailed.success).toBe(false);
      expect(detailed.diagnostic.errorCode).toBe("AUTH_FAILURE");
    });
  });

  // =========================================================================
  // 3. Telemetry Normalization Validation
  // =========================================================================
  describe("Telemetry Normalization Schemas", () => {
    it("validates valid NormalizedMetricRecord and rejects invalid shapes", () => {
      const valid: NormalizedMetricRecord = {
        id: "metric-101",
        provider: "PROMETHEUS",
        serviceName: "payment-service",
        metricType: "LATENCY_P95",
        metricName: "http_request_duration_seconds",
        timestamp: new Date().toISOString(),
        value: 125.4,
        unit: "ms",
        labels: { tier: "3", env: "prod" },
        hasAnomaly: true,
      };

      expect(() => validateMetricRecord(valid)).not.toThrow();

      // Missing required serviceName
      const invalid = { ...valid, serviceName: "" };
      expect(() => validateMetricRecord(invalid)).toThrow();
    });

    it("validates NormalizedTraceSpan hierarchy", () => {
      const validSpan: NormalizedTraceSpan = {
        traceId: "trace-999",
        spanId: "span-001",
        serviceName: "order-service",
        operationName: "POST /orders",
        startTimeIso: new Date().toISOString(),
        durationMs: 45,
        statusCode: "OK",
        attributes: { "http.method": "POST", "http.status_code": 200 },
        childSpanIds: ["span-002"],
        depth: 0,
      };

      expect(() => validateTraceSpan(validSpan)).not.toThrow();
    });

    it("validates full NormalizedTelemetryBatch", () => {
      const batch = {
        batchId: "batch-test-1",
        collectedAt: new Date().toISOString(),
        mode: "LIVE" as const,
        metrics: [
          {
            id: "m-1",
            provider: "PROMETHEUS" as const,
            serviceName: "api-gateway",
            metricType: "REQUEST_RATE" as const,
            metricName: "http_requests_total",
            timestamp: new Date().toISOString(),
            value: 850,
            unit: "req/s",
            labels: {},
            hasAnomaly: false,
          },
        ],
        spans: [],
        diagnostics: [
          {
            provider: "PROMETHEUS" as const,
            endpoint: "http://localhost:9090",
            status: "OK" as const,
            message: "Query successful",
            latencyMs: 12,
            timestamp: new Date().toISOString(),
          },
        ],
      };

      const validated = validateTelemetryBatch(batch);
      expect(validated.batchId).toBe("batch-test-1");
      expect(validated.metrics.length).toBe(1);
    });
  });

  // =========================================================================
  // 4. Deterministic Multi-Service Incident Validation & RCA
  // =========================================================================
  describe("Multi-Service Incident Validation Scenario", () => {
    it("creates realistic 4-service topology and verifies healthy baseline trace", () => {
      const graph = createMultiServiceGraph();
      const validation = graph.validateGraphIntegrity();
      expect(validation.isValid).toBe(true);
      expect(validation.nodeCount).toBe(4);
      expect(validation.edgeCount).toBe(3);

      const healthyTrace = buildHealthyTrace();
      expect(healthyTrace.hasErrors).toBe(false);
      expect(healthyTrace.servicesInvolved).toEqual([
        "api-gateway",
        "order-service",
        "payment-service",
        "postgres-db",
      ]);
      expect(healthyTrace.durationMs).toBeLessThan(100);
    });

    it("evaluates cascading failure: correctly ranks downstream postgres-db as root cause", () => {
      const scenario = buildMultiServiceIncidentScenario();
      const failureTrace = buildFailureTrace();

      expect(failureTrace.hasErrors).toBe(true);
      expect(failureTrace.durationMs).toBeGreaterThan(2000);
      expect(failureTrace.allSpans.length).toBe(4);

      // Analyze scenario using evidence-grounded RootCauseEngine
      const result = analyzeMultiServiceIncident(scenario, "inc_val_cascading_001");

      expect(result.isConclusive).toBe(true);
      expect(result.topRootCause).toBeDefined();

      // The root cause must be postgres-db where the fault originated at step 4
      expect(result.topRootCause?.serviceId).toBe("postgres-db");
      expect(result.topRootCause?.score).toBeGreaterThan(60);

      // Blast radius should include the 3 upstream dependents
      expect(result.topRootCause?.affectedDependentsCount).toBe(3);

      // Supporting evidence must contain timing precedence or telemetry spike
      const evidenceTypes = result.topRootCause?.supportingEvidence.map((e) => e.type) || [];
      expect(evidenceTypes).toContain("TIMING_PRECEDENCE");

      // Transitive upstream services (Gateway, Order) must be evaluated as lower-ranked candidates
      const gatewayCandidate = result.allCandidates.find((c) => c.serviceId === "api-gateway");
      expect(gatewayCandidate).toBeDefined();
      expect(gatewayCandidate!.score).toBeLessThan(result.topRootCause!.score);
    });

    it("returns INCONCLUSIVE when evidence is insufficient or all services are healthy", () => {
      const graph = createMultiServiceGraph();
      const engine = new RootCauseEngine(6);

      // Healthy telemetry without anomalies
      const telemetrySamples: TelemetryPoint[] = [
        { serviceId: "api-gateway", simulationStep: 1, timestamp: new Date(), latency: 15, errorRate: 0.1, requestCount: 1000, healthStatus: "HEALTHY" },
        { serviceId: "order-service", simulationStep: 1, timestamp: new Date(), latency: 35, errorRate: 0.2, requestCount: 500, healthStatus: "HEALTHY" },
        { serviceId: "payment-service", simulationStep: 1, timestamp: new Date(), latency: 45, errorRate: 0.1, requestCount: 400, healthStatus: "HEALTHY" },
        { serviceId: "postgres-db", simulationStep: 1, timestamp: new Date(), latency: 12, errorRate: 0.05, requestCount: 1500, healthStatus: "HEALTHY" },
      ];

      const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
        ["api-gateway", { status: "HEALTHY", latency: 15, errorRate: 0.1 }],
        ["order-service", { status: "HEALTHY", latency: 35, errorRate: 0.2 }],
        ["payment-service", { status: "HEALTHY", latency: 45, errorRate: 0.1 }],
        ["postgres-db", { status: "HEALTHY", latency: 12, errorRate: 0.05 }],
      ]);

      const result = engine.analyzeIncident({
        incidentId: "inc_healthy_inconclusive",
        graph,
        telemetrySamples,
        currentServiceStates: currentStates,
      });

      expect(result.isConclusive).toBe(false);
      expect(result.topRootCause).toBeNull();
    });
  });

  // =========================================================================
  // 5. Telemetry Mode Separation (SIMULATION vs LIVE vs DEGRADED)
  // =========================================================================
  describe("Telemetry Mode Transitions & Freshness", () => {
    it("preserves SIMULATION mode and does not contact backends", () => {
      const manager = new TelemetryManager();
      manager.setMode("SIMULATION");
      expect(manager.getMode()).toBe("SIMULATION");
    });

    it("switches to LIVE mode and maps legacy REAL mode alias", () => {
      const manager = new TelemetryManager();
      manager.setMode("REAL");
      expect(manager.getMode()).toBe("LIVE");

      manager.setMode("LIVE");
      expect(manager.getMode()).toBe("LIVE");
    });

    it("returns DEGRADED mode when live backends are unreachable without fabricating simulation data", async () => {
      // Force fetch to reject (offline backends)
      global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      const overview = await manager.getObservedServices();
      // Must truthfully disclose DEGRADED mode when backends are offline
      expect(overview.mode).toBe("DEGRADED");
      expect(overview.backendHealth.prometheusAvailable).toBe(false);
      expect(overview.backendHealth.jaegerAvailable).toBe(false);

      // Telemetry source must be PROMETHEUS/offline, never silent fallback to SIMULATION
      for (const svc of overview.observedServices) {
        expect(svc.source).toBe("PROMETHEUS");
        expect(svc.status).toBe("UNKNOWN");
      }
    });

    it("determines LIVE mode strictly when both Prometheus and Tempo succeed and return valid data", async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        // Health probes
        if (decoded.includes("/api/v1/query?query=up") || decoded.includes("vector(1)")) {
          return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => ({ status: "success" }) } as unknown as Response);
        }
        if (decoded.includes("/api/traces") || decoded.includes("/api/search")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              traces: [{ traceID: "tr-100", rootServiceName: "order-service", durationMs: 40, spanSet: { spans: [] } }],
            }),
          } as unknown as Response);
        }
        // PromQL queries
        if (decoded.includes("rate(http_requests_total[1m])")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: { result: [{ metric: { service: "order-service" }, value: [1730000000, "150"] }] },
            }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ status: "success", data: { result: [] } }),
        } as unknown as Response);
      });

      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      const batch = await manager.getNormalizedBatch();
      expect(batch.mode).toBe("LIVE");
      expect(batch.metrics.length).toBeGreaterThan(0);
      expect(batch.spans.length).toBeGreaterThan(0);
      expect(manager.getLastIngestedAt()).not.toBeNull();
    });

    it("transitions to DEGRADED when Prometheus fails but Tempo succeeds", async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes(":9090") || url.includes("/api/prom")) {
          return Promise.resolve({ ok: false, status: 503, text: async () => "Prometheus Unavailable" } as unknown as Response);
        }
        // Tempo succeeds
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            traces: [{ traceID: "tr-200", rootServiceName: "order-service", durationMs: 35, spanSet: { spans: [] } }],
          }),
        } as unknown as Response);
      });

      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      const batch = await manager.getNormalizedBatch();
      expect(batch.mode).toBe("DEGRADED");
    });

    it("transitions to DEGRADED when health check probe passes but actual telemetry queries fail", async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        // Health check queries return 200 OK
        if (decoded.includes("query=up") || decoded.includes("vector(1)") || decoded.includes("limit=1")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ status: "success", data: { result: [] } }),
          } as unknown as Response);
        }
        // Actual metric query fails with 500
        if (decoded.includes("rate(http_requests_total[1m])")) {
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
            text: async () => "Query evaluation timed out on Prometheus TSDB engine",
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ status: "success", data: { result: [] } }),
        } as unknown as Response);
      });

      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      const batch = await manager.getNormalizedBatch();
      // Even though health probes passed, query failure MUST force DEGRADED mode
      expect(batch.mode).toBe("DEGRADED");
      const promDiag = batch.diagnostics.find((d) => d.provider === "PROMETHEUS");
      expect(promDiag?.status).toBe("ERROR");
    });

    it("treats empty query responses as DEGRADED with UNKNOWN status and never fabricates simulated data", async () => {
      // Both backends respond 200 OK with empty result arrays
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          status: "success",
          data: { result: [] },
          traces: [],
        }),
      } as unknown as Response);

      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      const batch = await manager.getNormalizedBatch();
      // An empty response with zero series cannot be considered verified LIVE telemetry
      expect(batch.mode).toBe("DEGRADED");
      expect(batch.metrics.length).toBe(0);
      expect(batch.spans.length).toBe(0);
    });
  });
});
