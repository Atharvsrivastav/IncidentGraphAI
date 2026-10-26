"use client";

import { useEffect, useState } from "react";
import {
  Sparkles,
  RefreshCw,
  Copy,
  Check,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  ShieldAlert,
  Search,
  ChevronDown,
  ChevronUp,
  Cpu,
  Layers,
  ArrowRight,
} from "lucide-react";
import { AIInvestigationReport, AIProviderStatus } from "@/lib/ai/types";

interface AiInvestigationSectionProps {
  incidentId: string;
  onNavigateToEvidence?: () => void;
}

export function AiInvestigationSection({
  incidentId,
  onNavigateToEvidence,
}: AiInvestigationSectionProps) {
  const [investigation, setInvestigation] = useState<AIInvestigationReport | null>(null);
  const [providerStatus, setProviderStatus] = useState<AIProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expandedHypothesis, setExpandedHypothesis] = useState<number | null>(1);

  useEffect(() => {
    let isCancelled = false;

    async function loadInvestigation() {
      try {
        const res = await fetch(`/api/incidents/${incidentId}/ai-investigation`);
        if (res.ok) {
          const data = await res.json();
          if (!isCancelled) {
            setInvestigation(data.investigation ?? null);
            setProviderStatus(data.providerStatus ?? null);
          }
        }
      } catch {
        // Ignored on initial load
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    }

    void loadInvestigation();

    return () => {
      isCancelled = true;
    };
  }, [incidentId]);

  const handleRunInvestigation = async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const res = await fetch(`/api/incidents/${incidentId}/ai-investigation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forceRefresh: true }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to synthesize AI investigation.");
      }

      setInvestigation(data.investigation);
      setProviderStatus(data.providerStatus);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to run AI investigation.");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleCopyReport = () => {
    if (!investigation) return;

    const reportMarkdown = [
      `# Incident Investigation Brief: ${incidentId}`,
      `**Status**: ${investigation.diagnosisStatus} | **Confidence**: ${investigation.confidenceCategory}`,
      `**Provenance**: ${investigation.provenance} | **Synthesized By**: ${investigation.metadata.provider} (${investigation.metadata.model})`,
      "",
      `## Summary`,
      investigation.summary,
      "",
      `## Verified Impact`,
      investigation.verifiedImpact,
      "",
      `## Ranked Hypotheses`,
      ...investigation.rankedHypotheses.map(
        (h) =>
          `### #${h.rank} ${h.serviceName} (${h.serviceId}) - Confidence: ${h.confidenceCategory}\n` +
          `${h.hypothesis}\n` +
          `- Supporting Evidence IDs: ${h.supportingEvidenceIds.length > 0 ? h.supportingEvidenceIds.join(", ") : "None"}\n` +
          `- Blast Radius: ${h.blastRadius.join(", ") || "None"}`
      ),
      "",
      `## Recommended Diagnostic Checks (Read-Only)`,
      ...investigation.recommendedChecks.map(
        (c) => `- **[${c.type}] on ${c.serviceId}**: ${c.description} (Expected: ${c.expectedSignal})`
      ),
      "",
      `## Safe Remediation Options (Requires Human Approval)`,
      ...investigation.remediationOptions.map(
        (r) =>
          `- **[${r.actionType}] on ${r.targetServiceId}** (Risk: ${r.riskLevel}): ${r.description}\n  Prerequisites: ${r.prerequisites}`
      ),
      "",
      `## Missing Evidence & Limitations`,
      ...investigation.missingEvidence.map((m) => `- ${m}`),
      "",
      `## Next Observations (15-30m)`,
      ...investigation.nextObservations.map((o) => `- ${o}`),
    ].join("\n");

    void navigator.clipboard.writeText(reportMarkdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/40">
        <div className="flex items-center gap-3 text-xs font-mono text-slate-400">
          <RefreshCw className="h-4 w-4 animate-spin text-purple-400" />
          <span>Checking AI investigation status...</span>
        </div>
      </div>
    );
  }

  // AI Unconfigured State (truthful display)
  if (!investigation && providerStatus && !providerStatus.isConfigured) {
    return (
      <div className="rounded-2xl border border-amber-500/30 bg-gradient-to-r from-amber-950/20 via-slate-900/80 to-slate-900/90 p-6 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[11px] font-bold text-amber-400 uppercase">
                AI Provider Standby
              </span>
              <span className="text-xs text-slate-400 font-mono">Deterministic Engine Active</span>
            </div>
            <h3 className="text-lg font-bold text-white tracking-tight">
              Evidence-Grounded AI Investigation
            </h3>
            <p className="text-xs text-slate-300 max-w-2xl leading-relaxed">
              No live LLM key configured (<code className="rounded bg-slate-800 px-1.5 py-0.5 text-amber-300">OPENAI_API_KEY</code>).
              The deterministic graph engine remains 100% active and testable on the adjacent tab.
              To enable server-side AI synthesis, add your API key to <code className="text-slate-300">.env</code> or test using the deterministic mock provider.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleRunInvestigation}
              disabled={analyzing}
              className="flex items-center gap-2 rounded-xl bg-purple-600 hover:bg-purple-500 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-purple-600/30 transition-all disabled:opacity-50"
            >
              <Sparkles className={`h-4 w-4 ${analyzing ? "animate-spin" : ""}`} />
              <span>{analyzing ? "Synthesizing..." : "Run AI Investigation"}</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-950/30 p-3 text-xs text-rose-300 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
        )}
      </div>
    );
  }

  // Not yet investigated
  if (!investigation) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-purple-500/10 border border-purple-500/20 text-purple-400">
          <Sparkles className="h-6 w-6" />
        </div>
        <div>
          <h3 className="text-base font-bold text-white">Synthesize Incident with AI</h3>
          <p className="mt-1 text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
            Correlate observed service telemetry, trace spans, and graph reachability with
            evidence-grounded AI synthesis. Every hypothesis is verified against genuine evidence IDs.
          </p>
        </div>

        {error && (
          <div className="mx-auto max-w-md rounded-xl border border-rose-500/30 bg-rose-950/30 p-3 text-xs text-rose-300 flex items-center gap-2 text-left">
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
        )}

        <button
          onClick={handleRunInvestigation}
          disabled={analyzing}
          className="inline-flex items-center gap-2 rounded-xl bg-purple-600 hover:bg-purple-500 px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-purple-600/30 transition-all disabled:opacity-50"
        >
          <Sparkles className={`h-4 w-4 ${analyzing ? "animate-spin" : ""}`} />
          <span>{analyzing ? "Synthesizing Investigation..." : "Investigate with AI"}</span>
        </button>
      </div>
    );
  }

  const {
    summary,
    verifiedImpact,
    diagnosisStatus,
    confidenceCategory,
    confidenceExplanation,
    rankedHypotheses,
    recommendedChecks,
    remediationOptions,
    missingEvidence,
    nextObservations,
    provenance,
    groundingValidation,
    deterministicAlignment,
    metadata,
  } = investigation;

  return (
    <div className="space-y-6">
      {/* Investigation Top Banner */}
      <div className="rounded-2xl border border-purple-500/40 bg-gradient-to-r from-purple-950/20 via-slate-900/80 to-slate-900/90 p-6 shadow-xl backdrop-blur-md">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              {/* Provenance Badge */}
              <span
                className={`flex items-center gap-1.5 rounded px-2.5 py-0.5 text-[10px] font-mono font-bold uppercase ${
                  provenance === "LIVE_TELEMETRY"
                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                    : provenance === "SIMULATED"
                    ? "bg-blue-500/20 text-blue-300 border border-blue-500/30"
                    : "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    provenance === "LIVE_TELEMETRY"
                      ? "bg-emerald-400 animate-pulse"
                      : provenance === "SIMULATED"
                      ? "bg-blue-400"
                      : "bg-amber-400"
                  }`}
                />
                {provenance === "LIVE_TELEMETRY"
                  ? "Live Telemetry (Grafana Cloud)"
                  : provenance === "SIMULATED"
                  ? "Simulated Telemetry"
                  : "Mock Telemetry"}
              </span>

              {/* Diagnosis Status Badge */}
              <span
                className={`rounded px-2.5 py-0.5 text-[10px] font-mono font-bold uppercase ${
                  diagnosisStatus === "PROBABLE_ROOT_CAUSE"
                    ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                    : diagnosisStatus === "MULTIPLE_CANDIDATES"
                    ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                    : "bg-slate-700/40 text-slate-300 border border-slate-600/30"
                }`}
              >
                {diagnosisStatus.replace(/_/g, " ")}
              </span>

              {/* Confidence Category */}
              <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-mono font-bold text-slate-300">
                Confidence: {confidenceCategory}
              </span>

              {/* Grounding Verification Badge */}
              <span
                className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-mono font-bold ${
                  groundingValidation.isFullyGrounded
                    ? "bg-emerald-950/40 text-emerald-400 border border-emerald-800/40"
                    : "bg-amber-950/40 text-amber-400 border border-amber-800/40"
                }`}
              >
                <CheckCircle2 className="h-3 w-3" />
                <span>
                  {Math.round(groundingValidation.groundingScore * 100)}% Evidence Grounded
                </span>
              </span>
            </div>

            <h2 className="mt-2 text-xl font-bold text-white tracking-tight">
              AI Incident Investigation
            </h2>
            <p className="mt-1 text-xs text-slate-400 font-mono">
              Provider: {metadata.provider} ({metadata.model}) · Latency: {metadata.executionTimeMs}ms
              {metadata.totalTokens ? ` · Tokens: ${metadata.totalTokens}` : ""}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleCopyReport}
              className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition-all"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copied ? "Copied Markdown" : "Copy SRE Brief"}</span>
            </button>

            <button
              onClick={handleRunInvestigation}
              disabled={analyzing}
              className="flex items-center gap-2 rounded-xl bg-purple-600 hover:bg-purple-500 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-purple-600/30 transition-all disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${analyzing ? "animate-spin" : ""}`} />
              <span>{analyzing ? "Re-analyzing..." : "Re-Run Investigation"}</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-950/30 p-3 text-xs text-rose-300 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
        )}

        {/* Executive Summary & Verified Impact */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <span className="text-[11px] font-bold font-mono uppercase text-purple-400 block mb-1">
              Executive Incident Summary
            </span>
            <p className="text-slate-200 leading-relaxed font-sans">{summary}</p>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <span className="text-[11px] font-bold font-mono uppercase text-blue-400 block mb-1">
              Verified Operational Impact
            </span>
            <p className="text-slate-200 leading-relaxed font-sans">{verifiedImpact}</p>
          </div>
        </div>

        {/* Confidence & Deterministic Alignment Bar */}
        <div className="mt-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-xs">
          <div className="flex items-center gap-2">
            <HelpCircle className="h-4 w-4 text-slate-400 shrink-0" />
            <span className="text-slate-300">
              <strong className="text-slate-100 font-mono">{confidenceCategory} Confidence:</strong>{" "}
              {confidenceExplanation}
            </span>
          </div>

          <div className="flex items-center gap-2 font-mono text-[11px] shrink-0">
            {deterministicAlignment.alignedWithDeterministicEngine ? (
              <span className="rounded bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 text-emerald-400 flex items-center gap-1">
                <Check className="h-3 w-3" />
                <span>Deterministic Engine Aligned</span>
              </span>
            ) : (
              <span className="rounded bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 text-amber-400">
                Deterministic Engine: #{deterministicAlignment.deterministicCandidateRank ?? "Unranked"} ({deterministicAlignment.topDeterministicCandidateId})
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Ranked Hypotheses View */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold font-mono uppercase text-slate-300 tracking-wider flex items-center gap-2">
            <Layers className="h-4 w-4 text-purple-400" />
            <span>Ranked Hypotheses ({rankedHypotheses.length})</span>
          </h3>
          <span className="text-xs text-slate-400 font-mono">
            Every claim grounded in verified telemetry signals
          </span>
        </div>

        <div className="space-y-3">
          {rankedHypotheses.map((hyp) => {
            const isExpanded = expandedHypothesis === hyp.rank;
            const isTopRank = hyp.rank === 1;

            return (
              <div
                key={hyp.rank}
                className={`rounded-2xl border transition-all ${
                  isTopRank
                    ? "border-purple-500/50 bg-gradient-to-r from-purple-950/20 via-slate-900/80 to-slate-900/90 shadow-lg"
                    : "border-slate-800 bg-slate-900/60"
                }`}
              >
                {/* Hypothesis Header / Toggle */}
                <button
                  type="button"
                  onClick={() => setExpandedHypothesis(isExpanded ? null : hyp.rank)}
                  className="w-full text-left p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`flex h-8 w-8 items-center justify-center rounded-xl font-mono text-xs font-black shrink-0 ${
                        isTopRank
                          ? "bg-purple-600 text-white shadow-md shadow-purple-600/40"
                          : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      #{hyp.rank}
                    </div>

                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-bold text-white tracking-tight">
                          {hyp.serviceName}
                        </span>
                        <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-400">
                          {hyp.serviceId}
                        </span>
                        <span className="rounded border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 font-mono text-[10px] text-purple-300">
                          {hyp.confidenceCategory} Confidence
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-300 leading-relaxed font-sans">
                        {hyp.hypothesis}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0 self-end sm:self-center">
                    <span className="text-[11px] font-mono text-slate-400">
                      {hyp.supportingEvidenceIds.length} Evidence Citation(s)
                    </span>
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4 text-slate-400" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-slate-400" />
                    )}
                  </div>
                </button>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="border-t border-slate-800/80 p-5 space-y-4">
                    {/* Blast Radius & Rationale */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5">
                        <span className="text-[10px] font-mono font-bold uppercase text-purple-400 block mb-1">
                          Confidence Rationale
                        </span>
                        <p className="text-slate-300 leading-relaxed">{hyp.confidenceExplanation}</p>
                      </div>

                      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5">
                        <span className="text-[10px] font-mono font-bold uppercase text-blue-400 block mb-1">
                          Downstream Blast Radius
                        </span>
                        <div className="flex flex-wrap gap-1.5 mt-1">
                          {hyp.blastRadius.length === 0 ? (
                            <span className="text-slate-500 italic">No downstream services affected</span>
                          ) : (
                            hyp.blastRadius.map((dep) => (
                              <span
                                key={dep}
                                className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-300"
                              >
                                {dep}
                              </span>
                            ))
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Cited Evidence IDs */}
                    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                      <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                        <span className="text-xs font-bold font-mono uppercase text-emerald-400">
                          Grounded Supporting Evidence Citations ({hyp.supportingEvidenceIds.length})
                        </span>
                        {onNavigateToEvidence && (
                          <button
                            type="button"
                            onClick={onNavigateToEvidence}
                            className="inline-flex items-center gap-1 text-[11px] font-mono text-blue-400 hover:text-blue-300"
                          >
                            <span>Inspect Timeline</span>
                            <ArrowRight className="h-3 w-3" />
                          </button>
                        )}
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {hyp.supportingEvidenceIds.length === 0 ? (
                          <p className="text-xs text-slate-500 italic">No supporting evidence cited.</p>
                        ) : (
                          hyp.supportingEvidenceIds.map((evId) => (
                            <span
                              key={evId}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-900/40 bg-emerald-950/30 px-2.5 py-1 font-mono text-[11px] text-emerald-300"
                            >
                              <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                              <span>Evidence ID: {evId}</span>
                            </span>
                          ))
                        )}
                      </div>

                      {/* Contradicting Evidence if any */}
                      {hyp.contradictingEvidenceIds && hyp.contradictingEvidenceIds.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-slate-800">
                          <span className="text-xs font-bold font-mono uppercase text-rose-400 block mb-2">
                            Contradicting / Counter Signals ({hyp.contradictingEvidenceIds.length})
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {hyp.contradictingEvidenceIds.map((evId) => (
                              <span
                                key={evId}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-900/40 bg-rose-950/30 px-2.5 py-1 font-mono text-[11px] text-rose-300"
                              >
                                <AlertTriangle className="h-3 w-3 text-rose-400" />
                                <span>Signal ID: {evId}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Recommended Diagnostic Checks & Remediation */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recommended Checks */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold font-mono uppercase text-blue-400 flex items-center gap-2">
              <Search className="h-4 w-4" />
              <span>Recommended Diagnostic Checks (Read-Only)</span>
            </h4>
            <span className="text-[10px] font-mono text-slate-400">Zero Side-Effects</span>
          </div>

          <div className="space-y-3">
            {recommendedChecks.map((check, idx) => (
              <div
                key={idx}
                className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5 text-xs space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="rounded bg-blue-500/20 px-2 py-0.5 font-mono text-[10px] font-bold text-blue-300">
                    {check.type}
                  </span>
                  <span className="font-mono text-[11px] text-slate-400">{check.serviceId}</span>
                </div>
                <p className="text-slate-200 leading-relaxed font-sans">{check.description}</p>
                <div className="text-[11px] font-mono text-slate-400">
                  <strong className="text-emerald-400">Expected Signal:</strong> {check.expectedSignal}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Safe Remediation Options */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold font-mono uppercase text-purple-400 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              <span>Safe Remediation Options (Human Approval Required)</span>
            </h4>
            <span className="text-[10px] font-mono text-rose-400">No Auto-Execution</span>
          </div>

          <div className="space-y-3">
            {remediationOptions.map((rem, idx) => (
              <div
                key={idx}
                className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5 text-xs space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-purple-500/20 px-2 py-0.5 font-mono text-[10px] font-bold text-purple-300">
                      {rem.actionType}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold ${
                        rem.riskLevel === "LOW"
                          ? "bg-emerald-500/20 text-emerald-300"
                          : rem.riskLevel === "MEDIUM"
                          ? "bg-amber-500/20 text-amber-300"
                          : "bg-rose-500/20 text-rose-300"
                      }`}
                    >
                      Risk: {rem.riskLevel}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-slate-400">{rem.targetServiceId}</span>
                </div>

                <p className="text-slate-200 leading-relaxed font-sans">{rem.description}</p>
                <div className="text-[11px] font-mono text-slate-400">
                  <strong className="text-slate-300">Prerequisites:</strong> {rem.prerequisites}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Missing Evidence & Next Observations */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 space-y-2">
          <span className="text-[11px] font-mono font-bold uppercase text-slate-400 flex items-center gap-1.5">
            <Cpu className="h-3.5 w-3.5 text-slate-400" />
            <span>Missing Telemetry & Observable Limitations</span>
          </span>
          <ul className="space-y-1 text-slate-300 list-disc list-inside">
            {missingEvidence.map((m, idx) => (
              <li key={idx} className="leading-relaxed">
                {m}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 space-y-2">
          <span className="text-[11px] font-mono font-bold uppercase text-slate-400 flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5 text-slate-400" />
            <span>Next Observations (15–30 Minute Window)</span>
          </span>
          <ul className="space-y-1 text-slate-300 list-disc list-inside">
            {nextObservations.map((o, idx) => (
              <li key={idx} className="leading-relaxed">
                {o}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
