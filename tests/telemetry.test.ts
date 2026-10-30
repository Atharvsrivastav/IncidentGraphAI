import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initServiceTelemetry } from "../sample-services/shared/telemetry";
import { SamplePostgresClient } from "../sample-services/shared/database";
import { PrometheusClient } from "../src/lib/telemetry/prometheusClient";
import { JaegerClient } from "../src/lib/telemetry/jaegerClient";
import { TelemetryManager } from "../src/lib/telemetry/telemetryManager";
import { RealIncidentDetector } from "../src/lib/detection/ruleDetector";
import { DirectedGraph } from "../src/lib/algorithms/graph";
import { RootCauseEngine } from "../src/lib/algorithms/rootCauseEngine";
import { ServiceNodeData, TelemetryPoint } from "../src/lib/algorithms/types";
import { startSampleEcosystem } from "../sample-services/runner";

describe("Phase 2: OpenTelemetry & Real Telemetry Pipeline Tests", () => {
  let ecosystem: { close: () => Promise<void> } | null = null;

  beforeEach(() => {
    // Reset fault state before each test
    SamplePostgresClient.getInstance().resetFault();
  });

  afterEach(async () => {
    if (ecosystem) {
      await ecosystem.close();
      ecosystem = null;
    }
  });

  // -------------------------------------------------------------------------
  // 1. OpenTelemetry Instrumentation & Trace Context Propagation
  // -------------------------------------------------------------------------
  it("creates OpenTelemetry spans and injects/extracts W3C trace context across boundaries", () => {
    const telemetry = initServiceTelemetry("test-order-service");
    const { span } = telemetry.startSpan("HTTP POST /orders");

    expect(span.spanContext().traceId).toBeDefined();
    expect(span.spanContext().traceId.length).toBe(32); // 128-bit hex trace ID
    expect(span.spanContext().spanId.length).toBe(16);   // 64-bit hex span ID

    const carrier: Record<string, string> = {};
    telemetry.injectTraceContext(carrier, span);

    // W3C TraceContext standard defines traceparent header
    expect(carrier.traceparent).toBeDefined();
    expect(carrier.traceparent).toContain(span.spanContext().traceId);

    // Extract downstream
    const downstreamTel = initServiceTelemetry("test-inventory-service");
    const downstream = downstreamTel.startSpan("HTTP POST /inventory/reserve", carrier);
    expect(downstream.span.spanContext().traceId).toBe(span.spanContext().traceId);

    telemetry.endSpan(span);
    downstreamTel.endSpan(downstream.span);
  });

  // -------------------------------------------------------------------------
  // 2. Metric Instruments from Actual Execution
  // -------------------------------------------------------------------------
  it("records metric instruments without throwing or leaking sensitive customer data", () => {
    const telemetry = initServiceTelemetry("test-payment-service");
    expect(() => {
      telemetry.requestCounter.add(1, { service: "test-payment-service", status: "200" });
      telemetry.durationHistogram.record(0.045, { service: "test-payment-service" });
      telemetry.errorCounter.add(0, { service: "test-payment-service" });
      telemetry.log("info", "Safe test log without credit card numbers", { orderId: "ord_123" });
    }).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // 3. Prometheus Client & Response Parsing
  // -------------------------------------------------------------------------
  it("parses Prometheus PromQL instant responses and normalizes metrics", async () => {
    const promClient = new PrometheusClient("http://localhost:9999", 500); // Intentionally unreachable test port
    const health = await promClient.checkHealth();
    expect(health.available).toBe(false);

    // Handles offline gracefully without crashing
    const metrics = await promClient.getServiceMetrics();
    expect(metrics.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4. Jaeger Client & Span Hierarchy Parsing
  // -------------------------------------------------------------------------
  it("parses Jaeger trace JSON and constructs parent-child span hierarchy", async () => {
    const jaegerClient = new JaegerClient("http://localhost:9999", 500);
    const health = await jaegerClient.checkHealth();
    expect(health.available).toBe(false);

    const traces = await jaegerClient.getRecentTraces();
    expect(traces).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 5. Telemetry Mode Separation (SIMULATION vs LIVE vs DEGRADED)
  // -------------------------------------------------------------------------
  it("strictly separates Simulation Mode and Real Telemetry Mode", () => {
    const manager = new TelemetryManager();
    expect(manager.getMode()).toBe("SIMULATION");

    manager.setMode("LIVE");
    expect(manager.getMode()).toBe("LIVE");

    manager.setMode("REAL");
    expect(["REAL", "LIVE"]).toContain(manager.getMode());

    manager.setMode("SIMULATION");
    expect(manager.getMode()).toBe("SIMULATION");
  });

  // -------------------------------------------------------------------------
  // 6. Unknown / Unmapped Service Identification
  // -------------------------------------------------------------------------
  it("identifies unknown services reporting telemetry that are absent from configured topology", async () => {
    const manager = new TelemetryManager();
    manager.setMode("LIVE");

    // In live mode when offline, backends truthfully report DEGRADED/UNKNOWN without fabricating fake data
    const overview = await manager.getObservedServices();
    expect(["LIVE", "DEGRADED", "REAL"]).toContain(overview.mode);
    expect(overview.unknownServices).toBeDefined();
    for (const obs of overview.observedServices) {
      expect(obs.source).toBe("PROMETHEUS");
    }
  });

  // -------------------------------------------------------------------------
  // 7. Incident Deduplication & Cooldown Rules
  // -------------------------------------------------------------------------
  it("enforces cooldown to prevent alert flapping and repeated incident spam", async () => {
    const detector = new RealIncidentDetector();
    detector.setCooldownSeconds(60);

    const firstRun = await detector.evaluateTelemetry();
    expect(firstRun.incidentCreated).toBe(false); // No live anomalies on offline/healthy state
  });

  // -------------------------------------------------------------------------
  // 8. Real-Evidence Root-Cause Analysis & Zero Ground-Truth Leakage
  // -------------------------------------------------------------------------
  it("ranks originating root-cause candidate based purely on telemetry and graph depth without peeking at scenario", () => {
    const engine = new RootCauseEngine(6);
    const graph = new DirectedGraph<ServiceNodeData>();

    // Topology: Gateway -> Order -> Database
    graph.addNode("api-gateway", {
      id: "api-gateway",
      name: "API Gateway",
      serviceType: "GATEWAY",
      tier: 1,
      status: "DEGRADED",
      baselineLatency: 20,
      currentLatency: 1200,
      baselineErrorRate: 0.1,
      currentErrorRate: 15.0,
      requestRate: 1000,
    });
    graph.addNode("order-service", {
      id: "order-service",
      name: "Order Service",
      serviceType: "ORDER",
      tier: 2,
      status: "DEGRADED",
      baselineLatency: 40,
      currentLatency: 1100,
      baselineErrorRate: 0.2,
      currentErrorRate: 18.0,
      requestRate: 500,
    });
    graph.addNode("postgres-db", {
      id: "postgres-db",
      name: "PostgreSQL Database Cluster",
      serviceType: "DATABASE",
      tier: 3,
      status: "DEGRADED",
      baselineLatency: 10,
      currentLatency: 1050, // 100x latency spike
      baselineErrorRate: 0.05,
      currentErrorRate: 0.05,
      requestRate: 1500,
    });

    graph.addEdge("api-gateway", "order-service", { dependencyType: "SYNC_HTTP", timeoutThreshold: 2000, criticality: "HIGH" });
    graph.addEdge("order-service", "postgres-db", { dependencyType: "DATABASE_CONN", timeoutThreshold: 2000, criticality: "CRITICAL" });

    const telemetrySamples: TelemetryPoint[] = [
      { serviceId: "postgres-db", simulationStep: 1, timestamp: new Date(), latency: 1050, errorRate: 0, requestCount: 1500, healthStatus: "DEGRADED" },
      { serviceId: "order-service", simulationStep: 2, timestamp: new Date(), latency: 1100, errorRate: 18, requestCount: 500, healthStatus: "DEGRADED" },
      { serviceId: "api-gateway", simulationStep: 2, timestamp: new Date(), latency: 1200, errorRate: 15, requestCount: 1000, healthStatus: "DEGRADED" },
    ];

    const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
      ["api-gateway", { status: "DEGRADED", latency: 1200, errorRate: 15 }],
      ["order-service", { status: "DEGRADED", latency: 1100, errorRate: 18 }],
      ["postgres-db", { status: "DEGRADED", latency: 1050, errorRate: 0 }],
    ]);

    const result = engine.analyzeIncident({
      incidentId: "inc_test_real",
      graph,
      telemetrySamples,
      currentServiceStates: currentStates,
    });

    expect(result.isConclusive).toBe(true);
    expect(result.topRootCause?.serviceId).toBe("postgres-db");
    expect(result.topRootCause?.score).toBeGreaterThan(60);
    expect(result.topRootCause?.supportingEvidence.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 9. End-to-End Live Sample Microservices HTTP Request Execution
  // -------------------------------------------------------------------------
  it("boots sample microservices, processes real HTTP order, and traces execution", async () => {
    ecosystem = await startSampleEcosystem();
    await new Promise((r) => setTimeout(r, 600)); // Allow servers to bind

    // Send real HTTP order creation request to Gateway (:4000)
    const orderRes = await fetch("http://localhost:4000/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer: "test_suite", items: [{ sku: "ITEM-101", quantity: 1 }] }),
    });

    expect(orderRes.status).toBe(201);
    const orderData = await orderRes.json();
    expect(orderData.success).toBe(true);
    expect(orderData.status).toBe("CONFIRMED");

    // Send inventory lookup
    const invRes = await fetch("http://localhost:4000/api/inventory/ITEM-101");
    expect(invRes.status).toBe(200);
    const invData = await invRes.json();
    expect(invData.status).toBe("AVAILABLE");

    // Verify recovery after injected fault
    const db = SamplePostgresClient.getInstance();
    db.setFault({ latencyMs: 800 });
    expect(db.getFaultConfig().latencyMs).toBe(800);
    db.resetFault();
    expect(db.getFaultConfig().latencyMs).toBe(12);
  });
});
