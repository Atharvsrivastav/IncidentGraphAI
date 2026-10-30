import prisma from "../db/prisma";
import { telemetryManager } from "../telemetry/telemetryManager";
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
  const isLiveScenario =
    incident.simulationScenario === "live-telemetry-observation" ||
    telemetryManager.getRequestedMode() === "LIVE" ||
    telemetryManager.getEffectiveMode() === "LIVE";

  if (deterministicCandidates.length === 0) {
    if (isLiveScenario) {
      await realRootCauseEngine.analyzeRealIncident(incidentId);
    } else {
      await simulator.recalculateRootCauses(incidentId);
    }

    const refreshedCandidates = await prisma.rootCauseCandidate.findMany({
      where: { incidentId },
      include: { service: { select: { id: true, name: true, status: true, tier: true, serviceType: true } } },
      orderBy: { rank: "asc" },
    });
    deterministicCandidates = refreshedCandidates;
  }

  // 4. Determine Provenance truthfully
  let provenance: TelemetryProvenance = "SIMULATED";
  if (isLiveScenario) {
    const health = await telemetryManager.getBackendHealth();
    provenance = health.backendType === "MOCK_EMULATION" ? "MOCK" : "LIVE_TELEMETRY";
  } else if (!incident.simulationScenario) {
    provenance = "MOCK";
  }

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

  // 6. Gather recent traces if available
  let recentTraces: AIInvestigationContext["recentTraces"] = [];
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
    provenance: record.provenance as TelemetryProvenance,
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
