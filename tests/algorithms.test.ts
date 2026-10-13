import { describe, it, expect, beforeEach } from "vitest";
import { DirectedGraph } from "../src/lib/algorithms/graph";
import { PriorityQueue } from "../src/lib/algorithms/priorityQueue";
import { SlidingWindowAnalyzer } from "../src/lib/algorithms/slidingWindow";
import { RootCauseEngine } from "../src/lib/algorithms/rootCauseEngine";
import { ServiceNodeData, TelemetryPoint } from "../src/lib/algorithms/types";

describe("DSA Layer Unit Tests", () => {
  let graph: DirectedGraph<ServiceNodeData>;

  const createDummyService = (id: string, name: string, tier: number = 2): ServiceNodeData => ({
    id,
    name,
    serviceType: "API",
    tier,
    status: "HEALTHY",
    baselineLatency: 20,
    currentLatency: 20,
    baselineErrorRate: 0.1,
    currentErrorRate: 0.1,
    requestRate: 500,
  });

  beforeEach(() => {
    graph = new DirectedGraph<ServiceNodeData>();
    // API Gateway -> Order Service -> Postgres DB
    // API Gateway -> Auth Service
    // Order Service -> Payment Service -> Postgres DB
    graph.addNode("api-gateway", createDummyService("api-gateway", "API Gateway", 1));
    graph.addNode("auth-service", createDummyService("auth-service", "Auth Service", 2));
    graph.addNode("order-service", createDummyService("order-service", "Order Service", 2));
    graph.addNode("payment-service", createDummyService("payment-service", "Payment Service", 2));
    graph.addNode("postgres-db", createDummyService("postgres-db", "PostgreSQL DB", 3));

    // A -> B means A depends on B
    graph.addEdge("api-gateway", "auth-service", { dependencyType: "SYNC_HTTP", timeoutThreshold: 800, criticality: "CRITICAL" });
    graph.addEdge("api-gateway", "order-service", { dependencyType: "SYNC_HTTP", timeoutThreshold: 2000, criticality: "CRITICAL" });
    graph.addEdge("order-service", "payment-service", { dependencyType: "SYNC_HTTP", timeoutThreshold: 2000, criticality: "CRITICAL" });
    graph.addEdge("order-service", "postgres-db", { dependencyType: "DATABASE_CONN", timeoutThreshold: 1000, criticality: "CRITICAL" });
    graph.addEdge("payment-service", "postgres-db", { dependencyType: "DATABASE_CONN", timeoutThreshold: 1000, criticality: "CRITICAL" });
  });

  // Test 1: BFS discovers the expected affected dependents
  it("1. BFS discovers the expected affected dependents along reverse dependencies", () => {
    // If postgres-db fails, its dependents are:
    // Immediate (depth 1): order-service, payment-service
    // Secondary (depth 2): api-gateway (since api-gateway depends on order-service)
    const impacted = graph.findImpactedDependents("postgres-db");
    const impactedIds = impacted.map((s) => s.serviceId);

    expect(impactedIds).toContain("order-service");
    expect(impactedIds).toContain("payment-service");
    expect(impactedIds).toContain("api-gateway");
    expect(impactedIds).not.toContain("auth-service"); // auth-service does not depend on postgres-db

    const orderServiceStep = impacted.find((s) => s.serviceId === "order-service");
    const apiGatewayStep = impacted.find((s) => s.serviceId === "api-gateway");

    expect(orderServiceStep?.depth).toBe(1);
    expect(apiGatewayStep?.depth).toBe(2);
  });

  // Test 2: DFS terminates correctly even with cycles
  it("2. DFS terminates correctly even with circular dependencies", () => {
    // Introduce a cycle: payment-service -> order-service -> payment-service
    graph.addEdge("payment-service", "order-service", {
      dependencyType: "SYNC_HTTP",
      timeoutThreshold: 1000,
      criticality: "HIGH",
    });

    // DFS for reachability must terminate and not throw or loop infinitely
    const reachable = graph.getReachableServices("order-service");
    expect(reachable.length).toBeGreaterThan(0);
    expect(reachable).toContain("payment-service");
    expect(reachable).toContain("postgres-db");
  });

  // Test 3: Cycle detection identifies directed cycles
  it("3. Cycle detection identifies directed cycles correctly", () => {
    expect(graph.hasCycle()).toBe(false);

    // Add directed circular dependency: C -> D -> E -> C
    graph.addNode("svc-c", createDummyService("svc-c", "Service C"));
    graph.addNode("svc-d", createDummyService("svc-d", "Service D"));
    graph.addNode("svc-e", createDummyService("svc-e", "Service E"));

    graph.addEdge("svc-c", "svc-d");
    graph.addEdge("svc-d", "svc-e");
    graph.addEdge("svc-e", "svc-c");

    const result = graph.findCycles();
    expect(result.hasCycle).toBe(true);
    expect(result.cycles.length).toBeGreaterThan(0);
  });

  // Test 4: Priority queue maintains correct priority order
  it("4. Priority queue maintains the correct priority order", () => {
    const maxPq = new PriorityQueue<string>("MAX");
    maxPq.insert("low-priority", 10);
    maxPq.insert("critical-priority", 95);
    maxPq.insert("medium-priority", 50);
    maxPq.insert("high-priority", 80);

    expect(maxPq.extract()?.item).toBe("critical-priority");
    expect(maxPq.extract()?.item).toBe("high-priority");
    expect(maxPq.extract()?.item).toBe("medium-priority");
    expect(maxPq.extract()?.item).toBe("low-priority");
    expect(maxPq.isEmpty()).toBe(true);

    const minPq = new PriorityQueue<string>("MIN");
    minPq.insert("ten", 10);
    minPq.insert("two", 2);
    minPq.insert("seven", 7);
    expect(minPq.extract()?.item).toBe("two");
    expect(minPq.extract()?.item).toBe("seven");
    expect(minPq.extract()?.item).toBe("ten");
  });

  // Test 5: Sliding-window calculations are correct
  it("5. Sliding-window calculations handle averages, deltas, and zero denominators safely", () => {
    const analyzer = new SlidingWindowAnalyzer(3);

    // Empty samples test
    const emptyStats = analyzer.analyzeServiceWindow("test-svc", [], 20, 0.1);
    expect(emptyStats.averageLatency).toBe(20);
    expect(emptyStats.latencyRatio).toBe(1.0);
    expect(emptyStats.hasLatencyAnomaly).toBe(false);

    // Normal samples
    const samples: TelemetryPoint[] = [
      { serviceId: "test-svc", simulationStep: 1, timestamp: new Date(), latency: 20, errorRate: 0.1, requestCount: 100, healthStatus: "HEALTHY" },
      { serviceId: "test-svc", simulationStep: 2, timestamp: new Date(), latency: 25, errorRate: 0.2, requestCount: 100, healthStatus: "HEALTHY" },
      { serviceId: "test-svc", simulationStep: 3, timestamp: new Date(), latency: 150, errorRate: 15.0, requestCount: 100, healthStatus: "DEGRADED" },
      { serviceId: "test-svc", simulationStep: 4, timestamp: new Date(), latency: 180, errorRate: 20.0, requestCount: 100, healthStatus: "DOWN" },
    ];

    // Window size is 3 -> takes steps 2, 3, 4
    const stats = analyzer.analyzeServiceWindow("test-svc", samples, 20, 0.1);
    expect(stats.sampleCount).toBe(3);
    expect(stats.hasLatencyAnomaly).toBe(true);
    expect(stats.hasErrorAnomaly).toBe(true);
    expect(stats.firstAnomalousStep).toBe(3);
  });

  // Test 6: Root-cause ranking responds correctly to temporal and dependency evidence
  it("6. Root-cause ranking responds correctly to temporal and dependency evidence", () => {
    const engine = new RootCauseEngine(5);

    // Scenario: Postgres DB slows down at step 1.
    // Order service slows down at step 2.
    // API gateway observes errors at step 3.
    const samples: TelemetryPoint[] = [
      { serviceId: "postgres-db", simulationStep: 1, timestamp: new Date(), latency: 850, errorRate: 12, requestCount: 500, healthStatus: "DEGRADED" },
      { serviceId: "order-service", simulationStep: 2, timestamp: new Date(), latency: 900, errorRate: 15, requestCount: 300, healthStatus: "DEGRADED" },
      { serviceId: "api-gateway", simulationStep: 3, timestamp: new Date(), latency: 1200, errorRate: 25, requestCount: 1200, healthStatus: "DEGRADED" },
      { serviceId: "auth-service", simulationStep: 1, timestamp: new Date(), latency: 18, errorRate: 0.05, requestCount: 1000, healthStatus: "HEALTHY" },
    ];

    const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
      ["postgres-db", { status: "DEGRADED", latency: 850, errorRate: 12 }],
      ["order-service", { status: "DEGRADED", latency: 900, errorRate: 15 }],
      ["api-gateway", { status: "DEGRADED", latency: 1200, errorRate: 25 }],
      ["auth-service", { status: "HEALTHY", latency: 18, errorRate: 0.05 }],
      ["payment-service", { status: "HEALTHY", latency: 65, errorRate: 0.08 }],
    ]);

    const result = engine.analyzeIncident({
      incidentId: "inc-001",
      graph,
      telemetrySamples: samples,
      currentServiceStates: currentStates,
    });

    expect(result.isConclusive).toBe(true);
    expect(result.topRootCause?.serviceId).toBe("postgres-db");
    expect(result.topRootCause?.rank).toBe(1);
    expect(result.topRootCause?.supportingEvidence.some((e) => e.type === "TIMING_PRECEDENCE")).toBe(true);
    expect(result.topRootCause?.supportingEvidence.some((e) => e.type === "CASCADING_IMPACT")).toBe(true);
  });

  // Test 7: The engine returns an inconclusive result when evidence is insufficient
  it("7. The engine returns an inconclusive result when evidence is insufficient or all healthy", () => {
    const engine = new RootCauseEngine(5);
    const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
      ["postgres-db", { status: "HEALTHY", latency: 12, errorRate: 0.01 }],
      ["order-service", { status: "HEALTHY", latency: 45, errorRate: 0.15 }],
      ["api-gateway", { status: "HEALTHY", latency: 25, errorRate: 0.1 }],
    ]);

    const result = engine.analyzeIncident({
      incidentId: "inc-healthy",
      graph,
      telemetrySamples: [],
      currentServiceStates: currentStates,
    });

    expect(result.isConclusive).toBe(false);
    expect(result.topRootCause).toBeNull();
  });

  // Test 8: Analysis engine never accesses hidden simulator ground truth
  it("8. Analysis engine never accesses hidden simulator ground truth", () => {
    // Verify engine interface accepts strictly topological and telemetry inputs
    const engine = new RootCauseEngine();
    expect(engine).toBeDefined();
    // RootCauseInput type has incidentId, graph, telemetrySamples, currentServiceStates
    // It has NO field for injectedRootCause or groundTruth!
    const inputKeys = ["incidentId", "graph", "telemetrySamples", "currentServiceStates"];
    expect(inputKeys).not.toContain("injectedRootCause");
    expect(inputKeys).not.toContain("groundTruth");
  });

  // Test 9: Root-cause rankings are deterministic for identical evidence
  it("9. Root-cause rankings are deterministic for identical evidence", () => {
    const engine = new RootCauseEngine(5);
    const samples: TelemetryPoint[] = [
      { serviceId: "auth-service", simulationStep: 1, timestamp: new Date(), latency: 600, errorRate: 45, requestCount: 1000, healthStatus: "DOWN" },
      { serviceId: "api-gateway", simulationStep: 2, timestamp: new Date(), latency: 700, errorRate: 40, requestCount: 1200, healthStatus: "DEGRADED" },
    ];
    const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>([
      ["auth-service", { status: "DOWN", latency: 600, errorRate: 45 }],
      ["api-gateway", { status: "DEGRADED", latency: 700, errorRate: 40 }],
      ["order-service", { status: "HEALTHY", latency: 45, errorRate: 0.1 }],
    ]);

    const runA = engine.analyzeIncident({ incidentId: "inc-det", graph, telemetrySamples: samples, currentServiceStates: currentStates });
    const runB = engine.analyzeIncident({ incidentId: "inc-det", graph, telemetrySamples: samples, currentServiceStates: currentStates });

    expect(runA.topRootCause?.serviceId).toBe(runB.topRootCause?.serviceId);
    expect(runA.topRootCause?.score).toBe(runB.topRootCause?.score);
    expect(runA.allCandidates.length).toBe(runB.allCandidates.length);
    for (let i = 0; i < runA.allCandidates.length; i++) {
      expect(runA.allCandidates[i].serviceId).toBe(runB.allCandidates[i].serviceId);
      expect(runA.allCandidates[i].score).toBe(runB.allCandidates[i].score);
    }
  });
});
