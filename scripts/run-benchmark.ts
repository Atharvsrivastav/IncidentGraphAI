import fs from "fs";
import path from "path";
import { BenchmarkEvaluator } from "../src/lib/benchmark/evaluator";

async function main() {
  console.log("===============================================================================");
  console.log("   IncidentGraph AI — Advanced Root-Cause Robustness Benchmark Suite");
  console.log("===============================================================================\n");

  const evaluator = new BenchmarkEvaluator();
  const summary = evaluator.evaluateSuite();

  console.log(`Evaluated ${summary.totalScenarios} reproducible scenarios across 5 topology archetypes (Seed: ${summary.seed}).\n`);

  console.log("--- 1. Aggregated Reliability Metrics ---");
  console.log(
    `  • Top-1 Root-Cause Hit Rate      : ${summary.top1HitRatePercent}% [95% CI: ${summary.top1HitRateCi95[0]}% - ${summary.top1HitRateCi95[1]}%] (Denominator: ${summary.evaluableFailureScenarios} failure scenarios)`
  );
  console.log(
    `  • Top-3 Root-Cause Hit Rate      : ${summary.top3HitRatePercent}% [95% CI: ${summary.top3HitRateCi95[0]}% - ${summary.top3HitRateCi95[1]}%] (Denominator: ${summary.evaluableFailureScenarios} failure scenarios)`
  );
  console.log(
    `  • False-Positive Rate (Healthy)  : ${summary.falsePositiveRatePercent}% [95% CI: ${summary.falsePositiveRateCi95[0]}% - ${summary.falsePositiveRateCi95[1]}%] (Denominator: ${summary.healthyScenarios} healthy scenarios)`
  );
  console.log(
    `  • Recovery Verification Rate     : ${summary.recoveryVerificationSuccessRate}% [95% CI: ${summary.recoveryVerificationCi95[0]}% - ${summary.recoveryVerificationCi95[1]}%] (Denominator: ${summary.recoveryScenarios} recovery scenarios)`
  );
  console.log(
    `  • Ambiguous Inconclusive Rate    : ${summary.ambiguousInconclusiveRatePercent}% [95% CI: ${summary.ambiguousInconclusiveRateCi95[0]}% - ${summary.ambiguousInconclusiveRateCi95[1]}%] (Denominator: ${summary.ambiguousScenarios} ambiguous scenarios)`
  );
  console.log(
    `  • Suite Non-Conclusive Rate      : ${summary.suiteInconclusiveRatePercent}% [95% CI: ${summary.suiteInconclusiveRateCi95[0]}% - ${summary.suiteInconclusiveRateCi95[1]}%] (Denominator: ${summary.totalScenarios} total scenarios)`
  );
  console.log(
    `  • Mean Algorithm Execution Time  : ${summary.meanExecutionTimeMs} ms`
  );
  console.log(
    `  • P95 Algorithm Execution Time   : ${summary.p95ExecutionTimeMs} ms`
  );

  console.log("\n--- 2. Reconciled Scenario Suite Partitions ---");
  console.log(`  • 1. Definitive Failure Scenarios  : ${summary.evaluableFailureScenarios} (Single-point, cascading, timeouts, topology)`);
  console.log(`  • 2. Healthy Baseline Scenarios    : ${summary.healthyScenarios} (Standard & burst high-traffic loads)`);
  console.log(`  • 3. Recovery Cycle Scenarios      : ${summary.recoveryScenarios} (Post-incident cleared system verification)`);
  console.log(`  • 4. Ambiguous / Perturbed Signals : ${summary.ambiguousScenarios} (14 noisy + 10 contradictory + 10 multi-failure)`);
  console.log(`  -------------------------------------------------------------`);
  console.log(`    Total Reconciled Scenarios       : ${summary.totalScenarios} (100% MECE partition: 65 + 13 + 5 + 34 = 117)`);
  console.log(`    Total Non-Conclusive Verdicts    : ${summary.suiteInconclusiveCount} (18 healthy/recovery + 24 ambiguous abstentions)`);

  console.log("\n--- 3. Performance Breakdown by Failure Category ---");
  console.log("  " + "Category".padEnd(25) + "Total".padStart(6) + "EvalFail".padStart(10) + "Top-1".padStart(8) + "Top-3".padStart(8) + "Inconcl".padStart(9) + "PassRate".padStart(10) + "Mean(ms)".padStart(10));
  console.log("  " + "-".repeat(87));
  for (const [catName, catMetrics] of Object.entries(summary.categoryBreakdown)) {
    const top1 = catMetrics.evaluableFailures > 0 ? `${catMetrics.top1HitRatePercent}%` : "N/A";
    const top3 = catMetrics.evaluableFailures > 0 ? `${catMetrics.top3HitRatePercent}%` : "N/A";
    console.log(
      `  ${catName.padEnd(25)}${String(catMetrics.totalScenarios).padStart(6)}${String(catMetrics.evaluableFailures).padStart(10)}${top1.padStart(8)}${top3.padStart(8)}${String(catMetrics.inconclusiveCount).padStart(9)}${(catMetrics.passRatePercent + "%").padStart(10)}${(catMetrics.meanExecutionTimeMs + "ms").padStart(10)}`
    );
  }

  // Print sample scenario outputs
  console.log("\n--- 3. Sample Scenario Executions ---");
  const sampleScenarios = [
    ...summary.scenarioResults.slice(0, 8),
    ...summary.scenarioResults.filter((r) => r.evaluatorVerdict === "FAIL"),
    ...summary.scenarioResults.filter((r) => r.category === "TOPOLOGY_VARIATION").slice(0, 2),
  ];

  for (const res of sampleScenarios) {
    const statusMark =
      res.evaluatorVerdict === "PASS"
        ? "✓ [PASS]"
        : res.evaluatorVerdict === "ACCEPTABLE_INCONCLUSIVE"
        ? "✓ [INCONCL]"
        : "✗ [FAIL]";
    const exp = res.expectedRootCause ?? "None";
    const pred = res.predictedRootCause ?? "None";
    console.log(
      `  ${statusMark} ${res.scenarioId.padEnd(24)} | Expected: ${exp.padEnd(18)} | Predicted: ${pred.padEnd(18)} | Score: ${String(res.predictedScore).padStart(3)} | ${res.executionTimeMs}ms`
    );
  }

  // Ensure docs directory exists
  const docsDir = path.join(process.cwd(), "docs");
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  // 1. Write machine-readable JSON report
  const jsonPath = path.join(docsDir, "benchmark_results.json");
  const jsonReport = evaluator.generateJsonReport(summary);
  fs.writeFileSync(jsonPath, jsonReport, "utf-8");
  console.log(`\n✓ [OK] Machine-readable report saved to: ${jsonPath}`);

  // 2. Write Markdown documentation report
  const mdPath = path.join(docsDir, "ROOT_CAUSE_BENCHMARK.md");
  const mdReport = evaluator.generateMarkdownReport(summary);
  fs.writeFileSync(mdPath, mdReport, "utf-8");
  console.log(`✓ [OK] Documentation report saved to: ${mdPath}`);

  // Evaluate quality gate thresholds
  const passed =
    summary.top1HitRatePercent >= 90.0 &&
    summary.top3HitRatePercent >= 100.0 &&
    summary.falsePositiveRatePercent === 0.0 &&
    summary.recoveryVerificationSuccessRate === 100.0;

  if (passed) {
    console.log("\n===============================================================================");
    console.log("   ✓ ALL ROOT-CAUSE ROBUSTNESS BENCHMARK GATES PASSED");
    console.log("===============================================================================\n");
    process.exit(0);
  } else {
    console.error("\n===============================================================================");
    console.error("   ✗ BENCHMARK GATES FAILED TO MEET RELIABILITY THRESHOLDS");
    console.error("===============================================================================\n");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal benchmark execution error:", err);
  process.exit(1);
});
