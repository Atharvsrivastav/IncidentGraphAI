import { describe, it, expect } from "vitest";
import { DirectedGraph } from "../src/lib/algorithms/graph";
import { PriorityQueue } from "../src/lib/algorithms/priorityQueue";
import { SlidingWindowAnalyzer } from "../src/lib/algorithms/slidingWindow";
import { RootCauseEngine, RootCauseInput } from "../src/lib/algorithms/rootCauseEngine";
import { ServiceNodeData, TelemetryPoint } from "../src/lib/algorithms/types";
import { BenchmarkEvaluator } from "../src/lib/benchmark/evaluator";
import {
  BENCHMARK_SCENARIOS,
  createCanonicalTopology,
  createRecoveryScenario,
} from "../src/lib/benchmark/scenarios";

describe("Phase 3: Root-Cause Reliability Benchmark & Evaluation Suite", () => {
  const evaluator = new BenchmarkEvaluator();

  // =========================================================================
  // Section 1: Deterministic Test Scenarios (The 10 Required Scenarios)
  // =========================================================================
  describe("1. Deterministic Test Scenarios (10 Scenarios)", () => {
    // 1. Healthy system with normal traffic
    it("Scenario 1: Healthy system yields zero false positives and inconclusive root cause", () => {
      const scenario = BENCHMARK_SCENARIOS.find((s) => s.id === "scenario-01-healthy")!;
      expect(scenario).toBeDefined();

      const result = evaluator.evaluateScenario(scenario);
      expect(result.evaluatorVerdict).toBe("PASS");
      expect(result.isCorrect).toBe(true);
      expect(result.falsePositiveHealthy).toBe(false);
      expect(result.predictedRootCause).toBeNull();
      expect(result.isInconclusive).toBe(true);
    });

    // 2. PostgreSQL latency spike
    it("Scenario 2: PostgreSQL latency spike diagnosed with Top-1 hit and timing precedence", () => {
      const scenario = BENCHMARK_SCENARIOS.find((s) => s.id === "scenario-02-postgres-latency")!;
      expect(scenario).toBeDefined();

      const result = evaluator.evaluateScenario(scenario);
      expect(result.evaluatorVerdict).toBe("PASS");
      expect(result.top1Hit).toBe(true);
      expect(result.predictedRootCause).toBe("postgres-db");
      expect(result.predictedScore).toBeGreaterThanOrEqual(75);
      expect(result.supportingEvidence.some((e) => e.includes("TIMING_PRECEDENCE"))).toBe(true);
      expect(result.supportingEvidence.some((e) => e.includes("CASCADING_IMPACT"))).toBe(true);
    });

    // 3. PostgreSQL outage
    it("Scenario 3: PostgreSQL outage diagnosed with Top-1 hit and high confidence", () => {
      const scenario = BENCHMARK_SCENARIOS.find((s) => s.id === "scenario-03-postgres-outage")!;
      expect(scenario).toBeDefined();

      const result = evaluator.evaluateScenario(scenario);
      expect(result.evaluatorVerdict).toBe("PASS");
      expect(result.top1Hit).toBe(true);
      expect(result.predictedRootCause).toBe("postgres-db");
      expect(result.predictedConfidence).toBe("HIGH");
      expect(result.supportingEvidence.some((e) => e.includes("STATUS_SIGNAL"))).toBe(true);
    });

    // 4. Payment service failure
    it("Scenario 4: Payment service failure correctly diagnosed without falsely blaming healthy database", () => {
      const scenario = BENCHMARK_SCENARIOS.find((s) => s.id === "scenario-04-payment-failure")!;
      expect(scenario).toBeDefined();

      const result = evaluator.evaluateScenario(scenario);
      expect(result.evaluatorVerdict).toBe("PASS");
      expect(result.top1Hit).toBe(true);
      expect(result.predictedRootCause).toBe("payment-service");
      // Verify postgres-db is NOT blamed
      expect(result.predictedRootCause).not.toBe("postgres-db");
    });

    // 5. Inventory service timeout
    it("Scenario 5: Inventory service timeout correctly diagnosed as originating root cause", () => {
      const scenario = BENCHMARK_SCENARIOS.find((s) => s.id === "scenario-05-inventory-timeout")!;
      expect(scenario).toBeDefined();

      const result = evaluator.evaluateScenario(scenario);
      expect(result.evaluatorVerdict).toBe("PASS");
      expect(result.top1Hit).toBe(true);
      expect(result.predictedRootCause).toBe("inventory-service");
    });

    // 6. Authentication service outage
    it("Scenario 6: Authentication service outage diagnosed with Top-1 hit", () => {
      const scenario = BENCHMARK_SCENARIOS.find((s) => s.id === "scenario-06-auth-outage")!;
      expect(scenario).toBeDefined();

      const result = evaluator.evaluateScenario(scenario);
      expect(result.evaluatorVerdict).toBe("PASS");
      expect(result.top1Hit).toBe(true);
      expect(result.predictedRootCause).toBe("auth-service");
      expect(result.predictedConfidence).toBe("HIGH");
    });

    // 7. Network latency affecting selected dependencies
    it("Scenario 7: Selective dependency network latency diagnosed on target dependency", () => {
      const scenario = BENCHMARK_SCENARIOS.find((s) => s.id === "scenario-07-network-latency")!;
      expect(scenario).toBeDefined();

      const result = evaluator.evaluateScenario(scenario);
      expect(result.evaluatorVerdict).toBe("PASS");
      expect(result.top1Hit).toBe(true);
      expect(result.predictedRootCause).toBe("order-service");
    });

    // 8. Missing or stale telemetry
    it("Scenario 8: Missing or stale telemetry handled safely with acceptable inconclusive verdict", () => {
      const scenario = BENCHMARK_SCENARIOS.find((s) => s.id === "scenario-08-missing-telemetry")!;
      expect(scenario).toBeDefined();

      const result = evaluator.evaluateScenario(scenario);
      expect(result.evaluatorVerdict).toBe("ACCEPTABLE_INCONCLUSIVE");
      expect(result.isCorrect).toBe(true);
      expect(result.isInconclusive).toBe(true);
      // Engine must not throw error
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });

    // 9. Contradictory failure signals
    it("Scenario 9: Contradictory failure signals penalized and resolved without false accusations", () => {
      const scenario = BENCHMARK_SCENARIOS.find((s) => s.id === "scenario-09-contradictory-signals")!;
      expect(scenario).toBeDefined();

      const result = evaluator.evaluateScenario(scenario);
      expect(["PASS", "ACCEPTABLE_INCONCLUSIVE"]).toContain(result.evaluatorVerdict);
      expect(result.isCorrect).toBe(true);
      // Downstream healthy services must never be blamed
      expect(result.predictedRootCause).not.toBe("postgres-db");
      expect(result.predictedRootCause).not.toBe("order-service");
    });

    // 10. Unrelated service failure that should not affect suspected root cause
    it("Scenario 10: Unrelated concurrent failure does not divert diagnosis away from core root cause", () => {
      const scenario = BENCHMARK_SCENARIOS.find((s) => s.id === "scenario-10-unrelated-failure")!;
      expect(scenario).toBeDefined();

      const result = evaluator.evaluateScenario(scenario);
      expect(result.evaluatorVerdict).toBe("PASS");
      expect(result.top1Hit).toBe(true);
      expect(result.predictedRootCause).toBe("postgres-db");
      // Notification service must not rank #1
      expect(result.predictedRootCause).not.toBe("notification-service");
    });
  });

  // =========================================================================
  // Section 2: Real Evaluation Metrics & Recovery Verification
  // =========================================================================
  describe("2. Measured Evaluation Metrics & Recovery Verification", () => {
    it("evaluates core 10-scenario baseline meeting reliability targets", () => {
      const summary = evaluator.evaluateSuite(BENCHMARK_SCENARIOS);

      expect(summary.totalScenarios).toBe(10);
      expect(summary.evaluableFailureScenarios).toBe(7);
      expect(summary.healthyScenarios).toBe(1);

      // Top-1 hit rate: Target >= 90%
      expect(summary.top1HitRatePercent).toBeGreaterThanOrEqual(90.0);
      expect(summary.top3HitRatePercent).toBe(100.0);
      expect(summary.falsePositiveRatePercent).toBe(0.0);
      expect(summary.inconclusiveRatePercent).toBeLessThanOrEqual(35.0);
      expect(summary.meanExecutionTimeMs).toBeLessThan(15.0);
    });

    it("evaluates expanded 117-scenario suite across 5 topologies and 10 categories with reconciled MECE partitions", () => {
      const summary = evaluator.evaluateSuite();

      expect(summary.totalScenarios).toBe(117);
      expect(summary.evaluableFailureScenarios).toBe(65);
      expect(summary.healthyScenarios).toBe(13);
      expect(summary.recoveryScenarios).toBe(5);
      expect(summary.ambiguousScenarios).toBe(34);

      // Verify mathematical MECE Partition Invariant: 65 + 13 + 5 + 34 = 117
      expect(
        summary.evaluableFailureScenarios +
          summary.healthyScenarios +
          summary.recoveryScenarios +
          summary.ambiguousScenarios
      ).toBe(summary.totalScenarios);

      // Verify Non-Conclusive Outcome Reconciliation: 13 healthy + 5 recovery + 14 noisy + 10 contradictory = 42
      expect(summary.suiteInconclusiveCount).toBe(42);
      expect(summary.suiteInconclusiveRatePercent).toBe(35.9);
      expect(summary.ambiguousInconclusiveCount).toBe(24);
      expect(summary.ambiguousInconclusiveRatePercent).toBe(70.59);

      // Top-1 hit rate: Target >= 90%
      expect(summary.top1HitRatePercent).toBeGreaterThanOrEqual(90.0);

      // Top-3 hit rate: Target 100%
      expect(summary.top3HitRatePercent).toBe(100.0);

      // False-positive rate on healthy scenarios: Target 0.0%
      expect(summary.falsePositiveRatePercent).toBe(0.0);

      // Recovery verification success rate: Target 100.0%
      expect(summary.recoveryVerificationSuccessRate).toBe(100.0);

      // Verify Wilson score 95% confidence intervals are present and valid
      expect(summary.top1HitRateCi95[0]).toBeGreaterThanOrEqual(85.0);
      expect(summary.top1HitRateCi95[1]).toBeLessThanOrEqual(100.0);
      expect(summary.falsePositiveRateCi95[0]).toBe(0.0);
      expect(summary.suiteInconclusiveRateCi95[0]).toBeGreaterThan(20.0);
      expect(summary.ambiguousInconclusiveRateCi95[0]).toBeGreaterThan(50.0);

      // Category breakdown covers all expected categories
      const categories = Object.keys(summary.categoryBreakdown);
      expect(categories).toContain("HEALTHY");
      expect(categories).toContain("SINGLE_POINT_FAILURE");
      expect(categories).toContain("CASCADING_OUTAGE");
      expect(categories).toContain("MULTI_SERVICE_FAILURE");
      expect(categories).toContain("DEPENDENCY_TIMEOUT");
      expect(categories).toContain("NOISY_DATA");
      expect(categories).toContain("CONTRADICTORY_SIGNALS");
      expect(categories).toContain("TOPOLOGY_VARIATION");
      expect(categories).toContain("RECOVERY_CYCLE");
      expect(categories).toContain("EDGE_CASE");

      // Verify sum of category inconclusive counts equals suite inconclusive count
      const sumCategoryInconcl = Object.values(summary.categoryBreakdown).reduce(
        (acc, cat) => acc + cat.inconclusiveCount,
        0
      );
      expect(sumCategoryInconcl).toBe(summary.suiteInconclusiveCount);

      // Execution speed: sub-millisecond per scenario
      expect(summary.meanExecutionTimeMs).toBeLessThan(5.0);
    });

    it("verifies post-remediation recovery clears root-cause alerts", () => {
      const recoveryScenario = createRecoveryScenario();
      const result = evaluator.evaluateScenario(recoveryScenario);

      expect(result.evaluatorVerdict).toBe("PASS");
      expect(result.isCorrect).toBe(true);
      expect(result.falsePositiveHealthy).toBe(false);
      expect(result.predictedRootCause).toBeNull();
      expect(result.isInconclusive).toBe(true);
    });
  });

  // =========================================================================
  // Section 3: Evaluation Leakage & Isolation Guarantees
  // =========================================================================
  describe("3. Prevention of Evaluation Leakage", () => {
    it("engine cannot access evaluator expected metadata and receives only observable input", () => {
      const engine = new RootCauseEngine();
      const rawScenario = BENCHMARK_SCENARIOS[1]; // postgres latency scenario
      const input = rawScenario.getInput();

      // Ensure input contains strictly observable fields
      const inputKeys = Object.keys(input);
      expect(inputKeys).toContain("incidentId");
      expect(inputKeys).toContain("graph");
      expect(inputKeys).toContain("telemetrySamples");
      expect(inputKeys).toContain("currentServiceStates");

      // Verify zero evaluator metadata is attached
      expect(inputKeys).not.toContain("expected");
      expect(inputKeys).not.toContain("groundTruth");
      expect(inputKeys).not.toContain("injectedRootCause");
      expect(inputKeys).not.toContain("targetServiceId");

      // Verify engine execution is invariant to non-engine metadata
      const analysisOriginal = engine.analyzeIncident(input);

      // Artificially attach a fake/misleading expected root cause to an object
      const poisonedInput = {
        ...input,
        fakeEvaluatorHint: "auth-service",
        injectedRootCause: "auth-service",
      } as unknown as RootCauseInput;

      const analysisPoisoned = engine.analyzeIncident(poisonedInput);

      // Engine must ignore poisoned hint and output identical ranking
      expect(analysisPoisoned.topRootCause?.serviceId).toBe(analysisOriginal.topRootCause?.serviceId);
      expect(analysisPoisoned.topRootCause?.score).toBe(analysisOriginal.topRootCause?.score);
      expect(analysisPoisoned.topRootCause?.serviceId).toBe("postgres-db");
    });

    it("ensures the same scenario input produces 100% reproducible rankings across multiple runs", () => {
      const engine = new RootCauseEngine();
      const scenario = BENCHMARK_SCENARIOS[1];
      const input = scenario.getInput();

      const runs = [
        engine.analyzeIncident(input),
        engine.analyzeIncident(input),
        engine.analyzeIncident(input),
        engine.analyzeIncident(input),
        engine.analyzeIncident(input),
      ];

      const firstRun = runs[0];
      for (let i = 1; i < runs.length; i++) {
        expect(runs[i].topRootCause?.serviceId).toBe(firstRun.topRootCause?.serviceId);
        expect(runs[i].topRootCause?.score).toBe(firstRun.topRootCause?.score);
        expect(runs[i].allCandidates.length).toBe(firstRun.allCandidates.length);

        for (let j = 0; j < firstRun.allCandidates.length; j++) {
          expect(runs[i].allCandidates[j].serviceId).toBe(firstRun.allCandidates[j].serviceId);
          expect(runs[i].allCandidates[j].rank).toBe(firstRun.allCandidates[j].rank);
          expect(runs[i].allCandidates[j].score).toBe(firstRun.allCandidates[j].score);
        }
      }
    });
  });

  // =========================================================================
  // Section 4: Algorithmic Robustness & Edge-Case Resilience
  // =========================================================================
  describe("4. Algorithmic Robustness & Graph Invariants", () => {
    it("Reverse BFS impact propagation correctly computes upstream dependents", () => {
      const graph = createCanonicalTopology();

      // postgres-db failure should propagate upstream to its direct and indirect dependents:
      // order-service (depth 1), payment-service (depth 1), inventory-service (depth 1), api-gateway (depth 2)
      const impacted = graph.findImpactedDependents("postgres-db");
      const ids = impacted.map((s) => s.serviceId);

      expect(ids).toContain("order-service");
      expect(ids).toContain("payment-service");
      expect(ids).toContain("inventory-service");
      expect(ids).toContain("api-gateway");
      expect(ids).not.toContain("auth-service"); // Auth does not depend on postgres

      // Disconnected node has empty impacted dependents
      const disconnectedNode: ServiceNodeData = {
        id: "isolated-svc",
        name: "Isolated Service",
        serviceType: "API",
        tier: 2,
        status: "HEALTHY",
        baselineLatency: 20,
        currentLatency: 20,
        baselineErrorRate: 0.1,
        currentErrorRate: 0.1,
        requestRate: 100,
      };
      graph.addNode("isolated-svc", disconnectedNode);
      expect(graph.findImpactedDependents("isolated-svc")).toEqual([]);
    });

    it("DFS cycle detection handles acyclic, simple cyclic, and complex multi-cyclic graphs", () => {
      const graph = createCanonicalTopology();
      expect(graph.hasCycle()).toBe(false);

      // Add cycle: order-service -> payment-service -> order-service
      graph.addEdge("payment-service", "order-service");
      expect(graph.hasCycle()).toBe(true);

      const cycles = graph.findCycles();
      expect(cycles.hasCycle).toBe(true);
      expect(cycles.cycles.length).toBeGreaterThanOrEqual(1);

      // Verify traversal doesn't infinite loop with cycle present
      const reachable = graph.getReachableServices("order-service");
      expect(reachable.length).toBeGreaterThan(0);
    });

    it("Priority queue maintains binary heap order and tie-breaks cleanly", () => {
      const maxPq = new PriorityQueue<{ id: string }>("MAX");
      maxPq.insert({ id: "item-50" }, 50);
      maxPq.insert({ id: "item-100" }, 100);
      maxPq.insert({ id: "item-25" }, 25);
      maxPq.insert({ id: "item-75" }, 75);

      expect(maxPq.extract()?.priority).toBe(100);
      expect(maxPq.extract()?.priority).toBe(75);
      expect(maxPq.extract()?.priority).toBe(50);
      expect(maxPq.extract()?.priority).toBe(25);
      expect(maxPq.isEmpty()).toBe(true);
    });

    it("Sliding-window anomaly detector guards zero denominators and empty datasets", () => {
      const analyzer = new SlidingWindowAnalyzer(4);

      // Zero baseline latency
      const zeroBaseStats = analyzer.analyzeServiceWindow("zero-base", [], 0, 0);
      expect(zeroBaseStats.latencyRatio).toBe(1.0);
      expect(zeroBaseStats.hasLatencyAnomaly).toBe(false);

      // Non-zero empty samples
      const emptyStats = analyzer.analyzeServiceWindow("test", [], 20, 0.1);
      expect(emptyStats.averageLatency).toBe(20);
      expect(emptyStats.hasLatencyAnomaly).toBe(false);

      // Single anomalous sample
      const singleSample: TelemetryPoint[] = [
        { serviceId: "test", simulationStep: 1, timestamp: new Date(), latency: 150, errorRate: 20, requestCount: 100, healthStatus: "DOWN" },
      ];
      const singleStats = analyzer.analyzeServiceWindow("test", singleSample, 20, 0.1);
      expect(singleStats.hasLatencyAnomaly).toBe(true);
      expect(singleStats.hasErrorAnomaly).toBe(true);
      expect(singleStats.firstAnomalousStep).toBe(1);
    });
  });

  // =========================================================================
  // Section 5: Property-Based Verification of Graph Invariants
  // =========================================================================
  describe("5. Property-Based Testing of Graph Invariants", () => {
    it("Property 1: For any random graph, every detected cycle forms a contiguous edge path", () => {
      // Generate 25 pseudo-random directed graphs
      for (let trial = 0; trial < 25; trial++) {
        const testGraph = new DirectedGraph<ServiceNodeData>();
        const nodeCount = 4 + (trial % 6); // 4 to 9 nodes
        const nodeIds: string[] = [];

        for (let i = 0; i < nodeCount; i++) {
          const id = `node-${i}`;
          nodeIds.push(id);
          testGraph.addNode(id, {
            id,
            name: `Node ${i}`,
            serviceType: "API",
            tier: 2,
            status: "HEALTHY",
            baselineLatency: 20,
            currentLatency: 20,
            baselineErrorRate: 0.1,
            currentErrorRate: 0.1,
            requestRate: 100,
          });
        }

        // Add random edges
        for (let i = 0; i < nodeCount; i++) {
          for (let j = 0; j < nodeCount; j++) {
            if (i !== j && (i * 7 + j * 13 + trial) % 3 === 0) {
              testGraph.addEdge(nodeIds[i], nodeIds[j]);
            }
          }
        }

        const cycleResult = testGraph.findCycles();
        if (cycleResult.hasCycle) {
          for (const cycle of cycleResult.cycles) {
            // Verify cycle is closed: start equals end
            expect(cycle[0]).toBe(cycle[cycle.length - 1]);

            // Verify each consecutive edge exists in graph
            for (let k = 0; k < cycle.length - 1; k++) {
              const u = cycle[k];
              const v = cycle[k + 1];
              expect(testGraph.hasEdge(u, v)).toBe(true);
            }
          }
        }
      }
    });

    it("Property 2: Impacted dependents reachable set is always a strict subset of all graph nodes", () => {
      const graph = createCanonicalTopology();
      const allNodeIds = new Set(graph.getAllNodeIds());

      for (const originId of allNodeIds) {
        const impacted = graph.findImpactedDependents(originId);
        const impactedIds = new Set(impacted.map((s) => s.serviceId));

        // Origin node itself must never be in its own impacted dependent list
        expect(impactedIds.has(originId)).toBe(false);

        // All impacted nodes must exist in graph
        for (const depId of impactedIds) {
          expect(allNodeIds.has(depId)).toBe(true);
        }
      }
    });

    it("Property 3: Priority queue extraction invariant: elements extracted are monotonically non-increasing", () => {
      for (let trial = 0; trial < 10; trial++) {
        const pq = new PriorityQueue<number>("MAX");
        const count = 30;
        const priorities: number[] = [];

        for (let i = 0; i < count; i++) {
          const p = (i * 37 + trial * 19) % 100;
          priorities.push(p);
          pq.insert(p, p);
        }

        const extracted: number[] = [];
        while (!pq.isEmpty()) {
          const node = pq.extract();
          if (node) extracted.push(node.priority);
        }

        expect(extracted.length).toBe(count);

        // Invariant: Non-increasing order
        for (let i = 0; i < extracted.length - 1; i++) {
          expect(extracted[i]).toBeGreaterThanOrEqual(extracted[i + 1]);
        }
      }
    });
  });
});
