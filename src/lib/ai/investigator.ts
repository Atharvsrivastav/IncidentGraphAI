import prisma from "../db/prisma";
import { telemetryManager } from "../telemetry/telemetryManager";
import { BackendHealthStatus } from "../telemetry/types";
import { simulator } from "../simulation/simulator";
import { realRootCauseEngine } from "../algorithms/realRootCauseEngine";
import { AIProvider, AIInvestigationContext, AIProviderError } from "./providers/types";
import { getAIProvider } from "./providers/factory";
import { InvestigationLLMOutputSchema, AIInvestigationReport, TelemetryProvenance } from "./types";
import { validateAndGroundInvestigation } from "./groundingValidator";

export interface InvestigateOptions {
  provider?: AIProvider;
  forceRefresh?: boolean;
}

export function determineTelemetryProvenance(params: {
  isLiveScenario?: boolean;
  simulationScenario?: string | null;
  hasSimulationScenario?: boolean;
  isSimulationOrigin?: boolean;
  isExplicitLiveObservation?: boolean;
  requestedMode?: string;
  effectiveMode: string;
  backendHealth: {
    backendType: "GRAFANA_CLOUD" | "GENUINE_STACK" | "MOCK_EMULATION" | "UNAVAILABLE" | "SIMULATION";
    prometheusAvailable: boolean;
    jaegerAvailable: boolean;
  };
}): TelemetryProvenance {
  const { backendHealth, effectiveMode } = params;

  // 1. Identify simulation-origin incidents
  // Explicit simulation scenario or a reliable persisted origin marker is required to assign SIMULATED.
  // A simulation-origin incident must remain SIMULATED even after the application switches to LIVE
  // or genuine/mock providers are present.
  const isSimulationOrigin =
    params.isSimulationOrigin === true ||
    (Boolean(params.simulationScenario) && params.simulationScenario !== "live-telemetry-observation") ||
    (params.hasSimulationScenario === true &&
      params.simulationScenario !== "live-telemetry-observation" &&
      !params.isExplicitLiveObservation &&
      !params.isLiveScenario);

  if (isSimulationOrigin) {
    return "SIMULATED";
  }

  // 2. Identify live-origin incidents
  // simulationScenario === "live-telemetry-observation" identifies explicit live-observation origin.
  const isLiveOrigin =
    params.isExplicitLiveObservation === true ||
    params.simulationScenario === "live-telemetry-observation" ||
    (params.isLiveScenario === true && !isSimulationOrigin);

  if (!isLiveOrigin && !params.isExplicitLiveObservation) {
    // Incidents with unverified origin must NOT automatically become SIMULATED merely because global mode is SIMULATION.
    // Unknown origin + mock provider returns MOCK without falsely labeling as simulation-derived.
    if (backendHealth.backendType === "MOCK_EMULATION") {
      return "MOCK";
    }
    return "UNAVAILABLE";
  }

  // 3. For live-origin incidents:
  if (backendHealth.backendType === "MOCK_EMULATION") {
    return "MOCK";
  }

  const isGenuineBackend =
    backendHealth.backendType === "GRAFANA_CLOUD" ||
    backendHealth.backendType === "GENUINE_STACK";

  if (isGenuineBackend) {
    // determineTelemetryProvenance() must not independently label an investigation LIVE_TELEMETRY
    // unless all required conditions are satisfied:
    // - effectiveMode is LIVE
    // - backendType is GRAFANA_CLOUD or GENUINE_STACK
    // - prometheusAvailable is true
    // - jaegerAvailable is true
    if (
      effectiveMode === "LIVE" &&
      backendHealth.prometheusAvailable === true &&
      backendHealth.jaegerAvailable === true
    ) {
      return "LIVE_TELEMETRY";
    }

    // A genuine provider that is only partially available must be PARTIAL_TELEMETRY, not LIVE_TELEMETRY.
    if (backendHealth.prometheusAvailable || backendHealth.jaegerAvailable) {
      return "PARTIAL_TELEMETRY";
    }

    return "UNAVAILABLE";
  }

  return "UNAVAILABLE";
}

export function parsePersistedProvenance(raw: unknown): TelemetryProvenance {
  if (
    raw === "LIVE_TELEMETRY" ||
    raw === "PARTIAL_TELEMETRY" ||
    raw === "UNAVAILABLE" ||
    raw === "SIMULATED" ||
    raw === "MOCK"
  ) {
    return raw;
  }
  return "UNAVAILABLE";
}

/**
 * Investigates an existing incident end-to-end.
 * Gathers telemetry, dependencies, deterministic engine candidates,
 * passes redacted context to server-side AI provider, validates output,
 * verifies evidence citations, and persists the investigation report.
 */
export async function investigateIncident(
  incidentId: string,
  options?: InvestigateOptions
): Promise<AIInvestigationReport> {
  // 1. Fetch incident and verify it exists
  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
    include: {
      evidences: {
        include: { service: { select: { id: true, name: true, status: true, tier: true } } },
        orderBy: { timestamp: "asc" },
      },
      rootCauseCandidates: {
        include: { service: { select: { id: true, name: true, status: true, tier: true, serviceType: true } } },
        orderBy: { rank: "asc" },
      },
      aiInvestigation: true,
    },
  });

  if (!incident) {
    throw new AIProviderError(`Incident '${incidentId}' not found.`, "UNCONFIGURED", 404);
  }

  // 2. Return cached investigation if already exists and refresh is not requested
  if (incident.aiInvestigation && !options?.forceRefresh) {
    return parsePersistedInvestigation(incident.aiInvestigation, incident);
  }

  // 3. Ensure deterministic root-cause candidates exist
  let deterministicCandidates = incident.rootCauseCandidates;
  const isSimulationIncident = Boolean(
    incident.simulationScenario && incident.simulationScenario !== "live-telemetry-observation"
  );
  const isExplicitLiveObservation = incident.simulationScenario === "live-telemetry-observation";

  if (deterministicCandidates.length === 0) {
    if (isSimulationIncident) {
      await simulator.recalculateRootCauses(incidentId);
    } else {
      await realRootCauseEngine.analyzeRealIncident(incidentId);
    }

    const refreshedCandidates = await prisma.rootCauseCandidate.findMany({
      where: { incidentId },
      include: { service: { select: { id: true, name: true, status: true, tier: true, serviceType: true } } },
      orderBy: { rank: "asc" },
    });
    deterministicCandidates = refreshedCandidates;
  }

  // 4. Determine Provenance truthfully with a consistent observation snapshot
  const requestedMode = telemetryManager.getRequestedMode();
  let effectiveMode = telemetryManager.getEffectiveMode();
  let health: BackendHealthStatus;

  if (isSimulationIncident || requestedMode === "SIMULATION") {
    health = await telemetryManager.getBackendHealth(false);
    effectiveMode = "SIMULATION";
  } else {
    try {
      // Reuses fresh 3s observation snapshot; provides consistent effectiveMode & health
      const observation = await telemetryManager.getObservedServices(false);
      effectiveMode = observation.effectiveMode ?? observation.mode;
      health = observation.backendHealth;
    } catch {
      telemetryManager.markDegraded();
      effectiveMode = "DEGRADED";
      health = await telemetryManager.getBackendHealth(false).catch(() => ({
        prometheusAvailable: false,
        jaegerAvailable: false,
        prometheusUrl: "",
        jaegerUrl: "",
        isMockBackend: false,
        isCloudBackend: false,
        cloudConfigured: false,
        backendType: "UNAVAILABLE" as const,
        lastChecked: new Date().toISOString(),
        details: "Observation snapshot probe failed during investigation",
      }));
    }
  }

  const provenance: TelemetryProvenance = determineTelemetryProvenance({
    isSimulationOrigin: isSimulationIncident,
    isExplicitLiveObservation,
    simulationScenario: incident.simulationScenario,
    hasSimulationScenario: Boolean(incident.simulationScenario),
    requestedMode,
    effectiveMode,
    backendHealth: health,
  });

  // 5. Gather service topology
  const services = await prisma.service.findMany({
    include: { outgoingDependencies: true },
  });

  const topology = services.map((s) => ({
    id: s.id,
    name: s.name,
    serviceType: s.serviceType,
    tier: s.tier,
    status: s.status,
    baselineLatency: s.baselineLatency,
    currentLatency: s.currentLatency,
    baselineErrorRate: s.baselineErrorRate,
    currentErrorRate: s.currentErrorRate,
    dependencies: s.outgoingDependencies.map((d) => d.targetServiceId),
  }));

  // 6. Gather recent traces if available (strictly isolated by incident origin)
  let recentTraces: AIInvestigationContext["recentTraces"] = [];
  if (isSimulationIncident) {
    // Simulation-origin incidents must never query genuine live trace providers.
    // If simulation-specific traces exist, retrieve only traces scoped to that incident/scenario.
    // Otherwise pass an empty trace collection and make the lack of trace evidence explicit.
    recentTraces = [];
  } else if (isExplicitLiveObservation && health.jaegerAvailable) {
    // Explicit live-observation incidents may collect genuine provider traces, subject to verified backend state
    try {
      const rawTraces = await telemetryManager.getRecentTraces(undefined, 8);
      recentTraces = rawTraces.map((t) => {
        let bottleneckSpan:
          | {
              service: string;
              operation: string;
              durationMs: number;
              isError: boolean;
            }
          | undefined = undefined;

        const spans = t.allSpans ?? [];
        if (spans.length > 0) {
          const longestSpan = spans.reduce(
            (max, s) => (s.durationMs > (max?.durationMs ?? 0) ? s : max),
            spans[0]
          );
          if (longestSpan) {
            bottleneckSpan = {
              service: longestSpan.serviceName,
              operation: longestSpan.operationName,
              durationMs: longestSpan.durationMs,
              isError: longestSpan.statusCode === "ERROR",
            };
          }
        }

        return {
          traceId: t.traceId,
          rootService: t.rootServiceName,
          durationMs: t.durationMs,
          hasErrors: t.hasErrors,
          servicesInvolved: t.servicesInvolved,
          bottleneckSpan,
        };
      });
    } catch {
      // Non-fatal if trace backend is offline
      recentTraces = [];
    }
  } else {
    recentTraces = [];
  }

  // 7. Assemble investigation context
  const context: AIInvestigationContext = {
    incidentId: incident.id,
    incidentTitle: incident.title,
    incidentDescription: incident.description,
    severity: incident.severity,
    status: incident.status,
    startedAt: incident.startedAt.toISOString(),
    provenance,
    topology,
    evidences: incident.evidences.map((e) => ({
      id: e.id,
      serviceId: e.serviceId,
      evidenceType: e.evidenceType,
      observedValue: e.observedValue,
      expectedValue: e.expectedValue,
      threshold: e.threshold,
      unit: e.unit,
      timestamp: e.timestamp.toISOString(),
      explanation: e.explanation,
    })),
    deterministicCandidates: deterministicCandidates.map((c) => ({
      serviceId: c.candidateServiceId,
      rank: c.rank,
      score: c.score,
      confidence: c.confidence,
      explanation: c.explanation,
      recommendedAction: c.recommendedAction,
    })),
    recentTraces,
  };

  // 8. Select and invoke AI provider
  const provider = getAIProvider(options?.provider);
  if (!provider.isConfigured()) {
    throw new AIProviderError(
      `AI provider '${provider.providerName}' is not configured. Set OPENAI_API_KEY in .env to enable live incident investigations.`,
      "UNCONFIGURED",
      503
    );
  }

  const result = await provider.generateInvestigation(context);

  // 9. Parse and validate JSON with Zod
  let rawJsonObj: unknown;
  try {
    rawJsonObj = JSON.parse(result.rawJson);
  } catch {
    throw new AIProviderError(
      "AI provider response could not be parsed as valid JSON.",
      "MALFORMED_OUTPUT",
      502
    );
  }

  const parseResult = InvestigationLLMOutputSchema.safeParse(rawJsonObj);
  if (!parseResult.success) {
    const errorMessages = parseResult.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new AIProviderError(
      `AI provider output failed schema validation: ${errorMessages}`,
      "MALFORMED_OUTPUT",
      502
    );
  }

  // 10. Perform post-generation evidence grounding & deterministic alignment check
  const { groundedReport, groundingValidation, deterministicAlignment } =
    validateAndGroundInvestigation(parseResult.data, context);

  // 11. Persist investigation report to SQLite
  const persisted = await prisma.aiInvestigation.upsert({
    where: { incidentId },
    update: {
      summary: groundedReport.summary,
      verifiedImpact: groundedReport.verifiedImpact,
      diagnosisStatus: groundedReport.diagnosisStatus,
      confidenceCategory: groundedReport.confidenceCategory,
      confidenceExplanation: groundedReport.confidenceExplanation,
      rankedHypothesesJson: JSON.stringify(groundedReport.rankedHypotheses),
      recommendedChecksJson: JSON.stringify(groundedReport.recommendedChecks),
      remediationOptionsJson: JSON.stringify(groundedReport.remediationOptions),
      missingEvidenceJson: JSON.stringify(groundedReport.missingEvidence),
      nextObservationsJson: JSON.stringify(groundedReport.nextObservations),
      provenance,
      provider: provider.providerName,
      model: provider.modelName,
      executionTimeMs: result.executionTimeMs,
      promptTokens: result.promptTokens ?? null,
      completionTokens: result.completionTokens ?? null,
      totalTokens: result.totalTokens ?? null,
      rawResponseJson: result.rawJson,
    },
    create: {
      incidentId,
      summary: groundedReport.summary,
      verifiedImpact: groundedReport.verifiedImpact,
      diagnosisStatus: groundedReport.diagnosisStatus,
      confidenceCategory: groundedReport.confidenceCategory,
      confidenceExplanation: groundedReport.confidenceExplanation,
      rankedHypothesesJson: JSON.stringify(groundedReport.rankedHypotheses),
      recommendedChecksJson: JSON.stringify(groundedReport.recommendedChecks),
      remediationOptionsJson: JSON.stringify(groundedReport.remediationOptions),
      missingEvidenceJson: JSON.stringify(groundedReport.missingEvidence),
      nextObservationsJson: JSON.stringify(groundedReport.nextObservations),
      provenance,
      provider: provider.providerName,
      model: provider.modelName,
      executionTimeMs: result.executionTimeMs,
      promptTokens: result.promptTokens ?? null,
      completionTokens: result.completionTokens ?? null,
      totalTokens: result.totalTokens ?? null,
      rawResponseJson: result.rawJson,
    },
  });

  return {
    id: persisted.id,
    incidentId,
    summary: groundedReport.summary,
    verifiedImpact: groundedReport.verifiedImpact,
    diagnosisStatus: groundedReport.diagnosisStatus,
    confidenceCategory: groundedReport.confidenceCategory,
    confidenceExplanation: groundedReport.confidenceExplanation,
    rankedHypotheses: groundedReport.rankedHypotheses,
    recommendedChecks: groundedReport.recommendedChecks,
    remediationOptions: groundedReport.remediationOptions,
    missingEvidence: groundedReport.missingEvidence,
    nextObservations: groundedReport.nextObservations,
    provenance,
    groundingValidation,
    deterministicAlignment,
    metadata: {
      provider: provider.providerName,
      model: provider.modelName,
      executionTimeMs: result.executionTimeMs,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      timestamp: persisted.updatedAt.toISOString(),
    },
  };
}

/**
 * Reconstitutes persisted DB record into a typed AIInvestigationReport
 */
function parsePersistedInvestigation(
  record: {
    id: string;
    incidentId: string;
    summary: string;
    verifiedImpact: string;
    diagnosisStatus: string;
    confidenceCategory: string;
    confidenceExplanation: string;
    rankedHypothesesJson: string;
    recommendedChecksJson: string;
    remediationOptionsJson: string;
    missingEvidenceJson: string;
    nextObservationsJson: string;
    provenance: string;
    provider: string;
    model: string;
    executionTimeMs: number;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    updatedAt: Date;
  },
  incident: {
    evidences: Array<{ id: string }>;
    rootCauseCandidates: Array<{ candidateServiceId: string; rank: number }>;
  }
): AIInvestigationReport {
  let rankedHypotheses = [];
  let recommendedChecks = [];
  let remediationOptions = [];
  let missingEvidence = [];
  let nextObservations = [];

  try {
    rankedHypotheses = JSON.parse(record.rankedHypothesesJson || "[]");
    recommendedChecks = JSON.parse(record.recommendedChecksJson || "[]");
    remediationOptions = JSON.parse(record.remediationOptionsJson || "[]");
    missingEvidence = JSON.parse(record.missingEvidenceJson || "[]");
    nextObservations = JSON.parse(record.nextObservationsJson || "[]");
  } catch {
    // Handled gracefully
  }

  const validEvidenceIds = new Set(incident.evidences.map((e) => e.id));
  let totalCitations = 0;
  let validCitations = 0;
  const hallucinated: string[] = [];

  for (const h of rankedHypotheses) {
    for (const id of h.supportingEvidenceIds || []) {
      totalCitations++;
      if (validEvidenceIds.has(id)) validCitations++;
      else hallucinated.push(id);
    }
  }

  const topDet = incident.rootCauseCandidates[0];
  const topAI = rankedHypotheses[0];

  return {
    id: record.id,
    incidentId: record.incidentId,
    summary: record.summary,
    verifiedImpact: record.verifiedImpact,
    diagnosisStatus: record.diagnosisStatus as AIInvestigationReport["diagnosisStatus"],
    confidenceCategory: record.confidenceCategory as AIInvestigationReport["confidenceCategory"],
    confidenceExplanation: record.confidenceExplanation,
    rankedHypotheses,
    recommendedChecks,
    remediationOptions,
    missingEvidence,
    nextObservations,
    provenance: parsePersistedProvenance(record.provenance),
    groundingValidation: {
      totalEvidenceCitations: totalCitations,
      validEvidenceCitations: validCitations,
      hallucinatedEvidenceIds: hallucinated,
      groundingScore: totalCitations > 0 ? Number((validCitations / totalCitations).toFixed(3)) : 1.0,
      hasInvalidServiceReferences: false,
      invalidServiceIds: [],
      isFullyGrounded: hallucinated.length === 0,
    },
    deterministicAlignment: {
      alignedWithDeterministicEngine: Boolean(topDet && topAI && topDet.candidateServiceId === topAI.serviceId),
      topDeterministicCandidateId: topDet?.candidateServiceId ?? null,
      deterministicCandidateRank: topDet?.rank ?? null,
      notes: "Loaded from verified persistent investigation storage.",
    },
    metadata: {
      provider: record.provider,
      model: record.model,
      executionTimeMs: record.executionTimeMs,
      promptTokens: record.promptTokens ?? undefined,
      completionTokens: record.completionTokens ?? undefined,
      totalTokens: record.totalTokens ?? undefined,
      timestamp: record.updatedAt.toISOString(),
    },
  };
}
