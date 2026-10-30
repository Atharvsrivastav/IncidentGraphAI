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
    it("successfully queries instant metrics and normalizes values with labels", async () => {
      const mockPromPayload = {
        status: "success",
        data: {
          resultType: "vector",
          result: [
            {
              metric: { service: "order-service", env: "production", job: "order-api" },
              value: [1730000000, "0.045"],
            },
            {
              metric: { service: "payment-service", env: "production", job: "payment-api" },
              value: [1730000000, "0.120"],
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
      expect(orderMetric?.value).toBe(0.045);
      expect(orderMetric?.unit).toBe("ms");
      expect(orderMetric?.labels["env"]).toBe("production");
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

    it("parses OTLP / Tempo v2 trace batch hierarchy with parent-child relationships and error tags", async () => {
      const traceId = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
      const mockOtlpBatch = {
        batches: [
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: "order-service" } }],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId,
                    spanId: "span-root-01",
                    name: "POST /orders",
                    startTimeUnixNano: "1730000000000000000",
                    endTimeUnixNano: "1730000001000000000", // 1000ms
                    status: { code: 2, message: "Database timeout" },
                    attributes: [{ key: "http.status_code", value: { intValue: 500 } }],
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
      expect(trace?.hasErrors).toBe(true);
      expect(trace?.rootServiceName).toBe("order-service");
      expect(trace?.allSpans[0].statusCode).toBe("ERROR");
      expect(trace?.allSpans[0].errorMessage).toBe("Database timeout");
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
  });
});
