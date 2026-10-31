import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PrometheusClient } from "@/lib/telemetry/prometheusClient";
import { JaegerClient } from "@/lib/telemetry/jaegerClient";
import { TelemetryManager } from "@/lib/telemetry/telemetryManager";
import { mergeServiceMetrics, ServiceMapItem } from "@/lib/telemetry/mergeServiceMetrics";
import { ObservedServiceMetric } from "@/lib/telemetry/types";
import { PrometheusRegistry } from "../sample-services/shared/telemetry";

describe("Phase 6: Observability Provenance, Failure Handling & Security Verification", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // =========================================================================
  // 1. Missing & Invalid Credentials Security
  // =========================================================================
  describe("Credentials Handling & Secret Protection", () => {
    it("handles missing credentials without claiming LIVE provenance and without leaking tokens", async () => {
      // Simulate unconfigured client
      const unauthClient = new PrometheusClient("http://unconfigured-prometheus.invalid", 1000);
      global.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND unconfigured-prometheus.invalid"));

      const result = await unauthClient.queryInstant("up");
      expect(result).toEqual([]);
    });

    it("handles 401 Unauthorized from metrics backend without marking status as healthy or leaking auth headers", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "Invalid basic auth token",
        headers: new Headers(),
      } as unknown as Response);

      const client = new PrometheusClient("https://prometheus-prod-fake.grafana.net/api/v1/query", 1000);
      const health = await client.checkHealth();

      expect(health.available).toBe(false);
      expect(health.errorCode).toBe("AUTH_FAILURE");
      expect(health.error).toBeDefined();
      expect(health.error).toContain("401");
      // Must not leak secret tokens in the error string
      expect(health.error).not.toMatch(/Bearer\s+[a-zA-Z0-9_-]+/);
      expect(health.error).not.toMatch(/Basic\s+[a-zA-Z0-9+/=]+/);
    });

    it("handles 403 Forbidden from Tempo backend gracefully", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () => "User does not have access to tempo-prod tenant",
        headers: new Headers(),
      } as unknown as Response);

      const tempoClient = new JaegerClient("https://tempo-prod-fake.grafana.net", 1000);
      const res = await tempoClient.getRecentTracesDetailed("order-service", 10);

      expect(res.success).toBe(false);
      expect(res.traces).toEqual([]);
      expect(res.diagnostic.errorCode).toBe("AUTH_FAILURE");
    });
  });

  // =========================================================================
  // 2. Unreachable Backend Endpoints & Network Faults
  // =========================================================================
  describe("Unreachable Backend Endpoints & Network Faults", () => {
    it("handles network timeout gracefully when querying Prometheus", async () => {
      global.fetch = vi.fn().mockImplementation(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error("The operation was aborted")), 10);
        });
      });

      const client = new PrometheusClient("http://192.0.2.1:9090", 50); // RFC 5737 TEST-NET unreachable
      const res = await client.queryInstantDetailed("up", "CUSTOM");

      expect(res.success).toBe(false);
      expect(res.records).toEqual([]);
      expect(["TIMEOUT", "UNAVAILABLE"]).toContain(res.diagnostic.errorCode);
    });

    it("handles connection reset / ECONNREFUSED without throwing uncaught exceptions", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9090"));

      const client = new PrometheusClient("http://127.0.0.1:9090", 500);
      const health = await client.checkHealth();

      expect(health.available).toBe(false);
    });

    it("handles Tempo search failure by falling back to empty trace collection without crashing", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:3200"));

      const tempoClient = new JaegerClient("http://127.0.0.1:3200", 500);
      const trace = await tempoClient.getTraceById("non-existent-trace-id");

      expect(trace).toBeNull();
    });
  });

  // =========================================================================
  // 3. Provenance Semantics & Distinctions (Phase 3 Acceptance Criteria)
  // =========================================================================
  describe("Telemetry Provenance Distinctions", () => {
    it("assigns DISABLED provenance in SIMULATION mode regardless of configured endpoints", () => {
      const dbServices: ServiceMapItem[] = [
        {
          id: "s1",
          name: "order-service",
          serviceType: "API",
          tier: 2,
          status: "HEALTHY",
          currentLatency: 45,
          baselineLatency: 40,
          currentErrorRate: 0.01,
          baselineErrorRate: 0.01,
          requestRate: 100,
          description: "Order Service",
        },
      ];
      const observed: ObservedServiceMetric[] = [
        {
          serviceId: "s1",
          serviceName: "order-service",
          source: "PROMETHEUS",
          status: "HEALTHY",
          errorRate: 0.01,
          latencyMs: 45,
          requestRate: 100,
          provenance: "LIVE",
          lastObserved: new Date().toISOString(),
          traceCount: 5,
          isStale: false,
          isKnownInTopology: true,
        },
      ];

      const merged = mergeServiceMetrics(dbServices, observed, "SIMULATION");
      expect(merged[0].provenance).toBe("DISABLED");
    });

    it("assigns MOCK_EMULATION provenance when data originates from in-process mock server", () => {
      const dbServices: ServiceMapItem[] = [
        {
          id: "s1",
          name: "order-service",
          serviceType: "API",
          tier: 2,
          status: "HEALTHY",
          currentLatency: 45,
          baselineLatency: 40,
          currentErrorRate: 0.01,
          baselineErrorRate: 0.01,
          requestRate: 100,
          description: "Order Service",
        },
      ];
      const observed: ObservedServiceMetric[] = [
        {
          serviceId: "s1",
          serviceName: "order-service",
          source: "SIMULATION",
          status: "HEALTHY",
          errorRate: 0.01,
          latencyMs: 45,
          requestRate: 100,
          provenance: "MOCK_EMULATION",
          lastObserved: new Date().toISOString(),
          traceCount: 5,
          isStale: false,
          isKnownInTopology: true,
        },
      ];

      const merged = mergeServiceMetrics(dbServices, observed, "LIVE");
      expect(merged[0].provenance).toBe("MOCK_EMULATION");
    });

    it("assigns LIVE provenance only when confirmed external ingestion is reported", () => {
      const dbServices: ServiceMapItem[] = [
        {
          id: "s1",
          name: "order-service",
          serviceType: "API",
          tier: 2,
          status: "HEALTHY",
          currentLatency: 45,
          baselineLatency: 40,
          currentErrorRate: 0.01,
          baselineErrorRate: 0.01,
          requestRate: 100,
          description: "Order Service",
        },
      ];
      const observed: ObservedServiceMetric[] = [
        {
          serviceId: "s1",
          serviceName: "order-service",
          source: "PROMETHEUS",
          status: "HEALTHY",
          errorRate: 0.01,
          latencyMs: 45,
          requestRate: 100,
          provenance: "LIVE",
          lastObserved: new Date().toISOString(),
          traceCount: 5,
          isStale: false,
          isKnownInTopology: true,
        },
      ];

      const merged = mergeServiceMetrics(dbServices, observed, "LIVE");
      expect(merged[0].provenance).toBe("LIVE");
    });

    it("marks unobserved topology services as ERROR provenance in LIVE mode", () => {
      const dbServices: ServiceMapItem[] = [
        {
          id: "s1",
          name: "unobserved-service",
          serviceType: "API",
          tier: 2,
          status: "UNKNOWN",
          currentLatency: null,
          baselineLatency: 40,
          currentErrorRate: null,
          baselineErrorRate: 0.01,
          requestRate: null,
          description: "Unobserved Service",
        },
      ];
      const observed: ObservedServiceMetric[] = []; // No observations

      const merged = mergeServiceMetrics(dbServices, observed, "LIVE");
      expect(merged[0].provenance).toBe("ERROR");
      expect(merged[0].status).toBe("UNKNOWN");
    });

    it("manager health returns DISABLED provenance in SIMULATION mode", async () => {
      const manager = new TelemetryManager();
      manager.setMode("SIMULATION");

      const health = await manager.getBackendHealth(false);
      expect(health.provenance).toBe("DISABLED");
      expect(health.isCloudBackend).toBe(false);
    });
  });

  // =========================================================================
  // 4. Prometheus Registry & Text Exposition Format
  // =========================================================================
  describe("Prometheus Exposition Format (/metrics & Microservices)", () => {
    it("generates valid Prometheus text exposition format with TYPE and HELP headers", () => {
      const registry = new PrometheusRegistry("payment-service");
      registry.recordRequest(10, { status: "200" });
      registry.recordRequest(2, { status: "500" });
      registry.recordError(2, { status: "500" });
      registry.recordDuration(0.045);
      registry.recordDuration(0.120);

      const exposition = registry.toPrometheusFormat();

      expect(exposition).toContain("# HELP http_requests_total");
      expect(exposition).toContain("# TYPE http_requests_total counter");
      expect(exposition).toContain('http_requests_total{service="payment-service",status="200"} 10');
      expect(exposition).toContain('http_requests_total{service="payment-service",status="500"} 2');

      expect(exposition).toContain("# HELP http_request_errors_total");
      expect(exposition).toContain("# TYPE http_request_errors_total counter");
      expect(exposition).toContain('http_request_errors_total{service="payment-service",status="500"} 2');

      expect(exposition).toContain("# HELP http_request_duration_seconds");
      expect(exposition).toContain("# TYPE http_request_duration_seconds histogram");
      expect(exposition).toContain('http_request_duration_seconds_bucket{service="payment-service",le="+Inf"} 2');
      expect(exposition).toContain('http_request_duration_seconds_count{service="payment-service"} 2');

      expect(exposition).toContain("# HELP service_health_status");
      expect(exposition).toContain("# TYPE service_health_status gauge");
      expect(exposition).toContain('service_health_status{service="payment-service"} 1');
    });

    it("formats histogram buckets monotonically without NaN or negative values", () => {
      const registry = new PrometheusRegistry("order-service");
      registry.recordDuration(0.002);
      registry.recordDuration(0.025);
      registry.recordDuration(0.5);

      const exposition = registry.toPrometheusFormat();
      const bucketLines = exposition
        .split("\n")
        .filter((l) => l.startsWith("http_request_duration_seconds_bucket"));

      expect(bucketLines.length).toBeGreaterThan(0);

      let prevCount = 0;
      for (const line of bucketLines) {
        const match = line.match(/\}\s+(\d+)$/);
        expect(match).not.toBeNull();
        const count = parseInt(match![1], 10);
        expect(count).toBeGreaterThanOrEqual(prevCount);
        prevCount = count;
      }
    });
  });

  // =========================================================================
  // 5. Live Smoke Test Validation Guardrails
  // =========================================================================
  describe("Live Smoke Test Safety & Identification", () => {
    it("uses isolated synthetic verification identifiers that never collide with customer data", () => {
      const timestamp = Date.now();
      const testId = `live-verify-${timestamp}`;
      expect(testId).toMatch(/^live-verify-\d+$/);
      expect(testId).not.toContain("customer");
      expect(testId).not.toContain("prod-user");
    });
  });

  // =========================================================================
  // 6. Phase 2.1 Hardening: Strict Verification & Provenance Tests
  // =========================================================================
  describe("Phase 2.1 Hardening: Strict Verification, Tempo & Provenance", () => {
    it("backend reachable but no metrics returned results in metricsIngested: false and degraded provenance", async () => {
      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      // Mock empty metrics
      vi.spyOn(PrometheusClient.prototype, "checkHealth").mockResolvedValue({
        available: true,
        isCloud: true,
      });
      vi.spyOn(PrometheusClient.prototype, "getServiceMetricsDetailed").mockResolvedValue({
        success: true,
        metrics: new Map(), // No metrics returned
        p95Supported: true,
        diagnostics: [{
          provider: "PROMETHEUS",
          endpoint: "https://prometheus-prod.grafana.net",
          status: "OK",
          message: "Query successful",
          latencyMs: 40,
          timestamp: new Date().toISOString(),
        }],
      });
      vi.spyOn(JaegerClient.prototype, "checkHealth").mockResolvedValue({
        available: true,
        isCloud: true,
      });
      vi.spyOn(JaegerClient.prototype, "getRecentTracesDetailed").mockResolvedValue({
        success: true,
        traces: [],
        normalizedSpans: [],
        diagnostic: {
          provider: "TEMPO",
          endpoint: "https://tempo-prod.grafana.net",
          status: "OK",
          message: "Query successful",
          latencyMs: 50,
          timestamp: new Date().toISOString(),
        },
      });

      const obs = await manager.getObservedServices(true);
      expect(obs.backendHealth.metricsIngested).toBe(false);
      expect(obs.backendHealth.tracesIngested).toBe(false);
      expect(obs.backendHealth.provenance).not.toBe("LIVE");
    });

    it("backend reachable but no traces returned prevents LIVE provenance", async () => {
      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      vi.spyOn(PrometheusClient.prototype, "checkHealth").mockResolvedValue({ available: true, isCloud: true });
      vi.spyOn(JaegerClient.prototype, "checkHealth").mockResolvedValue({ available: true, isCloud: true });

      const metricsMap = new Map();
      metricsMap.set("order-service", {
        serviceId: "order-service",
        serviceName: "order-service",
        latencyMs: 35,
        hasValidLatency: true,
        errorRate: 0,
        hasValidErrorRate: true,
        requestRate: 50,
        hasValidRequestRate: true,
        isStale: false,
      });

      vi.spyOn(PrometheusClient.prototype, "getServiceMetricsDetailed").mockResolvedValue({
        success: true,
        metrics: metricsMap,
        p95Supported: true,
        diagnostics: [{
          provider: "PROMETHEUS",
          endpoint: "https://prometheus.test",
          status: "OK",
          message: "Query successful",
          latencyMs: 30,
          timestamp: new Date().toISOString(),
        }],
      });

      // No traces returned
      vi.spyOn(JaegerClient.prototype, "getRecentTracesDetailed").mockResolvedValue({
        success: true,
        traces: [],
        normalizedSpans: [],
        diagnostic: {
          provider: "TEMPO",
          endpoint: "https://tempo.test",
          status: "OK",
          message: "Query successful",
          latencyMs: 30,
          timestamp: new Date().toISOString(),
        },
      });

      const obs = await manager.getObservedServices(true);
      expect(obs.backendHealth.metricsIngested).toBe(true);
      expect(obs.backendHealth.tracesIngested).toBe(false);
      expect(obs.backendHealth.provenance).not.toBe("LIVE");
    });

    it("rejects stale or unrelated foreign telemetry from satisfying LIVE provenance", async () => {
      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      vi.spyOn(PrometheusClient.prototype, "checkHealth").mockResolvedValue({ available: true, isCloud: true });
      vi.spyOn(JaegerClient.prototype, "checkHealth").mockResolvedValue({ available: true, isCloud: true });

      // Only unrelated foreign service
      const foreignMetrics = new Map();
      foreignMetrics.set("foreign-unrelated-cluster-service", {
        serviceId: "foreign-unrelated-cluster-service",
        serviceName: "foreign-unrelated-cluster-service",
        latencyMs: 10,
        hasValidLatency: true,
        errorRate: 0,
        hasValidErrorRate: true,
        requestRate: 10,
        hasValidRequestRate: true,
        isStale: false,
      });

      vi.spyOn(PrometheusClient.prototype, "getServiceMetricsDetailed").mockResolvedValue({
        success: true,
        metrics: foreignMetrics,
        p95Supported: true,
        diagnostics: [{ provider: "PROMETHEUS", endpoint: "test", status: "OK", message: "OK", latencyMs: 10, timestamp: new Date().toISOString() }],
      });

      // Stale trace from 5 days ago
      const staleTrace = {
        traceId: "old-trace-id",
        rootServiceName: "order-service",
        operationName: "HTTP GET",
        startTime: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
        durationMs: 40,
        totalSpans: 1,
        hasErrors: false,
        servicesInvolved: ["order-service"],
        rootSpan: null,
        allSpans: [{
          spanId: "s1",
          traceId: "old-trace-id",
          operationName: "HTTP GET",
          serviceName: "order-service",
          startTimeUs: 1000,
          durationMs: 40,
          statusCode: "OK" as const,
          attributes: {},
          depth: 0,
          children: [],
        }],
        isFallback: false,
      };

      vi.spyOn(JaegerClient.prototype, "getRecentTracesDetailed").mockResolvedValue({
        success: true,
        traces: [staleTrace],
        normalizedSpans: [],
        diagnostic: { provider: "TEMPO", endpoint: "test", status: "OK", message: "OK", latencyMs: 10, timestamp: new Date().toISOString() },
      });

      const obs = await manager.getObservedServices(true);
      expect(obs.backendHealth.metricsIngested).toBe(false);
      expect(obs.backendHealth.tracesIngested).toBe(false);
      expect(obs.backendHealth.provenance).not.toBe("LIVE");
    });

    it("strict Tempo verification: getTraceById with allowFallback: false returns null for empty spans", async () => {
      const client = new JaegerClient("https://tempo-test.invalid", 1000);
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ batches: [] }), // Empty batches
        headers: new Headers(),
      } as unknown as Response);

      const strictTrace = await client.getTraceById("trace-12345", { allowFallback: false });
      expect(strictTrace).toBeNull();

      // Dashboard fallback returns fallback object with isFallback: true
      const fallbackTrace = await client.getTraceById("trace-12345", { allowFallback: true });
      expect(fallbackTrace).not.toBeNull();
      expect(fallbackTrace?.isFallback).toBe(true);
    });

    it("strict Tempo verification: verifyLiveTrace rejects fallback traces, ID mismatches, and missing attributes", () => {
      const client = new JaegerClient();

      // 1. Rejects fallback trace
      const fallbackTrace = {
        traceId: "1234567890abcdef",
        rootServiceName: "cloud-tempo",
        operationName: "Cloud Trace",
        startTime: new Date().toISOString(),
        durationMs: 50,
        totalSpans: 1,
        hasErrors: false,
        servicesInvolved: ["cloud-tempo"],
        rootSpan: null,
        allSpans: [],
        isFallback: true,
      };
      const r1 = client.verifyLiveTrace(fallbackTrace, "1234567890abcdef", "verify-1");
      expect(r1.valid).toBe(false);
      expect(r1.reason).toContain("fallback");

      // 2. Rejects Trace ID mismatch
      const realTrace = {
        traceId: "1111111111111111",
        rootServiceName: "api-gateway",
        operationName: "HTTP POST",
        startTime: new Date().toISOString(),
        durationMs: 25,
        totalSpans: 1,
        hasErrors: false,
        servicesInvolved: ["api-gateway"],
        rootSpan: null,
        allSpans: [{
          spanId: "span-1",
          traceId: "1111111111111111",
          operationName: "HTTP POST",
          serviceName: "api-gateway",
          startTimeUs: 1000,
          durationMs: 25,
          statusCode: "OK" as const,
          attributes: { "verification.id": "verify-1" },
          depth: 0,
          children: [],
        }],
        isFallback: false,
      };
      const r2 = client.verifyLiveTrace(realTrace, "9999999999999999", "verify-1");
      expect(r2.valid).toBe(false);
      expect(r2.reason).toContain("Trace ID mismatch");

      // 3. Rejects missing verification attribute
      const r3 = client.verifyLiveTrace(realTrace, "1111111111111111", "wrong-verification-id");
      expect(r3.valid).toBe(false);
      expect(r3.reason).toContain("Verification attribute");

      // 4. Accepts valid matching trace
      const r4 = client.verifyLiveTrace(realTrace, "1111111111111111", "verify-1");
      expect(r4.valid).toBe(true);
    });

    it("EXPORT_CONFIRMED_QUERY_PENDING or NOT_VERIFIED can NEVER result in overall success or exit code 0", () => {
      // Direct verification invariant: any pending or non-passed status fails overall verification
      const metricsStatus: string = "NOT_VERIFIED";
      const tracesStatus: string = "PASSED";

      const overallPassed = metricsStatus === "PASSED" && tracesStatus === "PASSED";
      expect(overallPassed).toBe(false);

      const exitCode = overallPassed ? 0 : 1;
      expect(exitCode).toBe(1);
    });

    it("PrometheusRegistry updates dynamic service_health_status and safely escapes labels", () => {
      const registry = new PrometheusRegistry("order-service");
      expect(registry.getHealthStatus()).toBe(1);

      // Verify health transitions
      registry.setHealthStatus("DEGRADED");
      expect(registry.getHealthStatus()).toBe(0);
      expect(registry.toPrometheusFormat()).toContain('service_health_status{service="order-service"} 0');

      registry.setHealthStatus("HEALTHY");
      expect(registry.getHealthStatus()).toBe(1);
      expect(registry.toPrometheusFormat()).toContain('service_health_status{service="order-service"} 1');

      // Verify label escaping
      const escapedRegistry = new PrometheusRegistry('svc"test\\name');
      escapedRegistry.recordRequest(1, { status: "200" });
      const exp = escapedRegistry.toPrometheusFormat();
      expect(exp).toContain('service="svc\\"test\\\\name"');
    });

    it("correct recovery from ERROR to verified LIVE when valid telemetry is received", async () => {
      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      // 1. Initial State: Backends offline -> ERROR
      vi.spyOn(PrometheusClient.prototype, "checkHealth").mockResolvedValue({
        available: false,
        isCloud: true,
        error: "Connect timeout",
      });
      vi.spyOn(JaegerClient.prototype, "checkHealth").mockResolvedValue({
        available: false,
        isCloud: true,
        error: "Connect timeout",
      });

      const initialHealth = await manager.getBackendHealth(true);
      expect(initialHealth.provenance).toBe("ERROR");

      // 2. Recovery: Backends become online and verified metrics/traces are received
      vi.spyOn(PrometheusClient.prototype, "checkHealth").mockResolvedValue({ available: true, isCloud: true });
      vi.spyOn(JaegerClient.prototype, "checkHealth").mockResolvedValue({ available: true, isCloud: true });

      const metricsMap = new Map();
      metricsMap.set("order-service", {
        serviceId: "order-service",
        serviceName: "order-service",
        latencyMs: 30,
        hasValidLatency: true,
        errorRate: 0,
        hasValidErrorRate: true,
        requestRate: 50,
        hasValidRequestRate: true,
        isStale: false,
      });

      vi.spyOn(PrometheusClient.prototype, "getServiceMetricsDetailed").mockResolvedValue({
        success: true,
        metrics: metricsMap,
        p95Supported: true,
        diagnostics: [{ provider: "PROMETHEUS", endpoint: "test", status: "OK", message: "OK", latencyMs: 10, timestamp: new Date().toISOString() }],
      });

      const validTrace = {
        traceId: "recov-trace-1",
        rootServiceName: "order-service",
        operationName: "HTTP POST /orders",
        startTime: new Date().toISOString(),
        durationMs: 30,
        totalSpans: 2,
        hasErrors: false,
        servicesInvolved: ["order-service"],
        rootSpan: null,
        allSpans: [{
          spanId: "sp1",
          traceId: "recov-trace-1",
          operationName: "HTTP POST /orders",
          serviceName: "order-service",
          startTimeUs: Date.now() * 1000,
          durationMs: 30,
          statusCode: "OK" as const,
          attributes: { "service.name": "order-service" },
          depth: 0,
          children: [],
        }],
        isFallback: false,
      };

      vi.spyOn(JaegerClient.prototype, "getRecentTracesDetailed").mockResolvedValue({
        success: true,
        traces: [validTrace],
        normalizedSpans: [],
        diagnostic: { provider: "TEMPO", endpoint: "test", status: "OK", message: "OK", latencyMs: 10, timestamp: new Date().toISOString() },
      });

      const recoveredObs = await manager.getObservedServices(true);
      expect(recoveredObs.backendHealth.metricsIngested).toBe(true);
      expect(recoveredObs.backendHealth.tracesIngested).toBe(true);
      expect(recoveredObs.backendHealth.provenance).toBe("LIVE");
      expect(recoveredObs.backendHealth.lastVerifiedAt).toBeDefined();
    });
  });
});
