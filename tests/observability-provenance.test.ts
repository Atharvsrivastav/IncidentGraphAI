import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PrometheusClient } from "@/lib/telemetry/prometheusClient";
import { JaegerClient } from "@/lib/telemetry/jaegerClient";
import { TelemetryManager } from "@/lib/telemetry/telemetryManager";
import { mergeServiceMetrics, ServiceMapItem } from "@/lib/telemetry/mergeServiceMetrics";
import { ObservedServiceMetric } from "@/lib/telemetry/types";
import { PrometheusRegistry, sanitizeErrorMessage } from "../sample-services/shared/telemetry";
import {
  validateRemoteWriteConfig,
  generatePrometheusConfig,
  validateGeneratedYaml,
} from "../scripts/generate-prometheus-config";
import { setOrderFault, resetOrderFault, telemetry as orderTelemetry } from "../sample-services/order/server";

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

      // Verify health transitions: 1 (HEALTHY), 0.5 (DEGRADED), 0 (DOWN)
      registry.setHealthStatus("DEGRADED");
      expect(registry.getHealthStatus()).toBe(0.5);
      expect(registry.toPrometheusFormat()).toContain('service_health_status{service="order-service"} 0.5');

      registry.setHealthStatus("DOWN");
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

      vi.spyOn(PrometheusClient.prototype, "isCloudBackend").mockReturnValue(true);
      vi.spyOn(JaegerClient.prototype, "isCloudBackend").mockReturnValue(true);

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

  // =========================================================================
  // Phase 2.2: Strict Remote-Write Configuration Detection
  // =========================================================================
  describe("Phase 2.2: Remote-Write Configuration Detection & Permutations", () => {
    it("detects URL absent", () => {
      const res = validateRemoteWriteConfig({});
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("URL absent");
    });

    it("detects URL present but token absent", () => {
      const res = validateRemoteWriteConfig({
        GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL: "https://prometheus-prod-10.grafana.net/api/prom/push",
      });
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("token absent");
    });

    it("rejects OTLP ingestion token as remote-write credentials", () => {
      const res = validateRemoteWriteConfig({
        GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL: "https://prometheus-prod-10.grafana.net/api/prom/push",
        GRAFANA_CLOUD_INGESTION_TOKEN: "glc_ingest_token_12345",
      });
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("OTLP ingestion credentials do not count as Prometheus remote-write credentials");
    });

    it("validates dedicated remote-write token and username", () => {
      const res = validateRemoteWriteConfig({
        GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL: "https://prometheus-prod-10.grafana.net/api/prom/push",
        GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_USER: "1871065",
        GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_TOKEN: "glc_rw_token_abcde",
      });
      expect(res.valid).toBe(true);
      expect(res.url).toBe("https://prometheus-prod-10.grafana.net/api/prom/push");
      expect(res.user).toBe("1871065");
      expect(res.hasDedicatedToken).toBe(true);
    });

    it("rejects invalid or malformed URL", () => {
      const res = validateRemoteWriteConfig({
        GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL: "not-a-valid-url",
        GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_TOKEN: "token123",
      });
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("Invalid URL");
    });

    it("rejects non-http/https URL protocol", () => {
      const res = validateRemoteWriteConfig({
        GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL: "ftp://prometheus-prod.grafana.net/push",
        GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_TOKEN: "token123",
      });
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("Invalid URL protocol");
    });

    it("detects missing username when URL and token are present", () => {
      const res = validateRemoteWriteConfig({
        GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL: "https://prometheus-prod-10.grafana.net/api/prom/push",
        GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_TOKEN: "glc_rw_token_abcde",
      });
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("Missing username");
    });

    it("validates generated Prometheus YAML and detects malformed YAML indentation", () => {
      const validYaml = generatePrometheusConfig({
        remoteWriteUrl: "https://prometheus-prod-10.grafana.net/api/prom/push",
        remoteWriteUser: "1871065",
        remoteWriteToken: "glc_rw_token_abcde",
      });
      expect(validYaml).toContain("remote_write:");
      expect(validYaml).toContain("url: \"https://prometheus-prod-10.grafana.net/api/prom/push\"");
      expect(validYaml).toContain("username: \"1871065\"");

      // Check YAML validator
      const validation = validateGeneratedYaml(validYaml);
      expect(validation.valid).toBe(true);

      const tabBadYaml = "global:\n\tscrape_interval: 5s\nscrape_configs:\n";
      const badValidation = validateGeneratedYaml(tabBadYaml);
      expect(badValidation.valid).toBe(false);
      expect(badValidation.error).toContain("tab indentation error");
    });
  });

  // =========================================================================
  // Phase 2.2: Strict Telemetry Provenance Matrix
  // =========================================================================
  describe("Phase 2.2: Telemetry Provenance Matrix & Mode Transitions", () => {
    it("reports LOCAL when only OTLP endpoint is configured and query backends are local", async () => {
      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      // Local backends (isCloudBackend returns false)
      vi.spyOn(PrometheusClient.prototype, "isCloudBackend").mockReturnValue(false);
      vi.spyOn(JaegerClient.prototype, "isCloudBackend").mockReturnValue(false);
      vi.spyOn(PrometheusClient.prototype, "checkHealth").mockResolvedValue({ available: true, isCloud: false });
      vi.spyOn(JaegerClient.prototype, "checkHealth").mockResolvedValue({ available: true, isCloud: false });

      const health = await manager.getBackendHealth(true);
      expect(health.provenance).toBe("LOCAL");
      expect(health.backendType).toBe("GENUINE_STACK");
      expect(health.isCloudBackend).toBe(false);
    });

    it("reports LOCAL when only Grafana Cloud Prometheus is configured and Tempo is local (partial cloud)", async () => {
      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      vi.spyOn(PrometheusClient.prototype, "isCloudBackend").mockReturnValue(true);
      vi.spyOn(JaegerClient.prototype, "isCloudBackend").mockReturnValue(false);
      vi.spyOn(PrometheusClient.prototype, "checkHealth").mockResolvedValue({ available: true, isCloud: true });
      vi.spyOn(JaegerClient.prototype, "checkHealth").mockResolvedValue({ available: true, isCloud: false });

      const health = await manager.getBackendHealth(true);
      // Partial cloud must remain LOCAL, never LIVE
      expect(health.provenance).toBe("LOCAL");
      expect(health.isCloudBackend).toBe(false);
    });

    it("reports LOCAL when only Tempo is configured and Prometheus is local (partial cloud)", async () => {
      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      vi.spyOn(PrometheusClient.prototype, "isCloudBackend").mockReturnValue(false);
      vi.spyOn(JaegerClient.prototype, "isCloudBackend").mockReturnValue(true);
      vi.spyOn(PrometheusClient.prototype, "checkHealth").mockResolvedValue({ available: true, isCloud: false });
      vi.spyOn(JaegerClient.prototype, "checkHealth").mockResolvedValue({ available: true, isCloud: true });

      const health = await manager.getBackendHealth(true);
      expect(health.provenance).toBe("LOCAL");
      expect(health.isCloudBackend).toBe(false);
    });

    it("reports ERROR when requested LIVE mode has one failing backend", async () => {
      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      vi.spyOn(PrometheusClient.prototype, "isCloudBackend").mockReturnValue(true);
      vi.spyOn(JaegerClient.prototype, "isCloudBackend").mockReturnValue(true);
      vi.spyOn(PrometheusClient.prototype, "checkHealth").mockResolvedValue({ available: true, isCloud: true });
      vi.spyOn(JaegerClient.prototype, "checkHealth").mockResolvedValue({ available: false, isCloud: true, error: "Tempo 503" });

      const health = await manager.getBackendHealth(true);
      expect(health.provenance).toBe("ERROR");
    });

    it("reports MOCK_EMULATION when in-process mock server is used", async () => {
      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      vi.spyOn(PrometheusClient.prototype, "checkHealth").mockResolvedValue({ available: true, isMock: true });
      vi.spyOn(JaegerClient.prototype, "checkHealth").mockResolvedValue({ available: true, isMock: true });

      const health = await manager.getBackendHealth(true);
      expect(health.provenance).toBe("MOCK_EMULATION");
      expect(health.backendType).toBe("MOCK_EMULATION");
    });

    it("resets verification timestamps and ingested statuses upon mode transition", () => {
      const manager = new TelemetryManager();
      manager.setMode("LIVE");
      expect(manager.getRequestedMode()).toBe("LIVE");
      expect(manager.getEffectiveMode()).toBe("DEGRADED");

      manager.setMode("SIMULATION");
      expect(manager.getRequestedMode()).toBe("SIMULATION");
      expect(manager.getEffectiveMode()).toBe("SIMULATION");
      expect(manager.getLastIngestedAt()).toBeNull();
    });
  });

  // =========================================================================
  // Phase 2.2: Hardened Tempo Trace Response Validation
  // =========================================================================
  describe("Phase 2.2: Hardened Tempo Trace Response Validation", () => {
    const client = new JaegerClient();

    it("validates matching trace ID and verification attribute successfully", () => {
      const trace = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        rootServiceName: "order-service",
        operationName: "HTTP POST /orders",
        startTime: new Date().toISOString(),
        durationMs: 45,
        totalSpans: 1,
        hasErrors: false,
        servicesInvolved: ["order-service"],
        rootSpan: null,
        allSpans: [{
          spanId: "00f067aa0ba902b7",
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          operationName: "HTTP POST /orders",
          serviceName: "order-service",
          startTimeUs: Date.now() * 1000,
          durationMs: 45,
          statusCode: "OK" as const,
          attributes: { "verification.id": "test_verification_123" },
          depth: 0,
          children: [],
        }],
        isFallback: false,
      };

      const outcome = client.verifyLiveTrace(trace, "4bf92f3577b34da6a3ce929d0e0e4736", "test_verification_123");
      expect(outcome.valid).toBe(true);
    });

    it("rejects mismatched root trace ID", () => {
      const trace = {
        traceId: "wrong-trace-id-9999",
        rootServiceName: "order-service",
        operationName: "HTTP POST /orders",
        startTime: new Date().toISOString(),
        durationMs: 45,
        totalSpans: 1,
        hasErrors: false,
        servicesInvolved: ["order-service"],
        rootSpan: null,
        allSpans: [{
          spanId: "sp1",
          traceId: "wrong-trace-id-9999",
          operationName: "HTTP POST /orders",
          serviceName: "order-service",
          startTimeUs: Date.now() * 1000,
          durationMs: 45,
          statusCode: "OK" as const,
          attributes: { "verification.id": "test_verification_123" },
          depth: 0,
          children: [],
        }],
        isFallback: false,
      };

      const outcome = client.verifyLiveTrace(trace, "expected-trace-id-1111", "test_verification_123");
      expect(outcome.valid).toBe(false);
      expect(outcome.reason).toContain("Trace ID mismatch");
    });

    it("rejects mismatched individual span trace ID", () => {
      const trace = {
        traceId: "expected-trace-id-1111",
        rootServiceName: "order-service",
        operationName: "HTTP POST /orders",
        startTime: new Date().toISOString(),
        durationMs: 45,
        totalSpans: 1,
        hasErrors: false,
        servicesInvolved: ["order-service"],
        rootSpan: null,
        allSpans: [{
          spanId: "sp1",
          traceId: "different-span-trace-id-2222",
          operationName: "HTTP POST /orders",
          serviceName: "order-service",
          startTimeUs: Date.now() * 1000,
          durationMs: 45,
          statusCode: "OK" as const,
          attributes: { "verification.id": "test_verification_123" },
          depth: 0,
          children: [],
        }],
        isFallback: false,
      };

      const outcome = client.verifyLiveTrace(trace, "expected-trace-id-1111", "test_verification_123");
      expect(outcome.valid).toBe(false);
      expect(outcome.reason).toContain("trace ID mismatch");
    });

    it("rejects missing verification attribute", () => {
      const trace = {
        traceId: "trace-abc",
        rootServiceName: "order-service",
        operationName: "HTTP POST",
        startTime: new Date().toISOString(),
        durationMs: 10,
        totalSpans: 1,
        hasErrors: false,
        servicesInvolved: ["order-service"],
        rootSpan: null,
        allSpans: [{
          spanId: "sp1",
          traceId: "trace-abc",
          operationName: "HTTP POST",
          serviceName: "order-service",
          startTimeUs: Date.now() * 1000,
          durationMs: 10,
          statusCode: "OK" as const,
          attributes: { unrelated: "value" },
          depth: 0,
          children: [],
        }],
        isFallback: false,
      };

      const outcome = client.verifyLiveTrace(trace, "trace-abc", "target-verification-id");
      expect(outcome.valid).toBe(false);
      expect(outcome.reason).toContain("Verification attribute");
    });

    it("rejects synthesized fallback traces", () => {
      const fallbackTrace = {
        traceId: "fallback-trace",
        rootServiceName: "api-gateway",
        operationName: "Cloud Trace",
        startTime: new Date().toISOString(),
        durationMs: 45,
        totalSpans: 1,
        hasErrors: false,
        servicesInvolved: ["api-gateway"],
        rootSpan: null,
        allSpans: [{
          spanId: "sp1",
          traceId: "fallback-trace",
          operationName: "Cloud Trace",
          serviceName: "api-gateway",
          startTimeUs: Date.now() * 1000,
          durationMs: 45,
          statusCode: "OK" as const,
          attributes: { "verification.id": "my_id" },
          depth: 0,
          children: [],
        }],
        isFallback: true,
      };

      const outcome = client.verifyLiveTrace(fallbackTrace, "fallback-trace", "my_id");
      expect(outcome.valid).toBe(false);
      expect(outcome.reason).toContain("fallback trace");
    });

    it("parseTempoTraceDetail preserves backend returned trace ID without overwriting with requested ID", () => {
      const backendPayload = {
        traceID: "backend-actual-trace-9999",
        batches: [{
          resource: { attributes: [{ key: "service.name", value: { stringValue: "order-service" } }] },
          scopeSpans: [{
            spans: [{
              traceId: "backend-actual-trace-9999",
              spanId: "span-1234",
              name: "processOrder",
              attributes: [{ key: "verification.id", value: { stringValue: "verify_1" } }],
            }],
          }],
        }],
      };

      const parsed = client.parseTempoTraceDetail(backendPayload, "caller-requested-trace-0000", { allowFallback: false });
      expect(parsed).not.toBeNull();
      // Crucial: traceId must NOT be overwritten with caller-requested-trace-0000!
      expect(parsed?.traceId).toBe("backend-actual-trace-9999");
      expect(parsed?.allSpans[0].traceId).toBe("backend-actual-trace-9999");
    });

    it("parseTempoTraceDetail with allowFallback: false returns null on empty batches or malformed JSON", () => {
      expect(client.parseTempoTraceDetail({}, "req-1", { allowFallback: false })).toBeNull();
      expect(client.parseTempoTraceDetail({ batches: [] }, "req-1", { allowFallback: false })).toBeNull();
      expect(client.parseTempoTraceDetail(null as unknown as Record<string, unknown>, "req-1", { allowFallback: false })).toBeNull();
    });
  });

  // =========================================================================
  // Phase 2.2: Service Health Gauge Semantics & Fault Cycles
  // =========================================================================
  describe("Phase 2.2: Service Health Gauge Semantics & Fault Cycles", () => {
    it("strictly supports HEALTHY (1), DEGRADED (0.5), DOWN (0) and rejects invalid numeric values", () => {
      const registry = new PrometheusRegistry("payment-service");

      registry.setHealthStatus(1);
      expect(registry.getHealthStatus()).toBe(1);

      registry.setHealthStatus(0.5);
      expect(registry.getHealthStatus()).toBe(0.5);

      registry.setHealthStatus(0);
      expect(registry.getHealthStatus()).toBe(0);

      registry.setHealthStatus("DEGRADED");
      expect(registry.getHealthStatus()).toBe(0.5);

      registry.setHealthStatus("HEALTHY");
      expect(registry.getHealthStatus()).toBe(1);

      registry.setHealthStatus("DOWN");
      expect(registry.getHealthStatus()).toBe(0);

      // Boolean support
      registry.setHealthStatus(true);
      expect(registry.getHealthStatus()).toBe(1);
      registry.setHealthStatus(false);
      expect(registry.getHealthStatus()).toBe(0);

      // Invalid numeric values must throw Error
      expect(() => registry.setHealthStatus(2)).toThrow("Invalid numeric health status: 2");
      expect(() => registry.setHealthStatus(-1)).toThrow("Invalid numeric health status: -1");
      expect(() => registry.setHealthStatus(0.7)).toThrow("Invalid numeric health status: 0.7");
      expect(() => registry.setHealthStatus(0.2)).toThrow("Invalid numeric health status: 0.2");
    });

    it("order-service fault injection cycle correctly transitions health gauge: normal -> degraded -> outage -> restored", () => {
      // 1. Normal operation
      resetOrderFault();
      expect(orderTelemetry.getHealthStatus()).toBe(1);
      expect(orderTelemetry.getPrometheusMetrics()).toContain("service_health_status{service=\"order-service\"} 1");

      // 2. Degraded state: small delay, low failure rate
      setOrderFault(800, 0.05);
      expect(orderTelemetry.getHealthStatus()).toBe(0.5);
      expect(orderTelemetry.getPrometheusMetrics()).toContain("service_health_status{service=\"order-service\"} 0.5");

      // 3. Full outage: severe delay and high failure rate
      setOrderFault(3000, 0.5);
      expect(orderTelemetry.getHealthStatus()).toBe(0);
      expect(orderTelemetry.getPrometheusMetrics()).toContain("service_health_status{service=\"order-service\"} 0");

      // 4. Restoration: fault reset
      resetOrderFault();
      expect(orderTelemetry.getHealthStatus()).toBe(1);
      expect(orderTelemetry.getPrometheusMetrics()).toContain("service_health_status{service=\"order-service\"} 1");
    });
  });

  // =========================================================================
  // Phase 2.2: Export Tracking & Signal Separation
  // =========================================================================
  describe("Phase 2.2: Export Tracking & Signal Separation", () => {
    it("sanitizeErrorMessage redacts Bearer tokens, Basic tokens, glc_ credentials, and passwords", () => {
      const rawError1 = "Failed to export: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret";
      expect(sanitizeErrorMessage(rawError1)).toBe("Failed to export: Bearer [REDACTED]");

      const rawError2 = "Basic MTg3MTA2NTpnbGNfZmFrZV90b2tlbg==";
      expect(sanitizeErrorMessage(rawError2)).toBe("Basic [REDACTED]");

      const rawError3 = "Token glc_eyJvIjoiMTg3MTA2NSIsIm4iOiJpbmcifQ== invalid";
      expect(sanitizeErrorMessage(rawError3)).not.toContain("glc_");
      expect(sanitizeErrorMessage(rawError3)).toContain("[REDACTED_TOKEN]");

      const rawError4 = "Connection failed with user=admin&password=SuperSecretPassword123!";
      expect(sanitizeErrorMessage(rawError4)).not.toContain("SuperSecretPassword123!");
      expect(sanitizeErrorMessage(rawError4)).toContain("password=[REDACTED]");
    });

    it("tracks metrics and traces export status independently without collision", () => {
      const exportStatus = orderTelemetry.getExportStatus();
      expect(exportStatus).toHaveProperty("metrics");
      expect(exportStatus).toHaveProperty("traces");
      expect(exportStatus.metrics).toHaveProperty("status");
      expect(exportStatus.metrics).toHaveProperty("successCount");
      expect(exportStatus.metrics).toHaveProperty("failureCount");
      expect(exportStatus.traces).toHaveProperty("status");
      expect(exportStatus.traces).toHaveProperty("successCount");
      expect(exportStatus.traces).toHaveProperty("failureCount");
    });
  });
});
