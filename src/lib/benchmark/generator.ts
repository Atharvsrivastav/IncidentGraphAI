import { DirectedGraph } from "../algorithms/graph";
import { ServiceNodeData, TelemetryPoint } from "../algorithms/types";
import { BenchmarkScenario, ScenarioCategory } from "./types";
import { SeededPRNG } from "./prng";

/**
 * Topology 1: Canonical E-Commerce (7 nodes)
 */
export function buildCanonicalGraph(): DirectedGraph<ServiceNodeData> {
  const g = new DirectedGraph<ServiceNodeData>();
  const nodes: ServiceNodeData[] = [
    { id: "api-gateway", name: "API Gateway", serviceType: "GATEWAY", tier: 1, status: "HEALTHY", baselineLatency: 22, currentLatency: 22, baselineErrorRate: 0.1, currentErrorRate: 0.1, requestRate: 1450 },
    { id: "auth-service", name: "Auth Service", serviceType: "AUTH", tier: 2, status: "HEALTHY", baselineLatency: 16, currentLatency: 16, baselineErrorRate: 0.05, currentErrorRate: 0.05, requestRate: 1200 },
    { id: "order-service", name: "Order Service", serviceType: "ORDER", tier: 2, status: "HEALTHY", baselineLatency: 42, currentLatency: 42, baselineErrorRate: 0.15, currentErrorRate: 0.15, requestRate: 520 },
    { id: "payment-service", name: "Payment Service", serviceType: "PAYMENT", tier: 2, status: "HEALTHY", baselineLatency: 65, currentLatency: 65, baselineErrorRate: 0.08, currentErrorRate: 0.08, requestRate: 240 },
    { id: "inventory-service", name: "Inventory Service", serviceType: "INVENTORY", tier: 2, status: "HEALTHY", baselineLatency: 32, currentLatency: 32, baselineErrorRate: 0.12, currentErrorRate: 0.12, requestRate: 360 },
    { id: "notification-service", name: "Notification Service", serviceType: "NOTIFICATION", tier: 2, status: "HEALTHY", baselineLatency: 38, currentLatency: 38, baselineErrorRate: 0.25, currentErrorRate: 0.25, requestRate: 190 },
    { id: "postgres-db", name: "PostgreSQL Database", serviceType: "DATABASE", tier: 3, status: "HEALTHY", baselineLatency: 11, currentLatency: 11, baselineErrorRate: 0.02, currentErrorRate: 0.02, requestRate: 1550 },
  ];
  for (const n of nodes) g.addNode(n.id, n);
  g.addEdge("api-gateway", "auth-service", { dependencyType: "SYNC_HTTP", timeoutThreshold: 800, criticality: "CRITICAL" });
  g.addEdge("api-gateway", "order-service", { dependencyType: "SYNC_HTTP", timeoutThreshold: 2000, criticality: "CRITICAL" });
  g.addEdge("order-service", "payment-service", { dependencyType: "SYNC_HTTP", timeoutThreshold: 2500, criticality: "CRITICAL" });
  g.addEdge("order-service", "inventory-service", { dependencyType: "SYNC_HTTP", timeoutThreshold: 1500, criticality: "HIGH" });
  g.addEdge("order-service", "postgres-db", { dependencyType: "DATABASE_CONN", timeoutThreshold: 1000, criticality: "CRITICAL" });
  g.addEdge("payment-service", "postgres-db", { dependencyType: "DATABASE_CONN", timeoutThreshold: 1000, criticality: "CRITICAL" });
  g.addEdge("inventory-service", "postgres-db", { dependencyType: "DATABASE_CONN", timeoutThreshold: 1000, criticality: "CRITICAL" });
  g.addEdge("order-service", "notification-service", { dependencyType: "ASYNC_QUEUE", timeoutThreshold: 3000, criticality: "LOW" });
  return g;
}

/**
 * Topology 2: Linear Pipeline (6 nodes)
 * edge-proxy -> auth-gateway -> checkout-api -> payment-engine -> fraud-risk -> ledger-db
 */
export function buildPipelineGraph(): DirectedGraph<ServiceNodeData> {
  const g = new DirectedGraph<ServiceNodeData>();
  const nodes: ServiceNodeData[] = [
    { id: "edge-proxy", name: "Edge Proxy", serviceType: "GATEWAY", tier: 1, status: "HEALTHY", baselineLatency: 15, currentLatency: 15, baselineErrorRate: 0.05, currentErrorRate: 0.05, requestRate: 2000 },
    { id: "auth-gateway", name: "Auth Gateway", serviceType: "AUTH", tier: 2, status: "HEALTHY", baselineLatency: 20, currentLatency: 20, baselineErrorRate: 0.05, currentErrorRate: 0.05, requestRate: 1800 },
    { id: "checkout-api", name: "Checkout API", serviceType: "API", tier: 2, status: "HEALTHY", baselineLatency: 35, currentLatency: 35, baselineErrorRate: 0.1, currentErrorRate: 0.1, requestRate: 600 },
    { id: "payment-engine", name: "Payment Engine", serviceType: "PAYMENT", tier: 3, status: "HEALTHY", baselineLatency: 50, currentLatency: 50, baselineErrorRate: 0.1, currentErrorRate: 0.1, requestRate: 400 },
    { id: "fraud-risk", name: "Fraud Risk Service", serviceType: "RISK", tier: 3, status: "HEALTHY", baselineLatency: 45, currentLatency: 45, baselineErrorRate: 0.15, currentErrorRate: 0.15, requestRate: 400 },
    { id: "ledger-db", name: "Ledger Database", serviceType: "DATABASE", tier: 4, status: "HEALTHY", baselineLatency: 12, currentLatency: 12, baselineErrorRate: 0.01, currentErrorRate: 0.01, requestRate: 800 },
  ];
  for (const n of nodes) g.addNode(n.id, n);
  g.addEdge("edge-proxy", "auth-gateway", { dependencyType: "SYNC_HTTP", timeoutThreshold: 1000, criticality: "CRITICAL" });
  g.addEdge("auth-gateway", "checkout-api", { dependencyType: "SYNC_HTTP", timeoutThreshold: 1500, criticality: "CRITICAL" });
  g.addEdge("checkout-api", "payment-engine", { dependencyType: "SYNC_HTTP", timeoutThreshold: 2000, criticality: "CRITICAL" });
  g.addEdge("payment-engine", "fraud-risk", { dependencyType: "SYNC_HTTP", timeoutThreshold: 1500, criticality: "HIGH" });
  g.addEdge("fraud-risk", "ledger-db", { dependencyType: "DATABASE_CONN", timeoutThreshold: 1000, criticality: "CRITICAL" });
  return g;
}

/**
 * Topology 3: Microservices Mesh (9 nodes)
 */
export function buildMeshGraph(): DirectedGraph<ServiceNodeData> {
  const g = new DirectedGraph<ServiceNodeData>();
  const nodes: ServiceNodeData[] = [
    { id: "mesh-ingress", name: "Mesh Ingress", serviceType: "GATEWAY", tier: 1, status: "HEALTHY", baselineLatency: 18, currentLatency: 18, baselineErrorRate: 0.05, currentErrorRate: 0.05, requestRate: 2500 },
    { id: "user-svc", name: "User Service", serviceType: "API", tier: 2, status: "HEALTHY", baselineLatency: 25, currentLatency: 25, baselineErrorRate: 0.1, currentErrorRate: 0.1, requestRate: 1500 },
    { id: "order-svc", name: "Order Service", serviceType: "ORDER", tier: 2, status: "HEALTHY", baselineLatency: 38, currentLatency: 38, baselineErrorRate: 0.12, currentErrorRate: 0.12, requestRate: 800 },
    { id: "catalog-svc", name: "Catalog Service", serviceType: "API", tier: 2, status: "HEALTHY", baselineLatency: 28, currentLatency: 28, baselineErrorRate: 0.08, currentErrorRate: 0.08, requestRate: 1100 },
    { id: "cart-svc", name: "Cart Service", serviceType: "API", tier: 2, status: "HEALTHY", baselineLatency: 30, currentLatency: 30, baselineErrorRate: 0.1, currentErrorRate: 0.1, requestRate: 900 },
    { id: "recs-svc", name: "Recommendations", serviceType: "ML", tier: 2, status: "HEALTHY", baselineLatency: 55, currentLatency: 55, baselineErrorRate: 0.2, currentErrorRate: 0.2, requestRate: 400 },
    { id: "inventory-svc", name: "Inventory", serviceType: "INVENTORY", tier: 2, status: "HEALTHY", baselineLatency: 32, currentLatency: 32, baselineErrorRate: 0.1, currentErrorRate: 0.1, requestRate: 600 },
    { id: "pg-primary", name: "PostgreSQL Primary", serviceType: "DATABASE", tier: 3, status: "HEALTHY", baselineLatency: 10, currentLatency: 10, baselineErrorRate: 0.01, currentErrorRate: 0.01, requestRate: 3000 },
    { id: "redis-cache", name: "Redis Cache Cluster", serviceType: "CACHE", tier: 3, status: "HEALTHY", baselineLatency: 4, currentLatency: 4, baselineErrorRate: 0.01, currentErrorRate: 0.01, requestRate: 4000 },
  ];
  for (const n of nodes) g.addNode(n.id, n);
  g.addEdge("mesh-ingress", "user-svc", { dependencyType: "SYNC_HTTP", timeoutThreshold: 800, criticality: "CRITICAL" });
  g.addEdge("mesh-ingress", "order-svc", { dependencyType: "SYNC_HTTP", timeoutThreshold: 1500, criticality: "CRITICAL" });
  g.addEdge("mesh-ingress", "catalog-svc", { dependencyType: "SYNC_HTTP", timeoutThreshold: 1000, criticality: "MEDIUM" });
  g.addEdge("order-svc", "cart-svc", { dependencyType: "SYNC_HTTP", timeoutThreshold: 1200, criticality: "HIGH" });
  g.addEdge("order-svc", "inventory-svc", { dependencyType: "SYNC_HTTP", timeoutThreshold: 1200, criticality: "CRITICAL" });
  g.addEdge("catalog-svc", "recs-svc", { dependencyType: "SYNC_HTTP", timeoutThreshold: 1800, criticality: "LOW" });
  g.addEdge("user-svc", "pg-primary", { dependencyType: "DATABASE_CONN", timeoutThreshold: 1000, criticality: "CRITICAL" });
  g.addEdge("order-svc", "pg-primary", { dependencyType: "DATABASE_CONN", timeoutThreshold: 1000, criticality: "CRITICAL" });
  g.addEdge("cart-svc", "redis-cache", { dependencyType: "DATABASE_CONN", timeoutThreshold: 400, criticality: "HIGH" });
  g.addEdge("catalog-svc", "redis-cache", { dependencyType: "DATABASE_CONN", timeoutThreshold: 400, criticality: "MEDIUM" });
  return g;
}

/**
 * Topology 4: Hub-and-Spoke (8 nodes)
 */
export function buildHubSpokeGraph(): DirectedGraph<ServiceNodeData> {
  const g = new DirectedGraph<ServiceNodeData>();
  const nodes: ServiceNodeData[] = [
    { id: "event-hub", name: "Central Event Hub", serviceType: "MESSAGING", tier: 2, status: "HEALTHY", baselineLatency: 15, currentLatency: 15, baselineErrorRate: 0.05, currentErrorRate: 0.05, requestRate: 5000 },
    { id: "worker-ingest", name: "Ingest Worker", serviceType: "WORKER", tier: 1, status: "HEALTHY", baselineLatency: 25, currentLatency: 25, baselineErrorRate: 0.1, currentErrorRate: 0.1, requestRate: 2000 },
    { id: "worker-analytics", name: "Analytics Worker", serviceType: "WORKER", tier: 1, status: "HEALTHY", baselineLatency: 40, currentLatency: 40, baselineErrorRate: 0.15, currentErrorRate: 0.15, requestRate: 1000 },
    { id: "worker-email", name: "Email Worker", serviceType: "WORKER", tier: 1, status: "HEALTHY", baselineLatency: 35, currentLatency: 35, baselineErrorRate: 0.2, currentErrorRate: 0.2, requestRate: 500 },
    { id: "worker-search", name: "Search Indexer", serviceType: "WORKER", tier: 1, status: "HEALTHY", baselineLatency: 30, currentLatency: 30, baselineErrorRate: 0.1, currentErrorRate: 0.1, requestRate: 800 },
    { id: "worker-billing", name: "Billing Sync Worker", serviceType: "WORKER", tier: 1, status: "HEALTHY", baselineLatency: 45, currentLatency: 45, baselineErrorRate: 0.08, currentErrorRate: 0.08, requestRate: 400 },
    { id: "worker-audit", name: "Audit Logger", serviceType: "WORKER", tier: 1, status: "HEALTHY", baselineLatency: 20, currentLatency: 20, baselineErrorRate: 0.05, currentErrorRate: 0.05, requestRate: 600 },
    { id: "kafka-cluster", name: "Kafka Storage Cluster", serviceType: "DATABASE", tier: 3, status: "HEALTHY", baselineLatency: 8, currentLatency: 8, baselineErrorRate: 0.01, currentErrorRate: 0.01, requestRate: 6000 },
  ];
  for (const n of nodes) g.addNode(n.id, n);
  g.addEdge("worker-ingest", "event-hub", { dependencyType: "ASYNC_QUEUE", timeoutThreshold: 2000, criticality: "CRITICAL" });
  g.addEdge("worker-analytics", "event-hub", { dependencyType: "ASYNC_QUEUE", timeoutThreshold: 2000, criticality: "MEDIUM" });
  g.addEdge("worker-email", "event-hub", { dependencyType: "ASYNC_QUEUE", timeoutThreshold: 2000, criticality: "LOW" });
  g.addEdge("worker-search", "event-hub", { dependencyType: "ASYNC_QUEUE", timeoutThreshold: 2000, criticality: "HIGH" });
  g.addEdge("worker-billing", "event-hub", { dependencyType: "ASYNC_QUEUE", timeoutThreshold: 2000, criticality: "CRITICAL" });
  g.addEdge("worker-audit", "event-hub", { dependencyType: "ASYNC_QUEUE", timeoutThreshold: 2000, criticality: "LOW" });
  g.addEdge("event-hub", "kafka-cluster", { dependencyType: "DATABASE_CONN", timeoutThreshold: 1000, criticality: "CRITICAL" });
  return g;
}

/**
 * Topology 5: Cyclic Microservices (6 nodes)
 * Contains intentional circular dependency between order-srv and payment-srv for retry loop
 */
export function buildCyclicGraph(): DirectedGraph<ServiceNodeData> {
  const g = new DirectedGraph<ServiceNodeData>();
  const nodes: ServiceNodeData[] = [
    { id: "cyclic-gateway", name: "Cyclic Gateway", serviceType: "GATEWAY", tier: 1, status: "HEALTHY", baselineLatency: 20, currentLatency: 20, baselineErrorRate: 0.1, currentErrorRate: 0.1, requestRate: 1000 },
    { id: "cyclic-order", name: "Order Service", serviceType: "ORDER", tier: 2, status: "HEALTHY", baselineLatency: 35, currentLatency: 35, baselineErrorRate: 0.1, currentErrorRate: 0.1, requestRate: 600 },
    { id: "cyclic-payment", name: "Payment Service", serviceType: "PAYMENT", tier: 2, status: "HEALTHY", baselineLatency: 45, currentLatency: 45, baselineErrorRate: 0.1, currentErrorRate: 0.1, requestRate: 600 },
    { id: "cyclic-inventory", name: "Inventory Service", serviceType: "INVENTORY", tier: 2, status: "HEALTHY", baselineLatency: 28, currentLatency: 28, baselineErrorRate: 0.1, currentErrorRate: 0.1, requestRate: 400 },
    { id: "cyclic-db", name: "Backend DB", serviceType: "DATABASE", tier: 3, status: "HEALTHY", baselineLatency: 12, currentLatency: 12, baselineErrorRate: 0.02, currentErrorRate: 0.02, requestRate: 1200 },
    { id: "cyclic-notify", name: "Notifier", serviceType: "NOTIFICATION", tier: 2, status: "HEALTHY", baselineLatency: 30, currentLatency: 30, baselineErrorRate: 0.15, currentErrorRate: 0.15, requestRate: 200 },
  ];
  for (const n of nodes) g.addNode(n.id, n);
  g.addEdge("cyclic-gateway", "cyclic-order", { dependencyType: "SYNC_HTTP", timeoutThreshold: 1500, criticality: "CRITICAL" });
  g.addEdge("cyclic-order", "cyclic-payment", { dependencyType: "SYNC_HTTP", timeoutThreshold: 1500, criticality: "CRITICAL" });
  // Cyclic edge: payment depends on order status confirmation
  g.addEdge("cyclic-payment", "cyclic-order", { dependencyType: "SYNC_HTTP", timeoutThreshold: 1500, criticality: "MEDIUM" });
  g.addEdge("cyclic-order", "cyclic-inventory", { dependencyType: "SYNC_HTTP", timeoutThreshold: 1200, criticality: "HIGH" });
  g.addEdge("cyclic-payment", "cyclic-db", { dependencyType: "DATABASE_CONN", timeoutThreshold: 1000, criticality: "CRITICAL" });
  g.addEdge("cyclic-order", "cyclic-notify", { dependencyType: "ASYNC_QUEUE", timeoutThreshold: 2000, criticality: "LOW" });
  return g;
}

const TOPOLOGY_FACTORIES = [
  { name: "Canonical", fn: buildCanonicalGraph },
  { name: "Pipeline", fn: buildPipelineGraph },
  { name: "Mesh", fn: buildMeshGraph },
  { name: "HubSpoke", fn: buildHubSpokeGraph },
  { name: "Cyclic", fn: buildCyclicGraph },
];

/**
 * Builds baseline samples across N steps for all nodes in graph.
 */
function generateBaselineTelemetry(
  graph: DirectedGraph<ServiceNodeData>,
  steps: number,
  prng: SeededPRNG,
  trafficMultiplier: number = 1.0
): TelemetryPoint[] {
  const samples: TelemetryPoint[] = [];
  const baseTime = new Date("2026-10-14T01:00:00Z");

  for (let s = 0; s < steps; s++) {
    const timestamp = new Date(baseTime.getTime() + s * 10000);
    for (const [id, node] of graph.getAllNodes()) {
      const jitterLat = prng.nextFloat(-1.5, 1.5);
      const lat = Math.max(1, Math.round(node.baselineLatency + jitterLat));
      const jitterErr = prng.nextFloat(-0.02, 0.02);
      const err = Math.max(0, Math.round((node.baselineErrorRate + jitterErr) * 100) / 100);

      samples.push({
        serviceId: id,
        simulationStep: s,
        timestamp,
        latency: lat,
        errorRate: err,
        requestCount: Math.round(node.requestRate * trafficMultiplier),
        healthStatus: "HEALTHY",
      });
    }
  }
  return samples;
}

/**
 * Generates an expanded suite of at least 100 reproducible benchmark scenarios.
 * Seed is fixed for 100% deterministic reproducibility.
 */
export function generateExpandedBenchmarkSuite(seed: number = 42, count: number = 107): BenchmarkScenario[] {
  const prng = new SeededPRNG(seed);
  const scenarios: BenchmarkScenario[] = [];

  for (let i = 1; i <= count; i++) {
    const id = `scenario-param-${String(i).padStart(3, "0")}`;
    const topoEntry = TOPOLOGY_FACTORIES[(i - 1) % TOPOLOGY_FACTORIES.length];

    // Partition scenarios systematically across categories
    let category: ScenarioCategory;
    if (i <= 12) {
      category = "HEALTHY";
    } else if (i <= 32) {
      category = "SINGLE_POINT_FAILURE";
    } else if (i <= 50) {
      category = "CASCADING_OUTAGE";
    } else if (i <= 60) {
      category = "MULTI_SERVICE_FAILURE";
    } else if (i <= 70) {
      category = "DEPENDENCY_TIMEOUT";
    } else if (i <= 82) {
      category = "NOISY_DATA";
    } else if (i <= 92) {
      category = "CONTRADICTORY_SIGNALS";
    } else if (i <= 102) {
      category = "TOPOLOGY_VARIATION";
    } else {
      category = "RECOVERY_CYCLE";
    }

    const scenario = buildParameterizedScenario(id, category, topoEntry, prng);
    scenarios.push(scenario);
  }

  return scenarios;
}

function buildParameterizedScenario(
  id: string,
  category: ScenarioCategory,
  topoEntry: { name: string; fn: () => DirectedGraph<ServiceNodeData> },
  prng: SeededPRNG
): BenchmarkScenario {
  switch (category) {
    case "HEALTHY": {
      const highLoad = prng.chance(0.5);
      const trafficMul = highLoad ? prng.nextFloat(3.0, 8.0) : 1.0;
      return {
        id,
        name: `Healthy Baseline (${topoEntry.name}${highLoad ? " - High Load" : ""})`,
        description: `Normal operations under ${highLoad ? "heavy burst traffic" : "standard traffic"} on ${topoEntry.name} topology.`,
        category: "HEALTHY",
        getInput: () => {
          const graph = topoEntry.fn();
          const samples = generateBaselineTelemetry(graph, 4, prng, trafficMul);
          const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>();
          for (const [sId, node] of graph.getAllNodes()) {
            currentStates.set(sId, { status: "HEALTHY", latency: node.baselineLatency, errorRate: node.baselineErrorRate });
          }
          return { incidentId: id, graph, telemetrySamples: samples, currentServiceStates: currentStates };
        },
        expected: {
          expectedClassification: "HEALTHY",
          expectedRootCauseId: null,
          allowInconclusive: true,
        },
      };
    }

    case "SINGLE_POINT_FAILURE": {
      // Pick a target node that has at least 1 dependent if possible, or leaf DB
      const targetGraph = topoEntry.fn();
      const nodeIds = targetGraph.getAllNodeIds();
      const targetId = prng.pick(nodeIds);
      const node = targetGraph.getNode(targetId)!;
      const severity = prng.pick(["MILD", "MODERATE", "SEVERE"] as const);

      const latMultiplier = severity === "MILD" ? prng.nextFloat(2.5, 4.0) : severity === "MODERATE" ? prng.nextFloat(6.0, 15.0) : prng.nextFloat(30.0, 80.0);
      const errorRate = severity === "MILD" ? prng.nextFloat(10.0, 20.0) : severity === "MODERATE" ? prng.nextFloat(25.0, 60.0) : prng.nextFloat(75.0, 98.0);
      const status = severity === "SEVERE" ? "DOWN" : "DEGRADED";

      return {
        id,
        name: `Single Service Failure: ${node.name} (${severity})`,
        description: `Originating failure on ${node.name} with ${Math.round(latMultiplier)}x latency and ${Math.round(errorRate)}% errors.`,
        category: "SINGLE_POINT_FAILURE",
        getInput: () => {
          const graph = topoEntry.fn();
          const samples = generateBaselineTelemetry(graph, 3, prng).filter(
            (s) => s.serviceId !== targetId || s.simulationStep === 0
          );
          const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>();

          for (const [sId, n] of graph.getAllNodes()) {
            if (sId === targetId) {
              const elevatedLat = Math.round(n.baselineLatency * latMultiplier);
              currentStates.set(sId, { status, latency: elevatedLat, errorRate });
              // Inject failure sample at step 1 and step 2
              samples.push({
                serviceId: sId,
                simulationStep: 1,
                timestamp: new Date(),
                latency: elevatedLat,
                errorRate,
                requestCount: n.requestRate,
                healthStatus: status,
              });
              samples.push({
                serviceId: sId,
                simulationStep: 2,
                timestamp: new Date(),
                latency: elevatedLat,
                errorRate,
                requestCount: n.requestRate,
                healthStatus: status,
              });
            } else {
              currentStates.set(sId, { status: "HEALTHY", latency: n.baselineLatency, errorRate: n.baselineErrorRate });
            }
          }

          return { incidentId: id, graph, telemetrySamples: samples, currentServiceStates: currentStates };
        },
        expected: {
          expectedClassification: "DEFINITIVE_ROOT_CAUSE",
          expectedRootCauseId: targetId,
          minConfidence: severity === "MILD" ? "LOW" : "MEDIUM",
        },
      };
    }

    case "CASCADING_OUTAGE": {
      // Pick a deep infrastructure or tier-3 node that cascades upwards
      const targetGraph = topoEntry.fn();
      const nodeIds = targetGraph.getAllNodeIds();
      // Prefer leaf nodes or nodes with highest dependents
      const nodesWithDeps = nodeIds.filter((nid) => targetGraph.getDependents(nid).length > 0);
      const originId = nodesWithDeps.length > 0 ? prng.pick(nodesWithDeps) : prng.pick(nodeIds);
      const originNode = targetGraph.getNode(originId)!;

      return {
        id,
        name: `Cascading Outage via ${originNode.name}`,
        description: `Failure on ${originNode.name} cascades upward to ${targetGraph.getDependents(originId).length} direct callers.`,
        category: "CASCADING_OUTAGE",
        getInput: () => {
          const graph = topoEntry.fn();
          const dependents = graph.findImpactedDependents(originId);
          const affectedIds = new Set([originId, ...dependents.map((d) => d.serviceId)]);
          const samples = generateBaselineTelemetry(graph, 3, prng).filter(
            (s) => !affectedIds.has(s.serviceId) || s.simulationStep === 0
          );
          const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>();

          // Origin fails at step 1
          const originLat = Math.round(originNode.baselineLatency * prng.nextFloat(25.0, 60.0));
          const originErr = prng.nextFloat(40.0, 90.0);
          currentStates.set(originId, { status: "DOWN", latency: originLat, errorRate: originErr });
          samples.push({
            serviceId: originId,
            simulationStep: 1,
            timestamp: new Date(),
            latency: originLat,
            errorRate: originErr,
            requestCount: originNode.requestRate,
            healthStatus: "DOWN",
          });

          // Dependents fail at step 2 or 3 based on depth
          for (const step of dependents) {
            const depNode = graph.getNode(step.serviceId)!;
            const depLat = Math.round(depNode.baselineLatency * prng.nextFloat(5.0, 15.0));
            const depErr = prng.nextFloat(15.0, 45.0);
            currentStates.set(step.serviceId, { status: "DEGRADED", latency: depLat, errorRate: depErr });
            samples.push({
              serviceId: step.serviceId,
              simulationStep: 1 + step.depth,
              timestamp: new Date(),
              latency: depLat,
              errorRate: depErr,
              requestCount: depNode.requestRate,
              healthStatus: "DEGRADED",
            });
          }

          // Any remaining nodes are healthy
          for (const [nid, node] of graph.getAllNodes()) {
            if (!currentStates.has(nid)) {
              currentStates.set(nid, { status: "HEALTHY", latency: node.baselineLatency, errorRate: node.baselineErrorRate });
            }
          }

          return { incidentId: id, graph, telemetrySamples: samples, currentServiceStates: currentStates };
        },
        expected: {
          expectedClassification: "DEFINITIVE_ROOT_CAUSE",
          expectedRootCauseId: originId,
          minConfidence: "HIGH",
        },
      };
    }

    case "MULTI_SERVICE_FAILURE": {
      // Two simultaneous independent failures
      const targetGraph = topoEntry.fn();
      const nodeIds = targetGraph.getAllNodeIds();
      const causeA = nodeIds[0];
      const causeB = nodeIds[nodeIds.length - 1];

      return {
        id,
        name: `Multi-Service Simultaneous Failure (${causeA} & ${causeB})`,
        description: `Two independent services experience simultaneous failures at step 1.`,
        category: "MULTI_SERVICE_FAILURE",
        getInput: () => {
          const graph = topoEntry.fn();
          const samples = generateBaselineTelemetry(graph, 3, prng).filter(
            (s) => (s.serviceId !== causeA && s.serviceId !== causeB) || s.simulationStep === 0
          );
          const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>();

          for (const [nid, node] of graph.getAllNodes()) {
            if (nid === causeA || nid === causeB) {
              const lat = Math.round(node.baselineLatency * 12.0);
              const err = 60.0;
              currentStates.set(nid, { status: "DOWN", latency: lat, errorRate: err });
              samples.push({
                serviceId: nid,
                simulationStep: 1,
                timestamp: new Date(),
                latency: lat,
                errorRate: err,
                requestCount: node.requestRate,
                healthStatus: "DOWN",
              });
            } else {
              currentStates.set(nid, { status: "HEALTHY", latency: node.baselineLatency, errorRate: node.baselineErrorRate });
            }
          }

          return { incidentId: id, graph, telemetrySamples: samples, currentServiceStates: currentStates };
        },
        expected: {
          expectedClassification: "AMBIGUOUS",
          expectedRootCauseId: null,
          acceptableRootCauseIds: [causeA, causeB],
          allowInconclusive: true,
        },
      };
    }

    case "DEPENDENCY_TIMEOUT": {
      // Callee latency surges past caller's timeout
      const targetGraph = topoEntry.fn();
      const nodeIds = targetGraph.getAllNodeIds();
      const calleeId = nodeIds.find((nid) => targetGraph.getDependents(nid).length > 0) ?? nodeIds[0];
      const callee = targetGraph.getNode(calleeId)!;
      const callerId = targetGraph.getDependents(calleeId)[0] ?? nodeIds[1];
      const caller = targetGraph.getNode(callerId)!;

      return {
        id,
        name: `Dependency Timeout: ${caller.name} waiting on ${callee.name}`,
        description: `${callee.name} latency exceeds upstream caller timeout threshold.`,
        category: "DEPENDENCY_TIMEOUT",
        getInput: () => {
          const graph = topoEntry.fn();
          const samples = generateBaselineTelemetry(graph, 3, prng).filter(
            (s) => (s.serviceId !== calleeId && s.serviceId !== callerId) || s.simulationStep === 0
          );
          const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>();

          // Callee latency jumps to 2800ms at step 1
          currentStates.set(calleeId, { status: "DEGRADED", latency: 2800, errorRate: 5.0 });
          samples.push({ serviceId: calleeId, simulationStep: 1, timestamp: new Date(), latency: 2800, errorRate: 5.0, requestCount: callee.requestRate, healthStatus: "DEGRADED" });

          // Caller times out at step 2
          currentStates.set(callerId, { status: "DEGRADED", latency: 1600, errorRate: 35.0 });
          samples.push({ serviceId: callerId, simulationStep: 2, timestamp: new Date(), latency: 1600, errorRate: 35.0, requestCount: caller.requestRate, healthStatus: "DEGRADED" });

          for (const [nid, node] of graph.getAllNodes()) {
            if (!currentStates.has(nid)) {
              currentStates.set(nid, { status: "HEALTHY", latency: node.baselineLatency, errorRate: node.baselineErrorRate });
            }
          }

          return { incidentId: id, graph, telemetrySamples: samples, currentServiceStates: currentStates };
        },
        expected: {
          expectedClassification: "DEFINITIVE_ROOT_CAUSE",
          expectedRootCauseId: calleeId,
          acceptableRootCauseIds: [calleeId, callerId],
        },
      };
    }

    case "NOISY_DATA": {
      const targetGraph = topoEntry.fn();
      const nodeIds = targetGraph.getAllNodeIds();
      const failingId = prng.pick(nodeIds);
      const isMissingTelemetry = prng.chance(0.5);

      return {
        id,
        name: `Noisy / Missing Telemetry (${isMissingTelemetry ? "Sparse Samples" : "High Jitter"})`,
        description: `Observations for failing service ${failingId} are degraded or missing.`,
        category: "NOISY_DATA",
        getInput: () => {
          const graph = topoEntry.fn();
          // Generate sparse or empty telemetry
          const samples: TelemetryPoint[] = isMissingTelemetry ? [] : generateBaselineTelemetry(graph, 2, prng);
          const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>();

          for (const [nid, node] of graph.getAllNodes()) {
            if (nid === failingId) {
              currentStates.set(nid, { status: "DEGRADED", latency: node.baselineLatency * 4, errorRate: 20.0 });
            } else {
              currentStates.set(nid, { status: "HEALTHY", latency: node.baselineLatency, errorRate: node.baselineErrorRate });
            }
          }

          return { incidentId: id, graph, telemetrySamples: samples, currentServiceStates: currentStates };
        },
        expected: {
          expectedClassification: "INCONCLUSIVE",
          expectedRootCauseId: null,
          acceptableRootCauseIds: [failingId],
          allowInconclusive: true,
        },
      };
    }

    case "CONTRADICTORY_SIGNALS": {
      const targetGraph = topoEntry.fn();
      const nodeIds = targetGraph.getAllNodeIds();
      const targetId = prng.pick(nodeIds);

      return {
        id,
        name: `Contradictory Signal on ${targetId}`,
        description: `Service state reports DOWN, but telemetry samples are strictly within baseline bounds.`,
        category: "CONTRADICTORY_SIGNALS",
        getInput: () => {
          const graph = topoEntry.fn();
          const samples = generateBaselineTelemetry(graph, 4, prng);
          const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>();

          for (const [nid, node] of graph.getAllNodes()) {
            if (nid === targetId) {
              // Contradiction: flagged DOWN, but latency is baseline
              currentStates.set(nid, { status: "DOWN", latency: node.baselineLatency, errorRate: node.baselineErrorRate });
            } else {
              currentStates.set(nid, { status: "HEALTHY", latency: node.baselineLatency, errorRate: node.baselineErrorRate });
            }
          }

          return { incidentId: id, graph, telemetrySamples: samples, currentServiceStates: currentStates };
        },
        expected: {
          expectedClassification: "AMBIGUOUS",
          expectedRootCauseId: null,
          acceptableRootCauseIds: [targetId],
          allowInconclusive: true,
        },
      };
    }

    case "TOPOLOGY_VARIATION": {
      // Tests non-standard graphs (mesh, pipeline, hub-and-spoke, cyclic) with a localized single failure
      const targetGraph = topoEntry.fn();
      const nodeIds = targetGraph.getAllNodeIds();
      const targetId = nodeIds[nodeIds.length - 1]; // Pick leaf/database
      const node = targetGraph.getNode(targetId)!;

      return {
        id,
        name: `Topology Variation: ${topoEntry.name} Failure on ${node.name}`,
        description: `Tests diagnosis engine on non-canonical ${topoEntry.name} graph structure.`,
        category: "TOPOLOGY_VARIATION",
        getInput: () => {
          const graph = topoEntry.fn();
          const samples = generateBaselineTelemetry(graph, 3, prng).filter(
            (s) => s.serviceId !== targetId || s.simulationStep === 0
          );
          const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>();

          const lat = Math.round(node.baselineLatency * 20.0);
          const err = 50.0;
          currentStates.set(targetId, { status: "DOWN", latency: lat, errorRate: err });
          samples.push({ serviceId: targetId, simulationStep: 1, timestamp: new Date(), latency: lat, errorRate: err, requestCount: node.requestRate, healthStatus: "DOWN" });

          for (const [nid, n] of graph.getAllNodes()) {
            if (nid !== targetId) {
              currentStates.set(nid, { status: "HEALTHY", latency: n.baselineLatency, errorRate: n.baselineErrorRate });
            }
          }

          return { incidentId: id, graph, telemetrySamples: samples, currentServiceStates: currentStates };
        },
        expected: {
          expectedClassification: "DEFINITIVE_ROOT_CAUSE",
          expectedRootCauseId: targetId,
          minConfidence: "HIGH",
        },
      };
    }

    case "RECOVERY_CYCLE": {
      // Simulates an incident followed by recovery samples
      return {
        id,
        name: `Recovery Cycle (${topoEntry.name})`,
        description: `Evaluates healed state after an incident has cleared.`,
        category: "RECOVERY_CYCLE",
        getInput: () => {
          const graph = topoEntry.fn();
          const samples = generateBaselineTelemetry(graph, 5, prng);
          const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>();

          for (const [nid, node] of graph.getAllNodes()) {
            currentStates.set(nid, { status: "HEALTHY", latency: node.baselineLatency, errorRate: node.baselineErrorRate });
          }

          return { incidentId: id, graph, telemetrySamples: samples, currentServiceStates: currentStates };
        },
        expected: {
          expectedClassification: "HEALTHY",
          expectedRootCauseId: null,
          allowInconclusive: true,
        },
      };
    }

    case "EDGE_CASE":
    default: {
      return {
        id,
        name: `Edge Case Variation (${topoEntry.name})`,
        description: `Uncommon failure pattern on ${topoEntry.name} topology.`,
        category: "EDGE_CASE",
        getInput: () => {
          const graph = topoEntry.fn();
          const samples = generateBaselineTelemetry(graph, 3, prng);
          const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>();
          for (const [nid, node] of graph.getAllNodes()) {
            currentStates.set(nid, { status: "HEALTHY", latency: node.baselineLatency, errorRate: node.baselineErrorRate });
          }
          return { incidentId: id, graph, telemetrySamples: samples, currentServiceStates: currentStates };
        },
        expected: {
          expectedClassification: "HEALTHY",
          expectedRootCauseId: null,
          allowInconclusive: true,
        },
      };
    }
  }
}
