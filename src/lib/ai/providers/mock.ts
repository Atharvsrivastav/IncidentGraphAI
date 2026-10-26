import { AIProvider, AIInvestigationContext, AIProviderResult, AIProviderError } from "./types";
import { InvestigationLLMOutput } from "../types";

export interface MockAIOptions {
  simulateTimeout?: boolean;
  simulateRateLimit?: boolean;
  simulateMalformedJson?: boolean;
  simulateHallucinatedEvidenceId?: boolean;
  simulateAuthFailure?: boolean;
  customLatencyMs?: number;
}

export class MockAIProvider implements AIProvider {
  public readonly providerName = "mock";
  public readonly modelName = "deterministic-mock-v1";

  private options: MockAIOptions;

  constructor(options: MockAIOptions = {}) {
    this.options = options;
  }

  public setOptions(options: MockAIOptions): void {
    this.options = { ...this.options, ...options };
  }

  public isConfigured(): boolean {
    return !this.options.simulateAuthFailure;
  }

  public async generateInvestigation(context: AIInvestigationContext): Promise<AIProviderResult> {
    const startTime = Date.now();

    if (this.options.customLatencyMs && this.options.customLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.options.customLatencyMs));
    }

    if (this.options.simulateTimeout) {
      throw new AIProviderError(
        "AI request timed out after 15000ms. Telemetry synthesis aborted.",
        "TIMEOUT",
        504
      );
    }

    if (this.options.simulateRateLimit) {
      throw new AIProviderError(
        "AI provider rate limit reached (HTTP 429). Please retry after 30 seconds.",
        "RATE_LIMITED",
        429,
        30
      );
    }

    if (this.options.simulateAuthFailure) {
      throw new AIProviderError(
        "OpenAI API key is missing or invalid. Check your OPENAI_API_KEY environment variable.",
        "AUTHENTICATION_FAILED",
        401
      );
    }

    if (this.options.simulateMalformedJson) {
      return {
        rawJson: "{ this is invalid json response from model",
        executionTimeMs: Date.now() - startTime,
      };
    }

    // Generate grounded deterministic response based on the real context
    const output = this.generateGroundedInvestigation(context);

    if (this.options.simulateHallucinatedEvidenceId) {
      // Intentionally insert a fake evidence ID for testing the grounding validator
      if (output.rankedHypotheses.length > 0) {
        output.rankedHypotheses[0].supportingEvidenceIds.push("ev_hallucinated_fake_9999");
      }
    }

    return {
      rawJson: JSON.stringify(output),
      promptTokens: 850,
      completionTokens: 420,
      totalTokens: 1270,
      executionTimeMs: Math.max(1, Date.now() - startTime),
    };
  }

  private generateGroundedInvestigation(context: AIInvestigationContext): InvestigationLLMOutput {
    const topologyMap = new Map(context.topology.map((t) => [t.id, t]));
    const evidences = context.evidences;
    const topDeterministic = context.deterministicCandidates[0];

    // Determine diagnosis status and top candidates
    const hasEvidences = evidences.length > 0;
    const candidateServices = context.deterministicCandidates.slice(0, 3);

    let diagnosisStatus: "PROBABLE_ROOT_CAUSE" | "MULTIPLE_CANDIDATES" | "INCONCLUSIVE" = "INCONCLUSIVE";
    let confidenceCategory: "HIGH" | "MEDIUM" | "LOW" | "UNCERTAIN" = "UNCERTAIN";
    let confidenceExplanation = "Telemetry signals are insufficient or ambiguous to isolate causality.";

    if (!hasEvidences || candidateServices.length === 0) {
      diagnosisStatus = "INCONCLUSIVE";
      confidenceCategory = "UNCERTAIN";
      confidenceExplanation = "No telemetry anomalies or evidence recorded for this incident window.";
    } else if (topDeterministic && topDeterministic.score >= 80) {
      diagnosisStatus = "PROBABLE_ROOT_CAUSE";
      confidenceCategory = "HIGH";
      confidenceExplanation = `Top candidate '${topDeterministic.serviceId}' exhibits primary timing precedence and overwhelming anomalous degradation (${topDeterministic.score}/100 score).`;
    } else if (candidateServices.length > 1) {
      diagnosisStatus = "MULTIPLE_CANDIDATES";
      confidenceCategory = "MEDIUM";
      confidenceExplanation = "Multiple services exhibit concurrent latency or error anomalies without a single definitive origin.";
    }

    // Build grounded hypotheses
    const rankedHypotheses = candidateServices.length > 0
      ? candidateServices.map((cand, idx) => {
          const service = topologyMap.get(cand.serviceId);
          const serviceName = service?.name ?? cand.serviceId;

          // Find genuine supporting evidence IDs for this service
          const serviceEvidences = evidences.filter((e) => e.serviceId === cand.serviceId);
          const supportingEvidenceIds = serviceEvidences.length > 0
            ? serviceEvidences.map((e) => e.id)
            : evidences.slice(0, 2).map((e) => e.id); // fallback to available evidences

          // Find contradictory evidence: signals from unrelated tiers
          const otherEvidences = evidences.filter((e) => e.serviceId !== cand.serviceId);
          const contradictoryEvidenceIds = otherEvidences
            .filter((e) => e.evidenceType === "ERROR_RATE_SPIKE" && e.serviceId !== cand.serviceId)
            .slice(0, 1)
            .map((e) => e.id);

          return {
            rank: idx + 1,
            serviceId: cand.serviceId,
            serviceName,
            hypothesis: `${serviceName} is experiencing ${cand.explanation || "severe degradation"}, causing cascading latency and connection timeouts across dependent services.`,
            supportingEvidenceIds,
            contradictingEvidenceIds: contradictoryEvidenceIds,
            confidenceCategory: idx === 0 && cand.score >= 80 ? ("HIGH" as const) : ("MEDIUM" as const),
            confidenceExplanation: `Supported by ${supportingEvidenceIds.length} telemetry breach(es) and deterministic ranking score ${cand.score}/100.`,
            blastRadius: service?.dependencies ?? [],
          };
        })
      : [
          {
            rank: 1,
            serviceId: context.topology[0]?.id ?? "unknown-service",
            serviceName: context.topology[0]?.name ?? "Unknown Service",
            hypothesis: "Unable to confirm root cause due to absence of definitive telemetry signals.",
            supportingEvidenceIds: evidences.map((e) => e.id),
            contradictingEvidenceIds: [],
            confidenceCategory: "UNCERTAIN" as const,
            confidenceExplanation: "No conclusive evidence available in this observation window.",
            blastRadius: [],
          },
        ];

    // Build diagnostic checks
    const primaryServiceId = rankedHypotheses[0]?.serviceId ?? context.topology[0]?.id ?? "system";
    const recommendedChecks = [
      {
        serviceId: primaryServiceId,
        type: "METRIC_QUERY" as const,
        description: `Execute PromQL query for container CPU saturation and memory working set on ${primaryServiceId}.`,
        expectedSignal: "CPU usage < 80%, memory usage < 85% of cgroup limit.",
      },
      {
        serviceId: primaryServiceId,
        type: "TRACE_ANALYSIS" as const,
        description: `Inspect Tempo trace waterfall for ${primaryServiceId} to verify downstream span durations and database connection pool acquire times.`,
        expectedSignal: "Span duration < 50ms with no error status code.",
      },
      {
        serviceId: primaryServiceId,
        type: "LOG_INSPECTION" as const,
        description: `Search recent application logs for ${primaryServiceId} for connection reset by peer, timeouts, or unhandled exceptions.`,
        expectedSignal: "Zero ERROR or CRITICAL log events in rolling 5m window.",
      },
    ];

    // Build safe remediation options
    const remediationOptions = [
      {
        targetServiceId: primaryServiceId,
        actionType: "CIRCUIT_BREAKER" as const,
        description: `Temporarily trip circuit breaker or lower timeout thresholds on upstream callers to isolate ${primaryServiceId} and prevent queue saturation.`,
        riskLevel: "MEDIUM" as const,
        requiresHumanApproval: true as const,
        prerequisites: "Verify that upstream callers have graceful fallback responses or cached responses configured.",
      },
      {
        targetServiceId: primaryServiceId,
        actionType: "SCALE_REPLICAS" as const,
        description: `Scale horizontal pod replicas of ${primaryServiceId} from current baseline to accommodate pending backlog.`,
        riskLevel: "LOW" as const,
        requiresHumanApproval: true as const,
        prerequisites: "Confirm backend database connection limits can support increased replica pool count.",
      },
      {
        targetServiceId: primaryServiceId,
        actionType: "MANUAL_INVESTIGATION" as const,
        description: `Open an interactive SRE shell on the staging replica of ${primaryServiceId} and inspect lock waits and thread pool stack dumps.`,
        riskLevel: "LOW" as const,
        requiresHumanApproval: true as const,
        prerequisites: "Operator must possess valid read-only diagnostic credentials.",
      },
    ];

    return {
      summary: `Automated investigation completed for '${context.incidentTitle}'. ${
        diagnosisStatus === "PROBABLE_ROOT_CAUSE"
          ? `Primary root cause isolated to '${rankedHypotheses[0]?.serviceName}' with high confidence.`
          : diagnosisStatus === "MULTIPLE_CANDIDATES"
          ? "Multiple service anomalies detected across system tiers. Immediate triage required."
          : "Incident signals are inconclusive; further telemetry collection recommended."
      }`,
      verifiedImpact: `Observed ${evidences.length} telemetry breach(es) affecting critical path services. Current severity rated ${context.severity}.`,
      diagnosisStatus,
      confidenceCategory,
      confidenceExplanation,
      rankedHypotheses,
      recommendedChecks,
      remediationOptions,
      missingEvidence: [
        "Infrastructure cgroup memory pressure metrics (OOM kill events)",
        "Database active lock contention and slow query log exports",
      ],
      nextObservations: [
        "Monitor p95 latency on API Gateway over the next 15 minutes",
        "Observe downstream queue depth and HTTP 5xx error rate stabilization",
      ],
    };
  }
}
