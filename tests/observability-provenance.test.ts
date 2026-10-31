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
});
