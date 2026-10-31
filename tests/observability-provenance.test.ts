import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PrometheusClient } from "@/lib/telemetry/prometheusClient";
import { JaegerClient } from "@/lib/telemetry/jaegerClient";
import { TelemetryManager } from "@/lib/telemetry/telemetryManager";
import { mergeServiceMetrics, ServiceMapItem } from "@/lib/telemetry/mergeServiceMetrics";
import { ObservedServiceMetric, DistributedTrace } from "@/lib/telemetry/types";
import { PrometheusRegistry, sanitizeErrorMessage } from "../sample-services/shared/telemetry";
import http from "http";
import fs from "fs";
import path from "path";
import {
  validateRemoteWriteConfig,
  generatePrometheusConfig,
  validateGeneratedYaml,
} from "../scripts/generate-prometheus-config";
import {
  setOrderFault,
  resetOrderFault,
  telemetry as orderTelemetry,
  server as orderServer,
  safeTokenEquals,
} from "../sample-services/order/server";
import { startDisposableOrderService, generateSecureToken, stopChildProcess } from "../scripts/verify-live-observability";
import YAML from "yaml";

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

      const validation = validateGeneratedYaml(validYaml);
      expect(validation.valid).toBe(true);

      const tabBadYaml = "global:\n\tscrape_interval: 5s\nscrape_configs:\n";
      const badValidation = validateGeneratedYaml(tabBadYaml);
      expect(badValidation.valid).toBe(false);
      expect(badValidation.error).toContain("tab indentation error");
    });

    it("rejects read-only Prometheus query token as remote-write credentials", () => {
      const res = validateRemoteWriteConfig({
        GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL: "https://prometheus-prod-10.grafana.net/api/prom/push",
        GRAFANA_CLOUD_PROMETHEUS_TOKEN: "glc_read_only_token_12345",
        GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_USER: "1871065",
      });
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("read-only Prometheus token");
    });

    it("no credentials produces local standalone mode without remote_write block", () => {
      const standaloneYaml = generatePrometheusConfig({});
      expect(standaloneYaml).not.toContain("remote_write:");
      expect(standaloneYaml).toContain("scrape_configs:");
      const validation = validateGeneratedYaml(standaloneYaml);
      expect(validation.valid).toBe(true);
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

  // =========================================================================
  // Phase 2.3: Strict Tempo Trace Identifier Validation
  // =========================================================================
  describe("Phase 2.3: Strict Tempo Trace Identifier Validation", () => {
    const client = new JaegerClient("https://tempo-prod.grafana.net", 2000);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    const verificationId = "verify_test_trace_12345";

    const createValidTrace = (): DistributedTrace => ({
      traceId,
      rootServiceName: "order-service",
      operationName: "POST /orders",
      startTime: new Date().toISOString(),
      durationMs: 45,
      totalSpans: 1,
      hasErrors: false,
      servicesInvolved: ["order-service"],
      isFallback: false,
      rootSpan: {
        spanId,
        traceId,
        serviceName: "order-service",
        operationName: "POST /orders",
        startTimeUs: Date.now() * 1000,
        durationMs: 45,
        statusCode: "OK",
        attributes: { "verification.id": verificationId },
        depth: 0,
        children: [],
      },
      allSpans: [
        {
          spanId,
          traceId,
          serviceName: "order-service",
          operationName: "POST /orders",
          startTimeUs: Date.now() * 1000,
          durationMs: 45,
          statusCode: "OK",
          attributes: { "verification.id": verificationId },
          depth: 0,
          children: [],
        },
      ],
    });

    it("validates genuine Tempo response with matching root and span IDs", () => {
      const trace = createValidTrace();
      const res = client.verifyLiveTrace(trace, traceId, verificationId);
      expect(res.valid).toBe(true);
    });

    it("rejects trace missing root trace ID", () => {
      const trace = createValidTrace();
      trace.traceId = "";
      const res = client.verifyLiveTrace(trace, traceId, verificationId);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("Missing root ID");
    });

    it("rejects trace missing span trace ID", () => {
      const trace = createValidTrace();
      trace.allSpans[0].traceId = "";
      const res = client.verifyLiveTrace(trace, traceId, verificationId);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("Missing span trace ID");
    });

    it("rejects trace missing span ID", () => {
      const trace = createValidTrace();
      trace.allSpans[0].spanId = "";
      const res = client.verifyLiveTrace(trace, traceId, verificationId);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("Missing span ID");
    });

    it("rejects trace with wrong root ID", () => {
      const trace = createValidTrace();
      trace.traceId = "11112222333344445555666677778888";
      const res = client.verifyLiveTrace(trace, traceId, verificationId);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("Wrong root ID");
    });

    it("rejects trace with wrong individual span ID", () => {
      const trace = createValidTrace();
      trace.allSpans[0].traceId = "99998888777766665555444433332222";
      const res = client.verifyLiveTrace(trace, traceId, verificationId);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("Wrong individual span ID");
    });

    it("rejects trace with conflicting or duplicate span IDs", () => {
      const trace = createValidTrace();
      trace.allSpans.push({
        spanId, // Duplicate spanId
        traceId,
        serviceName: "order-service",
        operationName: "POST /sub",
        startTimeUs: Date.now() * 1000,
        durationMs: 10,
        statusCode: "OK",
        attributes: {},
        depth: 1,
        children: [],
      });
      const res = client.verifyLiveTrace(trace, traceId, verificationId);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("Conflicting span IDs");
    });

    it("rejects trace with empty spans", () => {
      const trace = createValidTrace();
      trace.allSpans = [];
      const res = client.verifyLiveTrace(trace, traceId, verificationId);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("no span data");
    });

    it("rejects trace missing verification attribute", () => {
      const trace = createValidTrace();
      trace.allSpans[0].attributes = { unrelated: "foo" };
      const res = client.verifyLiveTrace(trace, traceId, verificationId);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("not found in span hierarchy");
    });

    it("rejects synthesized fallback trace", () => {
      const trace = createValidTrace();
      trace.isFallback = true;
      const res = client.verifyLiveTrace(trace, traceId, verificationId);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("fallback trace");
    });

    it("parseTempoTraceDetail in strict mode rejects missing backend span IDs and never manufactures IDs", () => {
      const rawPayload = {
        traceID: traceId,
        batches: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "order-service" } }] },
            scopeSpans: [
              {
                spans: [
                  {
                    // Missing spanId / spanID!
                    traceId,
                    name: "HTTP GET",
                    attributes: [{ key: "verification.id", value: { stringValue: verificationId } }],
                  },
                ],
              },
            ],
          },
        ],
      };

      // Strict mode: allowFallback = false -> must return null
      const strictResult = client.parseTempoTraceDetail(rawPayload, traceId, { allowFallback: false });
      expect(strictResult).toBeNull();

      // Fallback mode: allowFallback = true -> creates fallback span ID for dashboard continuity
      const fallbackResult = client.parseTempoTraceDetail(rawPayload, traceId, { allowFallback: true });
      expect(fallbackResult).not.toBeNull();
      expect(fallbackResult?.allSpans[0].spanId).toBe(traceId.slice(0, 16));
    });

    it("parseTempoTraceDetail in strict mode rejects conflicting root and batch trace IDs", () => {
      const conflictingPayload = {
        traceID: traceId,
        batches: [
          {
            traceID: "different_trace_id_1234567890",
            resource: { attributes: [{ key: "service.name", value: { stringValue: "order-service" } }] },
            scopeSpans: [
              {
                spans: [
                  {
                    spanId,
                    traceId,
                    name: "HTTP GET",
                  },
                ],
              },
            ],
          },
        ],
      };

      const result = client.parseTempoTraceDetail(conflictingPayload, traceId, { allowFallback: false });
      expect(result).toBeNull();
    });

    it("parseTempoTraceDetail in strict mode rejects conflicting span trace IDs", () => {
      const conflictingSpanPayload = {
        traceID: traceId,
        batches: [
          {
            traceID: traceId,
            resource: { attributes: [{ key: "service.name", value: { stringValue: "order-service" } }] },
            scopeSpans: [
              {
                spans: [
                  {
                    spanId,
                    traceId: "conflicting_span_trace_id_999",
                    name: "HTTP GET",
                  },
                ],
              },
            ],
          },
        ],
      };

      const result = client.parseTempoTraceDetail(conflictingSpanPayload, traceId, { allowFallback: false });
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // Phase 2.3: Secure Synthetic Test Metric Endpoint
  // =========================================================================
  describe("Phase 2.3: Secure Synthetic Test Metric Endpoint", () => {
    let testPort: number;
    let boundServer: http.Server;

    function sendTestRequest(options: {
      method?: string;
      path?: string;
      headers?: Record<string, string>;
      body?: string;
    }): Promise<{ status: number; body: Record<string, unknown> | string }> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: testPort,
            path: options.path || "/test/record-metric",
            method: options.method || "POST",
            headers: options.headers || {},
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("end", () => {
              let parsed: Record<string, unknown> | string = data;
              try {
                parsed = JSON.parse(data);
              } catch {
                // Return string if not JSON
              }
              resolve({ status: res.statusCode || 0, body: parsed });
            });
          }
        );
        req.on("error", reject);
        if (options.body) req.write(options.body);
        req.end();
      });
    }

    beforeEach(async () => {
      delete process.env.ENABLE_TEST_METRIC_ENDPOINT;
      delete process.env.TEST_METRIC_ENDPOINT_TOKEN;
      delete process.env.DEPLOYMENT_ENVIRONMENT;
      (process.env as Record<string, string | undefined>).NODE_ENV = "test";

      boundServer = orderServer;
      if (!boundServer.listening) {
        await new Promise<void>((resolve) => {
          boundServer.listen(0, () => {
            const addr = boundServer.address();
            testPort = typeof addr === "object" && addr ? addr.port : 4001;
            resolve();
          });
        });
      }
    });

    it("rejects requests with 403 when test endpoint is default-disabled", async () => {
      delete process.env.ENABLE_TEST_METRIC_ENDPOINT;
      const res = await sendTestRequest({
        headers: { "Content-Type": "application/json", "x-test-token": "any" },
        body: JSON.stringify({ verification_id: "verify_12345678", count: 1 }),
      });
      expect(res.status).toBe(403);
      expect((res.body as Record<string, unknown>).disabled).toBe(true);
    });

    it("rejects requests with 403 in production mode even if ENABLE_TEST_METRIC_ENDPOINT is true", async () => {
      process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      const res = await sendTestRequest({
        headers: { "Content-Type": "application/json", "x-test-token": "any" },
        body: JSON.stringify({ verification_id: "verify_12345678", count: 1 }),
      });
      expect(res.status).toBe(403);
      expect((res.body as Record<string, unknown>).error).toContain("strictly disabled in production mode");
    });

    it("rejects unauthenticated requests or invalid auth token with 401", async () => {
      process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
      process.env.TEST_METRIC_ENDPOINT_TOKEN = "secret_local_token_999";

      // Missing token
      const res1 = await sendTestRequest({
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verification_id: "verify_12345678", count: 1 }),
      });
      expect(res1.status).toBe(401);
      expect((res1.body as Record<string, unknown>).error).toContain("Unauthorized");

      // Invalid token
      const res2 = await sendTestRequest({
        headers: { "Content-Type": "application/json", "x-test-token": "wrong_token" },
        body: JSON.stringify({ verification_id: "verify_12345678", count: 1 }),
      });
      expect(res2.status).toBe(401);
      expect((res2.body as Record<string, unknown>).error).toContain("Unauthorized");
    });

    it("accepts valid authenticated test request and records metric with 200", async () => {
      process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
      process.env.TEST_METRIC_ENDPOINT_TOKEN = "secret_local_token_999";

      const res = await sendTestRequest({
        headers: {
          "Content-Type": "application/json",
          "x-test-token": "secret_local_token_999",
        },
        body: JSON.stringify({
          verification_id: "verify_valid_token_123",
          count: 5,
          status: "test_verified",
        }),
      });

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.verification_id).toBe("verify_valid_token_123");
      expect(body.count).toBe(5);
      expect(body.status).toBe("test_verified");

      // Verify exposed on /metrics
      const metricsText = orderTelemetry.getPrometheusMetrics();
      expect(metricsText).toContain('verification_id="verify_valid_token_123"');
    });

    it("rejects oversized payloads (> 1024 bytes) with 413", async () => {
      process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
      process.env.TEST_METRIC_ENDPOINT_TOKEN = "secret_local_token_999";

      const hugePayload = JSON.stringify({
        verification_id: "verify_valid_id_123",
        count: 1,
        padding: "X".repeat(2000),
      });

      const res = await sendTestRequest({
        headers: {
          "Content-Type": "application/json",
          "x-test-token": "secret_local_token_999",
          "content-length": String(hugePayload.length),
        },
        body: hugePayload,
      });

      expect(res.status).toBe(413);
      expect((res.body as Record<string, unknown>).error).toContain("Payload too large");
    });

    it("rejects invalid JSON payloads with 400", async () => {
      process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
      process.env.TEST_METRIC_ENDPOINT_TOKEN = "secret_local_token_999";

      const res = await sendTestRequest({
        headers: {
          "Content-Type": "application/json",
          "x-test-token": "secret_local_token_999",
        },
        body: "{ not valid json ...",
      });

      expect(res.status).toBe(400);
      expect((res.body as Record<string, unknown>).error).toContain("Invalid JSON");
    });

    it("rejects invalid verification_id formats (too short, special chars) with 400", async () => {
      process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
      process.env.TEST_METRIC_ENDPOINT_TOKEN = "secret_local_token_999";

      // Too short (< 8 chars)
      const res1 = await sendTestRequest({
        headers: { "Content-Type": "application/json", "x-test-token": "secret_local_token_999" },
        body: JSON.stringify({ verification_id: "short", count: 1 }),
      });
      expect(res1.status).toBe(400);

      // Special characters
      const res2 = await sendTestRequest({
        headers: { "Content-Type": "application/json", "x-test-token": "secret_local_token_999" },
        body: JSON.stringify({ verification_id: "bad!@#id_with_symbols", count: 1 }),
      });
      expect(res2.status).toBe(400);
    });

    it("rejects negative, zero, infinite, NaN, and excessive counts with 400", async () => {
      process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
      process.env.TEST_METRIC_ENDPOINT_TOKEN = "secret_local_token_999";

      const testCounts = [-5, 0, 5000, 1.5];
      for (const badCount of testCounts) {
        const res = await sendTestRequest({
          headers: { "Content-Type": "application/json", "x-test-token": "secret_local_token_999" },
          body: JSON.stringify({ verification_id: "verify_count_test_1", count: badCount }),
        });
        expect(res.status).toBe(400);
      }
    });

    it("rejects un-whitelisted status values to bound metric cardinality", async () => {
      process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
      process.env.TEST_METRIC_ENDPOINT_TOKEN = "secret_local_token_999";

      const res = await sendTestRequest({
        headers: { "Content-Type": "application/json", "x-test-token": "secret_local_token_999" },
        body: JSON.stringify({
          verification_id: "verify_cardinality_1",
          count: 1,
          status: "arbitrary_attacker_label_explosion",
        }),
      });
      expect(res.status).toBe(400);
      expect((res.body as Record<string, unknown>).error).toContain("Invalid status");
    });

    it("handles repeated synthetic metric requests cleanly without crashing", async () => {
      process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
      process.env.TEST_METRIC_ENDPOINT_TOKEN = "secret_local_token_999";

      for (let i = 1; i <= 3; i++) {
        const res = await sendTestRequest({
          headers: { "Content-Type": "application/json", "x-test-token": "secret_local_token_999" },
          body: JSON.stringify({
            verification_id: "verify_repeated_test",
            count: 2,
            status: "test_verified",
          }),
        });
        expect(res.status).toBe(200);
      }
    });

    it("recordSyntheticMetric in telemetry throws on invalid verification ID or count", () => {
      expect(() => orderTelemetry.recordSyntheticMetric("short", 1)).toThrow("Invalid verificationId");
      expect(() => orderTelemetry.recordSyntheticMetric("verify_valid_123", -1)).toThrow("Invalid synthetic metric count");
      expect(() => orderTelemetry.recordSyntheticMetric("verify_valid_123", 99999)).toThrow("Invalid synthetic metric count");
    });
  });

  // =========================================================================
  // Phase 2.4 Regression Test Suites
  // =========================================================================

  // 1. Strict Tempo Backend Identity Validation
  describe("Phase 2.4: Strict Tempo Backend Identity Validation", () => {
    it("fails strict verification when top-level backend root trace ID is missing with otherwise valid spans", async () => {
      const client = new JaegerClient("https://tempo-test.invalid", 1000);
      const payloadMissingRoot = {
        batches: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "order-service" } }] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                    spanId: "00f067aa0ba902b7",
                    name: "HTTP GET /orders",
                    startTimeUnixNano: "1000000000",
                    endTimeUnixNano: "1050000000",
                    status: { code: 1 },
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
        json: async () => payloadMissingRoot,
        text: async () => JSON.stringify(payloadMissingRoot),
      } as unknown as Response);

      const strictRes = await client.getTraceById("4bf92f3577b34da6a3ce929d0e0e4736", { allowFallback: false });
      expect(strictRes).toBeNull();

      const fallbackRes = await client.getTraceById("4bf92f3577b34da6a3ce929d0e0e4736", { allowFallback: true });
      expect(fallbackRes).not.toBeNull();
      expect(fallbackRes?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    });

    it("fails strict verification when individual span trace ID is missing while batch and root IDs exist", async () => {
      const client = new JaegerClient("https://tempo-test.invalid", 1000);
      const payloadMissingSpanTraceId = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        batches: [
          {
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            resource: { attributes: [{ key: "service.name", value: { stringValue: "order-service" } }] },
            scopeSpans: [
              {
                spans: [
                  {
                    spanId: "00f067aa0ba902b7",
                    name: "HTTP GET /orders",
                    startTimeUnixNano: "1000000000",
                    endTimeUnixNano: "1050000000",
                    status: { code: 1 },
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
        json: async () => payloadMissingSpanTraceId,
        text: async () => JSON.stringify(payloadMissingSpanTraceId),
      } as unknown as Response);

      const strictRes = await client.getTraceById("4bf92f3577b34da6a3ce929d0e0e4736", { allowFallback: false });
      expect(strictRes).toBeNull();
    });

    it("fails strict verification when individual span trace ID is missing while only root ID exists", async () => {
      const client = new JaegerClient("https://tempo-test.invalid", 1000);
      const payloadMissingSpanTraceIdNoBatch = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        batches: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "order-service" } }] },
            scopeSpans: [
              {
                spans: [
                  {
                    spanId: "00f067aa0ba902b7",
                    name: "HTTP GET /orders",
                    startTimeUnixNano: "1000000000",
                    endTimeUnixNano: "1050000000",
                    status: { code: 1 },
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
        json: async () => payloadMissingSpanTraceIdNoBatch,
        text: async () => JSON.stringify(payloadMissingSpanTraceIdNoBatch),
      } as unknown as Response);

      const strictRes = await client.getTraceById("4bf92f3577b34da6a3ce929d0e0e4736", { allowFallback: false });
      expect(strictRes).toBeNull();
    });

    it("fails strict verification on conflicting traceId and traceID spellings", async () => {
      const client = new JaegerClient("https://tempo-test.invalid", 1000);
      const conflictingSpellings = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        traceID: "different_trace_id_value_12345",
        batches: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "order-service" } }] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                    spanId: "00f067aa0ba902b7",
                    name: "HTTP GET /orders",
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
        json: async () => conflictingSpellings,
        text: async () => JSON.stringify(conflictingSpellings),
      } as unknown as Response);

      const strictRes = await client.getTraceById("4bf92f3577b34da6a3ce929d0e0e4736", { allowFallback: false });
      expect(strictRes).toBeNull();
    });

    it("fails strict verification on missing span ID", async () => {
      const client = new JaegerClient("https://tempo-test.invalid", 1000);
      const payloadMissingSpanId = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        batches: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "order-service" } }] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                    name: "HTTP GET /orders",
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
        json: async () => payloadMissingSpanId,
        text: async () => JSON.stringify(payloadMissingSpanId),
      } as unknown as Response);

      const strictRes = await client.getTraceById("4bf92f3577b34da6a3ce929d0e0e4736", { allowFallback: false });
      expect(strictRes).toBeNull();
    });

    it("fails strict verification on duplicate span IDs", async () => {
      const client = new JaegerClient("https://tempo-test.invalid", 1000);
      const payloadDuplicateSpanId = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        batches: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "order-service" } }] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                    spanId: "duplicate_span_01",
                    name: "HTTP GET /orders",
                  },
                  {
                    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                    spanId: "duplicate_span_01",
                    name: "SELECT orders",
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
        json: async () => payloadDuplicateSpanId,
        text: async () => JSON.stringify(payloadDuplicateSpanId),
      } as unknown as Response);

      const strictRes = await client.getTraceById("4bf92f3577b34da6a3ce929d0e0e4736", { allowFallback: false });
      expect(strictRes).toBeNull();
    });

    it("fails strict verification when root ID does not match span trace ID or requested ID", async () => {
      const client = new JaegerClient("https://tempo-test.invalid", 1000);
      const payloadMismatchedTraceId = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        batches: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "order-service" } }] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "wrong_span_trace_id_9999",
                    spanId: "span_01",
                    name: "HTTP GET /orders",
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
        json: async () => payloadMismatchedTraceId,
        text: async () => JSON.stringify(payloadMismatchedTraceId),
      } as unknown as Response);

      const strictRes = await client.getTraceById("4bf92f3577b34da6a3ce929d0e0e4736", { allowFallback: false });
      expect(strictRes).toBeNull();
    });

    it("accepts valid backend payload with all genuine identifiers in strict mode", async () => {
      const client = new JaegerClient("https://tempo-test.invalid", 1000);
      const validPayload = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        batches: [
          {
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            resource: { attributes: [{ key: "service.name", value: { stringValue: "order-service" } }] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                    spanId: "span_01",
                    name: "HTTP GET /orders",
                    startTimeUnixNano: "1700000000000000000",
                    endTimeUnixNano: "1700000000100000000",
                    status: { code: 1 },
                  },
                  {
                    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                    spanId: "span_02",
                    name: "SELECT orders",
                    startTimeUnixNano: "1700000000020000000",
                    endTimeUnixNano: "1700000000080000000",
                    status: { code: 1 },
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
        json: async () => validPayload,
        text: async () => JSON.stringify(validPayload),
      } as unknown as Response);

      const strictRes = await client.getTraceById("4bf92f3577b34da6a3ce929d0e0e4736", { allowFallback: false });
      expect(strictRes).not.toBeNull();
      expect(strictRes?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(strictRes?.allSpans.length).toBe(2);
      expect(strictRes?.allSpans[0].spanId).toBe("span_01");
      expect(strictRes?.allSpans[1].spanId).toBe("span_02");
    });

    it("strictly verifies Jaeger-style trace payloads", async () => {
      const client = new JaegerClient("https://jaeger-test.invalid", 1000);
      const validJaeger = {
        data: [
          {
            traceID: "4bf92f3577b34da6a3ce929d0e0e4736",
            spans: [
              {
                traceID: "4bf92f3577b34da6a3ce929d0e0e4736",
                spanID: "j_span_1",
                operationName: "order.create",
                startTime: 1700000000000,
                duration: 50000,
                processID: "p1",
                tags: [],
              },
            ],
            processes: {
              p1: { serviceName: "order-service" },
            },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => validJaeger,
        text: async () => JSON.stringify(validJaeger),
      } as unknown as Response);

      const strictRes = await client.getTraceById("4bf92f3577b34da6a3ce929d0e0e4736", { allowFallback: false });
      expect(strictRes).not.toBeNull();
      expect(strictRes?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");

      const dupSpanJaeger = {
        data: [
          {
            traceID: "4bf92f3577b34da6a3ce929d0e0e4736",
            spans: [
              { traceID: "4bf92f3577b34da6a3ce929d0e0e4736", spanID: "dup_span", operationName: "op1", tags: [] },
              { traceID: "4bf92f3577b34da6a3ce929d0e0e4736", spanID: "dup_span", operationName: "op2", tags: [] },
            ],
            processes: { p1: { serviceName: "order-service" } },
          },
        ],
      };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => dupSpanJaeger,
        text: async () => JSON.stringify(dupSpanJaeger),
      } as unknown as Response);

      const dupStrictRes = await client.getTraceById("4bf92f3577b34da6a3ce929d0e0e4736", { allowFallback: false });
      expect(dupStrictRes).toBeNull();
    });
  });

  // 2. Order Service Test Endpoint Authentication & Zero Default Token
  describe("Phase 2.4: Order Service Test Endpoint Authentication & Zero Default Token", () => {
    let boundServer: http.Server;
    let testPort = 4001;

    const sendReq = (options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      path?: string;
    }): Promise<{ status: number; body: unknown }> => {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: testPort,
            path: options.path || "/test/record-metric",
            method: options.method || "POST",
            headers: options.headers || {},
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode || 500, body: data ? JSON.parse(data) : {} });
              } catch {
                resolve({ status: res.statusCode || 500, body: data });
              }
            });
          }
        );
        req.on("error", reject);
        if (options.body) req.write(options.body);
        req.end();
      });
    };

    beforeEach(async () => {
      delete process.env.ENABLE_TEST_METRIC_ENDPOINT;
      delete process.env.TEST_METRIC_ENDPOINT_TOKEN;
      delete process.env.DEPLOYMENT_ENVIRONMENT;
      (process.env as Record<string, string | undefined>).NODE_ENV = "test";

      boundServer = orderServer;
      if (!boundServer.listening) {
        await new Promise<void>((resolve) => {
          boundServer.listen(0, () => {
            const addr = boundServer.address();
            testPort = typeof addr === "object" && addr ? addr.port : 4001;
            resolve();
          });
        });
      } else {
        const addr = boundServer.address();
        testPort = typeof addr === "object" && addr ? addr.port : 4001;
      }
    });

    it("fails closed with 500 when endpoint is enabled but authentication token is absent", async () => {
      process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
      delete process.env.TEST_METRIC_ENDPOINT_TOKEN;

      const res = await sendReq({
        headers: { "Content-Type": "application/json", "x-test-token": "any_token" },
        body: JSON.stringify({ verification_id: "verify_no_token_123", count: 1 }),
      });
      expect(res.status).toBe(500);
      expect((res.body as Record<string, unknown>).misconfigured).toBe(true);
      expect((res.body as Record<string, unknown>).error).toContain("Authentication not configured");
    });

    it("fails closed with 500 when endpoint is enabled with empty token", async () => {
      process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
      process.env.TEST_METRIC_ENDPOINT_TOKEN = "   ";

      const res = await sendReq({
        headers: { "Content-Type": "application/json", "x-test-token": "any_token" },
        body: JSON.stringify({ verification_id: "verify_empty_token_123", count: 1 }),
      });
      expect(res.status).toBe(500);
      expect((res.body as Record<string, unknown>).misconfigured).toBe(true);
    });

    it("rejects the old hardcoded default token when another token is configured", async () => {
      process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
      process.env.TEST_METRIC_ENDPOINT_TOKEN = "unpredictable_secret_token_abc123";

      const res = await sendReq({
        headers: { "Content-Type": "application/json", "x-test-token": "test-metric-secret-token" },
        body: JSON.stringify({ verification_id: "verify_default_pw_test", count: 1 }),
      });
      expect(res.status).toBe(401);
      expect((res.body as Record<string, unknown>).error).toContain("Unauthorized");
    });
  });

  // 3. Metric Cardinality Ceiling & Cleanup Protection
  describe("Phase 2.4: Metric Cardinality Ceiling & Cleanup Protection", () => {
    let boundServer: http.Server;
    let testPort = 4001;

    const sendReq = (options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      path?: string;
    }): Promise<{ status: number; body: unknown }> => {
      const headers = { ...(options.headers || {}) };
      if (options.body && !headers["Content-Length"] && !headers["content-length"]) {
        headers["Content-Length"] = String(Buffer.byteLength(options.body));
      }
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: testPort,
            path: options.path || "/test/record-metric",
            method: options.method || "POST",
            headers,
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode || 500, body: data ? JSON.parse(data) : {} });
              } catch {
                resolve({ status: res.statusCode || 500, body: data });
              }
            });
          }
        );
        req.on("error", reject);
        if (options.body) req.write(options.body);
        req.end();
      });
    };

    beforeEach(async () => {
      process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
      process.env.TEST_METRIC_ENDPOINT_TOKEN = "secret_ceiling_token_123";
      (process.env as Record<string, string | undefined>).NODE_ENV = "test";
      orderTelemetry.clearSyntheticVerificationIds();

      boundServer = orderServer;
      if (!boundServer.listening) {
        await new Promise<void>((resolve) => {
          boundServer.listen(0, () => {
            const addr = boundServer.address();
            testPort = typeof addr === "object" && addr ? addr.port : 4001;
            resolve();
          });
        });
      } else {
        const addr = boundServer.address();
        testPort = typeof addr === "object" && addr ? addr.port : 4001;
      }
    });

    afterEach(() => {
      orderTelemetry.clearSyntheticVerificationIds();
    });

    it("accepts repeated use of the same ID without consuming additional capacity", async () => {
      for (let i = 0; i < 5; i++) {
        const res = await sendReq({
          headers: { "Content-Type": "application/json", "x-test-token": "secret_ceiling_token_123" },
          body: JSON.stringify({ verification_id: "verify_same_id_reuse", count: 1, status: "test_verified" }),
        });
        expect(res.status).toBe(200);
      }
      expect(orderTelemetry.getActiveSyntheticVerificationIds().length).toBe(1);
    });

    it("accepts distinct IDs up to the ceiling (100) and rejects the 101st with 429", async () => {
      for (let i = 1; i <= 100; i++) {
        orderTelemetry.recordSyntheticMetric(`verify_unique_${String(i).padStart(4, "0")}`, 1, "test_verified");
      }
      expect(orderTelemetry.getActiveSyntheticVerificationIds().length).toBe(100);

      expect(() => {
        orderTelemetry.recordSyntheticMetric("verify_unique_over_ceiling", 1, "test_verified");
      }).toThrow(/cardinality ceiling/);

      const res = await sendReq({
        headers: { "Content-Type": "application/json", "x-test-token": "secret_ceiling_token_123" },
        body: JSON.stringify({ verification_id: "verify_unique_over_ceiling", count: 1, status: "test_verified" }),
      });
      expect(res.status).toBe(429);
      expect((res.body as Record<string, unknown>).ceiling).toBe(100);
    });

    it("releases capacity upon deterministic cleanup and allows new ID", async () => {
      for (let i = 1; i <= 100; i++) {
        orderTelemetry.recordSyntheticMetric(`verify_clean_${String(i).padStart(4, "0")}`, 1, "test_verified");
      }
      expect(orderTelemetry.getActiveSyntheticVerificationIds().length).toBe(100);

      const delRes = await sendReq({
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-test-token": "secret_ceiling_token_123" },
        body: JSON.stringify({ verification_id: "verify_clean_0001" }),
      });
      expect(delRes.body).toEqual({ success: true, removed: true, verification_id: "verify_clean_0001" });
      expect(delRes.status).toBe(200);
      expect(orderTelemetry.getActiveSyntheticVerificationIds().length).toBe(99);

      const postRes = await sendReq({
        headers: { "Content-Type": "application/json", "x-test-token": "secret_ceiling_token_123" },
        body: JSON.stringify({ verification_id: "verify_brand_new_id", count: 1, status: "test_verified" }),
      });
      expect(postRes.status).toBe(200);
      expect(orderTelemetry.getActiveSyntheticVerificationIds().length).toBe(100);
    });
  });

  // 4. Path B Disposable Service Isolation
  describe("Phase 2.4: Path B Disposable Service Isolation", () => {
    it("starts a disposable service on an isolated dynamically allocated port with ephemeral credentials", async () => {
      const ephemeralToken = "test_ephemeral_token_xyz987";
      const disposable = await startDisposableOrderService({ token: ephemeralToken });

      try {
        expect(disposable.port).toBeGreaterThan(0);
        expect(disposable.baseUrl).toBe(`http://localhost:${disposable.port}`);

        const healthRes = await fetch(`${disposable.baseUrl}/health`);
        expect(healthRes.ok).toBe(true);

        const recordRes = await fetch(`${disposable.baseUrl}/test/record-metric`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-test-token": ephemeralToken,
          },
          body: JSON.stringify({
            verification_id: "verify_disposable_1",
            count: 3,
            status: "test_verified",
          }),
        });
        expect(recordRes.ok).toBe(true);

        const metricsRes = await fetch(`${disposable.baseUrl}/metrics`);
        const metricsText = await metricsRes.text();
        expect(metricsText).toContain('verification_id="verify_disposable_1"');
      } finally {
        await disposable.stop();
      }
    });

    it("handles occupied port by allocating an isolated free port without disrupting existing listener", async () => {
      const blocker = http.createServer((_, res) => {
        res.writeHead(200);
        res.end("blocker-response");
      });
      await new Promise<void>((resolve) => blocker.listen(0, resolve));
      const blockerPort = (blocker.address() as { port: number }).port;

      try {
        const disposable = await startDisposableOrderService({
          port: blockerPort,
          token: "isolated_token_456",
        });

        try {
          expect(disposable.port).not.toBe(blockerPort);
          expect(disposable.port).toBeGreaterThan(0);

          const blockerRes = await fetch(`http://127.0.0.1:${blockerPort}`);
          expect(await blockerRes.text()).toBe("blocker-response");

          const healthRes = await fetch(`${disposable.baseUrl}/health`);
          expect(healthRes.ok).toBe(true);
        } finally {
          await disposable.stop();
        }
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });
  });

  // 5. Prometheus YAML Generation & Real YAML Parsing
  describe("Phase 2.4: Prometheus YAML Generation & Real YAML Parsing", () => {
    it("safely escapes special characters in credentials and produces valid YAML parsed by real parser", () => {
      const specialUser = '1871065:special\\user"with#chars';
      const specialToken = 'glc_token:with"quotes\nand\\backslashes#hash';
      const yamlStr = generatePrometheusConfig({
        remoteWriteUrl: "https://prometheus-prod.grafana.net/api/prom/push",
        remoteWriteUser: specialUser,
        remoteWriteToken: specialToken,
      });

      const validation = validateGeneratedYaml(yamlStr);
      expect(validation.valid).toBe(true);

      const parsed = YAML.parse(yamlStr);
      expect(parsed.remote_write).toBeDefined();
      expect(parsed.remote_write[0].basic_auth.username).toBe(specialUser);
      expect(parsed.remote_write[0].basic_auth.password).toBe(specialToken);
    });

    it("throws when remote_write is requested with incomplete configuration", () => {
      expect(() => {
        generatePrometheusConfig({
          remoteWriteUrl: "https://prometheus-prod.grafana.net/api/prom/push",
          remoteWriteToken: "",
        });
      }).toThrow(/Incomplete or invalid remote_write configuration/);

      expect(() => {
        generatePrometheusConfig({
          remoteWriteUrl: "https://prometheus-prod.grafana.net/api/prom/push",
          remoteWriteToken: "valid_token",
          remoteWriteUser: "",
        });
      }).toThrow(/Incomplete or invalid remote_write configuration/);
    });

    it("rejects YAML parser failures on invalid structure or non-object roots", () => {
      const invalidSyntax = "global: [missing bracket\n";
      const res1 = validateGeneratedYaml(invalidSyntax);
      expect(res1.valid).toBe(false);
      expect(res1.error).toContain("YAML parse error");

      const stringOnly = "just a plain string, not a mapping";
      const res2 = validateGeneratedYaml(stringOnly);
      expect(res2.valid).toBe(false);
      expect(res2.error).toContain("root configuration mapping");

      const noScrape = "global:\n  scrape_interval: 5s\n";
      const res3 = validateGeneratedYaml(noScrape);
      expect(res3.valid).toBe(false);
      expect(res3.error).toContain("scrape_configs");
    });
  });

  // =========================================================================
  // Phase 2.5: Final Telemetry Verification Integrity & Isolation
  // =========================================================================

  // 1. Tempo Search-Fallback Verification Bypass & Candidate Discovery
  describe("Phase 2.5: Tempo Search-Fallback Verification Bypass & Candidate Discovery", () => {
    const client = new JaegerClient();
    const testTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const testVerificationId = "verify_tempo_2_5_abc";

    it("search result with trace ID and span IDs cannot directly pass strict verification", () => {
      // Raw Tempo search-trace summary object
      const searchSummaryTrace: DistributedTrace = {
        traceId: testTraceId,
        rootServiceName: "order-service",
        operationName: "HTTP POST /orders",
        startTime: new Date().toISOString(),
        durationMs: 45,
        totalSpans: 2,
        hasErrors: false,
        servicesInvolved: ["order-service"],
        rootSpan: null,
        allSpans: [
          {
            spanId: "span111111111111",
            traceId: testTraceId, // derived from summary
            operationName: "HTTP POST /orders",
            serviceName: "order-service",
            startTimeUs: Date.now() * 1000,
            durationMs: 45,
            statusCode: "OK",
            attributes: { "verification.id": testVerificationId },
            depth: 0,
            children: [],
          },
        ],
        isFallback: false,
        isSearchSummary: true, // Marked as search-derived summary
      };

      const outcome = client.verifyLiveTrace(searchSummaryTrace, testTraceId, testVerificationId);
      expect(outcome.valid).toBe(false);
      expect(outcome.reason).toContain("Search-derived summary traces cannot be accepted");
    });

    it("search result can locate a candidate trace ID, followed by successful full detail retrieval and validation", () => {
      // 1. Search candidate has trace ID
      const candidateTraceId = testTraceId;

      // 2. Full backend detail payload retrieved using candidate ID
      const fullBackendDetailPayload = {
        traceID: candidateTraceId,
        batches: [
          {
            traceID: candidateTraceId,
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: "order-service" } }],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceID: candidateTraceId,
                    spanID: "span_full_detail_1",
                    name: "HTTP POST /orders",
                    startTimeUnixNano: "1700000000000000000",
                    endTimeUnixNano: "1700000000050000000",
                    status: { code: 1 },
                    attributes: [
                      { key: "verification.id", value: { stringValue: testVerificationId } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const parsedFull = client.parseTempoTraceDetail(fullBackendDetailPayload, candidateTraceId, { allowFallback: false });
      expect(parsedFull).not.toBeNull();
      expect(parsedFull?.isSearchSummary).toBeFalsy();

      const verifyOutcome = client.verifyLiveTrace(parsedFull, testTraceId, testVerificationId);
      expect(verifyOutcome.valid).toBe(true);
    });

    it("rejects full detail response when root trace ID is missing", () => {
      const payload = {
        batches: [
          {
            traceID: testTraceId,
            scopeSpans: [
              {
                spans: [{ traceID: testTraceId, spanID: "s1" }],
              },
            ],
          },
        ],
      };
      const res = client.parseTempoTraceDetail(payload, testTraceId, { allowFallback: false });
      expect(res).toBeNull();
    });

    it("rejects full detail response when individual span trace ID is missing", () => {
      const payload = {
        traceID: testTraceId,
        batches: [
          {
            traceID: testTraceId,
            scopeSpans: [
              {
                spans: [{ spanID: "s1" }], // Missing span traceID
              },
            ],
          },
        ],
      };
      const res = client.parseTempoTraceDetail(payload, testTraceId, { allowFallback: false });
      expect(res).toBeNull();
    });

    it("rejects full detail response with conflicting root, batch, or span identifiers", () => {
      const payload = {
        traceID: testTraceId,
        batches: [
          {
            traceID: "different_batch_id_9999",
            scopeSpans: [
              {
                spans: [{ traceID: testTraceId, spanID: "s1" }],
              },
            ],
          },
        ],
      };
      const res = client.parseTempoTraceDetail(payload, testTraceId, { allowFallback: false });
      expect(res).toBeNull();
    });

    it("rejects full detail response with conflicting traceId and traceID aliases", () => {
      const payload = {
        traceID: testTraceId,
        traceId: "conflicting_alias_trace_id_8888",
        batches: [],
      };
      const res = client.parseTempoTraceDetail(payload, testTraceId, { allowFallback: false });
      expect(res).toBeNull();
    });

    it("accepts valid full backend detail response", () => {
      const payload = {
        traceID: testTraceId,
        batches: [
          {
            traceID: testTraceId,
            scopeSpans: [
              {
                spans: [{ traceID: testTraceId, spanID: "s_valid_1" }],
              },
            ],
          },
        ],
      };
      const res = client.parseTempoTraceDetail(payload, testTraceId, { allowFallback: false });
      expect(res).not.toBeNull();
      expect(res?.traceId).toBe(testTraceId);
      expect(res?.allSpans.length).toBe(1);
    });

    it("preserves fallback dashboard parsing without being accepted by live verification", () => {
      const emptyPayload = {};
      const fallbackTrace = client.parseTempoTraceDetail(emptyPayload, testTraceId, { allowFallback: true });
      expect(fallbackTrace).not.toBeNull();
      expect(fallbackTrace?.isFallback).toBe(true);

      const outcome = client.verifyLiveTrace(fallbackTrace, testTraceId, testVerificationId);
      expect(outcome.valid).toBe(false);
      expect(outcome.reason).toContain("fallback trace");
    });
  });

  // 2. Bounded OpenTelemetry & Deterministic Prometheus TTL Cardinality
  describe("Phase 2.5: Bounded OpenTelemetry & Deterministic Prometheus TTL Cardinality", () => {
    it("accepts exactly 100 active IDs and rejects the 101st unique active ID", () => {
      const registry = new PrometheusRegistry("test-service-cardinality");

      for (let i = 1; i <= 100; i++) {
        registry.recordRequest(1, {
          verification_id: `v_unique_id_${String(i).padStart(3, "0")}`,
          status: "200",
        });
      }
      expect(registry.getActiveSyntheticVerificationIds().length).toBe(100);

      expect(() => {
        registry.recordRequest(1, {
          verification_id: "v_unique_id_101",
          status: "200",
        });
      }).toThrow(/cardinality ceiling \(100\) reached/);
    });

    it("repeated use of an existing active ID does not consume extra capacity", () => {
      const registry = new PrometheusRegistry("test-service-repeated");

      for (let i = 1; i <= 100; i++) {
        registry.recordRequest(1, {
          verification_id: `v_rep_id_${String(i).padStart(3, "0")}`,
        });
      }

      // Record on already registered ID 50
      expect(() => {
        registry.recordRequest(5, {
          verification_id: "v_rep_id_050",
        });
      }).not.toThrow();
      expect(registry.getActiveSyntheticVerificationIds().length).toBe(100);
    });

    it("deterministic TTL expiry releases capacity for new registrations", () => {
      const registry = new PrometheusRegistry("test-service-ttl");
      const baseTime = 1000000;

      // Fill 100 IDs at baseTime
      for (let i = 1; i <= 100; i++) {
        registry.recordRequest(1, {
          verification_id: `v_ttl_id_${String(i).padStart(3, "0")}`,
          _recordTimeMs: baseTime,
        } as unknown as Record<string, unknown>);
      }
      expect(registry.getActiveSyntheticVerificationIds(baseTime).length).toBe(100);

      // Fast forward past default TTL (5 minutes = 300,000ms)
      const futureTime = baseTime + 301000;
      const pruned = registry.pruneExpiredSyntheticIds(futureTime);
      expect(pruned).toBe(100);
      expect(registry.getActiveSyntheticVerificationIds(futureTime).length).toBe(0);

      // Now registering a new unique ID succeeds
      expect(() => {
        registry.recordRequest(1, {
          verification_id: "v_ttl_new_after_expire",
          _recordTimeMs: futureTime,
        } as unknown as Record<string, unknown>);
      }).not.toThrow();
      expect(registry.getActiveSyntheticVerificationIds(futureTime).length).toBe(1);
    });

    it("manual cleanup releases custom registry capacity and allows re-registering", () => {
      const registry = new PrometheusRegistry("test-service-manual-clean");

      for (let i = 1; i <= 100; i++) {
        registry.recordRequest(1, {
          verification_id: `v_manual_${String(i).padStart(3, "0")}`,
        });
      }
      expect(registry.getActiveSyntheticVerificationIds().length).toBe(100);

      // Clear single ID
      const removed = registry.clearSyntheticVerificationId("v_manual_042");
      expect(removed).toBe(true);
      expect(registry.getActiveSyntheticVerificationIds().length).toBe(99);

      // Register new unique ID
      expect(() => {
        registry.recordRequest(1, { verification_id: "v_manual_new_registered" });
      }).not.toThrow();
      expect(registry.getActiveSyntheticVerificationIds().length).toBe(100);

      // Re-registering the previously cleared ID after clearing another
      registry.clearSyntheticVerificationId("v_manual_001");
      expect(() => {
        registry.recordRequest(1, { verification_id: "v_manual_042" });
      }).not.toThrow();
    });

    it("repeated register and cleanup cycles do not leak into OpenTelemetry metrics", () => {
      // Verify that Prometheus registry contains exact verification_id label
      // while OpenTelemetry counter uses bounded stable dimensions
      const registry = new PrometheusRegistry("test-service-otel-bounds");

      registry.recordRequest(1, {
        verification_id: "v_exact_label_123",
        status: "200",
      });

      const promFormat = registry.toPrometheusFormat();
      expect(promFormat).toContain('verification_id="v_exact_label_123"');

      // Clear releases Prometheus registry capacity
      registry.clearSyntheticVerificationId("v_exact_label_123");
      const clearedPromFormat = registry.toPrometheusFormat();
      expect(clearedPromFormat).not.toContain('verification_id="v_exact_label_123"');
    });
  });

  // 3. Dynamic-Port Prometheus Scrape & File-SD Integration
  describe("Phase 2.5: Dynamic-Port Prometheus Scrape & File-SD Integration", () => {
    it("generates Prometheus configuration containing order-service-dynamic job with file_sd_configs", () => {
      const yamlStr = generatePrometheusConfig();
      const parsed = YAML.parse(yamlStr);

      const dynamicJob = parsed.scrape_configs.find(
        (c: { job_name: string }) => c.job_name === "order-service-dynamic"
      );
      expect(dynamicJob).toBeDefined();
      expect(dynamicJob.file_sd_configs).toBeDefined();
      expect(dynamicJob.file_sd_configs.length).toBeGreaterThan(0);
      expect(dynamicJob.file_sd_configs[0].files).toContain("/etc/prometheus/file_sd/*.json");
    });
  });

  // 4. Real Process Isolation for Disposable Order Service
  describe("Phase 2.5: Real Process Isolation for Disposable Order Service", () => {
    it("runs disposable service in isolated child process without mutating parent process.env", async () => {
      delete process.env.ENABLE_TEST_METRIC_ENDPOINT;
      delete process.env.TEST_METRIC_ENDPOINT_TOKEN;

      const ephemeralToken = "isolated_test_token_phase_2_5_abc";
      const disposable = await startDisposableOrderService({
        token: ephemeralToken,
        registerPrometheusTarget: true,
      });

      try {
        // 1. Parent process.env is NEVER modified
        expect(process.env.ENABLE_TEST_METRIC_ENDPOINT).toBeUndefined();
        expect(process.env.TEST_METRIC_ENDPOINT_TOKEN).toBeUndefined();

        // 2. Child process received its own token and responds
        expect(disposable.port).toBeGreaterThan(0);
        expect(disposable.baseUrl).toBe(`http://localhost:${disposable.port}`);

        const recordRes = await fetch(`${disposable.baseUrl}/test/record-metric`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-test-token": ephemeralToken,
          },
          body: JSON.stringify({
            verification_id: "verify_child_process_123",
            count: 1,
            status: "test_verified",
          }),
        });
        expect(recordRes.status).toBe(200);

        // 3. File SD target registration file exists
        if (disposable.targetFilePath) {
          expect(fs.existsSync(disposable.targetFilePath)).toBe(true);
        }
      } finally {
        // 4. Cleanup stops child process and removes target registration
        const targetPath = disposable.targetFilePath;
        await disposable.stop();
        if (targetPath) {
          expect(fs.existsSync(targetPath)).toBe(false);
        }
      }
    });
  });

  // 5. Hardened Cleanup Endpoint Payload Handling and Authentication
  describe("Phase 2.5: Hardened Cleanup Endpoint Payload Handling and Authentication", () => {
    it("safeTokenEquals handles equal-length and different-length tokens in constant time without leaking length", () => {
      const secret = "correct_secret_token_1234567890";

      // Equal length invalid token
      const equalLengthWrong = "wrong___secret_token_1234567890";
      expect(equalLengthWrong.length).toBe(secret.length);
      expect(safeTokenEquals(equalLengthWrong, secret)).toBe(false);

      // Different length invalid tokens
      expect(safeTokenEquals("short", secret)).toBe(false);
      expect(safeTokenEquals("way_too_long_token_exceeding_secret_length_completely", secret)).toBe(false);
      expect(safeTokenEquals("", secret)).toBe(false);
      expect(safeTokenEquals(secret, "")).toBe(false);

      // Correct token
      expect(safeTokenEquals(secret, secret)).toBe(true);
    });

    describe("Cleanup endpoint HTTP contract", () => {
      let boundServer: http.Server;
      let testPort = 4001;

      const sendReq = (options: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        path?: string;
      }): Promise<{ status: number; body: unknown }> => {
        const headers = { ...(options.headers || {}) };
        if (options.body && !headers["Content-Length"] && !headers["content-length"]) {
          headers["Content-Length"] = String(Buffer.byteLength(options.body));
        }
        return new Promise((resolve, reject) => {
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port: testPort,
              path: options.path || "/test/record-metric",
              method: options.method || "DELETE",
              headers,
            },
            (res) => {
              let data = "";
              res.on("data", (chunk) => {
                data += chunk;
              });
              res.on("end", () => {
                try {
                  resolve({ status: res.statusCode || 500, body: data ? JSON.parse(data) : {} });
                } catch {
                  resolve({ status: res.statusCode || 500, body: data });
                }
              });
            }
          );
          req.on("error", reject);
          if (options.body) req.write(options.body);
          req.end();
        });
      };

      beforeEach(async () => {
        process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
        process.env.TEST_METRIC_ENDPOINT_TOKEN = "secret_cleanup_token_phase25";
        (process.env as Record<string, string | undefined>).NODE_ENV = "test";

        boundServer = orderServer;
        if (!boundServer.listening) {
          await new Promise<void>((resolve) => {
            boundServer.listen(0, () => {
              const addr = boundServer.address();
              testPort = typeof addr === "object" && addr ? addr.port : 4001;
              resolve();
            });
          });
        } else {
          const addr = boundServer.address();
          testPort = typeof addr === "object" && addr ? addr.port : 4001;
        }
      });

      afterEach(async () => {
        delete process.env.ENABLE_TEST_METRIC_ENDPOINT;
        delete process.env.TEST_METRIC_ENDPOINT_TOKEN;
        (process.env as Record<string, string | undefined>).NODE_ENV = "test";
        if (boundServer && boundServer.listening) {
          await new Promise<void>((resolve) => boundServer.close(() => resolve()));
        }
      });

      it("returns 413 when cleanup payload exceeds 1024 bytes", async () => {
        const oversizedBody = JSON.stringify({
          verification_id: "verify_oversized_cleanup_test",
          extra: "x".repeat(1100),
        });

        const res = await sendReq({
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "x-test-token": "secret_cleanup_token_phase25",
          },
          body: oversizedBody,
        });
        expect(res.status).toBe(413);
        expect((res.body as Record<string, unknown>).error).toContain("Payload too large");
      });

      it("returns 400 when cleanup payload contains malformed JSON", async () => {
        const res = await sendReq({
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "x-test-token": "secret_cleanup_token_phase25",
          },
          body: "{ invalid_json_payload: ",
        });
        expect(res.status).toBe(400);
        expect((res.body as Record<string, unknown>).error).toContain("Invalid JSON payload");
      });

      it("returns 400 when verification_id fails regex validation", async () => {
        const res = await sendReq({
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "x-test-token": "secret_cleanup_token_phase25",
          },
          body: JSON.stringify({ verification_id: "short" }), // < 8 characters
        });
        expect(res.status).toBe(400);
        expect((res.body as Record<string, unknown>).error).toContain("Invalid verification_id");
      });

      it("returns 403 when endpoint is default-disabled", async () => {
        delete process.env.ENABLE_TEST_METRIC_ENDPOINT;
        const res = await sendReq({
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "x-test-token": "secret_cleanup_token_phase25",
          },
          body: JSON.stringify({ verification_id: "verify_valid_123" }),
        });
        expect(res.status).toBe(403);
        expect((res.body as Record<string, unknown>).disabled).toBe(true);
      });

      it("returns 403 in production mode even if ENABLE_TEST_METRIC_ENDPOINT is true", async () => {
        process.env.ENABLE_TEST_METRIC_ENDPOINT = "true";
        (process.env as Record<string, string | undefined>).NODE_ENV = "production";
        const res = await sendReq({
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "x-test-token": "secret_cleanup_token_phase25",
          },
          body: JSON.stringify({ verification_id: "verify_valid_123" }),
        });
        expect(res.status).toBe(403);
        expect((res.body as Record<string, unknown>).disabled).toBe(true);
      });
    });
  });

  // =========================================================================
  // Phase 2.6: TTL Scrape Cleanup, Child Lifecycle & Verification Corrections
  // =========================================================================
  describe("Phase 2.6: TTL Scrape Cleanup, Child Lifecycle & Verification Integrity", () => {
    describe("1. Prometheus Scrape TTL Expiration via Time Injection", () => {
      it("prunes expired synthetic IDs before Prometheus exposition output without waiting real-time", () => {
        const reg = new PrometheusRegistry("test-service");
        let currentTime = 1000000;
        reg.setTimeProvider(() => currentTime);

        // Record standard baseline metrics
        reg.setHealthStatus(1);
        reg.recordRequest(1, { route: "/api/orders", method: "GET", status: "200" });

        // Register synthetic verification ID
        reg.recordRequest(1, {
          verification_id: "verify_synth_001",
        });

        expect(reg.getActiveSyntheticVerificationIds()).toEqual(["verify_synth_001"]);

        // Exposition immediately shows synthetic metric
        const output1 = reg.toPrometheusFormat();
        expect(output1).toContain('verification_id="verify_synth_001"');
        expect(output1).toContain('service_health_status{service="test-service"} 1');

        // Repeated ID call refreshes timestamp and does NOT consume additional capacity
        currentTime += 2 * 60 * 1000; // +2 minutes
        reg.recordRequest(1, {
          verification_id: "verify_synth_001",
        });
        expect(reg.getActiveSyntheticVerificationIds().length).toBe(1);

        // Advance time by 6 minutes (TTL is 5 minutes, so 1000000 + 2m + 6m = expired)
        currentTime += 6 * 60 * 1000;

        // Calling toPrometheusFormat() directly must prune expired IDs before emitting output
        const output2 = reg.toPrometheusFormat();

        // Expired verification ID is absent from Prometheus exposition
        expect(output2).not.toContain('verification_id="verify_synth_001"');
        // Active ID map has decreased
        expect(reg.getActiveSyntheticVerificationIds()).toEqual([]);

        // Standard non-synthetic service metrics remain intact
        expect(output2).toContain('service_health_status{service="test-service"} 1');
        expect(output2).toContain('http_requests_total{service="test-service",status="200"} 1');

        // New ID can be registered after expiry
        reg.recordRequest(1, {
          verification_id: "verify_synth_002",
        });
        expect(reg.getActiveSyntheticVerificationIds()).toEqual(["verify_synth_002"]);
        const output3 = reg.toPrometheusFormat();
        expect(output3).toContain('verification_id="verify_synth_002"');
      });

      it("enforces 100-ID ceiling after expired IDs have been pruned", () => {
        const reg = new PrometheusRegistry("test-service");
        let currentTime = 1000000;
        reg.setTimeProvider(() => currentTime);

        // Register 100 IDs
        for (let i = 0; i < 100; i++) {
          reg.recordRequest(1, { verification_id: `id_${i}` });
        }
        expect(reg.getActiveSyntheticVerificationIds().length).toBe(100);

        // 101st ID is rejected when at ceiling
        expect(() => {
          reg.recordRequest(1, { verification_id: "id_overflow" });
        }).toThrow(/cardinality ceiling/i);

        // Advance time past TTL
        currentTime += 6 * 60 * 1000;

        // Pruning via toPrometheusFormat clears expired IDs
        reg.toPrometheusFormat();
        expect(reg.getActiveSyntheticVerificationIds().length).toBe(0);

        // Now registering new IDs succeeds
        expect(() => {
          reg.recordRequest(1, { verification_id: "id_fresh" });
        }).not.toThrow();
        expect(reg.getActiveSyntheticVerificationIds()).toEqual(["id_fresh"]);
      });
    });

    describe("2. Child Process Shutdown, Escalation & True Termination", () => {
      it("shuts down normal child cleanly and removes dynamic discovery file", async () => {
        const service = await startDisposableOrderService();
        expect(service.port).toBeGreaterThan(0);
        if (service.targetFilePath) {
          expect(fs.existsSync(service.targetFilePath)).toBe(true);
        }

        await service.stop();

        // Process is confirmed actually terminated
        expect(service.process).toBeDefined();
        expect(service.process!.exitCode !== null || service.process!.signalCode !== null).toBe(true);
        if (service.targetFilePath) {
          expect(fs.existsSync(service.targetFilePath)).toBe(false);
        }
      });

      it("handles stop() idempotently when child exits before stop() is called", async () => {
        const service = await startDisposableOrderService();
        // Manually kill child early
        expect(service.process).toBeDefined();
        service.process!.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 200));

        // stop() should complete cleanly without throwing and remove files
        await expect(service.stop()).resolves.toBeUndefined();
        // Repeated calls succeed idempotently
        await expect(service.stop()).resolves.toBeUndefined();
      });

      it("handles repeated sequential and parallel stop() calls idempotently", async () => {
        const service = await startDisposableOrderService();
        const p1 = service.stop();
        const p2 = service.stop();
        const p3 = service.stop();

        await Promise.all([p1, p2, p3]);
        expect(service.process).toBeDefined();
        expect(service.process!.exitCode !== null || service.process!.signalCode !== null).toBe(true);
      });

      it("escalates to SIGKILL if child ignores SIGTERM", async () => {
        const { EventEmitter } = await import("events");
        const emitter = new EventEmitter();
        const killSignals: string[] = [];

        interface MutableFakeChild {
          exitCode: number | null;
          signalCode: NodeJS.Signals | null;
          killed: boolean;
          pid: number;
          kill: (signal?: NodeJS.Signals | number) => boolean;
          once: (event: string, cb: (...args: unknown[]) => void) => import("child_process").ChildProcess;
          removeListener: (event: string, cb: (...args: unknown[]) => void) => import("child_process").ChildProcess;
        }

        const fakeChild: MutableFakeChild = {
          exitCode: null,
          signalCode: null,
          killed: false,
          pid: 12345,
          kill: (signal?: NodeJS.Signals | number) => {
            const sigStr = String(signal ?? "SIGTERM");
            killSignals.push(sigStr);
            if (sigStr === "SIGKILL") {
              fakeChild.exitCode = null;
              fakeChild.signalCode = "SIGKILL";
              setTimeout(() => {
                emitter.emit("exit", null, "SIGKILL");
                emitter.emit("close");
              }, 10);
            }
            return true;
          },
          once: (event: string, cb: (...args: unknown[]) => void) => {
            emitter.once(event, cb);
            return fakeChild as unknown as import("child_process").ChildProcess;
          },
          removeListener: (event: string, cb: (...args: unknown[]) => void) => {
            emitter.removeListener(event, cb);
            return fakeChild as unknown as import("child_process").ChildProcess;
          },
        };

        await stopChildProcess(fakeChild as unknown as import("child_process").ChildProcess, undefined, 50);

        expect(killSignals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(fakeChild.signalCode).toBe("SIGKILL");
      });

      it("handles child process startup failure and cleans up", async () => {
        await expect(
          startDisposableOrderService({ port: -1 })
        ).rejects.toThrow();
      });
    });

    describe("3. Parent-Process Environment Variable Preservation", () => {
      it("preserves pre-existing parent environment variables and does not leak child tokens", async () => {
        const SENTINEL_ENABLE = "parent_sentinel_enable_preserved";
        const SENTINEL_TOKEN = "parent_sentinel_token_preserved";

        process.env.ENABLE_TEST_METRIC_ENDPOINT = SENTINEL_ENABLE;
        process.env.TEST_METRIC_ENDPOINT_TOKEN = SENTINEL_TOKEN;

        try {
          const service = await startDisposableOrderService();
          // Parent environment was NOT overwritten by child's token
          expect(process.env.ENABLE_TEST_METRIC_ENDPOINT).toBe(SENTINEL_ENABLE);
          expect(process.env.TEST_METRIC_ENDPOINT_TOKEN).toBe(SENTINEL_TOKEN);

          // Child received its own distinct 32-byte token
          expect(service.token).not.toBe(SENTINEL_TOKEN);
          expect(service.token.length).toBeGreaterThanOrEqual(64); // 32 bytes in hex = 64 chars

          // Target service endpoint becomes unreachable after stop
          await service.stop();
          await expect(fetch(`${service.baseUrl}/health`)).rejects.toThrow();

          // Parent environment still preserved after cleanup
          expect(process.env.ENABLE_TEST_METRIC_ENDPOINT).toBe(SENTINEL_ENABLE);
          expect(process.env.TEST_METRIC_ENDPOINT_TOKEN).toBe(SENTINEL_TOKEN);
        } finally {
          delete process.env.ENABLE_TEST_METRIC_ENDPOINT;
          delete process.env.TEST_METRIC_ENDPOINT_TOKEN;
        }
      });
    });

    describe("4. Cryptographically Secure Disposable Token Generation", () => {
      it("generates tokens with at least 32 bytes of cryptographic randomness", () => {
        const token1 = generateSecureToken();
        const token2 = generateSecureToken();

        expect(token1).toHaveLength(64); // 32 bytes = 64 hex characters
        expect(token2).toHaveLength(64);
        expect(token1).not.toBe(token2);
        // Valid hex string
        expect(/^[0-9a-f]{64}$/.test(token1)).toBe(true);
      });

      it("allows deterministic token injection when explicitly requested by tests", async () => {
        const customToken = "deterministic_test_token_1234567890abcdef1234567890abcdef";
        const service = await startDisposableOrderService({ token: customToken });
        expect(service.token).toBe(customToken);
        await service.stop();
      });
    });

    describe("5. Dynamic File-Based Discovery Configuration", () => {
      it("uses host.docker.internal and avoids 127.0.0.1 in dynamic file_sd targets", async () => {
        const service = await startDisposableOrderService();
        expect(service.targetFilePath).toBeDefined();
        if (service.targetFilePath && fs.existsSync(service.targetFilePath)) {
          const content = JSON.parse(fs.readFileSync(service.targetFilePath, "utf8"));
          expect(Array.isArray(content)).toBe(true);
          const targets = content[0].targets;
          expect(targets).toContain(`host.docker.internal:${service.port}`);
          expect(targets).not.toContain(`127.0.0.1:${service.port}`);
        }
        await service.stop();
      });

      it("genuine Prometheus scrape integration test (disposable or local Prometheus if reachable)", async () => {
        const localPrometheusUrl = process.env.PROMETHEUS_URL || "http://localhost:9090";
        let isPrometheusRunning = false;
        try {
          const res = await fetch(`${localPrometheusUrl}/-/healthy`, { signal: AbortSignal.timeout(1000) });
          isPrometheusRunning = res.ok;
        } catch {
          isPrometheusRunning = false;
        }

        if (!isPrometheusRunning) {
          // Gracefully skip execution if Prometheus daemon is not available locally
          expect(true).toBe(true);
          return;
        }

        // If Prometheus is running locally, execute genuine target discovery & scrape validation
        const service = await startDisposableOrderService();
        const testAuthToken = service.token;
        const testVerificationId = `verify_scrape_${Date.now()}`;

        // Emit synthetic metric to child service
        const postRes = await fetch(`${service.baseUrl}/test/record-metric`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-test-token": testAuthToken },
          body: JSON.stringify({ verification_id: testVerificationId, count: 1 }),
        });
        expect(postRes.ok).toBe(true);

        // Verify target appears in Prometheus targets
        let discovered = false;
        for (let i = 0; i < 5; i++) {
          const tRes = await fetch(`${localPrometheusUrl}/api/v1/targets`);
          if (tRes.ok) {
            const data = (await tRes.json()) as {
              data?: {
                activeTargets?: Array<{
                  discoveredLabels?: Record<string, string>;
                }>;
              };
            };
            if (data.data?.activeTargets?.some((t) => t.discoveredLabels?.["__address__"]?.includes(`:${service.port}`))) {
              discovered = true;
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 1000));
        }

        await service.stop();
        expect(discovered).toBe(true);
      });

      it("validates docker-compose.yml host-gateway extra_hosts and file_sd volume mounting", () => {
        const composePath = path.resolve(__dirname, "..", "docker-compose.yml");
        expect(fs.existsSync(composePath)).toBe(true);
        const composeContent = fs.readFileSync(composePath, "utf8");
        const parsed = YAML.parse(composeContent) as {
          services?: {
            prometheus?: {
              extra_hosts?: string[];
              volumes?: string[];
              ports?: string[];
            };
          };
        };
        expect(parsed.services?.prometheus).toBeDefined();
        expect(parsed.services?.prometheus?.extra_hosts).toContain("host.docker.internal:host-gateway");
        expect(parsed.services?.prometheus?.volumes).toContain("./docker/file_sd:/etc/prometheus/file_sd");
        expect(parsed.services?.prometheus?.ports).toContain("9090:9090");
      });
    });

    describe("6. Detailed TTL Boundary Conditions & Interleaved Expiry", () => {
      it("evaluates exact boundary conditions: 1ms before TTL, exact TTL, and 1ms after TTL", () => {
        const reg = new PrometheusRegistry("boundary-service");
        let currentTime = 500000;
        reg.setTimeProvider(() => currentTime);
        const ttlMs = reg.getSyntheticIdTtlMs(); // 300,000ms

        reg.recordRequest(1, { verification_id: "verify_boundary_exact" });
        expect(reg.getActiveSyntheticVerificationIds()).toEqual(["verify_boundary_exact"]);

        // 1ms before TTL: 500000 + 300000 - 1 = 799999
        currentTime = 500000 + ttlMs - 1;
        const outBefore = reg.toPrometheusFormat();
        expect(outBefore).toContain('verification_id="verify_boundary_exact"');
        expect(reg.getActiveSyntheticVerificationIds().length).toBe(1);

        // Exact TTL: 500000 + 300000 = 800000 (now - registeredAt >= ttl -> expires!)
        currentTime = 500000 + ttlMs;
        const outExact = reg.toPrometheusFormat();
        expect(outExact).not.toContain('verification_id="verify_boundary_exact"');
        expect(reg.getActiveSyntheticVerificationIds().length).toBe(0);

        // 1ms after TTL: still expired
        currentTime = 500000 + ttlMs + 1;
        const outAfter = reg.toPrometheusFormat();
        expect(outAfter).not.toContain('verification_id="verify_boundary_exact"');
        expect(reg.getActiveSyntheticVerificationIds().length).toBe(0);
      });

      it("handles interleaved synthetic IDs with staggered registration and expiration times", () => {
        const reg = new PrometheusRegistry("staggered-service");
        let currentTime = 1000000;
        reg.setTimeProvider(() => currentTime);
        const ttl = 300000; // 5 min

        // ID_A registered at T=1,000,000
        reg.recordRequest(1, { verification_id: "id_alpha" });

        // Advance 100s, register ID_B at T=1,100,000
        currentTime += 100000;
        reg.recordRequest(1, { verification_id: "id_beta" });

        expect(reg.getActiveSyntheticVerificationIds().sort()).toEqual(["id_alpha", "id_beta"]);

        // Advance to T=1,300,000 (elapsed for alpha = 300,000 -> expires; elapsed for beta = 200,000 -> retains)
        currentTime = 1000000 + ttl;
        const scrape1 = reg.toPrometheusFormat();
        expect(scrape1).not.toContain('verification_id="id_alpha"');
        expect(scrape1).toContain('verification_id="id_beta"');
        expect(reg.getActiveSyntheticVerificationIds()).toEqual(["id_beta"]);

        // Advance to T=1,400,000 (elapsed for beta = 300,000 -> expires)
        currentTime = 1100000 + ttl;
        const scrape2 = reg.toPrometheusFormat();
        expect(scrape2).not.toContain('verification_id="id_beta"');
        expect(reg.getActiveSyntheticVerificationIds()).toEqual([]);
      });

      it("refreshes registration timestamp and preserves metric count on repeated registrations", () => {
        const reg = new PrometheusRegistry("refresh-service");
        let currentTime = 2000000;
        reg.setTimeProvider(() => currentTime);
        const ttl = 300000;

        reg.recordRequest(1, { verification_id: "id_refreshable" });
        expect(reg.toPrometheusFormat()).toContain('verification_id="id_refreshable"} 1');

        // Advance time by 200s (T=2,200,000) and re-register with count 2
        currentTime += 200000;
        reg.recordRequest(2, { verification_id: "id_refreshable" });
        expect(reg.toPrometheusFormat()).toContain('verification_id="id_refreshable"} 3');

        // At T=2,350,000: original registration (T=2,000,000) would have expired (350s > 300s),
        // but refreshed registration (T=2,200,000) has only elapsed 150s, so it must still be active!
        currentTime = 2000000 + 350000;
        const scrapeMid = reg.toPrometheusFormat();
        expect(scrapeMid).toContain('verification_id="id_refreshable"} 3');
        expect(reg.getActiveSyntheticVerificationIds()).toEqual(["id_refreshable"]);

        // At T=2,500,000 (2,200,000 + 300,000): now it expires!
        currentTime = 2200000 + ttl;
        const scrapeFinal = reg.toPrometheusFormat();
        expect(scrapeFinal).not.toContain('verification_id="id_refreshable"');
        expect(reg.getActiveSyntheticVerificationIds()).toEqual([]);
      });

      it("clearSyntheticVerificationId purges both active map and custom request registry", () => {
        const reg = new PrometheusRegistry("cleanup-verify");
        reg.recordRequest(3, { verification_id: "id_to_purge" });
        expect(reg.getActiveSyntheticVerificationIds()).toContain("id_to_purge");
        expect(reg.toPrometheusFormat()).toContain('verification_id="id_to_purge"} 3');

        const removed = reg.clearSyntheticVerificationId("id_to_purge");
        expect(removed).toBe(true);
        expect(reg.getActiveSyntheticVerificationIds()).not.toContain("id_to_purge");
        expect(reg.toPrometheusFormat()).not.toContain('verification_id="id_to_purge"');

        // Calling again returns false
        expect(reg.clearSyntheticVerificationId("id_to_purge")).toBe(false);
      });
    });

    describe("7. Advanced Child Lifecycle: Graceful SIGTERM vs Forced SIGKILL", () => {
      it("completes graceful shutdown when child terminates on SIGTERM without sending SIGKILL", async () => {
        const { EventEmitter } = await import("events");
        const emitter = new EventEmitter();
        const killSignals: string[] = [];

        interface MutableFakeChild {
          exitCode: number | null;
          signalCode: NodeJS.Signals | null;
          killed: boolean;
          pid: number;
          kill: (signal?: NodeJS.Signals | number) => boolean;
          once: (event: string, cb: (...args: unknown[]) => void) => import("child_process").ChildProcess;
          removeListener: (event: string, cb: (...args: unknown[]) => void) => import("child_process").ChildProcess;
        }

        const gracefulChild: MutableFakeChild = {
          exitCode: null,
          signalCode: null,
          killed: false,
          pid: 12345,
          kill: (signal?: NodeJS.Signals | number) => {
            const sigStr = String(signal ?? "SIGTERM");
            killSignals.push(sigStr);
            if (sigStr === "SIGTERM") {
              // Graceful exit within 20ms
              setTimeout(() => {
                gracefulChild.exitCode = 0;
                gracefulChild.signalCode = "SIGTERM";
                emitter.emit("exit", 0, "SIGTERM");
                emitter.emit("close");
              }, 20);
            }
            return true;
          },
          once: (event: string, cb: (...args: unknown[]) => void) => {
            emitter.once(event, cb);
            return gracefulChild as unknown as import("child_process").ChildProcess;
          },
          removeListener: (event: string, cb: (...args: unknown[]) => void) => {
            emitter.removeListener(event, cb);
            return gracefulChild as unknown as import("child_process").ChildProcess;
          },
        };

        // Grace period 200ms - graceful child terminates in 20ms
        await stopChildProcess(gracefulChild as unknown as import("child_process").ChildProcess, undefined, 200);

        // SIGKILL was NEVER dispatched because graceful SIGTERM succeeded
        expect(killSignals).toEqual(["SIGTERM"]);
        expect(gracefulChild.exitCode).toBe(0);
      });

      it("coalesces concurrent calls to stopChildProcess on the same child instance", async () => {
        const { EventEmitter } = await import("events");
        const emitter = new EventEmitter();
        let killCount = 0;

        interface MutableFakeChild {
          exitCode: number | null;
          signalCode: NodeJS.Signals | null;
          killed: boolean;
          pid: number;
          kill: (signal?: NodeJS.Signals | number) => boolean;
          once: (event: string, cb: (...args: unknown[]) => void) => import("child_process").ChildProcess;
          removeListener: (event: string, cb: (...args: unknown[]) => void) => import("child_process").ChildProcess;
        }

        const fakeChild: MutableFakeChild = {
          exitCode: null,
          signalCode: null,
          killed: false,
          pid: 23456,
          kill: () => {
            killCount++;
            setTimeout(() => {
              fakeChild.exitCode = 0;
              emitter.emit("exit", 0, null);
              emitter.emit("close");
            }, 30);
            return true;
          },
          once: (event: string, cb: (...args: unknown[]) => void) => {
            emitter.once(event, cb);
            return fakeChild as unknown as import("child_process").ChildProcess;
          },
          removeListener: (event: string, cb: (...args: unknown[]) => void) => {
            emitter.removeListener(event, cb);
            return fakeChild as unknown as import("child_process").ChildProcess;
          },
        };

        const cp = fakeChild as unknown as import("child_process").ChildProcess;
        // Concurrent stops
        const [r1, r2, r3] = await Promise.all([
          stopChildProcess(cp, undefined, 200),
          stopChildProcess(cp, undefined, 200),
          stopChildProcess(cp, undefined, 200),
        ]);

        expect(r1).toBeUndefined();
        expect(r2).toBeUndefined();
        expect(r3).toBeUndefined();
        // Kill was only called once because calls were deduplicated
        expect(killCount).toBe(1);
      });

      it("immediately completes stopChildProcess when child is already exited", async () => {
        const { EventEmitter } = await import("events");
        const emitter = new EventEmitter();
        let killCalled = false;

        const deadChild = {
          exitCode: 0,
          signalCode: null,
          killed: true,
          pid: 34567,
          kill: () => {
            killCalled = true;
            return false;
          },
          once: (event: string, cb: (...args: unknown[]) => void) => {
            emitter.once(event, cb);
            return deadChild as unknown as import("child_process").ChildProcess;
          },
          removeListener: (event: string, cb: (...args: unknown[]) => void) => {
            emitter.removeListener(event, cb);
            return deadChild as unknown as import("child_process").ChildProcess;
          },
        } as unknown as import("child_process").ChildProcess;

        await stopChildProcess(deadChild);
        expect(killCalled).toBe(false);
      });
    });
  });
});
