import { DirectedGraph } from "../algorithms/graph";
import {
  ServiceNodeData,
  TelemetryPoint,
} from "../algorithms/types";

/**
 * Expected evaluation outcome for a benchmark scenario.
 * Strictly isolated from the root-cause engine to prevent data leakage.
 */
export interface EvaluationExpectation {
  /**
   * Expected diagnosis category.
   * - HEALTHY: System operates normally; engine must NOT report a conclusive root cause.
   * - DEFINITIVE_ROOT_CAUSE: A single originating service failure must be identified.
   * - INCONCLUSIVE: Telemetry is absent, stale, or contradictory; inconclusive diagnosis is legitimate.
   * - AMBIGUOUS: Multiple valid candidate services could explain the failure.
   */
  expectedClassification: "HEALTHY" | "DEFINITIVE_ROOT_CAUSE" | "INCONCLUSIVE" | "AMBIGUOUS";

  /**
   * Designated originating root-cause service ID (null for HEALTHY or INCONCLUSIVE).
   */
  expectedRootCauseId: string | null;

  /**
   * Optional acceptable root-cause IDs when ambiguity or multi-cause failures exist.
   */
  acceptableRootCauseIds?: string[];

  /**
   * If true, an inconclusive verdict is considered valid (e.g., missing data or ambiguous signals).
   */
  allowInconclusive?: boolean;

  /**
   * Minimum confidence expected if conclusive (e.g., "HIGH" | "MEDIUM").
   */
  minConfidence?: "HIGH" | "MEDIUM" | "LOW" | "INCONCLUSIVE";

  /**
   * Downstream services expected to be impacted by this root cause.
   */
  expectedDownstreamImpacted?: string[];
}

export type ScenarioCategory =
  | "HEALTHY"
  | "SINGLE_POINT_FAILURE"
  | "CASCADING_OUTAGE"
  | "MULTI_SERVICE_FAILURE"
  | "DEPENDENCY_TIMEOUT"
  | "NOISY_DATA"
  | "CONTRADICTORY_SIGNALS"
  | "TOPOLOGY_VARIATION"
  | "RECOVERY_CYCLE"
  | "EDGE_CASE";

/**
 * Deterministic benchmark scenario specification.
 */
export interface BenchmarkScenario {
  id: string;
  name: string;
  description: string;
  category: ScenarioCategory;

  /**
   * Factory returning observable inputs for the diagnosis engine.
   * The returned object MUST NOT contain any ground-truth fields.
   */
  getInput: () => {
    incidentId: string;
    graph: DirectedGraph<ServiceNodeData>;
    telemetrySamples: TelemetryPoint[];
    currentServiceStates: Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>;
  };

  /**
   * Ground-truth evaluation metadata. Used solely by the independent test evaluator.
   */
  expected: EvaluationExpectation;
}

/**
 * Outcome of evaluating a single scenario against the engine's prediction.
 */
export interface ScenarioEvaluationResult {
  scenarioId: string;
  scenarioName: string;
  category: ScenarioCategory;
  executionTimeMs: number;
  top1Hit: boolean;
  top3Hit: boolean;
  falsePositiveHealthy: boolean;
  isInconclusive: boolean;
  isCorrect: boolean;
  predictedRootCause: string | null;
  predictedScore: number;
  predictedConfidence: "HIGH" | "MEDIUM" | "LOW" | "INCONCLUSIVE";
  expectedRootCause: string | null;
  allCandidates: { serviceId: string; rank: number; score: number }[];
  supportingEvidence: string[];
  contradictoryEvidence: string[];
  evaluatorVerdict: "PASS" | "FAIL" | "ACCEPTABLE_INCONCLUSIVE";
  notes: string;
}

export interface CategoryPerformanceMetrics {
  category: ScenarioCategory;
  totalScenarios: number;
  evaluableFailures: number;
  healthyCases: number;
  recoveryCases: number;
  ambiguousCases: number;
  top1Hits: number;
  top3Hits: number;
  inconclusiveCount: number;
  top1HitRatePercent: number;
  top3HitRatePercent: number;
  passRatePercent: number;
  meanExecutionTimeMs: number;
}

/**
 * Aggregated reliability and accuracy metrics for the benchmark suite.
 */
export interface BenchmarkSuiteSummary {
  timestamp: string;
  seed: number;
  totalScenarios: number;

  // Reconciled MECE scenario partition:
  // evaluableFailureScenarios (65) + healthyScenarios (13) + recoveryScenarios (5) + ambiguousScenarios (34) = 117
  evaluableFailureScenarios: number;
  healthyScenarios: number;
  recoveryScenarios: number;
  ambiguousScenarios: number;

  /**
   * Top-1 Hit Rate (%) = (Hits@1 / evaluableFailureScenarios) * 100
   */
  top1HitRatePercent: number;
  top1HitRateCi95: [number, number]; // Wilson score 95% confidence interval [lower, upper]

  /**
   * Top-3 Hit Rate (%) = (Hits@3 / evaluableFailureScenarios) * 100
   */
  top3HitRatePercent: number;
  top3HitRateCi95: [number, number];

  /**
   * False-Positive Rate on Healthy Scenarios (%) = (FalsePositives / healthyScenarios) * 100
   */
  falsePositiveRatePercent: number;
  falsePositiveRateCi95: [number, number];

  /**
   * Suite-wide Non-Conclusive Count (42 out of 117):
   * 13 healthy + 5 recovery + 14 noisy + 10 contradictory signals.
   */
  suiteInconclusiveCount: number;
  suiteInconclusiveRatePercent: number;
  suiteInconclusiveRateCi95: [number, number];

  /**
   * Inconclusive Count on Ambiguous/Perturbed Incident Scenarios (24 out of 34):
   * 14 noisy telemetry + 10 contradictory signals.
   */
  ambiguousInconclusiveCount: number;
  ambiguousInconclusiveRatePercent: number;
  ambiguousInconclusiveRateCi95: [number, number];

  /**
   * Backward-compatible alias for suiteInconclusiveRatePercent.
   */
  inconclusiveRatePercent: number;

  /**
   * Backward-compatible alias for ambiguousScenarios.
   */
  ambiguousOrInconclusiveScenarios: number;

  /**
   * Execution time statistics in milliseconds.
   */
  meanExecutionTimeMs: number;
  medianExecutionTimeMs: number;
  p95ExecutionTimeMs: number;
  minExecutionTimeMs: number;
  maxExecutionTimeMs: number;

  /**
   * Recovery verification results: percentage of healed states correctly identified as healthy.
   */
  recoveryVerificationSuccessRate: number;
  recoveryVerificationCi95: [number, number];

  /**
   * Performance broken down by failure/resilience category.
   */
  categoryBreakdown: Record<string, CategoryPerformanceMetrics>;

  /**
   * Case study examples for qualitative analysis.
   */
  caseStudies: {
    correctExamples: ScenarioEvaluationResult[];
    misclassifiedExamples: ScenarioEvaluationResult[];
    inconclusiveExamples: ScenarioEvaluationResult[];
  };

  scenarioResults: ScenarioEvaluationResult[];
}
