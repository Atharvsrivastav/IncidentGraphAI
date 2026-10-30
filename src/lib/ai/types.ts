import { z } from "zod";

export type DiagnosisStatus = "PROBABLE_ROOT_CAUSE" | "MULTIPLE_CANDIDATES" | "INCONCLUSIVE";
export type ConfidenceCategory = "HIGH" | "MEDIUM" | "LOW" | "UNCERTAIN";
export const TelemetryProvenanceSchema = z.enum([
  "LIVE_TELEMETRY",
  "PARTIAL_TELEMETRY",
  "UNAVAILABLE",
  "SIMULATED",
  "MOCK",
]);
export type TelemetryProvenance = z.infer<typeof TelemetryProvenanceSchema>;

export const DiagnosticCheckTypeSchema = z.enum([
  "METRIC_QUERY",
  "TRACE_ANALYSIS",
  "LOG_INSPECTION",
  "CONFIG_CHECK",
  "DEPENDENCY_PROBE",
]);
export type DiagnosticCheckType = z.infer<typeof DiagnosticCheckTypeSchema>;

export const RemediationActionTypeSchema = z.enum([
  "SCALE_REPLICAS",
  "CIRCUIT_BREAKER",
  "REVERT_DEPLOYMENT",
  "CACHE_FLUSH",
  "TRAFFIC_SHED",
  "DATABASE_FAILOVER",
  "RESTART_POD",
  "MANUAL_INVESTIGATION",
]);
export type RemediationActionType = z.infer<typeof RemediationActionTypeSchema>;

export const RankedHypothesisSchema = z.object({
  rank: z.number().int().positive(),
  serviceId: z.string().min(1),
  serviceName: z.string().min(1),
  hypothesis: z.string().min(5),
  supportingEvidenceIds: z.array(z.string()),
  contradictingEvidenceIds: z.array(z.string()).default([]),
  confidenceCategory: z.enum(["HIGH", "MEDIUM", "LOW", "UNCERTAIN"]),
  confidenceExplanation: z.string().min(5),
  blastRadius: z.array(z.string()).default([]),
});
export type RankedHypothesis = z.infer<typeof RankedHypothesisSchema>;

export const DiagnosticCheckSchema = z.object({
  serviceId: z.string().min(1),
  type: DiagnosticCheckTypeSchema,
  description: z.string().min(5),
  expectedSignal: z.string().min(3),
});
export type DiagnosticCheck = z.infer<typeof DiagnosticCheckSchema>;

export const RemediationOptionSchema = z.object({
  targetServiceId: z.string().min(1),
  actionType: RemediationActionTypeSchema,
  description: z.string().min(5),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
  requiresHumanApproval: z.literal(true),
  prerequisites: z.string().min(3),
});
export type RemediationOption = z.infer<typeof RemediationOptionSchema>;

/**
 * Raw structured output schema expected from LLM synthesis.
 */
export const InvestigationLLMOutputSchema = z.object({
  summary: z.string().min(10),
  verifiedImpact: z.string().min(5),
  diagnosisStatus: z.enum(["PROBABLE_ROOT_CAUSE", "MULTIPLE_CANDIDATES", "INCONCLUSIVE"]),
  confidenceCategory: z.enum(["HIGH", "MEDIUM", "LOW", "UNCERTAIN"]),
  confidenceExplanation: z.string().min(5),
  rankedHypotheses: z.array(RankedHypothesisSchema).min(1),
  recommendedChecks: z.array(DiagnosticCheckSchema).default([]),
  remediationOptions: z.array(RemediationOptionSchema).default([]),
  missingEvidence: z.array(z.string()).default([]),
  nextObservations: z.array(z.string()).default([]),
});
export type InvestigationLLMOutput = z.infer<typeof InvestigationLLMOutputSchema>;

/**
 * Complete, grounded investigation report returned to consumers.
 */
export interface AIInvestigationReport {
  id?: string;
  incidentId: string;
  summary: string;
  verifiedImpact: string;
  diagnosisStatus: DiagnosisStatus;
  confidenceCategory: ConfidenceCategory;
  confidenceExplanation: string;
  rankedHypotheses: RankedHypothesis[];
  recommendedChecks: DiagnosticCheck[];
  remediationOptions: RemediationOption[];
  missingEvidence: string[];
  nextObservations: string[];
  provenance: TelemetryProvenance;
  groundingValidation: {
    totalEvidenceCitations: number;
    validEvidenceCitations: number;
    hallucinatedEvidenceIds: string[];
    groundingScore: number; // 0.0 to 1.0 (valid / total)
    hasInvalidServiceReferences: boolean;
    invalidServiceIds: string[];
    isFullyGrounded: boolean;
  };
  deterministicAlignment: {
    alignedWithDeterministicEngine: boolean;
    topDeterministicCandidateId: string | null;
    deterministicCandidateRank: number | null;
    notes: string;
  };
  metadata: {
    provider: string;
    model: string;
    executionTimeMs: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    timestamp: string;
  };
}

export interface AIProviderStatus {
  isConfigured: boolean;
  providerName: string;
  modelName: string;
  details: string;
}
