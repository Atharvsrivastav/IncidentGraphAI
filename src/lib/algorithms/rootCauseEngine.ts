import { DirectedGraph } from "./graph";
import { PriorityQueue } from "./priorityQueue";
import { SlidingWindowAnalyzer } from "./slidingWindow";
import {
  IncidentAnalysisSummary,
  RootCauseCandidateResult,
  RootCauseEvidenceDetail,
  ContradictoryEvidenceDetail,
  ServiceNodeData,
  TelemetryPoint,
  TraversalStep,
} from "./types";

export interface RootCauseInput {
  incidentId: string;
  graph: DirectedGraph<ServiceNodeData>;
  telemetrySamples: TelemetryPoint[];
  currentServiceStates: Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN"; latency: number; errorRate: number }>;
}

/**
 * Deterministic, Explainable Root-Cause Ranking Engine
 *
 * Infers originating failures strictly from graph topology, temporal anomaly onset,
 * threshold breaches, and cascading reverse-dependency paths.
 *
 * CRITICAL RULE: Never reads or peeks at simulator hidden injected ground truth.
 */
export class RootCauseEngine {
  private windowAnalyzer: SlidingWindowAnalyzer;

  constructor(windowSize: number = 6) {
    this.windowAnalyzer = new SlidingWindowAnalyzer(windowSize);
  }

  public analyzeIncident(input: RootCauseInput): IncidentAnalysisSummary {
    const startTime = performance.now();
    const { incidentId, graph, telemetrySamples, currentServiceStates } = input;

    // Index telemetry samples by serviceId
    const telemetryByService = new Map<string, TelemetryPoint[]>();
    for (const sample of telemetrySamples) {
      const list = telemetryByService.get(sample.serviceId) ?? [];
      list.push(sample);
      telemetryByService.set(sample.serviceId, list);
    }

    // Build baseline lookup from graph nodes
    const baselines = new Map<string, { latency: number; errorRate: number }>();
    for (const [id, node] of graph.getAllNodes()) {
      baselines.set(id, { latency: node.baselineLatency, errorRate: node.baselineErrorRate });
    }

    // Compute sliding window metrics for each service
    const windowMetrics = this.windowAnalyzer.analyzeAllServices(telemetryByService, baselines);

    // Identify all services that exhibit symptoms (status degraded/down or telemetry anomalies)
    // UNKNOWN status alone without confirmed metric anomaly does NOT establish symptoms
    const symptomaticServiceIds = new Set<string>();
    for (const [id, state] of currentServiceStates.entries()) {
      const metrics = windowMetrics.get(id);
      if (
        state.status === "DOWN" ||
        state.status === "DEGRADED" ||
        (metrics && (metrics.hasLatencyAnomaly || metrics.hasErrorAnomaly))
      ) {
        symptomaticServiceIds.add(id);
      }
    }

    // If no symptomatic services are detected or insufficient data, return an inconclusive analysis
    if (symptomaticServiceIds.size === 0) {
      return this.buildInconclusiveSummary(incidentId, startTime);
    }

    // Find earliest anomalous step across all services for temporal precedence evaluation
    let minAnomalousStep = Number.MAX_SAFE_INTEGER;
    for (const metrics of windowMetrics.values()) {
      if (metrics.firstAnomalousStep !== null && metrics.firstAnomalousStep < minAnomalousStep) {
        minAnomalousStep = metrics.firstAnomalousStep;
      }
    }

    // Evaluate each candidate service using our Priority Queue
    const priorityQueue = new PriorityQueue<RootCauseCandidateResult>("MAX");
    // Sort allNodeIds alphabetically to guarantee deterministic evaluation order
    const allNodeIds = graph.getAllNodeIds().sort();

    for (const serviceId of allNodeIds) {
      const candidateResult = this.evaluateCandidate(
        serviceId,
        graph,
        currentServiceStates.get(serviceId),
        windowMetrics.get(serviceId),
        symptomaticServiceIds,
        minAnomalousStep
      );

      // Insert candidate into Max-Heap prioritized by heuristic score
      priorityQueue.insert(candidateResult, candidateResult.score);
    }

    // Extract candidates in ranked order from Priority Queue
    const extractedCandidates: RootCauseCandidateResult[] = [];
    while (!priorityQueue.isEmpty()) {
      const node = priorityQueue.extract();
      if (node) {
        extractedCandidates.push(node.item);
      }
    }

    // Stable tie-breaking: Primary by score descending, secondary by serviceId ascending
    extractedCandidates.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.serviceId.localeCompare(b.serviceId);
    });

    const rankedCandidates: RootCauseCandidateResult[] = extractedCandidates.map((cand, idx) => ({
      ...cand,
      rank: idx + 1,
    }));

    const topCandidate = rankedCandidates[0] ?? null;
    const isConclusive = Boolean(
      topCandidate && topCandidate.score >= 40 && topCandidate.confidence !== "INCONCLUSIVE"
    );

    // BFS impact graph for the top suspected root cause
    const affectedServicesGraph: TraversalStep[] = topCandidate
      ? graph.findImpactedDependents(topCandidate.serviceId)
      : [];

    const executionTime = Math.round((performance.now() - startTime) * 100) / 100;

    return {
      incidentId,
      analyzedAt: new Date().toISOString(),
      totalCandidatesEvaluated: rankedCandidates.length,
      topRootCause: isConclusive ? topCandidate : null,
      allCandidates: rankedCandidates,
      affectedServicesGraph,
      isConclusive,
      algorithmExecutionTimeMs: executionTime,
    };
  }

  private evaluateCandidate(
    serviceId: string,
    graph: DirectedGraph<ServiceNodeData>,
    state: { status: "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN"; latency: number; errorRate: number } | undefined,
    metrics: ReturnType<SlidingWindowAnalyzer["analyzeServiceWindow"]> | undefined,
    symptomaticServiceIds: Set<string>,
    minAnomalousStep: number
  ): RootCauseCandidateResult {
    const node = graph.getNode(serviceId);
    const serviceName = node?.name ?? serviceId;
    const supporting: RootCauseEvidenceDetail[] = [];
    const contradictory: ContradictoryEvidenceDetail[] = [];

    let rawScore = 0;

    // 1. Service Status Signal (max 25 pts)
    if (state?.status === "DOWN") {
      supporting.push({
        type: "STATUS_SIGNAL",
        description: "Service is completely DOWN and rejecting requests.",
        weight: 25,
        scoreContribution: 25,
      });
      rawScore += 25;
    } else if (state?.status === "DEGRADED") {
      supporting.push({
        type: "STATUS_SIGNAL",
        description: "Service is running in a DEGRADED health state.",
        weight: 15,
        scoreContribution: 15,
      });
      rawScore += 15;
    }

    // 2. Telemetry Spike Thresholds (max 25 pts)
    if (metrics) {
      if (metrics.latencyRatio >= 3.0) {
        const pts = Math.min(20, Math.round(metrics.latencyRatio * 4));
        supporting.push({
          type: "TELEMETRY_SPIKE",
          description: `Severe latency surge: ${metrics.averageLatency}ms is ${metrics.latencyRatio}x baseline (${metrics.baselineLatency}ms).`,
          weight: 20,
          scoreContribution: pts,
        });
        rawScore += pts;
      } else if (metrics.latencyRatio >= 1.8) {
        supporting.push({
          type: "TELEMETRY_SPIKE",
          description: `Moderate latency elevation: ${metrics.latencyRatio}x baseline.`,
          weight: 10,
          scoreContribution: 10,
        });
        rawScore += 10;
      }

      if (metrics.errorRateDelta >= 10) {
        supporting.push({
          type: "TELEMETRY_SPIKE",
          description: `Significant error rate delta: +${metrics.errorRateDelta}% over baseline.`,
          weight: 15,
          scoreContribution: 15,
        });
        rawScore += 15;
      }
    }

    // 3. Temporal Precedence (max 25 pts)
    if (metrics?.firstAnomalousStep !== null && metrics?.firstAnomalousStep !== undefined) {
      if (metrics.firstAnomalousStep === minAnomalousStep) {
        supporting.push({
          type: "TIMING_PRECEDENCE",
          description: `Earliest abnormality onset detected at simulation step ${metrics.firstAnomalousStep}, preceding dependent services.`,
          weight: 25,
          scoreContribution: 25,
        });
        rawScore += 25;
      } else if (metrics.firstAnomalousStep === minAnomalousStep + 1) {
        supporting.push({
          type: "TIMING_PRECEDENCE",
          description: `Near-earliest anomaly onset at step ${metrics.firstAnomalousStep} (1 step after initial alert).`,
          weight: 12,
          scoreContribution: 12,
        });
        rawScore += 12;
      } else {
        contradictory.push({
          description: `Anomaly onset at step ${metrics.firstAnomalousStep} occurred after upstream symptoms began at step ${minAnomalousStep}.`,
          penalty: 15,
        });
        rawScore -= 15;
      }
    }

    // 4. Graph Topology & Cascading Reachability (max 25 pts)
    const reachableDependents = graph.findImpactedDependents(serviceId);
    let explainedSymptomCount = 0;

    for (const step of reachableDependents) {
      if (symptomaticServiceIds.has(step.serviceId)) {
        explainedSymptomCount++;
      }
    }

    if (explainedSymptomCount > 0) {
      const coverageRatio = explainedSymptomCount / Math.max(1, symptomaticServiceIds.size - (symptomaticServiceIds.has(serviceId) ? 1 : 0));
      const topoScore = Math.min(25, Math.round(coverageRatio * 25));
      supporting.push({
        type: "CASCADING_IMPACT",
        description: `Path reachability explains ${explainedSymptomCount} affected downstream dependent(s) (${Math.round(coverageRatio * 100)}% symptom coverage).`,
        weight: 25,
        scoreContribution: topoScore,
      });
      rawScore += topoScore;
    } else if (reachableDependents.length === 0 && (node?.tier ?? 1) === 1) {
      // Edge ingress service has no dependents; if down, it explains user-facing impact
      supporting.push({
        type: "GRAPH_TOPOLOGY",
        description: "Edge Gateway ingress service: Direct entry point for user traffic.",
        weight: 10,
        scoreContribution: 10,
      });
      rawScore += 10;
    }

    // Contradictory penalty if service is completely healthy
    if (state?.status === "HEALTHY" && (!metrics || (!metrics.hasLatencyAnomaly && !metrics.hasErrorAnomaly))) {
      contradictory.push({
        description: "Service metrics and health signals are completely normal and within baseline bounds.",
        penalty: 40,
      });
      rawScore -= 40;
    }

    // Contradictory signal: Service marked HEALTHY despite anomalous telemetry
    if (state?.status === "HEALTHY" && metrics && (metrics.hasLatencyAnomaly || metrics.hasErrorAnomaly)) {
      contradictory.push({
        description: "Contradictory status signal: Service is reported HEALTHY despite anomalous telemetry observations.",
        penalty: 15,
      });
      rawScore -= 15;
    }

    // Contradictory signal: Service marked DOWN/DEGRADED but telemetry is pristine
    if (
      (state?.status === "DOWN" || state?.status === "DEGRADED") &&
      metrics &&
      metrics.sampleCount >= 2 &&
      !metrics.hasLatencyAnomaly &&
      !metrics.hasErrorAnomaly
    ) {
      contradictory.push({
        description: "Contradictory telemetry signals: Service status is flagged abnormal, but sliding window metrics remain within baseline limits.",
        penalty: 15,
      });
      rawScore -= 15;
    }

    // Missing telemetry penalty on degraded/down service
    if ((state?.status === "DOWN" || state?.status === "DEGRADED") && (!metrics || metrics.sampleCount === 0)) {
      contradictory.push({
        description: "Missing telemetry: Zero metric samples recorded in the observation window.",
        penalty: 5,
      });
      rawScore -= 5;
    }

    const finalScore = Math.max(0, Math.min(100, rawScore));

    let confidence: "HIGH" | "MEDIUM" | "LOW" | "INCONCLUSIVE" = "INCONCLUSIVE";
    if (finalScore >= 75) {
      confidence = "HIGH";
    } else if (finalScore >= 50) {
      confidence = "MEDIUM";
    } else if (finalScore >= 30) {
      confidence = "LOW";
    }

    const explanation = this.generateExplanation(serviceName, finalScore, confidence, supporting, contradictory);
    const recommendedAction = this.generateRecommendedAction(serviceName, finalScore, node?.serviceType);

    return {
      serviceId,
      serviceName,
      rank: 0,
      score: finalScore,
      confidence,
      explanation,
      supportingEvidence: supporting,
      contradictoryEvidence: contradictory,
      recommendedAction,
      affectedDependentsCount: reachableDependents.length,
    };
  }

  private generateExplanation(
    name: string,
    score: number,
    confidence: string,
    supporting: RootCauseEvidenceDetail[],
    contradictory: ContradictoryEvidenceDetail[]
  ): string {
    if (score < 30 || confidence === "INCONCLUSIVE") {
      return `${name} exhibits insufficient abnormal evidence to be considered an originating root cause.`;
    }
    const topReason = supporting[0]?.description ?? "Telemetry anomalies detected.";
    const cascadeNote = supporting.find((s) => s.type === "CASCADING_IMPACT")?.description ?? "";
    const penaltyNote = contradictory.length > 0 ? ` Note: ${contradictory[0].description}` : "";

    return `${name} ranked with ${score}/100 score (${confidence} confidence). Primary signal: ${topReason} ${cascadeNote}${penaltyNote}`.trim();
  }

  private generateRecommendedAction(name: string, score: number, serviceType?: string): string {
    if (score < 40) {
      return `Monitor ${name} telemetry; unlikely to be the primary root cause.`;
    }
    if (serviceType === "DATABASE") {
      return `Inspect ${name} active connection pool, slow query logs, lock contention, and disk IOPS metrics.`;
    }
    if (serviceType === "AUTH") {
      return `Verify ${name} token issuer keys, JWKS endpoints, and identity provider latency.`;
    }
    if (serviceType === "GATEWAY") {
      return `Check ${name} upstream route configurations, ingress connection limits, and load balancer health checks.`;
    }
    return `Examine ${name} pod CPU/memory saturation, replica health, and thread dumps. Execute rollback or restart if required.`;
  }

  private buildInconclusiveSummary(incidentId: string, startTime: number): IncidentAnalysisSummary {
    return {
      incidentId,
      analyzedAt: new Date().toISOString(),
      totalCandidatesEvaluated: 0,
      topRootCause: null,
      allCandidates: [],
      affectedServicesGraph: [],
      isConclusive: false,
      algorithmExecutionTimeMs: Math.round((performance.now() - startTime) * 100) / 100,
    };
  }
}
