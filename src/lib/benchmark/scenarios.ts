import { DirectedGraph } from "../algorithms/graph";
import { ServiceNodeData, TelemetryPoint } from "../algorithms/types";
import { BenchmarkScenario } from "./types";

/**
 * Creates the standard 7-node microservice dependency topology:
 *
 * api-gateway (tier 1)
 *  ├─ auth-service (tier 2)
 *  └─ order-service (tier 2)
 *      ├─ payment-service (tier 2) ──> postgres-db (tier 3)
 *      ├─ inventory-service (tier 2) ──> postgres-db (tier 3)
 *      ├─ postgres-db (tier 3)
 *      └─ notification-service (tier 2, async queue)
 */
export function createCanonicalTopology(): DirectedGraph<ServiceNodeData> {
  const graph = new DirectedGraph<ServiceNodeData>();

  const services: ServiceNodeData[] = [
    {
      id: "api-gateway",
      name: "API Gateway",
      serviceType: "GATEWAY",
      tier: 1,
      status: "HEALTHY",
      baselineLatency: 22,
      currentLatency: 22,
      baselineErrorRate: 0.1,
      currentErrorRate: 0.1,
      requestRate: 1450,
    },
    {
      id: "auth-service",
      name: "Authentication Service",
      serviceType: "AUTH",
      tier: 2,
      status: "HEALTHY",
      baselineLatency: 16,
      currentLatency: 16,
      baselineErrorRate: 0.05,
      currentErrorRate: 0.05,
      requestRate: 1200,
    },
    {
      id: "order-service",
      name: "Order Service",
      serviceType: "ORDER",
      tier: 2,
      status: "HEALTHY",
      baselineLatency: 42,
      currentLatency: 42,
      baselineErrorRate: 0.15,
      currentErrorRate: 0.15,
      requestRate: 520,
    },
    {
      id: "payment-service",
      name: "Payment Gateway Service",
      serviceType: "PAYMENT",
      tier: 2,
      status: "HEALTHY",
      baselineLatency: 65,
      currentLatency: 65,
      baselineErrorRate: 0.08,
      currentErrorRate: 0.08,
      requestRate: 240,
    },
    {
      id: "inventory-service",
      name: "Inventory Service",
      serviceType: "INVENTORY",
      tier: 2,
      status: "HEALTHY",
      baselineLatency: 32,
      currentLatency: 32,
      baselineErrorRate: 0.12,
      currentErrorRate: 0.12,
      requestRate: 360,
    },
    {
      id: "notification-service",
      name: "Notification Service",
      serviceType: "NOTIFICATION",
      tier: 2,
      status: "HEALTHY",
      baselineLatency: 38,
      currentLatency: 38,
      baselineErrorRate: 0.25,
      currentErrorRate: 0.25,
      requestRate: 190,
    },
    {
      id: "postgres-db",
      name: "PostgreSQL Database Cluster",
      serviceType: "DATABASE",
      tier: 3,
      status: "HEALTHY",
      baselineLatency: 11,
      currentLatency: 11,
      baselineErrorRate: 0.02,
      currentErrorRate: 0.02,
      requestRate: 1550,
    },
  ];

  for (const svc of services) {
    graph.addNode(svc.id, svc);
  }

  // Edges: source depends on target (A calls B)
  graph.addEdge("api-gateway", "auth-service", { dependencyType: "SYNC_HTTP", timeoutThreshold: 800, criticality: "CRITICAL" });
  graph.addEdge("api-gateway", "order-service", { dependencyType: "SYNC_HTTP", timeoutThreshold: 2000, criticality: "CRITICAL" });
  graph.addEdge("order-service", "payment-service", { dependencyType: "SYNC_HTTP", timeoutThreshold: 2500, criticality: "CRITICAL" });
  graph.addEdge("order-service", "inventory-service", { dependencyType: "SYNC_HTTP", timeoutThreshold: 1500, criticality: "HIGH" });
  graph.addEdge("order-service", "postgres-db", { dependencyType: "DATABASE_CONN", timeoutThreshold: 1000, criticality: "CRITICAL" });
  graph.addEdge("payment-service", "postgres-db", { dependencyType: "DATABASE_CONN", timeoutThreshold: 1000, criticality: "CRITICAL" });
  graph.addEdge("inventory-service", "postgres-db", { dependencyType: "DATABASE_CONN", timeoutThreshold: 1000, criticality: "CRITICAL" });
  graph.addEdge("order-service", "notification-service", { dependencyType: "ASYNC_QUEUE", timeoutThreshold: 3000, criticality: "LOW" });

  return graph;
}

/**
 * Deterministic test scenario suite covering the 10 required failure and resilience modes.
 */
export const BENCHMARK_SCENARIOS: BenchmarkScenario[] = [
  // 1. Healthy system with normal traffic
  {
    id: "scenario-01-healthy",
    name: "Healthy Baseline System",
    description: "All services operating normally with baseline latency and negligible error rates under standard load.",
    category: "HEALTHY",
    getInput: () => {
      const graph = createCanonicalTopology();
      const samples: TelemetryPoint[] = [];
      const baseTime = new Date("2026-10-14T00:00:00Z");

      const serviceBaselines: Record<string, { lat: number; err: number }> = {
        "api-gateway": { lat: 22, err: 0.1 },
        "auth-service": { lat: 16, err: 0.05 },
        "order-service": { lat: 42, err: 0.15 },
        "payment-service": { lat: 65, err: 0.08 },
        "inventory-service": { lat: 32, err: 0.12 },
        "notification-service": { lat: 38, err: 0.25 },
        "postgres-db": { lat: 11, err: 0.02 },
      };

      for (let step = 0; step <= 4; step++) {
        const time = new Date(baseTime.getTime() + step * 10000);
        for (const [sId, base] of Object.entries(serviceBaselines)) {
          samples.push({
            serviceId: sId,
            simulationStep: step,
            timestamp: time,
            latency: base.lat + (step % 2 === 0 ? 1 : -1),
            errorRate: base.err,
            requestCount: 500,
            healthStatus: "HEALTHY",
          });
        }
      }

      const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>();
      for (const [sId, base] of Object.entries(serviceBaselines)) {
        currentStates.set(sId, { status: "HEALTHY", latency: base.lat, errorRate: base.err });
      }

      return {
        incidentId: "bench-01-healthy",
        graph,
        telemetrySamples: samples,
        currentServiceStates: currentStates,
      };
    },
    expected: {
      expectedClassification: "HEALTHY",
      expectedRootCauseId: null,
      allowInconclusive: true,
    },
  },

  // 2. PostgreSQL latency spike
  {
    id: "scenario-02-postgres-latency",
    name: "PostgreSQL Latency Surge",
    description: "PostgreSQL query execution latency surges to 850ms, causing cascading queueing in order, payment, and inventory services.",
    category: "CASCADING_OUTAGE",
    getInput: () => {
      const graph = createCanonicalTopology();
      const samples: TelemetryPoint[] = [
        // Step 0: Normal baseline
        { serviceId: "postgres-db", simulationStep: 0, timestamp: new Date(), latency: 11, errorRate: 0.02, requestCount: 1500, healthStatus: "HEALTHY" },
        { serviceId: "order-service", simulationStep: 0, timestamp: new Date(), latency: 42, errorRate: 0.15, requestCount: 500, healthStatus: "HEALTHY" },
        { serviceId: "payment-service", simulationStep: 0, timestamp: new Date(), latency: 65, errorRate: 0.08, requestCount: 250, healthStatus: "HEALTHY" },
        { serviceId: "inventory-service", simulationStep: 0, timestamp: new Date(), latency: 32, errorRate: 0.12, requestCount: 350, healthStatus: "HEALTHY" },
        { serviceId: "api-gateway", simulationStep: 0, timestamp: new Date(), latency: 22, errorRate: 0.1, requestCount: 1400, healthStatus: "HEALTHY" },

        // Step 1: PostgreSQL latency spikes sharply
        { serviceId: "postgres-db", simulationStep: 1, timestamp: new Date(), latency: 850, errorRate: 6.0, requestCount: 1500, healthStatus: "DEGRADED" },
        { serviceId: "order-service", simulationStep: 1, timestamp: new Date(), latency: 55, errorRate: 0.2, requestCount: 500, healthStatus: "HEALTHY" },
        { serviceId: "payment-service", simulationStep: 1, timestamp: new Date(), latency: 70, errorRate: 0.1, requestCount: 250, healthStatus: "HEALTHY" },
        { serviceId: "inventory-service", simulationStep: 1, timestamp: new Date(), latency: 40, errorRate: 0.15, requestCount: 350, healthStatus: "HEALTHY" },
        { serviceId: "api-gateway", simulationStep: 1, timestamp: new Date(), latency: 25, errorRate: 0.1, requestCount: 1400, healthStatus: "HEALTHY" },

        // Step 2: Cascading latency to upstream transactional services
        { serviceId: "postgres-db", simulationStep: 2, timestamp: new Date(), latency: 920, errorRate: 8.5, requestCount: 1500, healthStatus: "DEGRADED" },
        { serviceId: "order-service", simulationStep: 2, timestamp: new Date(), latency: 920, errorRate: 14.0, requestCount: 500, healthStatus: "DEGRADED" },
        { serviceId: "payment-service", simulationStep: 2, timestamp: new Date(), latency: 890, errorRate: 10.0, requestCount: 250, healthStatus: "DEGRADED" },
        { serviceId: "inventory-service", simulationStep: 2, timestamp: new Date(), latency: 870, errorRate: 9.0, requestCount: 350, healthStatus: "DEGRADED" },
        { serviceId: "api-gateway", simulationStep: 2, timestamp: new Date(), latency: 350, errorRate: 5.0, requestCount: 1400, healthStatus: "DEGRADED" },

        // Step 3: Gateway timeout symptoms
        { serviceId: "postgres-db", simulationStep: 3, timestamp: new Date(), latency: 950, errorRate: 10.0, requestCount: 1500, healthStatus: "DEGRADED" },
        { serviceId: "order-service", simulationStep: 3, timestamp: new Date(), latency: 1100, errorRate: 22.0, requestCount: 500, healthStatus: "DEGRADED" },
        { serviceId: "payment-service", simulationStep: 3, timestamp: new Date(), latency: 950, errorRate: 12.0, requestCount: 250, healthStatus: "DEGRADED" },
        { serviceId: "api-gateway", simulationStep: 3, timestamp: new Date(), latency: 1150, errorRate: 18.0, requestCount: 1400, healthStatus: "DEGRADED" },
      ];

      const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
        ["postgres-db", { status: "DEGRADED", latency: 950, errorRate: 10.0 }],
        ["order-service", { status: "DEGRADED", latency: 1100, errorRate: 22.0 }],
        ["payment-service", { status: "DEGRADED", latency: 950, errorRate: 12.0 }],
        ["inventory-service", { status: "DEGRADED", latency: 870, errorRate: 9.0 }],
        ["api-gateway", { status: "DEGRADED", latency: 1150, errorRate: 18.0 }],
        ["auth-service", { status: "HEALTHY", latency: 16, errorRate: 0.05 }],
        ["notification-service", { status: "HEALTHY", latency: 38, errorRate: 0.25 }],
      ]);

      return {
        incidentId: "bench-02-postgres-latency",
        graph,
        telemetrySamples: samples,
        currentServiceStates: currentStates,
      };
    },
    expected: {
      expectedClassification: "DEFINITIVE_ROOT_CAUSE",
      expectedRootCauseId: "postgres-db",
      minConfidence: "HIGH",
      expectedDownstreamImpacted: ["order-service", "payment-service", "inventory-service", "api-gateway"],
    },
  },

  // 3. PostgreSQL outage
  {
    id: "scenario-03-postgres-outage",
    name: "PostgreSQL Cluster Outage",
    description: "PostgreSQL crashes completely, rejecting all incoming connections with 100% error rate.",
    category: "CASCADING_OUTAGE",
    getInput: () => {
      const graph = createCanonicalTopology();
      const samples: TelemetryPoint[] = [
        { serviceId: "postgres-db", simulationStep: 1, timestamp: new Date(), latency: 3000, errorRate: 100.0, requestCount: 1500, healthStatus: "DOWN" },
        { serviceId: "order-service", simulationStep: 2, timestamp: new Date(), latency: 2500, errorRate: 85.0, requestCount: 500, healthStatus: "DOWN" },
        { serviceId: "payment-service", simulationStep: 2, timestamp: new Date(), latency: 2500, errorRate: 80.0, requestCount: 250, healthStatus: "DOWN" },
        { serviceId: "inventory-service", simulationStep: 2, timestamp: new Date(), latency: 2000, errorRate: 75.0, requestCount: 350, healthStatus: "DOWN" },
        { serviceId: "api-gateway", simulationStep: 3, timestamp: new Date(), latency: 2800, errorRate: 95.0, requestCount: 1400, healthStatus: "DOWN" },
      ];

      const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
        ["postgres-db", { status: "DOWN", latency: 3000, errorRate: 100.0 }],
        ["order-service", { status: "DOWN", latency: 2500, errorRate: 85.0 }],
        ["payment-service", { status: "DOWN", latency: 2500, errorRate: 80.0 }],
        ["inventory-service", { status: "DOWN", latency: 2000, errorRate: 75.0 }],
        ["api-gateway", { status: "DOWN", latency: 2800, errorRate: 95.0 }],
        ["auth-service", { status: "HEALTHY", latency: 16, errorRate: 0.05 }],
        ["notification-service", { status: "HEALTHY", latency: 38, errorRate: 0.25 }],
      ]);

      return {
        incidentId: "bench-03-postgres-outage",
        graph,
        telemetrySamples: samples,
        currentServiceStates: currentStates,
      };
    },
    expected: {
      expectedClassification: "DEFINITIVE_ROOT_CAUSE",
      expectedRootCauseId: "postgres-db",
      minConfidence: "HIGH",
    },
  },

  // 4. Payment service failure
  {
    id: "scenario-04-payment-failure",
    name: "Payment Gateway Failure",
    description: "Third-party payment acquiring channel fails; database and inventory remain completely healthy.",
    category: "SINGLE_POINT_FAILURE",
    getInput: () => {
      const graph = createCanonicalTopology();
      const samples: TelemetryPoint[] = [
        { serviceId: "payment-service", simulationStep: 1, timestamp: new Date(), latency: 450, errorRate: 85.0, requestCount: 240, healthStatus: "DOWN" },
        { serviceId: "postgres-db", simulationStep: 1, timestamp: new Date(), latency: 11, errorRate: 0.02, requestCount: 1550, healthStatus: "HEALTHY" },
        { serviceId: "order-service", simulationStep: 2, timestamp: new Date(), latency: 520, errorRate: 35.0, requestCount: 520, healthStatus: "DEGRADED" },
        { serviceId: "api-gateway", simulationStep: 3, timestamp: new Date(), latency: 110, errorRate: 22.0, requestCount: 1450, healthStatus: "DEGRADED" },
        { serviceId: "inventory-service", simulationStep: 1, timestamp: new Date(), latency: 32, errorRate: 0.12, requestCount: 360, healthStatus: "HEALTHY" },
        { serviceId: "auth-service", simulationStep: 1, timestamp: new Date(), latency: 16, errorRate: 0.05, requestCount: 1200, healthStatus: "HEALTHY" },
      ];

      const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
        ["payment-service", { status: "DOWN", latency: 450, errorRate: 85.0 }],
        ["order-service", { status: "DEGRADED", latency: 520, errorRate: 35.0 }],
        ["api-gateway", { status: "DEGRADED", latency: 110, errorRate: 22.0 }],
        ["postgres-db", { status: "HEALTHY", latency: 11, errorRate: 0.02 }],
        ["inventory-service", { status: "HEALTHY", latency: 32, errorRate: 0.12 }],
        ["auth-service", { status: "HEALTHY", latency: 16, errorRate: 0.05 }],
        ["notification-service", { status: "HEALTHY", latency: 38, errorRate: 0.25 }],
      ]);

      return {
        incidentId: "bench-04-payment-failure",
        graph,
        telemetrySamples: samples,
        currentServiceStates: currentStates,
      };
    },
    expected: {
      expectedClassification: "DEFINITIVE_ROOT_CAUSE",
      expectedRootCauseId: "payment-service",
      minConfidence: "HIGH",
    },
  },

  // 5. Inventory service timeout
  {
    id: "scenario-05-inventory-timeout",
    name: "Inventory Service Timeout",
    description: "Inventory stock reservation locks cause latency to exceed Order Service's 1500ms timeout threshold.",
    category: "SINGLE_POINT_FAILURE",
    getInput: () => {
      const graph = createCanonicalTopology();
      const samples: TelemetryPoint[] = [
        { serviceId: "inventory-service", simulationStep: 1, timestamp: new Date(), latency: 2400, errorRate: 8.0, requestCount: 360, healthStatus: "DEGRADED" },
        { serviceId: "postgres-db", simulationStep: 1, timestamp: new Date(), latency: 12, errorRate: 0.02, requestCount: 1550, healthStatus: "HEALTHY" },
        { serviceId: "order-service", simulationStep: 2, timestamp: new Date(), latency: 1650, errorRate: 28.0, requestCount: 520, healthStatus: "DEGRADED" },
        { serviceId: "api-gateway", simulationStep: 3, timestamp: new Date(), latency: 1700, errorRate: 20.0, requestCount: 1450, healthStatus: "DEGRADED" },
        { serviceId: "payment-service", simulationStep: 1, timestamp: new Date(), latency: 65, errorRate: 0.08, requestCount: 240, healthStatus: "HEALTHY" },
      ];

      const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
        ["inventory-service", { status: "DEGRADED", latency: 2400, errorRate: 8.0 }],
        ["order-service", { status: "DEGRADED", latency: 1650, errorRate: 28.0 }],
        ["api-gateway", { status: "DEGRADED", latency: 1700, errorRate: 20.0 }],
        ["postgres-db", { status: "HEALTHY", latency: 12, errorRate: 0.02 }],
        ["payment-service", { status: "HEALTHY", latency: 65, errorRate: 0.08 }],
        ["auth-service", { status: "HEALTHY", latency: 16, errorRate: 0.05 }],
        ["notification-service", { status: "HEALTHY", latency: 38, errorRate: 0.25 }],
      ]);

      return {
        incidentId: "bench-05-inventory-timeout",
        graph,
        telemetrySamples: samples,
        currentServiceStates: currentStates,
      };
    },
    expected: {
      expectedClassification: "DEFINITIVE_ROOT_CAUSE",
      expectedRootCauseId: "inventory-service",
      minConfidence: "HIGH",
    },
  },

  // 6. Authentication service outage
  {
    id: "scenario-06-auth-outage",
    name: "Authentication Service Outage",
    description: "Auth Service crashes, causing API Gateway to reject incoming user requests with 401/500.",
    category: "SINGLE_POINT_FAILURE",
    getInput: () => {
      const graph = createCanonicalTopology();
      const samples: TelemetryPoint[] = [
        { serviceId: "auth-service", simulationStep: 1, timestamp: new Date(), latency: 600, errorRate: 92.0, requestCount: 1200, healthStatus: "DOWN" },
        { serviceId: "api-gateway", simulationStep: 2, timestamp: new Date(), latency: 700, errorRate: 65.0, requestCount: 1450, healthStatus: "DEGRADED" },
        { serviceId: "order-service", simulationStep: 1, timestamp: new Date(), latency: 42, errorRate: 0.15, requestCount: 520, healthStatus: "HEALTHY" },
        { serviceId: "payment-service", simulationStep: 1, timestamp: new Date(), latency: 65, errorRate: 0.08, requestCount: 240, healthStatus: "HEALTHY" },
        { serviceId: "postgres-db", simulationStep: 1, timestamp: new Date(), latency: 11, errorRate: 0.02, requestCount: 1550, healthStatus: "HEALTHY" },
      ];

      const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
        ["auth-service", { status: "DOWN", latency: 600, errorRate: 92.0 }],
        ["api-gateway", { status: "DEGRADED", latency: 700, errorRate: 65.0 }],
        ["order-service", { status: "HEALTHY", latency: 42, errorRate: 0.15 }],
        ["payment-service", { status: "HEALTHY", latency: 65, errorRate: 0.08 }],
        ["inventory-service", { status: "HEALTHY", latency: 32, errorRate: 0.12 }],
        ["notification-service", { status: "HEALTHY", latency: 38, errorRate: 0.25 }],
        ["postgres-db", { status: "HEALTHY", latency: 11, errorRate: 0.02 }],
      ]);

      return {
        incidentId: "bench-06-auth-outage",
        graph,
        telemetrySamples: samples,
        currentServiceStates: currentStates,
      };
    },
    expected: {
      expectedClassification: "DEFINITIVE_ROOT_CAUSE",
      expectedRootCauseId: "auth-service",
      minConfidence: "HIGH",
    },
  },

  // 7. Network latency affecting selected dependencies
  {
    id: "scenario-07-network-latency",
    name: "Selective Dependency Network Latency",
    description: "Network latency affects synchronous communication to Order Service; databases and leaf services are healthy.",
    category: "EDGE_CASE",
    getInput: () => {
      const graph = createCanonicalTopology();
      const samples: TelemetryPoint[] = [
        { serviceId: "order-service", simulationStep: 1, timestamp: new Date(), latency: 950, errorRate: 12.0, requestCount: 520, healthStatus: "DEGRADED" },
        { serviceId: "api-gateway", simulationStep: 2, timestamp: new Date(), latency: 1050, errorRate: 15.0, requestCount: 1450, healthStatus: "DEGRADED" },
        { serviceId: "postgres-db", simulationStep: 1, timestamp: new Date(), latency: 11, errorRate: 0.02, requestCount: 1550, healthStatus: "HEALTHY" },
        { serviceId: "payment-service", simulationStep: 1, timestamp: new Date(), latency: 65, errorRate: 0.08, requestCount: 240, healthStatus: "HEALTHY" },
        { serviceId: "inventory-service", simulationStep: 1, timestamp: new Date(), latency: 32, errorRate: 0.12, requestCount: 360, healthStatus: "HEALTHY" },
      ];

      const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
        ["order-service", { status: "DEGRADED", latency: 950, errorRate: 12.0 }],
        ["api-gateway", { status: "DEGRADED", latency: 1050, errorRate: 15.0 }],
        ["postgres-db", { status: "HEALTHY", latency: 11, errorRate: 0.02 }],
        ["payment-service", { status: "HEALTHY", latency: 65, errorRate: 0.08 }],
        ["inventory-service", { status: "HEALTHY", latency: 32, errorRate: 0.12 }],
        ["auth-service", { status: "HEALTHY", latency: 16, errorRate: 0.05 }],
        ["notification-service", { status: "HEALTHY", latency: 38, errorRate: 0.25 }],
      ]);

      return {
        incidentId: "bench-07-network-latency",
        graph,
        telemetrySamples: samples,
        currentServiceStates: currentStates,
      };
    },
    expected: {
      expectedClassification: "DEFINITIVE_ROOT_CAUSE",
      expectedRootCauseId: "order-service",
      acceptableRootCauseIds: ["order-service"],
    },
  },

  // 8. Missing or stale telemetry
  {
    id: "scenario-08-missing-telemetry",
    name: "Missing or Stale Telemetry Observations",
    description: "Failure symptoms occur with sparse or absent telemetry metrics; engine must handle incomplete observations without throwing.",
    category: "NOISY_DATA",
    getInput: () => {
      const graph = createCanonicalTopology();
      // Only 1 telemetry sample for an unrelated node; key failing nodes have no time-series metrics
      const samples: TelemetryPoint[] = [
        { serviceId: "auth-service", simulationStep: 1, timestamp: new Date(), latency: 16, errorRate: 0.05, requestCount: 1200, healthStatus: "HEALTHY" },
      ];

      // Service state indicates Order Service is degraded, but no metric series exists
      const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
        ["order-service", { status: "DEGRADED", latency: 42, errorRate: 0.15 }],
        ["api-gateway", { status: "HEALTHY", latency: 22, errorRate: 0.1 }],
        ["auth-service", { status: "HEALTHY", latency: 16, errorRate: 0.05 }],
      ]);

      return {
        incidentId: "bench-08-missing-telemetry",
        graph,
        telemetrySamples: samples,
        currentServiceStates: currentStates,
      };
    },
    expected: {
      expectedClassification: "INCONCLUSIVE",
      expectedRootCauseId: null,
      acceptableRootCauseIds: ["order-service"],
      allowInconclusive: true,
    },
  },

  // 9. Contradictory failure signals
  {
    id: "scenario-09-contradictory-signals",
    name: "Contradictory Failure Signals",
    description: "A service reports DOWN status while its telemetry exhibits strictly normal baseline behavior.",
    category: "NOISY_DATA",
    getInput: () => {
      const graph = createCanonicalTopology();
      const samples: TelemetryPoint[] = [
        // Samples indicate completely healthy baseline latency and 0% errors across all nodes
        { serviceId: "api-gateway", simulationStep: 1, timestamp: new Date(), latency: 22, errorRate: 0.01, requestCount: 1450, healthStatus: "HEALTHY" },
        { serviceId: "api-gateway", simulationStep: 2, timestamp: new Date(), latency: 23, errorRate: 0.01, requestCount: 1450, healthStatus: "HEALTHY" },
        { serviceId: "order-service", simulationStep: 1, timestamp: new Date(), latency: 42, errorRate: 0.01, requestCount: 520, healthStatus: "HEALTHY" },
        { serviceId: "postgres-db", simulationStep: 1, timestamp: new Date(), latency: 11, errorRate: 0.01, requestCount: 1550, healthStatus: "HEALTHY" },
      ];

      // Contradiction: api-gateway claims DOWN, but telemetry is pristine baseline
      const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
        ["api-gateway", { status: "DOWN", latency: 22, errorRate: 0.01 }],
        ["order-service", { status: "HEALTHY", latency: 42, errorRate: 0.01 }],
        ["postgres-db", { status: "HEALTHY", latency: 11, errorRate: 0.01 }],
      ]);

      return {
        incidentId: "bench-09-contradictory-signals",
        graph,
        telemetrySamples: samples,
        currentServiceStates: currentStates,
      };
    },
    expected: {
      expectedClassification: "AMBIGUOUS",
      expectedRootCauseId: null,
      acceptableRootCauseIds: ["api-gateway"],
      allowInconclusive: true,
    },
  },

  // 10. An unrelated service failure that should not affect the suspected root cause
  {
    id: "scenario-10-unrelated-failure",
    name: "Unrelated Concurrent Service Failure",
    description: "Core PostgreSQL failure cascades into orders; an unrelated asynchronous notification service experiences independent errors.",
    category: "CASCADING_OUTAGE",
    getInput: () => {
      const graph = createCanonicalTopology();
      const samples: TelemetryPoint[] = [
        // Step 1: PostgreSQL latency spike begins
        { serviceId: "postgres-db", simulationStep: 1, timestamp: new Date(), latency: 950, errorRate: 8.0, requestCount: 1550, healthStatus: "DEGRADED" },

        // Step 2: Cascades to Order and Payment; Notification experiences unrelated issue
        { serviceId: "postgres-db", simulationStep: 2, timestamp: new Date(), latency: 1020, errorRate: 12.0, requestCount: 1550, healthStatus: "DEGRADED" },
        { serviceId: "order-service", simulationStep: 2, timestamp: new Date(), latency: 980, errorRate: 20.0, requestCount: 520, healthStatus: "DEGRADED" },
        { serviceId: "payment-service", simulationStep: 2, timestamp: new Date(), latency: 920, errorRate: 15.0, requestCount: 240, healthStatus: "DEGRADED" },
        // Unrelated failure on leaf async notification worker
        { serviceId: "notification-service", simulationStep: 2, timestamp: new Date(), latency: 45, errorRate: 18.0, requestCount: 190, healthStatus: "DEGRADED" },

        // Step 3: API Gateway degrades
        { serviceId: "api-gateway", simulationStep: 3, timestamp: new Date(), latency: 1100, errorRate: 25.0, requestCount: 1450, healthStatus: "DEGRADED" },
      ];

      const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
        ["postgres-db", { status: "DEGRADED", latency: 1020, errorRate: 12.0 }],
        ["order-service", { status: "DEGRADED", latency: 980, errorRate: 20.0 }],
        ["payment-service", { status: "DEGRADED", latency: 920, errorRate: 15.0 }],
        ["api-gateway", { status: "DEGRADED", latency: 1100, errorRate: 25.0 }],
        ["notification-service", { status: "DEGRADED", latency: 45, errorRate: 18.0 }],
        ["auth-service", { status: "HEALTHY", latency: 16, errorRate: 0.05 }],
        ["inventory-service", { status: "HEALTHY", latency: 32, errorRate: 0.12 }],
      ]);

      return {
        incidentId: "bench-10-unrelated-failure",
        graph,
        telemetrySamples: samples,
        currentServiceStates: currentStates,
      };
    },
    expected: {
      expectedClassification: "DEFINITIVE_ROOT_CAUSE",
      expectedRootCauseId: "postgres-db",
      minConfidence: "HIGH",
    },
  },
];

/**
 * Creates a post-remediation recovery scenario where all services have returned to healthy baseline.
 */
export function createRecoveryScenario(scenarioId: string = "scenario-recovery-verification"): BenchmarkScenario {
  return {
    id: scenarioId,
    name: "Post-Remediation Recovery Verification",
    description: "Evaluates system state post-remediation; verifies that root-cause candidate alerts resolve to healthy/inconclusive state.",
    category: "HEALTHY",
    getInput: () => {
      const graph = createCanonicalTopology();
      const samples: TelemetryPoint[] = [
        { serviceId: "postgres-db", simulationStep: 10, timestamp: new Date(), latency: 11, errorRate: 0.02, requestCount: 1550, healthStatus: "HEALTHY" },
        { serviceId: "order-service", simulationStep: 10, timestamp: new Date(), latency: 42, errorRate: 0.15, requestCount: 520, healthStatus: "HEALTHY" },
        { serviceId: "payment-service", simulationStep: 10, timestamp: new Date(), latency: 65, errorRate: 0.08, requestCount: 240, healthStatus: "HEALTHY" },
        { serviceId: "inventory-service", simulationStep: 10, timestamp: new Date(), latency: 32, errorRate: 0.12, requestCount: 360, healthStatus: "HEALTHY" },
        { serviceId: "api-gateway", simulationStep: 10, timestamp: new Date(), latency: 22, errorRate: 0.1, requestCount: 1450, healthStatus: "HEALTHY" },
      ];

      const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
        ["postgres-db", { status: "HEALTHY", latency: 11, errorRate: 0.02 }],
        ["order-service", { status: "HEALTHY", latency: 42, errorRate: 0.15 }],
        ["payment-service", { status: "HEALTHY", latency: 65, errorRate: 0.08 }],
        ["inventory-service", { status: "HEALTHY", latency: 32, errorRate: 0.12 }],
        ["api-gateway", { status: "HEALTHY", latency: 22, errorRate: 0.1 }],
        ["auth-service", { status: "HEALTHY", latency: 16, errorRate: 0.05 }],
        ["notification-service", { status: "HEALTHY", latency: 38, errorRate: 0.25 }],
      ]);

      return {
        incidentId: "bench-recovery-verification",
        graph,
        telemetrySamples: samples,
        currentServiceStates: currentStates,
      };
    },
    expected: {
      expectedClassification: "HEALTHY",
      expectedRootCauseId: null,
      allowInconclusive: true,
    },
  };
}

import { generateExpandedBenchmarkSuite } from "./generator";

/**
 * 107 parameterized scenarios generated using fixed seed 42.
 */
export const EXPANDED_BENCHMARK_SCENARIOS: BenchmarkScenario[] = generateExpandedBenchmarkSuite(42, 107);

/**
 * Comprehensive benchmark suite containing 117 deterministic scenario instances:
 * - 10 core regression test scenarios
 * - 107 systematically parameterized topology, failure, noise, and recovery scenarios
 */
export const FULL_BENCHMARK_SUITE: BenchmarkScenario[] = [
  ...BENCHMARK_SCENARIOS,
  ...EXPANDED_BENCHMARK_SCENARIOS,
];
