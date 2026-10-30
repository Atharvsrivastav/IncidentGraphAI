"use client";

import { useEffect, useState, use, Suspense, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, Zap, RefreshCw, FileText, Sparkles } from "lucide-react";
import { AiInvestigationSection } from "@/components/incident/AiInvestigationSection";

interface SupportingSignal {
  scoreContribution: number;
  description: string;
}

interface ContradictorySignal {
  penalty: number;
  description: string;
}

interface IncidentCandidate {
  id: string;
  rank: number;
  candidateServiceId: string;
  score: number;
  confidence: string;
  explanation: string;
  recommendedAction: string;
  supportingEvidence: string;
  contradictoryEvidence: string;
  service?: {
    name: string;
    tier: number;
    serviceType: string;
  };
}

interface IncidentEvidenceItem {
  id: string;
  serviceId: string;
  evidenceType: string;
  timestamp: string;
  explanation: string;
  observedValue: number;
  expectedValue: number;
  threshold: number;
  unit: string;
  service?: {
    name: string;
  };
}

interface IncidentDetail {
  id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  rootCauseCandidates?: IncidentCandidate[];
  evidences?: IncidentEvidenceItem[];
}

function IncidentDetailContent({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [incident, setIncident] = useState<IncidentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [activeTab, setActiveTab] = useState<"ai-investigation" | "root-causes" | "evidence">("ai-investigation");

  const fetchIncident = useCallback(async () => {
    try {
      const res = await fetch(`/api/incidents/${id}`);
      if (res.ok) {
        const data = await res.json();
        setIncident(data.incident);
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchIncident();
  }, [fetchIncident]);

  const handleReanalyze = async () => {
    setAnalyzing(true);
    try {
      await fetch(`/api/incidents/${id}/analyze`, { method: "POST" });
      await fetchIncident();
    } finally {
      setAnalyzing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="flex items-center gap-3 text-slate-400 font-mono text-sm">
          <RefreshCw className="h-5 w-5 animate-spin text-blue-500" />
          <span>Loading incident triage data...</span>
        </div>
      </div>
    );
  }

  if (!incident) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center text-slate-400">
        <p>Incident not found.</p>
        <Link href="/incidents" className="mt-4 inline-block text-blue-400 underline">
          Back to incidents
        </Link>
      </div>
    );
  }

  const candidates = incident.rootCauseCandidates ?? [];
  const evidences = incident.evidences ?? [];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-6">
      {/* Back button & Title Header */}
      <div>
        <Link
          href="/incidents"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back to Incidents</span>
        </Link>

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl backdrop-blur-md">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded px-2.5 py-0.5 text-xs font-mono font-bold ${
                  incident.severity === "CRITICAL"
                    ? "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                    : "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                }`}
              >
                {incident.severity}
              </span>
              <span className="rounded bg-slate-800 px-2 py-0.5 text-xs font-mono text-slate-300">
                {incident.status}
              </span>
              <span className="text-xs font-mono text-slate-400">ID: {incident.id}</span>
            </div>

            <h1 className="mt-2 text-2xl font-black text-white tracking-tight sm:text-3xl">
              {incident.title}
            </h1>
            <p className="mt-1 text-xs text-slate-300 max-w-3xl leading-relaxed">
              {incident.description}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleReanalyze}
              disabled={analyzing}
              className="flex items-center gap-2 rounded-xl bg-purple-600 hover:bg-purple-500 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-purple-600/30 transition-all disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${analyzing ? "animate-spin" : ""}`} />
              <span>Re-Run DSA Root-Cause Engine</span>
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800">
        <button
          onClick={() => setActiveTab("ai-investigation")}
          className={`flex items-center gap-2 border-b-2 px-4 py-3 text-xs font-semibold transition-colors ${
            activeTab === "ai-investigation"
              ? "border-purple-500 text-purple-400 font-bold"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Sparkles className="h-4 w-4" />
          <span>AI Investigation</span>
        </button>
        <button
          onClick={() => setActiveTab("root-causes")}
          data-testid="ranked-root-causes-tab"
          className={`flex items-center gap-2 border-b-2 px-4 py-3 text-xs font-semibold transition-colors ${
            activeTab === "root-causes"
              ? "border-purple-500 text-purple-400 font-bold"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Zap className="h-4 w-4" />
          <span>Ranked Root Causes (DSA) ({candidates.length})</span>
        </button>
        <button
          onClick={() => setActiveTab("evidence")}
          className={`flex items-center gap-2 border-b-2 px-4 py-3 text-xs font-semibold transition-colors ${
            activeTab === "evidence"
              ? "border-blue-500 text-blue-400 font-bold"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <FileText className="h-4 w-4" />
          <span>Evidence Timeline ({evidences.length})</span>
        </button>
      </div>

      {/* Tab 0: AI Investigation */}
      {activeTab === "ai-investigation" && (
        <AiInvestigationSection
          incidentId={id}
          onNavigateToEvidence={() => setActiveTab("evidence")}
        />
      )}

      {/* Tab 1: Ranked Root Causes */}
      {activeTab === "root-causes" && (
        <div className="space-y-4">
          {candidates.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center text-xs text-slate-400 italic">
              No root cause candidates ranked yet. Advance simulation or click Re-Run DSA Engine.
            </div>
          ) : (
            candidates.map((cand) => {
              let supporting: SupportingSignal[] = [];
              let contradictory: ContradictorySignal[] = [];
              try {
                supporting = JSON.parse(cand.supportingEvidence || "[]");
                contradictory = JSON.parse(cand.contradictoryEvidence || "[]");
              } catch {
                // Handled gracefully
              }

              const isTopRank = cand.rank === 1;

              return (
                <div
                  key={cand.id}
                  className={`rounded-2xl border p-6 transition-all ${
                    isTopRank
                      ? "border-purple-500/60 bg-gradient-to-r from-purple-950/20 via-slate-900/80 to-slate-900/90 shadow-xl"
                      : "border-slate-800 bg-slate-900/60"
                  }`}
                >
                  {/* Candidate Header */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-800/80">
                    <div className="flex items-center gap-3">
                      <div
                        className={`flex h-9 w-9 items-center justify-center rounded-xl font-mono text-sm font-black ${
                          isTopRank
                            ? "bg-purple-600 text-white shadow-lg shadow-purple-600/40"
                            : "bg-slate-800 text-slate-400"
                        }`}
                      >
                        #{cand.rank}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-base font-bold text-white tracking-tight">
                            {cand.service?.name ?? cand.candidateServiceId}
                          </h3>
                          <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-mono text-slate-400">
                            Tier {cand.service?.tier} · {cand.service?.serviceType}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-slate-400">{cand.explanation}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2.5">
                      <div className="rounded-xl border border-purple-500/40 bg-purple-500/10 px-3 py-1 text-center">
                        <span className="text-[10px] font-mono text-purple-400 block uppercase">
                          Heuristic Score
                        </span>
                        <span className="text-sm font-black font-mono text-purple-300">
                          {cand.score} / 100
                        </span>
                      </div>
                      <span className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-mono font-semibold text-slate-300">
                        {cand.confidence}
                      </span>
                    </div>
                  </div>

                  {/* Evidence Breakdown Grid */}
                  <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Supporting Evidence */}
                    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                      <span className="text-xs font-bold font-mono uppercase text-emerald-400">
                        Supporting Evidence Signals ({supporting.length})
                      </span>
                      <div className="mt-2.5 space-y-2">
                        {supporting.length === 0 ? (
                          <p className="text-xs text-slate-500 italic">No positive signals.</p>
                        ) : (
                          supporting.map((ev, idx) => (
                            <div
                              key={idx}
                              className="flex items-start gap-2 rounded-lg bg-emerald-950/20 border border-emerald-900/30 p-2.5 text-xs text-slate-200"
                            >
                              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-emerald-400 shrink-0">
                                +{ev.scoreContribution} pts
                              </span>
                              <span>{ev.description}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* Contradictory Evidence & Recommended Action */}
                    <div className="space-y-4">
                      {contradictory.length > 0 && (
                        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                          <span className="text-xs font-bold font-mono uppercase text-rose-400">
                            Contradictory Penalties
                          </span>
                          <div className="mt-2 space-y-2">
                            {contradictory.map((c, idx) => (
                              <div
                                key={idx}
                                className="flex items-start gap-2 rounded-lg bg-rose-950/20 border border-rose-900/30 p-2.5 text-xs text-slate-200"
                              >
                                <span className="rounded bg-rose-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-rose-400 shrink-0">
                                  -{c.penalty} pts
                                </span>
                                <span>{c.description}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="rounded-xl border border-blue-900/40 bg-blue-950/20 p-4">
                        <span className="text-xs font-bold font-mono uppercase text-blue-400">
                          Recommended SRE Remediation
                        </span>
                        <p className="mt-2 text-xs text-slate-200 leading-relaxed font-sans">
                          {cand.recommendedAction}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Tab 2: Evidence Timeline */}
      {activeTab === "evidence" && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-md">
          {evidences.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400 italic">
              No evidence recorded yet.
            </div>
          ) : (
            <div className="relative pl-6 space-y-6 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-800">
              {evidences.map((ev) => (
                <div key={ev.id} className="relative flex items-start gap-4">
                  <div className="absolute -left-[19px] top-1 h-3.5 w-3.5 rounded-full border-2 border-slate-950 bg-blue-500 shadow-md" />
                  <div className="flex-1 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-100 text-xs">
                          {ev.service?.name ?? ev.serviceId}
                        </span>
                        <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-400">
                          {ev.evidenceType}
                        </span>
                      </div>
                      <span className="font-mono text-[11px] text-slate-400">
                        {new Date(ev.timestamp).toLocaleTimeString()}
                      </span>
                    </div>

                    <p className="mt-2 text-xs text-slate-300 leading-relaxed">{ev.explanation}</p>

                    <div className="mt-3 flex items-center gap-4 text-[11px] font-mono text-slate-400">
                      <span>Observed: <strong className="text-rose-400">{Math.round(ev.observedValue)}{ev.unit}</strong></span>
                      <span>Expected: <strong className="text-emerald-400">{Math.round(ev.expectedValue)}{ev.unit}</strong></span>
                      <span>Threshold: {Math.round(ev.threshold)}{ev.unit}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function IncidentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense
      fallback={
        <div className="flex h-96 items-center justify-center">
          <div className="flex items-center gap-3 text-slate-400 font-mono text-sm">
            <span>Loading incident triage data...</span>
          </div>
        </div>
      }
    >
      <IncidentDetailContent params={params} />
    </Suspense>
  );
}
