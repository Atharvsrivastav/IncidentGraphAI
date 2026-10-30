import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PrometheusClient, ServiceMetricsDetailedResult } from "../src/lib/telemetry/prometheusClient";
import { JaegerClient } from "../src/lib/telemetry/jaegerClient";
import { TelemetryManager } from "../src/lib/telemetry/telemetryManager";
import { BackendHealthStatus, DistributedTrace } from "../src/lib/telemetry/types";
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
import {
  obsStore,
  evaluateMockPromQl,
  evaluateMockPromQlRange,
  computeHistogramBuckets,
  calculateHistogramQuantile,
  PROMETHEUS_LE_STRINGS,
} from "../sample-services/mock-observability";
import { ensureDatabaseSeeded } from "../src/lib/db/ensure-seeded";
import { realRootCauseEngine } from "../src/lib/algorithms/realRootCauseEngine";
import { telemetryManager } from "../src/lib/telemetry/telemetryManager";
import { prisma } from "../src/lib/db/prisma";

describe("Phase 6: Live Telemetry Ingestion & Multi-Service RCA Suite", () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await ensureDatabaseSeeded();
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

    it("never falls back to raw cumulative counter totals when rate query fails or returns empty", async () => {
      const queriedUrls: string[] = [];
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        queriedUrls.push(decoded);
        // Rate query returns empty result or fails
        if (decoded.includes("rate(http_requests_total[1m])")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: { result: [] },
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
      const detailed = await client.getServiceMetricsDetailed();

      // When rate query returns empty, metrics must remain empty (no raw counter fallback)
      expect(detailed.metrics.size).toBe(0);
      // Ensure raw cumulative counters were NEVER queried as substitutes
      for (const u of queriedUrls) {
        expect(u).not.toMatch(/[?&]query=http_requests_total(?:&|$)/);
        expect(u).not.toMatch(/[?&]query=http_request_errors_total(?:&|$)/);
      }
    });

    it("correctly aggregates multi-instance series per service and computes weighted error percentage", async () => {
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
                  { metric: { service: "order-service", instance: "order-1" }, value: [1730000000, "150.0"] },
                  { metric: { service: "order-service", instance: "order-2" }, value: [1730000000, "100.0"] },
                  { metric: { service: "payment-service", instance: "pay-1" }, value: [1730000000, "80.0"] },
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
                  { metric: { service: "order-service", instance: "order-1" }, value: [1730000000, "3.0"] },
                  { metric: { service: "order-service", instance: "order-2" }, value: [1730000000, "4.0"] },
                  { metric: { service: "payment-service", instance: "pay-1" }, value: [1730000000, "0.0"] },
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
                  { metric: { service: "order-service", instance: "order-1" }, value: [1730000000, "0.040"] },
                  { metric: { service: "order-service", instance: "order-2" }, value: [1730000000, "0.060"] },
                  { metric: { service: "payment-service", instance: "pay-1" }, value: [1730000000, "0.020"] },
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
      const detailed = await client.getServiceMetricsDetailed();

      expect(detailed.success).toBe(true);
      const orderMetrics = detailed.metrics.get("order-service");
      expect(orderMetrics).toBeDefined();
      // Total request rate across instances: 150 + 100 = 250 req/s
      expect(orderMetrics?.requestRate).toBe(250);
      // Total error rate across instances: ( (3.0 + 4.0) / 250 ) * 100 = (7.0 / 250) * 100 = 2.8%
      expect(orderMetrics?.errorRate).toBe(2.8);
      // Latency average across 2 instances: (40ms + 60ms) / 2 = 50ms
      expect(orderMetrics?.latencyMs).toBe(50);
      expect(orderMetrics?.instanceCount).toBe(2);

      const payMetrics = detailed.metrics.get("payment-service");
      expect(payMetrics).toBeDefined();
      expect(payMetrics?.requestRate).toBe(80);
      expect(payMetrics?.errorRate).toBe(0);
      expect(payMetrics?.latencyMs).toBe(20);
      expect(payMetrics?.instanceCount).toBe(1);
    });

    it("calculates P95 histogram quantile and distinguishes it from average latency", async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("rate(http_requests_total[1m])")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: { result: [{ metric: { service: "order-service" }, value: [1730000000, "200.0"] }] },
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
              data: { result: [{ metric: { service: "order-service" }, value: [1730000000, "0.035"] }] }, // 35ms average
            }),
          } as unknown as Response);
        }
        if (decoded.includes("histogram_quantile(0.95")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: { result: [{ metric: { service: "order-service" }, value: [1730000000, "0.085"] }] }, // 85ms P95
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
      const detailed = await client.getServiceMetricsDetailed();

      expect(detailed.success).toBe(true);
      expect(detailed.p95Supported).toBe(true);

      const orderMetrics = detailed.metrics.get("order-service");
      expect(orderMetrics).toBeDefined();
      expect(orderMetrics?.latencyMs).toBe(35); // Average
      expect(orderMetrics?.latencyP95Ms).toBe(85); // P95
      expect(orderMetrics?.hasValidP95).toBe(true);
      expect(orderMetrics?.latencyP95Ms).not.toBe(orderMetrics?.latencyMs);
    });

    it("reports hasValidP95: false when histogram bucket data is missing without fabricating numbers", async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("rate(http_requests_total[1m])")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: { result: [{ metric: { service: "order-service" }, value: [1730000000, "200.0"] }] },
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
              data: { result: [{ metric: { service: "order-service" }, value: [1730000000, "0.035"] }] },
            }),
          } as unknown as Response);
        }
        // P95 histogram query returns empty (no histogram buckets in TSDB)
        if (decoded.includes("histogram_quantile(0.95")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ status: "success", data: { result: [] } }),
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
      const detailed = await client.getServiceMetricsDetailed();

      const orderMetrics = detailed.metrics.get("order-service");
      expect(orderMetrics).toBeDefined();
      expect(orderMetrics?.hasValidP95).toBe(false);
      expect(orderMetrics?.latencyP95Ms).toBeUndefined();
      expect(detailed.p95Supported).toBe(false);
    });

    it("integrates bounded range queries into getServiceMetricsHistory preserving matrix timestamps", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const startSec = nowSec - 300;
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("/api/v1/query_range")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [
                  {
                    metric: { service: "order-service" },
                    values: [
                      [startSec, "100.0"],
                      [startSec + 60, "120.0"],
                      [startSec + 120, "140.0"],
                    ],
                  },
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
      const history = await client.getServiceMetricsHistory({ lookbackSec: 300, stepSec: 60 });

      expect(history.success).toBe(true);
      expect(history.records.length).toBeGreaterThan(0);
      // Verify preserved ISO timestamp matches Unix epoch seconds
      expect(history.records[0].timestamp).toBe(new Date(startSec * 1000).toISOString());
      expect(history.records[1].timestamp).toBe(new Date((startSec + 60) * 1000).toISOString());
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

      // 4. Excessive point count: inclusive endpoints floor((end - start)/step) + 1 <= 11000
      // startSec = 0, endSec = 11000, stepSec = 1 -> floor(11000/1) + 1 = 11,001 points > 11,000 limit
      const boundaryExcessive = await client.queryRange({
        query: "up",
        startSec: 0,
        endSec: 11000,
        stepSec: 1,
      });
      expect(boundaryExcessive.success).toBe(false);
      expect(boundaryExcessive.diagnostic.message).toContain("exceeds standard point limit");

      // 5. Non-finite values
      const nonFinite = await client.queryRange({
        query: "up",
        startSec: NaN,
        endSec: 1000,
        stepSec: 10,
      });
      expect(nonFinite.success).toBe(false);
      expect(nonFinite.diagnostic.message).toContain("must be finite numbers");
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

    it("transitions to DEGRADED when Tempo fails but Prometheus succeeds", async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        // Prometheus succeeds
        if (decoded.includes(":9090") || decoded.includes("/api/prom") || decoded.includes("rate(http_requests_total[1m])")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "vector",
                result: [{ metric: { service: "order-service" }, value: [1730000000, "150.0"] }],
              },
            }),
          } as unknown as Response);
        }
        // Tempo / Jaeger fails with 503
        if (decoded.includes(":3200") || decoded.includes(":16686") || decoded.includes("/api/traces")) {
          return Promise.resolve({
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
            text: async () => "Tempo distributor unreachable",
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
      expect(batch.mode).toBe("DEGRADED");
      const tempoDiag = batch.diagnostics.find((d) => d.provider === "TEMPO");
      expect(tempoDiag?.status).toBe("ERROR");
      expect(manager.getLastIngestedAt()).toBeNull();
    });

    it("strictly isolates SIMULATION mode and executes zero external network requests across all telemetry entry points", async () => {
      const fetchSpy = vi.spyOn(global, "fetch");

      const manager = new TelemetryManager();
      manager.setMode("SIMULATION");

      // 1. Normalized Batch
      const batch = await manager.getNormalizedBatch();
      expect(batch.mode).toBe("SIMULATION");
      expect(batch.metrics.length).toBeGreaterThan(0);
      for (const m of batch.metrics) {
        expect(m.provider).toBe("SIMULATION");
      }

      // 2. Observed Services
      const overview = await manager.getObservedServices();
      expect(overview.mode).toBe("SIMULATION");
      for (const s of overview.observedServices) {
        expect(s.source).toBe("SIMULATION");
      }

      // 3. Recent Traces
      const traces = await manager.getRecentTraces();
      expect(traces).toEqual([]);

      // 4. Trace Detail
      const detail = await manager.getTraceDetail("trace-sim-001");
      expect(detail).toBeNull();

      // STRICT ISOLATION PROOF: Zero network calls made
      expect(fetchSpy).not.toHaveBeenCalled();
      // lastIngestedAt is NOT updated in simulation
      expect(manager.getLastIngestedAt()).toBeNull();
    });

    it("only updates lastIngestedAt timestamp after fully validated LIVE collection", async () => {
      const manager = new TelemetryManager();
      manager.setMode("LIVE");

      // Initial state is null
      expect(manager.getLastIngestedAt()).toBeNull();

      // Degraded run (offline backends)
      global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      await manager.getNormalizedBatch();
      expect(manager.getLastIngestedAt()).toBeNull();

      // Verified LIVE run
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("rate(http_requests_total[1m])")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: { result: [{ metric: { service: "order-service" }, value: [1730000000, "150.0"] }] },
            }),
          } as unknown as Response);
        }
        if (decoded.includes("/api/v1/query_range")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [{ metric: { service: "order-service" }, values: [[1730000000, "150.0"]] }],
              },
            }),
          } as unknown as Response);
        }
        if (decoded.includes("/api/traces") || decoded.includes("/api/search")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              traces: [
                {
                  traceID: "tr-live-verified",
                  rootServiceName: "order-service",
                  durationMs: 45,
                  spanSet: {
                    spans: [
                      {
                        spanID: "sp-1",
                        operationName: "POST /order",
                        startTime: 1730000000000,
                        duration: 45000,
                        tags: [],
                      },
                    ],
                  },
                },
              ],
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

      const liveBatch = await manager.getNormalizedBatch();
      expect(liveBatch.mode).toBe("LIVE");
      expect(manager.getLastIngestedAt()).not.toBeNull();
      const lastIngested = new Date(manager.getLastIngestedAt()!).getTime();
      expect(Number.isFinite(lastIngested)).toBe(true);
    });
  });

  // =========================================================================
  // 6. Mock Observability Server & PromQL Evaluation Suite
  // =========================================================================
  describe("Mock Observability Server & PromQL Evaluation", () => {
    it("evaluates supported PromQL expressions deterministically and rejects unsupported queries", () => {
      const nowSec = Math.floor(Date.now() / 1000);

      // 1. Health checks
      const upPoints = evaluateMockPromQl("up", nowSec);
      expect(upPoints).not.toBeNull();
      expect(upPoints!.length).toBeGreaterThan(0);
      expect(upPoints![0].value[1]).toBe("1");
      expect(upPoints![0].metric["instance"]).toBeDefined();

      const vecPoints = evaluateMockPromQl("vector(1)", nowSec);
      expect(vecPoints).toEqual([{ metric: {}, value: [nowSec, "1"] }]);

      // 2. Request rates
      const ratePoints = evaluateMockPromQl("sum by (service) (rate(http_requests_total[1m]))", nowSec);
      expect(ratePoints).not.toBeNull();
      expect(ratePoints!.length).toBeGreaterThan(0);
      expect(ratePoints![0].metric["service"]).toBeDefined();

      // 3. Error rates
      const errPoints = evaluateMockPromQl("sum by (service) (rate(http_request_errors_total[1m]))", nowSec);
      expect(errPoints).not.toBeNull();
      expect(errPoints!.length).toBeGreaterThan(0);

      // 4. Histogram sum/count latency
      const latPoints = evaluateMockPromQl(
        "sum by (service) (rate(http_request_duration_seconds_sum[1m])) / sum by (service) (rate(http_request_duration_seconds_count[1m]))",
        nowSec
      );
      expect(latPoints).not.toBeNull();
      expect(latPoints!.length).toBeGreaterThan(0);
      expect(parseFloat(latPoints![0].value[1])).toBeGreaterThan(0);

      // 5. P95 Histogram Quantile
      const p95Points = evaluateMockPromQl(
        "histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[1m])))",
        nowSec
      );
      expect(p95Points).not.toBeNull();
      expect(p95Points!.length).toBeGreaterThan(0);
      expect(parseFloat(p95Points![0].value[1])).toBeGreaterThan(0);

      // 6. Histogram buckets with le labels
      const bucketPoints = evaluateMockPromQl(
        "sum by (le, service) (rate(http_request_duration_seconds_bucket[1m]))",
        nowSec
      );
      expect(bucketPoints).not.toBeNull();
      expect(bucketPoints!.length).toBeGreaterThan(0);
      expect(bucketPoints![0].metric["le"]).toBeDefined();

      // 7. Unsupported expressions return null (mock server responds 400 Bad Request)
      const unsupported = evaluateMockPromQl("unknown_metric{foo='bar'}", nowSec);
      expect(unsupported).toBeNull();
    });
  });

  // =========================================================================
  // 10. Prometheus Data Integrity & Regression Suite
  // =========================================================================
  describe("Prometheus Data Integrity & Regression Suite", () => {
    it("reports failure when request-rate succeeds but error-rate query fails", async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("http_requests_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "vector",
                result: [{ metric: { service: "order-service" }, value: [1730000000, "100.0"] }],
              },
            }),
          } as unknown as Response);
        }
        if (decoded.includes("http_request_errors_total")) {
          return Promise.resolve({
            ok: false,
            status: 500,
            headers: new Headers(),
            json: async () => ({ status: "error", error: "Internal server error" }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ status: "success", data: { result: [] } }),
        } as unknown as Response);
      });

      const client = new PrometheusClient("http://mock-prom:9090", 2000);
      const res = await client.getServiceMetricsDetailed();

      expect(res.success).toBe(false);
      expect(res.metrics.size).toBe(0);
      const errDiag = res.diagnostics.find((d) => d.errorCode === "UNAVAILABLE" || d.status === "ERROR");
      expect(errDiag).toBeDefined();
    });

    it("reports failure when request-rate succeeds but average-latency query fails", async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("http_request_duration_seconds_sum")) {
          return Promise.resolve({
            ok: false,
            status: 503,
            headers: new Headers(),
            json: async () => ({ status: "error", error: "Service unavailable" }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: "success",
            data: {
              resultType: "vector",
              result: [{ metric: { service: "order-service" }, value: [1730000000, "50.0"] }],
            },
          }),
        } as unknown as Response);
      });

      const client = new PrometheusClient("http://mock-prom:9090", 2000);
      const res = await client.getServiceMetricsDetailed();

      expect(res.success).toBe(false);
      expect(res.metrics.size).toBe(0);
    });

    it("fails range request history when request-rate succeeds but error-range query fails", async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("http_request_errors_total")) {
          return Promise.resolve({
            ok: false,
            status: 500,
            headers: new Headers(),
            json: async () => ({ status: "error", error: "TSDB storage failure" }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: "success",
            data: {
              resultType: "matrix",
              result: [
                {
                  metric: { service: "payment-service" },
                  values: [[1730000000, "150.0"]],
                },
              ],
            },
          }),
        } as unknown as Response);
      });

      const client = new PrometheusClient("http://mock-prom:9090", 2000);
      const history = await client.getServiceMetricsHistory({ lookbackSec: 300, stepSec: 60 });

      expect(history.success).toBe(false);
      expect(history.historyByService.size).toBe(0);
    });

    it("fails range request history when request-rate succeeds but latency-range query fails", async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("http_request_duration_seconds")) {
          return Promise.resolve({
            ok: false,
            status: 500,
            headers: new Headers(),
            json: async () => ({ status: "error", error: "Latency range failure" }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: "success",
            data: {
              resultType: "matrix",
              result: [
                {
                  metric: { service: "payment-service" },
                  values: [[1730000000, "150.0"]],
                },
              ],
            },
          }),
        } as unknown as Response);
      });

      const client = new PrometheusClient("http://mock-prom:9090", 2000);
      const history = await client.getServiceMetricsHistory({ lookbackSec: 300, stepSec: 60 });

      expect(history.success).toBe(false);
    });

    it("distinguishes P95 provider failure from unsupported histogram buckets", async () => {
      // Case 1: P95 HTTP Request fails (e.g. 500) -> overall success is false
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("histogram_quantile")) {
          return Promise.resolve({
            ok: false,
            status: 500,
            headers: new Headers(),
            json: async () => ({ status: "error", error: "Histogram engine error" }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: "success",
            data: {
              resultType: "vector",
              result: [{ metric: { service: "order-service" }, value: [1730000000, "10.0"] }],
            },
          }),
        } as unknown as Response);
      });

      const client = new PrometheusClient("http://mock-prom:9090", 2000);
      const failRes = await client.getServiceMetricsDetailed();
      expect(failRes.success).toBe(false);

      // Case 2: P95 query succeeds (200 OK) but returns no matching series (buckets genuinely absent)
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("histogram_quantile")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: { resultType: "vector", result: [] },
            }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: "success",
            data: {
              resultType: "vector",
              result: [{ metric: { service: "order-service" }, value: [1730000000, "10.0"] }],
            },
          }),
        } as unknown as Response);
      });

      const unsuppRes = await client.getServiceMetricsDetailed();
      expect(unsuppRes.success).toBe(true);
      expect(unsuppRes.p95Supported).toBe(false);
      const svcMetrics = unsuppRes.metrics.get("order-service");
      expect(svcMetrics?.hasValidP95).toBe(false);
      expect(svcMetrics?.latencyP95Ms).toBeUndefined();
    });

    it("calculates normalized ERROR_RATE percentage records with % unit and keeps ERROR_THROUGHPUT distinct", async () => {
      const startSec = 1730000000;
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("http_requests_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [
                  {
                    metric: { service: "payment-service" },
                    values: [[startSec, "50.0"]], // 50 req/s
                  },
                ],
              },
            }),
          } as unknown as Response);
        }
        if (decoded.includes("http_request_errors_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [
                  {
                    metric: { service: "payment-service" },
                    values: [[startSec, "5.0"]], // 5 errors/s
                  },
                ],
              },
            }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: "success",
            data: {
              resultType: "matrix",
              result: [
                {
                  metric: { service: "payment-service" },
                  values: [[startSec, "0.035"]],
                },
              ],
            },
          }),
        } as unknown as Response);
      });

      const client = new PrometheusClient("http://mock-prom:9090", 2000);
      const history = await client.getServiceMetricsHistory({ lookbackSec: 300, stepSec: 60 });

      expect(history.success).toBe(true);

      // Verify raw throughput has unit errors/s and metricType ERROR_THROUGHPUT
      const rawThroughput = history.records.find((r) => r.metricType === "ERROR_THROUGHPUT");
      expect(rawThroughput).toBeDefined();
      expect(rawThroughput?.unit).toBe("errors/s");
      expect(rawThroughput?.value).toBe(5);

      // Verify calculated ERROR_RATE has unit % and calculated percentage 10%
      const errorRate = history.records.find((r) => r.metricType === "ERROR_RATE");
      expect(errorRate).toBeDefined();
      expect(errorRate?.unit).toBe("%");
      expect(errorRate?.value).toBe(10); // (5 / 50) * 100 = 10%

      // Verify history point errorRate
      const pt = history.historyByService.get("payment-service")![0];
      expect(pt.errorRate).toBe(10);
      expect(pt.requestRate).toBe(50);
    });

    it("preserves fractional request rates without rounding before division (0.4 req/s and 0.1 errors/s produces 25%)", async () => {
      const startSec = 1730000000;
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("http_requests_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [
                  {
                    metric: { service: "low-vol-service" },
                    values: [[startSec, "0.4"]], // 0.4 req/s (Math.round would have turned this into 0!)
                  },
                ],
              },
            }),
          } as unknown as Response);
        }
        if (decoded.includes("http_request_errors_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [
                  {
                    metric: { service: "low-vol-service" },
                    values: [[startSec, "0.1"]], // 0.1 errors/s
                  },
                ],
              },
            }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: "success",
            data: { resultType: "matrix", result: [] },
          }),
        } as unknown as Response);
      });

      const client = new PrometheusClient("http://mock-prom:9090", 2000);
      const history = await client.getServiceMetricsHistory({ lookbackSec: 300, stepSec: 60 });

      expect(history.success).toBe(true);
      const pt = history.historyByService.get("low-vol-service")![0];
      expect(pt.requestRate).toBe(0.4);
      expect(pt.errorRate).toBe(25); // (0.1 / 0.4) * 100 = 25%

      const calcRec = history.records.find((r) => r.metricType === "ERROR_RATE" && r.serviceName === "low-vol-service");
      expect(calcRec?.value).toBe(25);
      expect(calcRec?.unit).toBe("%");
    });

    it("safely handles zero request rate producing 0% without NaN or Infinity", async () => {
      const startSec = 1730000000;
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("http_requests_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [{ metric: { service: "idle-service" }, values: [[startSec, "0.0"]] }],
              },
            }),
          } as unknown as Response);
        }
        if (decoded.includes("http_request_errors_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [{ metric: { service: "idle-service" }, values: [[startSec, "0.0"]] }],
              },
            }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: "success",
            data: { resultType: "matrix", result: [] },
          }),
        } as unknown as Response);
      });

      const client = new PrometheusClient("http://mock-prom:9090", 2000);
      const history = await client.getServiceMetricsHistory({ lookbackSec: 300, stepSec: 60 });

      expect(history.success).toBe(true);
      const pt = history.historyByService.get("idle-service")![0];
      expect(pt.errorRate).toBe(0);
      expect(Number.isFinite(pt.errorRate)).toBe(true);
    });

    it("verifies mock range history changes across windows rather than repeating a single snapshot", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const startSec = nowSec - 600; // 10 minutes ago
      const endSec = nowSec;
      const stepSec = 60; // 1 minute steps

      const rangeResult = evaluateMockPromQlRange(
        "sum by (service) (rate(http_request_duration_seconds_sum[1m])) / sum by (service) (rate(http_request_duration_seconds_count[1m]))",
        startSec,
        endSec,
        stepSec
      );

      expect(rangeResult).not.toBeNull();
      expect(rangeResult!.length).toBeGreaterThan(0);

      const paymentSeries = rangeResult!.find((s) => s.metric["service"] === "payment-service");
      expect(paymentSeries).toBeDefined();
      expect(paymentSeries!.values.length).toBeGreaterThan(1);

      // Verify that points across time are NOT all identical
      const firstVal = parseFloat(paymentSeries!.values[0][1]);
      const lastVal = parseFloat(paymentSeries!.values[paymentSeries!.values.length - 1][1]);
      // Baseline was ~30ms while recent traffic spiked to ~140ms
      expect(firstVal).not.toBe(lastVal);
      expect(lastVal).toBeGreaterThan(firstVal);
    });

    it("computes cumulative, monotonically non-decreasing histogram buckets with +Inf containing all observations", () => {
      const latenciesSec = [0.015, 0.045, 0.080, 0.120, 0.350, 0.900, 1.500];
      const buckets = computeHistogramBuckets(latenciesSec);

      expect(buckets.length).toBe(PROMETHEUS_LE_STRINGS.length);

      // Check monotonicity
      for (let i = 0; i < buckets.length - 1; i++) {
        expect(buckets[i].count).toBeLessThanOrEqual(buckets[i + 1].count);
      }

      // Check +Inf bucket contains all observations
      const infBucket = buckets.find((b) => b.le === "+Inf");
      expect(infBucket?.count).toBe(latenciesSec.length);
    });

    it("guarantees mock P95 calculation is mathematically consistent with its bucket distribution", () => {
      const latenciesSec = [0.010, 0.020, 0.030, 0.040, 0.050, 0.060, 0.070, 0.080, 0.090, 0.100];
      const buckets = computeHistogramBuckets(latenciesSec);
      const p95 = calculateHistogramQuantile(0.95, buckets);

      // 95th percentile of 10 items is between item 9 (0.09) and 10 (0.10)
      expect(p95).toBeGreaterThanOrEqual(0.09);
      expect(p95).toBeLessThanOrEqual(0.10);

      // Empty bucket distribution produces 0
      const emptyP95 = calculateHistogramQuantile(0.95, []);
      expect(emptyP95).toBe(0);
    });

    it("aggregates bucket counts across multiple instances before computing P95", () => {
      // Instance 1: fast requests [10ms, 15ms]
      const inst1Latencies = [0.010, 0.015];
      // Instance 2: slower requests [60ms, 85ms]
      const inst2Latencies = [0.060, 0.085];

      const b1 = computeHistogramBuckets(inst1Latencies);
      const b2 = computeHistogramBuckets(inst2Latencies);

      // Aggregate buckets across instances
      const aggregatedBuckets = b1.map((b, idx) => ({
        le: b.le,
        bound: b.bound,
        count: b.count + b2[idx].count,
      }));

      const infBucket = aggregatedBuckets.find((b) => b.le === "+Inf");
      expect(infBucket?.count).toBe(4);

      const combinedP95 = calculateHistogramQuantile(0.95, aggregatedBuckets);
      // P95 of combined distribution [10ms, 15ms, 60ms, 85ms] is near the 85ms boundary
      expect(combinedP95).toBeGreaterThan(0.060);
      expect(combinedP95).toBeLessThanOrEqual(0.100);
    });

    it("truthfully returns empty history when observation store is cleared without fabricating synthetic trends", () => {
      obsStore.clear();

      const nowSec = Math.floor(Date.now() / 1000);
      const rangeResult = evaluateMockPromQlRange(
        "sum by (service) (rate(http_requests_total[1m]))",
        nowSec - 300,
        nowSec,
        60
      );

      expect(rangeResult).toEqual([]);

      const instantResult = evaluateMockPromQl(
        "sum by (service) (rate(http_requests_total[1m]))",
        nowSec
      );
      expect(instantResult).toEqual([]);

      // Restore baseline observations for subsequent runs
      obsStore.seedBaselineObservations();
    });

    it("ensures downstream RootCauseEngine consumes normalized ERROR_RATE percentage records rather than raw errors/second", async () => {
      // In a low-volume incident, request rate is 0.4 req/s and error throughput is 0.1 errors/s
      // If raw error throughput (0.1) were used as errorRate (%), it would equal 0.1%, matching baseline error rate (0.1%), masking the outage.
      // With normalized ERROR_RATE (25%), the RootCauseEngine detects the massive 250x error rate spike.
      const startSec = 1730000000;
      global.fetch = vi.fn().mockImplementation((url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("http_requests_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [{ metric: { service: "payment-service" }, values: [[startSec, "0.4"]] }],
              },
            }),
          } as unknown as Response);
        }
        if (decoded.includes("http_request_errors_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [{ metric: { service: "payment-service" }, values: [[startSec, "0.1"]] }],
              },
            }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: "success",
            data: { resultType: "matrix", result: [] },
          }),
        } as unknown as Response);
      });

      const client = new PrometheusClient("http://mock-prom:9090", 2000);
      const history = await client.getServiceMetricsHistory({ lookbackSec: 300, stepSec: 60 });

      const rawThroughput = history.records.find((r) => r.serviceName === "payment-service" && r.metricType === "ERROR_THROUGHPUT");
      const normalizedErrorRate = history.records.find((r) => r.serviceName === "payment-service" && r.metricType === "ERROR_RATE");

      expect(rawThroughput?.value).toBe(0.1);
      expect(rawThroughput?.unit).toBe("errors/s");

      expect(normalizedErrorRate?.value).toBe(25);
      expect(normalizedErrorRate?.unit).toBe("%");

      // Build graph and root cause engine input using the normalized percentage
      const graph = createMultiServiceGraph();
      const node = graph.getNode("payment-service")!;

      // Verify that passing raw error throughput (0.1) does not exceed baseline (0.1%)
      expect(rawThroughput!.value <= node.baselineErrorRate).toBe(true);

      // Verify that passing normalized error percentage (25%) exceeds baseline (0.1%) by 250x
      expect(normalizedErrorRate!.value > node.baselineErrorRate).toBe(true);

      const rcaEngine = new RootCauseEngine(3);
      const sampleWithNormalizedPct: TelemetryPoint = {
        serviceId: "payment-service",
        simulationStep: 1,
        timestamp: new Date(startSec * 1000).toISOString(),
        latency: 45,
        errorRate: normalizedErrorRate!.value, // 25%
        requestCount: 0.4,
        healthStatus: "DEGRADED",
      };

      const states = new Map([
        ["payment-service", { status: "DEGRADED" as const, latency: 45, errorRate: normalizedErrorRate!.value }],
      ]);

      const result = rcaEngine.analyzeIncident({
        incidentId: "test-rca-integrity",
        graph,
        telemetrySamples: [sampleWithNormalizedPct],
        currentServiceStates: states,
      });

      expect(result.isConclusive).toBe(true);
      expect(result.topRootCause).toBeDefined();
      expect(result.topRootCause?.serviceId).toBe("payment-service");
      expect(result.topRootCause?.supportingEvidence.some((e) => e.type === "TELEMETRY_SPIKE" || e.description.includes("error"))).toBe(true);
    });
  });

  // =========================================================================
  // 8. End-to-End RCA Evidence Integrity Suite
  // =========================================================================
  describe("End-to-End RCA Evidence Integrity Suite", () => {
    const liveHealthStatus: BackendHealthStatus = {
      prometheusAvailable: true,
      jaegerAvailable: true,
      prometheusUrl: "http://localhost:9090",
      jaegerUrl: "http://localhost:16686",
      isMockBackend: false,
      isCloudBackend: false,
      cloudConfigured: false,
      backendType: "GENUINE_STACK",
      lastChecked: new Date().toISOString(),
    };

    it("verifies rate(...[1m]) uses fixed 60-second lookback window regardless of step size (15, 30, 60, 120s)", () => {
      obsStore.clear();
      const baseSec = 1730000000;

      // Seed 120 observations over 60 seconds (baseSec - 60 to baseSec) for payment-service:
      // Exactly 120 requests in the 60-second window -> rate should be exactly 120 / 60 = 2.0 req/s
      for (let s = 1; s <= 60; s++) {
        obsStore.addObservation({
          serviceName: "payment-service",
          instance: "payment-service-inst-1",
          timestampMs: (baseSec - 60 + s) * 1000,
          latencyMs: 40,
          isError: false,
          requestCount: 2,
        });
      }

      // Test with step sizes: 15s, 30s, 60s, 120s
      const stepSizes = [15, 30, 60, 120];

      for (const stepSec of stepSizes) {
        const startSec = baseSec - 120;
        const endSec = baseSec;

        const matrix = evaluateMockPromQlRange(
          "sum by (service) (rate(http_requests_total[1m]))",
          startSec,
          endSec,
          stepSec
        );

        expect(matrix).not.toBeNull();
        expect(matrix!.length).toBeGreaterThan(0);

        const paymentSeries = matrix!.find((m) => m.metric["service"] === "payment-service");
        expect(paymentSeries).toBeDefined();

        // Verify timestamps step by stepSec
        for (let i = 1; i < paymentSeries!.values.length; i++) {
          const prevTime = paymentSeries!.values[i - 1][0];
          const currTime = paymentSeries!.values[i][0];
          expect(currTime - prevTime).toBe(stepSec);
        }

        // The point evaluated at baseSec MUST evaluate exactly over [baseSec - 60, baseSec]
        // Rate is 120 / 60 = 2.0 req/s across all step sizes!
        const evalPointAtEnd = paymentSeries!.values.find((v) => v[0] === baseSec);
        expect(evalPointAtEnd).toBeDefined();
        expect(parseFloat(evalPointAtEnd![1])).toBe(2.0);
      }
    });

    it("handles all ERROR_RATE missing-series combinations strictly without fabricating false healthy status", async () => {
      const startSec = 1730000000;
      // Case A: Missing error series (absent error instrumentation)
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("http_requests_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [{ metric: { service: "auth-service" }, values: [[startSec, "10.0"]] }],
              },
            }),
          } as unknown as Response);
        }
        // Error query returns empty result (absent error series)
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: "success",
            data: { resultType: "matrix", result: [] },
          }),
        } as unknown as Response);
      });

      const client = new PrometheusClient("http://mock-prom:9090", 2000);
      const historyMissingError = await client.getServiceMetricsHistory({ lookbackSec: 300, stepSec: 60 });

      // Verify no ERROR_RATE record is generated for auth-service (does not fabricate 0%)
      const errRateRecordsA = historyMissingError.records.filter(
        (r) => r.serviceName === "auth-service" && r.metricType === "ERROR_RATE"
      );
      expect(errRateRecordsA.length).toBe(0);
      const ptA = historyMissingError.historyByService.get("auth-service")?.[0];
      expect(ptA?.hasValidErrorRate).toBeFalsy();

      // Case B: Missing request series (absent request rate instrumentation)
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("http_request_errors_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [{ metric: { service: "cache-service" }, values: [[startSec, "2.0"]] }],
              },
            }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: "success",
            data: { resultType: "matrix", result: [] },
          }),
        } as unknown as Response);
      });

      const historyMissingReq = await client.getServiceMetricsHistory({ lookbackSec: 300, stepSec: 60 });
      const errRateRecordsB = historyMissingReq.records.filter(
        (r) => r.serviceName === "cache-service" && r.metricType === "ERROR_RATE"
      );
      expect(errRateRecordsB.length).toBe(0);

      // Case C: Zero request traffic (req = 0, err = 0) -> explicit no-traffic condition
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("http_requests_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [{ metric: { service: "idle-service" }, values: [[startSec, "0"]] }],
              },
            }),
          } as unknown as Response);
        }
        if (url.includes("http_request_errors_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [{ metric: { service: "idle-service" }, values: [[startSec, "0"]] }],
              },
            }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: "success",
            data: { resultType: "matrix", result: [] },
          }),
        } as unknown as Response);
      });

      const historyIdle = await client.getServiceMetricsHistory({ lookbackSec: 300, stepSec: 60 });
      // Zero request volume must NOT generate fabricated 0% error rate
      const errRateRecordsC = historyIdle.records.filter(
        (r) => r.serviceName === "idle-service" && r.metricType === "ERROR_RATE"
      );
      expect(errRateRecordsC.length).toBe(0);
      const ptC = historyIdle.historyByService.get("idle-service")?.[0];
      expect(ptC?.hasValidErrorRate).toBe(false);

      // Case D: Valid traffic > 0 and 0 errors -> genuine 0% ERROR_RATE record generated
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("http_requests_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [{ metric: { service: "healthy-service" }, values: [[startSec, "25.0"]] }],
              },
            }),
          } as unknown as Response);
        }
        if (url.includes("http_request_errors_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [{ metric: { service: "healthy-service" }, values: [[startSec, "0.0"]] }],
              },
            }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: "success",
            data: { resultType: "matrix", result: [] },
          }),
        } as unknown as Response);
      });

      const historyHealthy = await client.getServiceMetricsHistory({ lookbackSec: 300, stepSec: 60 });
      const errRateRecordsD = historyHealthy.records.filter(
        (r) => r.serviceName === "healthy-service" && r.metricType === "ERROR_RATE"
      );
      expect(errRateRecordsD.length).toBe(1);
      expect(errRateRecordsD[0].value).toBe(0);
      expect(errRateRecordsD[0].unit).toBe("%");
      const ptD = historyHealthy.historyByService.get("healthy-service")?.[0];
      expect(ptD?.hasValidErrorRate).toBe(true);
      expect(ptD?.errorRate).toBe(0);

      // Case E: Valid throughput (0.1 errors/s) with volume (0.4 req/s) -> 25% ERROR_RATE record
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("http_requests_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [{ metric: { service: "active-service" }, values: [[startSec, "0.4"]] }],
              },
            }),
          } as unknown as Response);
        }
        if (url.includes("http_request_errors_total")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              status: "success",
              data: {
                resultType: "matrix",
                result: [{ metric: { service: "active-service" }, values: [[startSec, "0.1"]] }],
              },
            }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: "success",
            data: { resultType: "matrix", result: [] },
          }),
        } as unknown as Response);
      });

      const historyActive = await client.getServiceMetricsHistory({ lookbackSec: 300, stepSec: 60 });
      const rawThroughputE = historyActive.records.find(
        (r) => r.serviceName === "active-service" && r.metricType === "ERROR_THROUGHPUT"
      );
      const errRateE = historyActive.records.find(
        (r) => r.serviceName === "active-service" && r.metricType === "ERROR_RATE"
      );

      expect(rawThroughputE?.value).toBe(0.1);
      expect(rawThroughputE?.unit).toBe("errors/s");
      expect(errRateE?.value).toBe(25);
      expect(errRateE?.unit).toBe("%");
    });

    it("strictly handles trace-only, metrics-only, and partial telemetry without fabricating baseline metrics", async () => {
      telemetryManager.setMode("LIVE");

      // Mock Prometheus: payment-service has metrics; order-service has NO metrics (only traces)
      vi.spyOn(telemetryManager, "getBackendHealth").mockResolvedValue({
        prometheusAvailable: true,
        jaegerAvailable: true,
        prometheusUrl: "http://localhost:9090",
        jaegerUrl: "http://localhost:16686",
        isMockBackend: false,
        isCloudBackend: false,
        cloudConfigured: false,
        backendType: "GENUINE_STACK",
        lastChecked: new Date().toISOString(),
      });

      const mockPromDetailed: ServiceMetricsDetailedResult = {
        success: true,
        p95Supported: true,
        diagnostics: [],
        metrics: new Map([
          [
            "payment-service",
            {
              serviceName: "payment-service",
              latencyMs: 50,
              hasValidLatency: true,
              errorRate: 0,
              hasValidErrorRate: true,
              requestRate: 20,
              hasValidRequestRate: true,
              hasValidP95: false,
              instanceCount: 1,
            },
          ],
        ]),
      };

      vi.spyOn(PrometheusClient.prototype, "getServiceMetricsDetailed").mockResolvedValue(mockPromDetailed);

      // Mock Jaeger: order-service has traces (trace-only), payment-service has 0 traces
      const mockTraces: DistributedTrace[] = [
        {
          traceId: "trace-order-only",
          rootServiceName: "order-service",
          operationName: "GET /orders",
          startTime: new Date().toISOString(),
          durationMs: 45,
          totalSpans: 2,
          servicesInvolved: ["order-service"],
          hasErrors: false,
          rootSpan: null,
          allSpans: [],
        },
      ];

      vi.spyOn(JaegerClient.prototype, "getRecentTracesDetailed").mockResolvedValue({
        success: true,
        traces: mockTraces,
        normalizedSpans: [],
        diagnostic: {
          provider: "TEMPO",
          endpoint: "/api/traces",
          status: "OK",
          message: "Traces retrieved",
          latencyMs: 10,
          timestamp: new Date().toISOString(),
        },
      });

      const { observedServices } = await telemetryManager.getObservedServices();

      // 1. Trace-only service (order-service): MUST be UNKNOWN, not HEALTHY, latency 0 (not baseline)
      const orderObs = observedServices.find((s) => s.serviceId === "order-service");
      expect(orderObs).toBeDefined();
      expect(orderObs!.status).toBe("UNKNOWN");
      expect(orderObs!.source).toBe("JAEGER");
      expect(orderObs!.traceCount).toBe(1);
      expect(orderObs!.latencyMs).toBe(0); // NOT baseline 42ms
      expect(orderObs!.isStale).toBe(true);
      expect(orderObs!.lastObserved).toContain("Trace observations present, but metric telemetry missing");

      // 2. Metrics-only service (payment-service): MUST be HEALTHY from actual metric measurements
      const paymentObs = observedServices.find((s) => s.serviceId === "payment-service");
      expect(paymentObs).toBeDefined();
      expect(paymentObs!.status).toBe("HEALTHY");
      expect(paymentObs!.source).toBe("PROMETHEUS");
      expect(paymentObs!.traceCount).toBe(0);
      expect(paymentObs!.latencyMs).toBe(50);
      expect(paymentObs!.isStale).toBe(false);
    });

    it("constructs multiple chronological TelemetryPoint samples with monotonic step ordering in RealRootCauseEngine", async () => {
      telemetryManager.setMode("LIVE");

      const now = Date.now();
      const t1 = new Date(now - 120000).toISOString();
      const t2 = new Date(now - 60000).toISOString();
      const t3 = new Date(now).toISOString();

      // Mock 3 chronological samples for payment-service in normalized batch
      const mockMetrics: NormalizedMetricRecord[] = [
        // T1: Step 1 (Healthy)
        { id: "m1", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "REQUEST_RATE", metricName: "req", timestamp: t1, value: 50, unit: "req/s", labels: {}, hasAnomaly: false },
        { id: "m2", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t1, value: 0, unit: "%", labels: {}, hasAnomaly: false },
        { id: "m3", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t1, value: 30, unit: "ms", labels: {}, hasAnomaly: false },

        // T2: Step 2 (Degrading)
        { id: "m4", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "REQUEST_RATE", metricName: "req", timestamp: t2, value: 45, unit: "req/s", labels: {}, hasAnomaly: false },
        { id: "m5", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t2, value: 8, unit: "%", labels: {}, hasAnomaly: true },
        { id: "m6", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t2, value: 120, unit: "ms", labels: {}, hasAnomaly: true },

        // T3: Step 3 (Down)
        { id: "m7", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "REQUEST_RATE", metricName: "req", timestamp: t3, value: 30, unit: "req/s", labels: {}, hasAnomaly: false },
        { id: "m8", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t3, value: 35, unit: "%", labels: {}, hasAnomaly: true },
        { id: "m9", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t3, value: 350, unit: "ms", labels: {}, hasAnomaly: true },
      ];

      vi.spyOn(telemetryManager, "getNormalizedBatch").mockResolvedValue({
        batchId: "test-batch-multi-step",
        collectedAt: new Date().toISOString(),
        mode: "LIVE",
        metrics: mockMetrics,
        spans: [],
        diagnostics: [],
      });

      vi.spyOn(telemetryManager, "getObservedServices").mockResolvedValue({
        mode: "LIVE",
        backendHealth: liveHealthStatus,
        observedServices: [
          {
            serviceId: "payment-service",
            serviceName: "Payment Gateway Service",
            source: "PROMETHEUS",
            status: "DOWN",
            latencyMs: 350,
            errorRate: 35,
            requestRate: 30,
            lastObserved: t3,
            traceCount: 0,
            isStale: false,
            isKnownInTopology: true,
          },
        ],
        unknownServices: [],
        lastCollectedAt: new Date().toISOString(),
        lastIngestedAt: new Date().toISOString(),
      });

      vi.spyOn(telemetryManager, "getRecentTraces").mockResolvedValue([]);

      const incident = await prisma.incident.create({
        data: {
          title: "Test Historical Telemetry Multi-Step",
          description: "Testing chronological step ingestion",
          severity: "HIGH",
          status: "INVESTIGATING",
          rootCauseStatus: "DETECTED",
        },
      });

      const analysis = await realRootCauseEngine.analyzeRealIncident(incident.id);

      expect(analysis.isConclusive).toBe(true);
      expect(analysis.topRootCause?.serviceId).toBe("payment-service");

      // Verify that candidates in database reflect analysis
      const savedCandidates = await prisma.rootCauseCandidate.findMany({
        where: { incidentId: incident.id },
      });
      expect(savedCandidates.length).toBeGreaterThan(0);
      const topSaved = savedCandidates.find((c) => c.rank === 1);
      expect(topSaved?.candidateServiceId).toBe("payment-service");
    });

    it("executes End-to-End Multi-Service Cascading RCA over real analysis path with correct root cause ranking", async () => {
      telemetryManager.setMode("LIVE");

      const baseTime = Date.now();
      const t1 = new Date(baseTime - 300000).toISOString(); // Step 1: Baseline
      const t2 = new Date(baseTime - 240000).toISOString(); // Step 2: Postgres contention onset
      const t3 = new Date(baseTime - 180000).toISOString(); // Step 3: Payment degrades
      const t4 = new Date(baseTime - 120000).toISOString(); // Step 4: Order checkout timeouts
      const t5 = new Date(baseTime - 60000).toISOString();  // Step 5: Gateway 504 surge
      const t6 = new Date(baseTime).toISOString();          // Step 6: Recovery

      // Build 6-step cascading telemetry history for all 4 services
      const mockMetrics: NormalizedMetricRecord[] = [
        // --- Step 1 (Baseline - All Normal) ---
        { id: "1-db-lat", provider: "PROMETHEUS", serviceName: "postgres-db", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t1, value: 11, unit: "ms", labels: {}, hasAnomaly: false },
        { id: "1-db-err", provider: "PROMETHEUS", serviceName: "postgres-db", metricType: "ERROR_RATE", metricName: "err", timestamp: t1, value: 0, unit: "%", labels: {}, hasAnomaly: false },
        { id: "1-pay-lat", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t1, value: 45, unit: "ms", labels: {}, hasAnomaly: false },
        { id: "1-pay-err", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t1, value: 0, unit: "%", labels: {}, hasAnomaly: false },
        { id: "1-ord-lat", provider: "PROMETHEUS", serviceName: "order-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t1, value: 35, unit: "ms", labels: {}, hasAnomaly: false },
        { id: "1-ord-err", provider: "PROMETHEUS", serviceName: "order-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t1, value: 0, unit: "%", labels: {}, hasAnomaly: false },
        { id: "1-gw-lat", provider: "PROMETHEUS", serviceName: "api-gateway", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t1, value: 18, unit: "ms", labels: {}, hasAnomaly: false },
        { id: "1-gw-err", provider: "PROMETHEUS", serviceName: "api-gateway", metricType: "ERROR_RATE", metricName: "err", timestamp: t1, value: 0, unit: "%", labels: {}, hasAnomaly: false },

        // --- Step 2 (Postgres Latency Surge - Originating Failure Onset) ---
        // postgres-db baseline is 11ms; 1850ms is ~168x baseline!
        { id: "2-db-lat", provider: "PROMETHEUS", serviceName: "postgres-db", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t2, value: 1850, unit: "ms", labels: {}, hasAnomaly: true },
        { id: "2-db-err", provider: "PROMETHEUS", serviceName: "postgres-db", metricType: "ERROR_RATE", metricName: "err", timestamp: t2, value: 0, unit: "%", labels: {}, hasAnomaly: false },
        { id: "2-pay-lat", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t2, value: 50, unit: "ms", labels: {}, hasAnomaly: false },
        { id: "2-pay-err", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t2, value: 0, unit: "%", labels: {}, hasAnomaly: false },
        { id: "2-ord-lat", provider: "PROMETHEUS", serviceName: "order-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t2, value: 38, unit: "ms", labels: {}, hasAnomaly: false },
        { id: "2-ord-err", provider: "PROMETHEUS", serviceName: "order-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t2, value: 0, unit: "%", labels: {}, hasAnomaly: false },
        { id: "2-gw-lat", provider: "PROMETHEUS", serviceName: "api-gateway", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t2, value: 20, unit: "ms", labels: {}, hasAnomaly: false },
        { id: "2-gw-err", provider: "PROMETHEUS", serviceName: "api-gateway", metricType: "ERROR_RATE", metricName: "err", timestamp: t2, value: 0, unit: "%", labels: {}, hasAnomaly: false },

        // --- Step 3 (Payment Stalls Waiting for DB) ---
        { id: "3-db-lat", provider: "PROMETHEUS", serviceName: "postgres-db", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t3, value: 1900, unit: "ms", labels: {}, hasAnomaly: true },
        { id: "3-db-err", provider: "PROMETHEUS", serviceName: "postgres-db", metricType: "ERROR_RATE", metricName: "err", timestamp: t3, value: 0, unit: "%", labels: {}, hasAnomaly: false },
        { id: "3-pay-lat", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t3, value: 1950, unit: "ms", labels: {}, hasAnomaly: true },
        { id: "3-pay-err", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t3, value: 15, unit: "%", labels: {}, hasAnomaly: true },
        { id: "3-ord-lat", provider: "PROMETHEUS", serviceName: "order-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t3, value: 75, unit: "ms", labels: {}, hasAnomaly: false },
        { id: "3-ord-err", provider: "PROMETHEUS", serviceName: "order-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t3, value: 0, unit: "%", labels: {}, hasAnomaly: false },
        { id: "3-gw-lat", provider: "PROMETHEUS", serviceName: "api-gateway", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t3, value: 25, unit: "ms", labels: {}, hasAnomaly: false },
        { id: "3-gw-err", provider: "PROMETHEUS", serviceName: "api-gateway", metricType: "ERROR_RATE", metricName: "err", timestamp: t3, value: 0, unit: "%", labels: {}, hasAnomaly: false },

        // --- Step 4 (Order Service Checkout Timeout Surge) ---
        { id: "4-db-lat", provider: "PROMETHEUS", serviceName: "postgres-db", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t4, value: 1920, unit: "ms", labels: {}, hasAnomaly: true },
        { id: "4-db-err", provider: "PROMETHEUS", serviceName: "postgres-db", metricType: "ERROR_RATE", metricName: "err", timestamp: t4, value: 0, unit: "%", labels: {}, hasAnomaly: false },
        { id: "4-pay-lat", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t4, value: 2000, unit: "ms", labels: {}, hasAnomaly: true },
        { id: "4-pay-err", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t4, value: 22, unit: "%", labels: {}, hasAnomaly: true },
        { id: "4-ord-lat", provider: "PROMETHEUS", serviceName: "order-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t4, value: 2100, unit: "ms", labels: {}, hasAnomaly: true },
        { id: "4-ord-err", provider: "PROMETHEUS", serviceName: "order-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t4, value: 25, unit: "%", labels: {}, hasAnomaly: true },
        { id: "4-gw-lat", provider: "PROMETHEUS", serviceName: "api-gateway", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t4, value: 80, unit: "ms", labels: {}, hasAnomaly: false },
        { id: "4-gw-err", provider: "PROMETHEUS", serviceName: "api-gateway", metricType: "ERROR_RATE", metricName: "err", timestamp: t4, value: 0, unit: "%", labels: {}, hasAnomaly: false },

        // --- Step 5 (API Gateway Ingress Timeout Surge) ---
        { id: "5-db-lat", provider: "PROMETHEUS", serviceName: "postgres-db", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t5, value: 1900, unit: "ms", labels: {}, hasAnomaly: true },
        { id: "5-db-err", provider: "PROMETHEUS", serviceName: "postgres-db", metricType: "ERROR_RATE", metricName: "err", timestamp: t5, value: 0, unit: "%", labels: {}, hasAnomaly: false },
        { id: "5-pay-lat", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t5, value: 1980, unit: "ms", labels: {}, hasAnomaly: true },
        { id: "5-pay-err", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t5, value: 25, unit: "%", labels: {}, hasAnomaly: true },
        { id: "5-ord-lat", provider: "PROMETHEUS", serviceName: "order-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t5, value: 2150, unit: "ms", labels: {}, hasAnomaly: true },
        { id: "5-ord-err", provider: "PROMETHEUS", serviceName: "order-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t5, value: 28, unit: "%", labels: {}, hasAnomaly: true },
        { id: "5-gw-lat", provider: "PROMETHEUS", serviceName: "api-gateway", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t5, value: 2250, unit: "ms", labels: {}, hasAnomaly: true },
        { id: "5-gw-err", provider: "PROMETHEUS", serviceName: "api-gateway", metricType: "ERROR_RATE", metricName: "err", timestamp: t5, value: 35, unit: "%", labels: {}, hasAnomaly: true },

        // --- Step 6 (Recovery) ---
        { id: "6-db-lat", provider: "PROMETHEUS", serviceName: "postgres-db", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t6, value: 12, unit: "ms", labels: {}, hasAnomaly: false },
        { id: "6-db-err", provider: "PROMETHEUS", serviceName: "postgres-db", metricType: "ERROR_RATE", metricName: "err", timestamp: t6, value: 0, unit: "%", labels: {}, hasAnomaly: false },
        { id: "6-pay-lat", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t6, value: 50, unit: "ms", labels: {}, hasAnomaly: false },
        { id: "6-pay-err", provider: "PROMETHEUS", serviceName: "payment-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t6, value: 0, unit: "%", labels: {}, hasAnomaly: false },
        { id: "6-ord-lat", provider: "PROMETHEUS", serviceName: "order-service", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t6, value: 40, unit: "ms", labels: {}, hasAnomaly: false },
        { id: "6-ord-err", provider: "PROMETHEUS", serviceName: "order-service", metricType: "ERROR_RATE", metricName: "err", timestamp: t6, value: 0, unit: "%", labels: {}, hasAnomaly: false },
        { id: "6-gw-lat", provider: "PROMETHEUS", serviceName: "api-gateway", metricType: "LATENCY_AVG", metricName: "lat", timestamp: t6, value: 22, unit: "ms", labels: {}, hasAnomaly: false },
        { id: "6-gw-err", provider: "PROMETHEUS", serviceName: "api-gateway", metricType: "ERROR_RATE", metricName: "err", timestamp: t6, value: 0, unit: "%", labels: {}, hasAnomaly: false },
      ];

      vi.spyOn(telemetryManager, "getNormalizedBatch").mockResolvedValue({
        batchId: "batch-cascading-test",
        collectedAt: t6,
        mode: "LIVE",
        metrics: mockMetrics,
        spans: [],
        diagnostics: [],
      });

      vi.spyOn(telemetryManager, "getObservedServices").mockResolvedValue({
        mode: "LIVE",
        backendHealth: liveHealthStatus,
        observedServices: [
          { serviceId: "postgres-db", serviceName: "PostgreSQL Database Cluster", source: "PROMETHEUS", status: "DOWN", latencyMs: 1850, errorRate: 0, requestRate: 1550, lastObserved: t6, traceCount: 0, isStale: false, isKnownInTopology: true },
          { serviceId: "payment-service", serviceName: "Payment Gateway Service", source: "PROMETHEUS", status: "DEGRADED", latencyMs: 1950, errorRate: 15, requestRate: 240, lastObserved: t6, traceCount: 0, isStale: false, isKnownInTopology: true },
          { serviceId: "order-service", serviceName: "Order Service", source: "PROMETHEUS", status: "DEGRADED", latencyMs: 2100, errorRate: 25, requestRate: 520, lastObserved: t6, traceCount: 0, isStale: false, isKnownInTopology: true },
          { serviceId: "api-gateway", serviceName: "API Gateway", source: "PROMETHEUS", status: "DOWN", latencyMs: 2250, errorRate: 35, requestRate: 1450, lastObserved: t6, traceCount: 0, isStale: false, isKnownInTopology: true },
        ],
        unknownServices: [],
        lastCollectedAt: t6,
        lastIngestedAt: t6,
      });

      vi.spyOn(telemetryManager, "getRecentTraces").mockResolvedValue([]);

      const incident = await prisma.incident.create({
        data: {
          title: "Production Outage: Cascading Gateway 504 Failure",
          description: "Database connection contention cascading to payment and gateway",
          severity: "CRITICAL",
          status: "INVESTIGATING",
          rootCauseStatus: "DETECTED",
        },
      });

      const analysis = await realRootCauseEngine.analyzeRealIncident(incident.id);

      // Verify analysis conclusion
      expect(analysis.isConclusive).toBe(true);
      expect(analysis.topRootCause).toBeDefined();

      // PostgreSQL must be ranked #1 as originating root cause:
      // - Earliest anomaly onset detected at step 2
      // - Deepest node in dependency tier (tier 3/4)
      // - Cascading reachability explains upstream payment, order, and gateway symptoms
      expect(analysis.topRootCause?.serviceId).toBe("postgres-db");

      // Verify timing precedence evidence mentions step 2 (earliest anomaly onset)
      const timingEvidence = analysis.topRootCause?.supportingEvidence.find(
        (e) => e.type === "TIMING_PRECEDENCE"
      );
      expect(timingEvidence).toBeDefined();
      expect(timingEvidence?.description).toContain("simulation step 2");

      // Verify cascading impact evidence explains upstream dependents
      const cascadeEvidence = analysis.topRootCause?.supportingEvidence.find(
        (e) => e.type === "CASCADING_IMPACT"
      );
      expect(cascadeEvidence).toBeDefined();

      // Verify upstream services are recognized as affected dependents
      const affectedServiceIds = analysis.affectedServicesGraph.map((s) => s.serviceId);
      expect(affectedServiceIds).toContain("payment-service");
      expect(affectedServiceIds).toContain("order-service");
      expect(affectedServiceIds).toContain("api-gateway");

      // Verify database persistence of the analysis
      const updatedIncident = await prisma.incident.findUnique({ where: { id: incident.id } });
      expect(updatedIncident?.rootCauseStatus).toBe("ANALYZED");
      expect(updatedIncident?.suspectedRootCauseId).toBe("postgres-db");
    });

    it("returns inconclusive when telemetry evidence is insufficient and never maps UNKNOWN to HEALTHY", async () => {
      telemetryManager.setMode("LIVE");

      // Empty telemetry batch
      vi.spyOn(telemetryManager, "getNormalizedBatch").mockResolvedValue({
        batchId: "empty-batch",
        collectedAt: new Date().toISOString(),
        mode: "DEGRADED",
        metrics: [],
        spans: [],
        diagnostics: [],
      });

      const degradedHealthStatus: BackendHealthStatus = {
        prometheusAvailable: false,
        jaegerAvailable: false,
        prometheusUrl: "http://localhost:9090",
        jaegerUrl: "http://localhost:16686",
        isMockBackend: false,
        isCloudBackend: false,
        cloudConfigured: false,
        backendType: "GENUINE_STACK",
        lastChecked: new Date().toISOString(),
      };

      vi.spyOn(telemetryManager, "getObservedServices").mockResolvedValue({
        mode: "DEGRADED",
        backendHealth: degradedHealthStatus,
        observedServices: [
          { serviceId: "postgres-db", serviceName: "PostgreSQL Database Cluster", source: "PROMETHEUS", status: "UNKNOWN", latencyMs: 0, errorRate: 0, requestRate: 0, lastObserved: "N/A", traceCount: 0, isStale: true, isKnownInTopology: true },
          { serviceId: "payment-service", serviceName: "Payment Gateway Service", source: "PROMETHEUS", status: "UNKNOWN", latencyMs: 0, errorRate: 0, requestRate: 0, lastObserved: "N/A", traceCount: 0, isStale: true, isKnownInTopology: true },
        ],
        unknownServices: [],
        lastCollectedAt: new Date().toISOString(),
        lastIngestedAt: null,
      });

      vi.spyOn(telemetryManager, "getRecentTraces").mockResolvedValue([]);

      const incident = await prisma.incident.create({
        data: {
          title: "Insufficient Evidence Test Incident",
          description: "Testing inconclusive outcome on missing telemetry",
          severity: "MEDIUM",
          status: "INVESTIGATING",
          rootCauseStatus: "DETECTED",
        },
      });

      const analysis = await realRootCauseEngine.analyzeRealIncident(incident.id);

      expect(analysis.isConclusive).toBe(false);
      expect(analysis.topRootCause).toBeNull();

      const updatedIncident = await prisma.incident.findUnique({ where: { id: incident.id } });
      expect(updatedIncident?.rootCauseStatus).toBe("INCONCLUSIVE");
      expect(updatedIncident?.suspectedRootCauseId).toBeNull();
    });

    it("preserves strict simulation isolation in RealRootCauseEngine and TelemetryManager", async () => {
      telemetryManager.setMode("SIMULATION");

      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      const batch = await telemetryManager.getNormalizedBatch();
      expect(batch.mode).toBe("SIMULATION");
      expect(batch.metrics.length).toBeGreaterThan(0);
      expect(batch.metrics.every((m) => m.provider === "SIMULATION")).toBe(true);

      const { observedServices } = await telemetryManager.getObservedServices();
      expect(observedServices.every((s) => s.source === "SIMULATION")).toBe(true);

      // Verify zero network requests occurred
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
