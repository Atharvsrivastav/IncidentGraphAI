import { AIInvestigationContext, AIProvider } from "./providers/types";
import { MockAIProvider } from "./providers/mock";
import { InvestigationLLMOutputSchema } from "./types";
import { validateAndGroundInvestigation } from "./groundingValidator";

export interface AIEvaluationTestCase {
  id: string;
  name: string;
  description: string;
  context: AIInvestigationContext;
  expectedDiagnosisStatus: "PROBABLE_ROOT_CAUSE" | "MULTIPLE_CANDIDATES" | "INCONCLUSIVE";
  expectedTopServiceId?: string;
  allowAbstention: boolean;
}

export interface AIEvaluationSummary {
  totalScenarios: number;
  schemaComplianceRate: number; // 0 - 100%
  citationValidityRate: number; // 0 - 100%
  unsupportedClaimRate: number; // 0 - 100%
  serviceGroundingRate: number; // 0 - 100%
  appropriateAbstentionRate: number; // 0 - 100%
  meanLatencyMs: number;
  totalTokensReported: number;
  scenarioResults: Array<{
    caseId: string;
    passed: boolean;
    diagnosisStatus: string;
    expectedDiagnosisStatus: string;
    citationValidity: number;
    hallucinatedEvidenceCount: number;
    latencyMs: number;
    notes: string;
  }>;
}

export const AI_EVALUATION_FIXTURES: AIEvaluationTestCase[] = [
  {
    id: "eval-01-database-latency",
    name: "Definitive PostgreSQL Storage Latency Spike",
    description: "Postgres disk contention causes cascading timeouts to order-service and api-gateway.",
    expectedDiagnosisStatus: "PROBABLE_ROOT_CAUSE",
    expectedTopServiceId: "postgres-db",
    allowAbstention: false,
    context: {
      incidentId: "inc_eval_01",
      incidentTitle: "PostgreSQL Disk I/O Saturation",
      incidentDescription: "Severe disk latency on postgres-db causing slow queries and pool exhaustion.",
      severity: "CRITICAL",
      status: "INVESTIGATING",
      startedAt: new Date(Date.now() - 600000).toISOString(),
      provenance: "SIMULATED",
      topology: [
        {
          id: "api-gateway",
          name: "API Gateway",
          serviceType: "GATEWAY",
          tier: 1,
          status: "DEGRADED",
          baselineLatency: 25,
          currentLatency: 850,
          baselineErrorRate: 0.1,
          currentErrorRate: 12.0,
          dependencies: ["order-service"],
        },
        {
          id: "order-service",
          name: "Order Service",
          serviceType: "ORDER",
          tier: 2,
          status: "DEGRADED",
          baselineLatency: 45,
          currentLatency: 780,
          baselineErrorRate: 0.2,
          currentErrorRate: 15.0,
          dependencies: ["postgres-db"],
        },
        {
          id: "postgres-db",
          name: "PostgreSQL Database",
          serviceType: "DATABASE",
          tier: 3,
          status: "DOWN",
          baselineLatency: 12,
          currentLatency: 920,
          baselineErrorRate: 0.0,
          currentErrorRate: 28.0,
          dependencies: [],
        },
      ],
      evidences: [
        {
          id: "ev_pg_lat_001",
          serviceId: "postgres-db",
          evidenceType: "LATENCY_SPIKE",
          observedValue: 920,
          expectedValue: 12,
          threshold: 50,
          unit: "ms",
          timestamp: new Date(Date.now() - 500000).toISOString(),
          explanation: "Disk I/O lock contention pushed query latency to 920ms.",
        },
        {
          id: "ev_pg_err_002",
          serviceId: "postgres-db",
          evidenceType: "ERROR_RATE_SPIKE",
          observedValue: 28,
          expectedValue: 0,
          threshold: 5,
          unit: "%",
          timestamp: new Date(Date.now() - 480000).toISOString(),
          explanation: "Client connection limit reached; rejecting queries.",
        },
        {
          id: "ev_order_lat_003",
          serviceId: "order-service",
          evidenceType: "LATENCY_SPIKE",
          observedValue: 780,
          expectedValue: 45,
          threshold: 100,
          unit: "ms",
          timestamp: new Date(Date.now() - 400000).toISOString(),
          explanation: "Downstream waiting on PostgreSQL connection acquire.",
        },
      ],
      deterministicCandidates: [
        {
          serviceId: "postgres-db",
          rank: 1,
          score: 95,
          confidence: "HIGH",
          explanation: "PostgreSQL exhibits earliest timing precedence and deepest topological dependency.",
          recommendedAction: "Inspect active lock table and kill long-running vacuum or analytical queries.",
        },
        {
          serviceId: "order-service",
          rank: 2,
          score: 55,
          confidence: "MEDIUM",
          explanation: "Order service latency is downstream symptom of database stall.",
          recommendedAction: "Increase connection acquire timeout and enable circuit breaking.",
        },
      ],
    },
  },
  {
    id: "eval-02-competing-anomalies",
    name: "Ambiguous Competing Network / Auth Anomalies",
    description: "Two independent tiers exhibit noisy latency deltas simultaneously without clear causal depth.",
    expectedDiagnosisStatus: "MULTIPLE_CANDIDATES",
    allowAbstention: true,
    context: {
      incidentId: "inc_eval_02",
      incidentTitle: "Intermittent Authentication & Inventory Latency",
      incidentDescription: "Both auth-service and inventory-service exhibit mild 10% latency fluctuations.",
      severity: "MEDIUM",
      status: "INVESTIGATING",
      startedAt: new Date(Date.now() - 300000).toISOString(),
      provenance: "SIMULATED",
      topology: [
        {
          id: "auth-service",
          name: "Auth Service",
          serviceType: "AUTH",
          tier: 2,
          status: "DEGRADED",
          baselineLatency: 30,
          currentLatency: 65,
          baselineErrorRate: 0.1,
          currentErrorRate: 2.1,
          dependencies: [],
        },
        {
          id: "inventory-service",
          name: "Inventory Service",
          serviceType: "INVENTORY",
          tier: 2,
          status: "DEGRADED",
          baselineLatency: 35,
          currentLatency: 70,
          baselineErrorRate: 0.1,
          currentErrorRate: 2.5,
          dependencies: [],
        },
      ],
      evidences: [
        {
          id: "ev_auth_01",
          serviceId: "auth-service",
          evidenceType: "LATENCY_SPIKE",
          observedValue: 65,
          expectedValue: 30,
          threshold: 60,
          unit: "ms",
          timestamp: new Date(Date.now() - 250000).toISOString(),
          explanation: "JWT verification took 65ms due to CPU throttle.",
        },
        {
          id: "ev_inv_02",
          serviceId: "inventory-service",
          evidenceType: "LATENCY_SPIKE",
          observedValue: 70,
          expectedValue: 35,
          threshold: 70,
          unit: "ms",
          timestamp: new Date(Date.now() - 245000).toISOString(),
          explanation: "Stock lookup latency slightly elevated.",
        },
      ],
      deterministicCandidates: [
        {
          serviceId: "auth-service",
          rank: 1,
          score: 52,
          confidence: "LOW",
          explanation: "Mild latency anomaly without definitive downstream impact.",
          recommendedAction: "Monitor token verification latency.",
        },
        {
          serviceId: "inventory-service",
          rank: 2,
          score: 50,
          confidence: "LOW",
          explanation: "Concurrent mild inventory latency.",
          recommendedAction: "Monitor Redis cache hit ratio.",
        },
      ],
    },
  },
  {
    id: "eval-03-healthy-baseline-abstention",
    name: "Healthy Baseline False-Alarm Abstention",
    description: "An alert fired on transient spike but all service signals are within healthy baseline.",
    expectedDiagnosisStatus: "INCONCLUSIVE",
    allowAbstention: true,
    context: {
      incidentId: "inc_eval_03",
      incidentTitle: "Transient Alert Verification",
      incidentDescription: "Ingress alert triggered but current telemetry shows 100% healthy service metrics.",
      severity: "LOW",
      status: "INVESTIGATING",
      startedAt: new Date(Date.now() - 100000).toISOString(),
      provenance: "LIVE_TELEMETRY",
      topology: [
        {
          id: "api-gateway",
          name: "API Gateway",
          serviceType: "GATEWAY",
          tier: 1,
          status: "HEALTHY",
          baselineLatency: 20,
          currentLatency: 22,
          baselineErrorRate: 0.1,
          currentErrorRate: 0.1,
          dependencies: [],
        },
      ],
      evidences: [],
      deterministicCandidates: [],
    },
  },
];

/**
 * Runs the AI evaluation fixture suite and calculates grounding and abstention metrics.
 */
export async function evaluateAIInvestigationQuality(
  provider: AIProvider = new MockAIProvider()
): Promise<AIEvaluationSummary> {
  let validCitations = 0;
  let totalCitations = 0;
  let validServiceReferences = 0;
  let totalServiceReferences = 0;
  let schemaPasses = 0;
  let correctAbstentions = 0;
  let totalAbstentionCases = 0;
  let totalExecutionTimeMs = 0;
  let totalTokens = 0;

  const scenarioResults: AIEvaluationSummary["scenarioResults"] = [];

  for (const testCase of AI_EVALUATION_FIXTURES) {
    const startTime = Date.now();
    let rawResult;
    try {
      rawResult = await provider.generateInvestigation(testCase.context);
    } catch (err: unknown) {
      scenarioResults.push({
        caseId: testCase.id,
        passed: false,
        diagnosisStatus: "ERROR",
        expectedDiagnosisStatus: testCase.expectedDiagnosisStatus,
        citationValidity: 0,
        hallucinatedEvidenceCount: 0,
        latencyMs: Date.now() - startTime,
        notes: `Provider error: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    totalExecutionTimeMs += rawResult.executionTimeMs;
    totalTokens += rawResult.totalTokens ?? 0;

    let parsedOutput;
    try {
      const rawObj = JSON.parse(rawResult.rawJson);
      parsedOutput = InvestigationLLMOutputSchema.parse(rawObj);
      schemaPasses++;
    } catch (err) {
      scenarioResults.push({
        caseId: testCase.id,
        passed: false,
        diagnosisStatus: "MALFORMED_OUTPUT",
        expectedDiagnosisStatus: testCase.expectedDiagnosisStatus,
        citationValidity: 0,
        hallucinatedEvidenceCount: 0,
        latencyMs: rawResult.executionTimeMs,
        notes: `Schema validation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const { groundingValidation, groundedReport } = validateAndGroundInvestigation(
      parsedOutput,
      testCase.context
    );

    totalCitations += groundingValidation.totalEvidenceCitations;
    validCitations += groundingValidation.validEvidenceCitations;

    for (const hyp of groundedReport.rankedHypotheses) {
      totalServiceReferences++;
      if (!groundingValidation.invalidServiceIds.includes(hyp.serviceId)) {
        validServiceReferences++;
      }
    }

    if (testCase.allowAbstention) {
      totalAbstentionCases++;
      if (
        groundedReport.diagnosisStatus === "INCONCLUSIVE" ||
        groundedReport.diagnosisStatus === "MULTIPLE_CANDIDATES"
      ) {
        correctAbstentions++;
      }
    }

    const statusMatches =
      groundedReport.diagnosisStatus === testCase.expectedDiagnosisStatus ||
      (testCase.allowAbstention &&
        (groundedReport.diagnosisStatus === "INCONCLUSIVE" ||
          groundedReport.diagnosisStatus === "MULTIPLE_CANDIDATES"));

    const casePassed =
      statusMatches &&
      groundingValidation.isFullyGrounded &&
      (!testCase.expectedTopServiceId ||
        groundedReport.rankedHypotheses[0]?.serviceId === testCase.expectedTopServiceId);

    scenarioResults.push({
      caseId: testCase.id,
      passed: casePassed,
      diagnosisStatus: groundedReport.diagnosisStatus,
      expectedDiagnosisStatus: testCase.expectedDiagnosisStatus,
      citationValidity: groundingValidation.groundingScore * 100,
      hallucinatedEvidenceCount: groundingValidation.hallucinatedEvidenceIds.length,
      latencyMs: rawResult.executionTimeMs,
      notes: casePassed ? "Passed all grounding and classification checks." : "Failed classification or grounding check.",
    });
  }

  const totalScenarios = AI_EVALUATION_FIXTURES.length;
  const citationValidityRate = totalCitations > 0 ? Number(((validCitations / totalCitations) * 100).toFixed(1)) : 100;
  const unsupportedClaimRate = totalCitations > 0 ? Number((((totalCitations - validCitations) / totalCitations) * 100).toFixed(1)) : 0;
  const serviceGroundingRate = totalServiceReferences > 0 ? Number(((validServiceReferences / totalServiceReferences) * 100).toFixed(1)) : 100;
  const schemaComplianceRate = Number(((schemaPasses / totalScenarios) * 100).toFixed(1));
  const appropriateAbstentionRate = totalAbstentionCases > 0 ? Number(((correctAbstentions / totalAbstentionCases) * 100).toFixed(1)) : 100;
  const meanLatencyMs = Number((totalExecutionTimeMs / totalScenarios).toFixed(1));

  return {
    totalScenarios,
    schemaComplianceRate,
    citationValidityRate,
    unsupportedClaimRate,
    serviceGroundingRate,
    appropriateAbstentionRate,
    meanLatencyMs,
    totalTokensReported: totalTokens,
    scenarioResults,
  };
}
