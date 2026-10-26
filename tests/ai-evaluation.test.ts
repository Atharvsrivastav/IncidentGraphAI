import { describe, it, expect } from "vitest";
import { evaluateAIInvestigationQuality } from "../src/lib/ai/evaluation";
import { MockAIProvider } from "../src/lib/ai/providers/mock";

describe("AI Output Quality & Evaluation Suite (Grounding & Abstention Contract)", () => {
  it("evaluates AI synthesis quality across benchmark fixtures with 100% citation validity and appropriate abstention", async () => {
    const mockProvider = new MockAIProvider();
    const evaluation = await evaluateAIInvestigationQuality(mockProvider);

    expect(evaluation.totalScenarios).toBe(3);

    // 1. Strict Schema Compliance Gate
    expect(evaluation.schemaComplianceRate).toBe(100);

    // 2. Strict Citation Validity Gate (Zero hallucinated evidence citations)
    expect(evaluation.citationValidityRate).toBe(100);
    expect(evaluation.unsupportedClaimRate).toBe(0);

    // 3. Service Grounding Gate (All cited services exist in topology)
    expect(evaluation.serviceGroundingRate).toBe(100);

    // 4. Calibrated SRE Abstention Gate (Appropriate abstention on ambiguous / false-alarm cases)
    expect(evaluation.appropriateAbstentionRate).toBe(100);

    // 5. Performance & Resource Tracking
    expect(evaluation.meanLatencyMs).toBeGreaterThanOrEqual(0);
    expect(evaluation.totalTokensReported).toBeGreaterThan(0);

    // Check individual scenario pass rates
    for (const res of evaluation.scenarioResults) {
      expect(res.passed).toBe(true);
      expect(res.hallucinatedEvidenceCount).toBe(0);
      expect(res.citationValidity).toBe(100);
    }
  });

  it("detects and flags hallucinated evidence IDs when simulated in evaluation", async () => {
    // Inject hallucination simulation
    const hallucinatingProvider = new MockAIProvider({
      simulateHallucinatedEvidenceId: true,
    });

    const evaluation = await evaluateAIInvestigationQuality(hallucinatingProvider);

    // The evaluation harness MUST detect the injected hallucination
    expect(evaluation.unsupportedClaimRate).toBeGreaterThan(0);
    expect(evaluation.citationValidityRate).toBeLessThan(100);

    const failingScenario = evaluation.scenarioResults.find(
      (r) => r.hallucinatedEvidenceCount > 0
    );
    expect(failingScenario).toBeDefined();
    expect(failingScenario?.passed).toBe(false);
  });
});
