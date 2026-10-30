import { DirectedGraph } from "../algorithms/graph";
import { RootCauseEngine, RootCauseInput } from "../algorithms/rootCauseEngine";
import {
  IncidentAnalysisSummary,
  ServiceNodeData,
  TelemetryPoint,
} from "../algorithms/types";
import { DistributedTrace, TraceSpan } from "./types";

export interface MultiServiceIncidentScenario {
  graph: DirectedGraph<ServiceNodeData>;
  telemetrySamples: TelemetryPoint[];
  currentServiceStates: Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>;
  failureTrace: DistributedTrace;
  healthyBaselineTrace: DistributedTrace;
}

/**
 * Creates the realistic 4-service dependency graph:
 * API Gateway -> Order Service -> Payment Service -> PostgreSQL
 */
export function createMultiServiceGraph(): DirectedGraph<ServiceNodeData> {
  const graph = new DirectedGraph<ServiceNodeData>();

  graph.addNode("api-gateway", {
    id: "api-gateway",
    name: "API Gateway",
    serviceType: "GATEWAY",
    tier: 1,
    status: "HEALTHY",
    baselineLatency: 15,
    currentLatency: 15,
    baselineErrorRate: 0.1,
    currentErrorRate: 0.1,
    requestRate: 1200,
  });

  graph.addNode("order-service", {
    id: "order-service",
    name: "Order Service",
    serviceType: "ORDER",
    tier: 2,
    status: "HEALTHY",
    baselineLatency: 35,
    currentLatency: 35,
    baselineErrorRate: 0.2,
    currentErrorRate: 0.2,
    requestRate: 600,
  });

  graph.addNode("payment-service", {
    id: "payment-service",
    name: "Payment Service",
    serviceType: "PAYMENT",
    tier: 3,
    status: "HEALTHY",
    baselineLatency: 45,
    currentLatency: 45,
    baselineErrorRate: 0.1,
    currentErrorRate: 0.1,
    requestRate: 400,
  });

  graph.addNode("postgres-db", {
    id: "postgres-db",
    name: "PostgreSQL Database",
    serviceType: "DATABASE",
    tier: 4,
    status: "HEALTHY",
    baselineLatency: 12,
    currentLatency: 12,
    baselineErrorRate: 0.05,
    currentErrorRate: 0.05,
    requestRate: 1500,
  });

  graph.addEdge("api-gateway", "order-service", {
    dependencyType: "SYNC_HTTP",
    timeoutThreshold: 2000,
    criticality: "CRITICAL",
  });

  graph.addEdge("order-service", "payment-service", {
    dependencyType: "SYNC_HTTP",
    timeoutThreshold: 2000,
    criticality: "CRITICAL",
  });

  graph.addEdge("payment-service", "postgres-db", {
    dependencyType: "DATABASE_CONN",
    timeoutThreshold: 1500,
    criticality: "CRITICAL",
  });

  return graph;
}

/**
 * Builds the cascading failure trace with parent-child span hierarchy.
 */
export function buildFailureTrace(): DistributedTrace {
  const traceId = "c4a7e91d84b248a39a01fd45812e9b01";
  const nowUs = Date.now() * 1000;

  const dbSpan: TraceSpan = {
    spanId: "span-db-leaf-004",
    parentSpanId: "span-payment-003",
    traceId,
    operationName: "SELECT pg_advisory_lock; UPDATE accounts",
    serviceName: "postgres-db",
    startTimeUs: nowUs + 400_000,
    durationMs: 1850,
    statusCode: "ERROR",
    errorMessage: "Connection pool timeout: query wait duration exceeded 1500ms limit",
    attributes: { "db.system": "postgresql", "db.statement": "UPDATE accounts SET balance = balance - 49.99" },
    depth: 3,
    children: [],
  };

  const paymentSpan: TraceSpan = {
    spanId: "span-payment-003",
    parentSpanId: "span-order-002",
    traceId,
    operationName: "POST /payments/authorize",
    serviceName: "payment-service",
    startTimeUs: nowUs + 200_000,
    durationMs: 1950,
    statusCode: "ERROR",
    errorMessage: "Database connection timed out during payment authorization",
    attributes: { "http.status_code": 500, "service.name": "payment-service" },
    depth: 2,
    children: [dbSpan],
  };

  const orderSpan: TraceSpan = {
    spanId: "span-order-002",
    parentSpanId: "span-gateway-001",
    traceId,
    operationName: "POST /orders/checkout",
    serviceName: "order-service",
    startTimeUs: nowUs + 50_000,
    durationMs: 2150,
    statusCode: "ERROR",
    errorMessage: "Payment service authorization failed with HTTP 500",
    attributes: { "http.status_code": 500, "service.name": "order-service" },
    depth: 1,
    children: [paymentSpan],
  };

  const rootSpan: TraceSpan = {
    spanId: "span-gateway-001",
    traceId,
    operationName: "POST /api/v1/orders",
    serviceName: "api-gateway",
    startTimeUs: nowUs,
    durationMs: 2250,
    statusCode: "ERROR",
    errorMessage: "Gateway timeout waiting on upstream order-service (504)",
    attributes: { "http.status_code": 504, "service.name": "api-gateway" },
    depth: 0,
    children: [orderSpan],
  };

  return {
    traceId,
    rootServiceName: "api-gateway",
    operationName: "POST /api/v1/orders",
    startTime: new Date().toISOString(),
    durationMs: 2250,
    totalSpans: 4,
    hasErrors: true,
    servicesInvolved: ["api-gateway", "order-service", "payment-service", "postgres-db"],
    rootSpan,
    allSpans: [rootSpan, orderSpan, paymentSpan, dbSpan],
  };
}

export function buildHealthyTrace(): DistributedTrace {
  const traceId = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const nowUs = Date.now() * 1000;

  const dbSpan: TraceSpan = {
    spanId: "span-db-ok-004",
    parentSpanId: "span-pay-ok-003",
    traceId,
    operationName: "SELECT * FROM accounts",
    serviceName: "postgres-db",
    startTimeUs: nowUs + 25_000,
    durationMs: 10,
    statusCode: "OK",
    attributes: { "db.system": "postgresql" },
    depth: 3,
    children: [],
  };

  const paymentSpan: TraceSpan = {
    spanId: "span-pay-ok-003",
    parentSpanId: "span-ord-ok-002",
    traceId,
    operationName: "POST /payments/authorize",
    serviceName: "payment-service",
    startTimeUs: nowUs + 15_000,
    durationMs: 25,
    statusCode: "OK",
    attributes: { "http.status_code": 200 },
    depth: 2,
    children: [dbSpan],
  };

  const orderSpan: TraceSpan = {
    spanId: "span-ord-ok-002",
    parentSpanId: "span-gw-ok-001",
    traceId,
    operationName: "POST /orders/checkout",
    serviceName: "order-service",
    startTimeUs: nowUs + 5_000,
    durationMs: 35,
    statusCode: "OK",
    attributes: { "http.status_code": 200 },
    depth: 1,
    children: [paymentSpan],
  };

  const rootSpan: TraceSpan = {
    spanId: "span-gw-ok-001",
    traceId,
    operationName: "POST /api/v1/orders",
    serviceName: "api-gateway",
    startTimeUs: nowUs,
    durationMs: 45,
    statusCode: "OK",
    attributes: { "http.status_code": 200 },
    depth: 0,
    children: [orderSpan],
  };

  return {
    traceId,
    rootServiceName: "api-gateway",
    operationName: "POST /api/v1/orders",
    startTime: new Date(Date.now() - 60_000).toISOString(),
    durationMs: 45,
    totalSpans: 4,
    hasErrors: false,
    servicesInvolved: ["api-gateway", "order-service", "payment-service", "postgres-db"],
    rootSpan,
    allSpans: [rootSpan, orderSpan, paymentSpan, dbSpan],
  };
}

/**
 * Generates the full 5-phase deterministic telemetry timeline:
 * Phase 1: Healthy Baseline (steps 1–3)
 * Phase 2: Downstream Fault Onset at PostgreSQL (step 4)
 * Phase 3: Cascading Latency & Error Propagation to Payment & Order (step 5)
 * Phase 4: Peak Blast Radius reaching API Gateway (step 6)
 * Phase 5: Recovery Period (steps 7–8)
 */
export function buildMultiServiceIncidentScenario(): MultiServiceIncidentScenario {
  const graph = createMultiServiceGraph();
  const failureTrace = buildFailureTrace();
  const healthyBaselineTrace = buildHealthyTrace();

  const now = Date.now();
  const stepMs = 5000;
  const samples: TelemetryPoint[] = [];

  // Helper to add sample
  const add = (serviceId: string, step: number, lat: number, err: number, req: number, status: "HEALTHY" | "DEGRADED" | "DOWN") => {
    samples.push({
      serviceId,
      simulationStep: step,
      timestamp: new Date(now - (8 - step) * stepMs),
      latency: lat,
      errorRate: err,
      requestCount: req,
      healthStatus: status,
    });
  };

  // Steps 1-3: Healthy Baseline
  for (let s = 1; s <= 3; s++) {
    add("postgres-db", s, 12, 0.0, 1500, "HEALTHY");
    add("payment-service", s, 45, 0.1, 400, "HEALTHY");
    add("order-service", s, 35, 0.2, 600, "HEALTHY");
    add("api-gateway", s, 15, 0.1, 1200, "HEALTHY");
  }

  // Step 4: Direct Fault Onset at PostgreSQL (Latency spike, pool contention)
  add("postgres-db", 4, 1850, 5.0, 1500, "DEGRADED");
  add("payment-service", 4, 52, 0.2, 395, "HEALTHY");
  add("order-service", 4, 38, 0.2, 600, "HEALTHY");
  add("api-gateway", 4, 16, 0.1, 1200, "HEALTHY");

  // Step 5: Cascading propagation to Payment & Order
  add("postgres-db", 5, 1920, 8.0, 1400, "DOWN");
  add("payment-service", 5, 1950, 14.0, 350, "DOWN");
  add("order-service", 5, 2100, 22.0, 480, "DOWN");
  add("api-gateway", 5, 320, 4.0, 1150, "DEGRADED");

  // Step 6: Full blast radius impact at API Gateway
  add("postgres-db", 6, 1880, 10.0, 1300, "DOWN");
  add("payment-service", 6, 1980, 18.0, 320, "DOWN");
  add("order-service", 6, 2150, 28.0, 420, "DOWN");
  add("api-gateway", 6, 2250, 32.0, 950, "DOWN");

  // Step 7-8: Recovery period
  add("postgres-db", 7, 25, 0.1, 1450, "HEALTHY");
  add("payment-service", 7, 65, 0.5, 380, "HEALTHY");
  add("order-service", 7, 85, 1.0, 550, "HEALTHY");
  add("api-gateway", 7, 45, 0.8, 1100, "HEALTHY");

  add("postgres-db", 8, 12, 0.0, 1500, "HEALTHY");
  add("payment-service", 8, 45, 0.1, 400, "HEALTHY");
  add("order-service", 8, 35, 0.2, 600, "HEALTHY");
  add("api-gateway", 8, 15, 0.1, 1200, "HEALTHY");

  // Current active states representing peak failure (Step 6)
  const currentServiceStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
    ["postgres-db", { status: "DOWN", latency: 1880, errorRate: 10.0 }],
    ["payment-service", { status: "DOWN", latency: 1980, errorRate: 18.0 }],
    ["order-service", { status: "DOWN", latency: 2150, errorRate: 28.0 }],
    ["api-gateway", { status: "DOWN", latency: 2250, errorRate: 32.0 }],
  ]);

  return {
    graph,
    telemetrySamples: samples,
    currentServiceStates,
    failureTrace,
    healthyBaselineTrace,
  };
}

/**
 * Runs explainable root-cause ranking over the multi-service incident scenario.
 * Verifies that the ranking derives purely from temporal onset, graph depth,
 * threshold breaches, and trace leaf bottleneck evidence.
 */
export function analyzeMultiServiceIncident(
  scenario: MultiServiceIncidentScenario,
  incidentId: string = "inc_multi_service_001"
): IncidentAnalysisSummary {
  const engine = new RootCauseEngine(6);

  const input: RootCauseInput = {
    incidentId,
    graph: scenario.graph,
    telemetrySamples: scenario.telemetrySamples,
    currentServiceStates: scenario.currentServiceStates,
  };

  return engine.analyzeIncident(input);
}
