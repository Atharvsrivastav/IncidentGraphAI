import { InvestigationLLMOutput, AIInvestigationReport, RankedHypothesis } from "./types";
import { AIInvestigationContext } from "./providers/types";

export interface GroundingValidationResult {
  groundedReport: Omit<AIInvestigationReport, "id" | "incidentId" | "metadata">;
  groundingValidation: AIInvestigationReport["groundingValidation"];
  deterministicAlignment: AIInvestigationReport["deterministicAlignment"];
}

export function validateAndGroundInvestigation(
  llmOutput: InvestigationLLMOutput,
  context: AIInvestigationContext
): GroundingValidationResult {
  const validServiceIds = new Set(context.topology.map((s) => s.id));
  const validEvidenceIds = new Set(context.evidences.map((e) => e.id));

  let totalEvidenceCitations = 0;
  let validEvidenceCitations = 0;
  const hallucinatedEvidenceIds: string[] = [];
  const invalidServiceIds: string[] = [];

  // Filter and ground hypotheses
  const groundedHypotheses: RankedHypothesis[] = llmOutput.rankedHypotheses.map((hyp, index) => {
    // Check service ID validity
    if (!validServiceIds.has(hyp.serviceId)) {
      invalidServiceIds.push(hyp.serviceId);
    }

    // Check supporting evidence citations
    const cleanSupporting: string[] = [];
    for (const evId of hyp.supportingEvidenceIds) {
      totalEvidenceCitations++;
      if (validEvidenceIds.has(evId)) {
        validEvidenceCitations++;
        cleanSupporting.push(evId);
      } else {
        hallucinatedEvidenceIds.push(evId);
      }
    }

    // Check contradicting evidence citations
    const cleanContradicting: string[] = [];
    for (const evId of hyp.contradictingEvidenceIds ?? []) {
      totalEvidenceCitations++;
      if (validEvidenceIds.has(evId)) {
        validEvidenceCitations++;
        cleanContradicting.push(evId);
      } else {
        hallucinatedEvidenceIds.push(evId);
      }
    }

    return {
      ...hyp,
      rank: index + 1,
      supportingEvidenceIds: cleanSupporting,
      contradictingEvidenceIds: cleanContradicting,
      // If service is invalid, mark confidence as UNCERTAIN
      confidenceCategory: !validServiceIds.has(hyp.serviceId) ? "UNCERTAIN" : hyp.confidenceCategory,
    };
  });

  const groundingScore =
    totalEvidenceCitations > 0
      ? Number((validEvidenceCitations / totalEvidenceCitations).toFixed(3))
      : 1.0;

  const isFullyGrounded = hallucinatedEvidenceIds.length === 0 && invalidServiceIds.length === 0;

  // Validate diagnosis status against evidence reality
  let diagnosisStatus = llmOutput.diagnosisStatus;
  let confidenceCategory = llmOutput.confidenceCategory;
  let confidenceExplanation = llmOutput.confidenceExplanation;

  if (context.evidences.length === 0 && diagnosisStatus === "PROBABLE_ROOT_CAUSE") {
    // Calibrated guard: Cannot declare probable root cause when zero evidence exists
    diagnosisStatus = "INCONCLUSIVE";
    confidenceCategory = "UNCERTAIN";
    confidenceExplanation = `${confidenceExplanation} (Calibrated SRE Guard: Downgraded to INCONCLUSIVE because zero anomalous evidence items were recorded).`;
  }

  // Check alignment with deterministic root cause engine
  const topDeterministic = context.deterministicCandidates[0];
  const topAIHypothesis = groundedHypotheses[0];

  let alignedWithDeterministicEngine = false;
  let deterministicCandidateRank: number | null = null;
  let alignmentNotes = "No deterministic candidates available for comparison.";

  if (topDeterministic && topAIHypothesis) {
    if (topAIHypothesis.serviceId === topDeterministic.serviceId) {
      alignedWithDeterministicEngine = true;
      deterministicCandidateRank = 1;
      alignmentNotes = `Both AI synthesis and deterministic graph engine agree: '${topDeterministic.serviceId}' is the primary root cause.`;
    } else {
      const foundRank = context.deterministicCandidates.findIndex(
        (c) => c.serviceId === topAIHypothesis.serviceId
      );
      if (foundRank !== -1) {
        deterministicCandidateRank = foundRank + 1;
        alignmentNotes = `AI prioritized '${topAIHypothesis.serviceId}' (ranked #${deterministicCandidateRank} in deterministic engine). Top deterministic candidate was '${topDeterministic.serviceId}'.`;
      } else {
        alignmentNotes = `AI proposed '${topAIHypothesis.serviceId}' which was not ranked by the deterministic engine. Top deterministic candidate was '${topDeterministic.serviceId}'.`;
      }
    }
  }

  const groundingValidation: AIInvestigationReport["groundingValidation"] = {
    totalEvidenceCitations,
    validEvidenceCitations,
    hallucinatedEvidenceIds,
    groundingScore,
    hasInvalidServiceReferences: invalidServiceIds.length > 0,
    invalidServiceIds,
    isFullyGrounded,
  };

  const deterministicAlignment: AIInvestigationReport["deterministicAlignment"] = {
    alignedWithDeterministicEngine,
    topDeterministicCandidateId: topDeterministic?.serviceId ?? null,
    deterministicCandidateRank,
    notes: alignmentNotes,
  };

  return {
    groundedReport: {
      summary: llmOutput.summary,
      verifiedImpact: llmOutput.verifiedImpact,
      diagnosisStatus,
      confidenceCategory,
      confidenceExplanation,
      rankedHypotheses: groundedHypotheses,
      recommendedChecks: llmOutput.recommendedChecks ?? [],
      remediationOptions: llmOutput.remediationOptions ?? [],
      missingEvidence: llmOutput.missingEvidence ?? [],
      nextObservations: llmOutput.nextObservations ?? [],
      provenance: context.provenance,
      groundingValidation,
      deterministicAlignment,
    },
    groundingValidation,
    deterministicAlignment,
  };
}
