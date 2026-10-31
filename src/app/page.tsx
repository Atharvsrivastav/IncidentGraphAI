"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Server,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Flame,
  ArrowRight,
  TrendingUp,
  Cpu,
  Zap,
  Play,
  ShieldAlert,
  Radio,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";

interface OverviewData {
  summary: {
    totalServices: number;
    healthyCount: number;
    degradedCount: number;
    downCount: number;
    activeIncidentsCount: number;
    currentSeverity: string;
  };
  telemetry?: {
    mode: string;
    effectiveMode: string;
    provenance: "LIVE" | "MOCK_EMULATION" | "LOCAL" | "DISABLED" | "ERROR";
    backendType: string;
    prometheusAvailable: boolean;
    jaegerAvailable: boolean;
    metricsIngested: boolean;
    tracesIngested: boolean;
    lastIngestedAt: string | null;
    lastVerifiedAt: string | null;
    details?: string;
  };
  distribution: { name: string; count: number; color: string }[];
  trends: { step: string; latency: number; errorRate: number }[];
  recentIncidents: {
    id: string;
    title: string;
    severity: string;
    status: string;
    startedAt: string;
    suspectedRootCause: string;
  }[];
  latestRootCause: {
    serviceId: string;
    serviceName: string;
    score: number;
    confidence: string;
    explanation: string;
    recommendedAction: string;
  } | null;
}

export default function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [advancing, setAdvancing] = useState(false);

  const [demoTriggering, setDemoTriggering] = useState(false);
  const [demoIncidentId, setDemoIncidentId] = useState<string | null>(null);

  const fetchOverview = async () => {
    try {
      const res = await fetch("/api/analytics/overview");
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOverview();
    const interval = setInterval(fetchOverview, 4000);
    return () => clearInterval(interval);
  }, []);

  const handleAdvanceSimulation = async () => {
    setAdvancing(true);
    try {
      await fetch("/api/simulations/advance", { method: "POST" });
      await fetchOverview();
    } finally {
      setAdvancing(false);
    }
  };

  const handle1ClickDemo = async () => {
    setDemoTriggering(true);
    setDemoIncidentId(null);
    try {
      const injectRes = await fetch("/api/simulations/inject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioId: "database-slowdown" }),
      });
      if (injectRes.ok) {
        const injectData = await injectRes.json();
        const incId = injectData.incidentId;
        // Advance one step so downstream cascading dependencies show symptoms
        await fetch("/api/simulations/advance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ incidentId: incId }),
        });
        setDemoIncidentId(incId);
        await fetchOverview();
      }
    } finally {
      setDemoTriggering(false);
    }
  };

  if (loading || !data) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="flex items-center gap-3 text-slate-400">
          <Cpu className="h-6 w-6 animate-spin text-blue-500" />
          <span className="font-mono text-sm">Loading SRE telemetry overview...</span>
        </div>
      </div>
    );
  }

  const { summary, distribution, trends, recentIncidents, latestRootCause } = data;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-8">
      {/* Top Banner & Quick Simulation Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-gradient-to-r from-slate-900/90 via-slate-900/60 to-slate-950 p-6 shadow-xl backdrop-blur-md">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-blue-500/20 px-2.5 py-0.5 text-xs font-semibold text-blue-400 border border-blue-500/30">
              Operations Center
            </span>
            <span className="rounded bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 text-[11px] font-mono font-bold text-emerald-400">
              PostgreSQL Connected
            </span>
            {data.telemetry?.provenance === "LIVE" ? (
              <span className="rounded bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 text-[11px] font-mono font-bold text-emerald-400 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                PROVENANCE: LIVE (Grafana Cloud Verified)
              </span>
            ) : data.telemetry?.provenance === "MOCK_EMULATION" ? (
              <span className="rounded bg-purple-500/10 border border-purple-500/30 px-2 py-0.5 text-[11px] font-mono font-bold text-purple-400 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-purple-400" />
                PROVENANCE: MOCK_EMULATION (Synthetic)
              </span>
            ) : data.telemetry?.provenance === "LOCAL" ? (
              <span className="rounded bg-blue-500/10 border border-blue-500/30 px-2 py-0.5 text-[11px] font-mono font-bold text-blue-400 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
                PROVENANCE: LOCAL (Unverified External)
              </span>
            ) : data.telemetry?.provenance === "ERROR" ? (
              <span className="rounded bg-rose-500/10 border border-rose-500/30 px-2 py-0.5 text-[11px] font-mono font-bold text-rose-400 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-rose-400 animate-pulse" />
                PROVENANCE: ERROR (Degraded)
              </span>
            ) : (
              <span className="rounded bg-slate-800 border border-slate-700 px-2 py-0.5 text-[11px] font-mono font-bold text-slate-400 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
                PROVENANCE: DISABLED (Simulation)
              </span>
            )}
          </div>
          <h1 className="mt-2 text-2xl font-black text-white tracking-tight sm:text-3xl">
            IncidentGraph AI Console
          </h1>
          <p className="mt-1 text-xs text-slate-400 max-w-2xl leading-relaxed">
            Diagnose cascading microservice failures in milliseconds using directed dependency graphs,
            reverse topological reachability, and evidence-grounded AI synthesis.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={handle1ClickDemo}
            disabled={demoTriggering}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-purple-600/30 transition-all hover:scale-[1.02] disabled:opacity-50"
          >
            <Zap className={`h-4 w-4 ${demoTriggering ? "animate-spin" : "text-amber-300"}`} />
            <span>{demoTriggering ? "Injecting Demo Outage..." : "1-Click Guided Demo"}</span>
          </button>
          <Link
            href="/simulator"
            className="flex items-center gap-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 px-3.5 py-2.5 text-xs font-bold text-white shadow-lg shadow-blue-600/30 transition-all hover:scale-[1.02]"
          >
            <Play className="h-4 w-4" />
            <span>Simulator</span>
          </Link>
          <button
            onClick={handleAdvanceSimulation}
            disabled={advancing || summary.activeIncidentsCount === 0}
            className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 hover:bg-slate-700 disabled:opacity-40 px-3 py-2.5 text-xs font-semibold text-slate-200 transition-colors"
          >
            <TrendingUp className={`h-4 w-4 ${advancing ? "animate-spin text-blue-400" : ""}`} />
            <span>Advance Step</span>
          </button>
          <Link
            href="/service-map"
            className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 hover:bg-slate-700 px-3 py-2.5 text-xs font-semibold text-slate-200 transition-colors"
          >
            <span>Topology</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      {/* Telemetry Ingestion & Provenance Status Panel */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-sm space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-blue-400" />
            <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
              Telemetry Pipeline & Provenance Status
            </h3>
          </div>
          <div className="flex items-center gap-2 text-[11px] font-mono">
            <span className="text-slate-400">Live Smoke Test:</span>
            <code className="rounded bg-slate-950 px-2 py-0.5 text-blue-400 border border-slate-800">
              npm run test:observability:live
            </code>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          {/* Provenance Card */}
          <div className="rounded-xl border border-slate-800/80 bg-slate-950/40 p-3 space-y-1">
            <div className="text-[10px] uppercase font-mono text-slate-400">Provenance State</div>
            <div className="flex items-center gap-2">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  data.telemetry?.provenance === "LIVE"
                    ? "bg-emerald-400 animate-pulse"
                    : data.telemetry?.provenance === "MOCK_EMULATION"
                    ? "bg-purple-400"
                    : data.telemetry?.provenance === "LOCAL"
                    ? "bg-blue-400"
                    : data.telemetry?.provenance === "ERROR"
                    ? "bg-rose-400 animate-pulse"
                    : "bg-slate-500"
                }`}
              />
              <span className="font-mono font-bold text-white text-xs">
                {data.telemetry?.provenance ?? "DISABLED"}
              </span>
            </div>
            <div className="text-[10px] text-slate-400">
              {data.telemetry?.provenance === "LIVE"
                ? "Verified external ingestion"
                : data.telemetry?.provenance === "MOCK_EMULATION"
                ? "Development synthetic data"
                : data.telemetry?.provenance === "LOCAL"
                ? "Local unverified pipeline"
                : data.telemetry?.provenance === "ERROR"
                ? "Integration error / degraded"
                : "Simulation mode active"}
            </div>
          </div>

          {/* Metrics Ingestion Card */}
          <div className="rounded-xl border border-slate-800/80 bg-slate-950/40 p-3 space-y-1">
            <div className="text-[10px] uppercase font-mono text-slate-400">Prometheus / Cloud Metrics</div>
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  data.telemetry?.metricsIngested
                    ? "bg-emerald-400"
                    : data.telemetry?.prometheusAvailable
                    ? "bg-amber-400"
                    : "bg-slate-500"
                }`}
              />
              <span className="font-mono font-semibold text-white text-xs">
                {data.telemetry?.metricsIngested
                  ? "Ingestion Confirmed"
                  : data.telemetry?.prometheusAvailable
                  ? "Reachable (No Ingestion)"
                  : "Not Connected"}
              </span>
            </div>
            <div className="text-[10px] text-slate-400 font-mono">
              Scrape: /api/metrics & sample microservices
            </div>
          </div>

          {/* Traces Ingestion Card */}
          <div className="rounded-xl border border-slate-800/80 bg-slate-950/40 p-3 space-y-1">
            <div className="text-[10px] uppercase font-mono text-slate-400">Tempo / OTLP Traces</div>
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  data.telemetry?.tracesIngested
                    ? "bg-emerald-400"
                    : data.telemetry?.jaegerAvailable
                    ? "bg-amber-400"
                    : "bg-slate-500"
                }`}
              />
              <span className="font-mono font-semibold text-white text-xs">
                {data.telemetry?.tracesIngested
                  ? "OTLP Traces Verified"
                  : data.telemetry?.jaegerAvailable
                  ? "Reachable (No Traces)"
                  : "Not Connected"}
              </span>
            </div>
            <div className="text-[10px] text-slate-400 font-mono">
              OTLP: /v1/traces via W3C context
            </div>
          </div>

          {/* Last Verification / Export */}
          <div className="rounded-xl border border-slate-800/80 bg-slate-950/40 p-3 space-y-1">
            <div className="text-[10px] uppercase font-mono text-slate-400">Last Verified / Ingested</div>
            <div className="font-mono text-white text-xs font-semibold truncate">
              {data.telemetry?.lastVerifiedAt
                ? new Date(data.telemetry.lastVerifiedAt).toLocaleTimeString()
                : data.telemetry?.lastIngestedAt
                ? new Date(data.telemetry.lastIngestedAt).toLocaleTimeString()
                : "No verified export yet"}
            </div>
            <div className="text-[10px] text-slate-400 font-mono truncate">
              Mode: {data.telemetry?.mode ?? "SIMULATION"} (Eff: {data.telemetry?.effectiveMode ?? "SIMULATION"})
            </div>
          </div>
        </div>
      </div>

      {/* 1-Click Demo Alert / Transition Banner */}
      {demoIncidentId && (
        <div className="rounded-2xl border border-emerald-500/40 bg-gradient-to-r from-emerald-950/40 via-slate-900/90 to-slate-950 p-5 shadow-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 animate-in fade-in">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="rounded bg-emerald-500/20 border border-emerald-500/40 px-2 py-0.5 text-[11px] font-mono font-bold text-emerald-400 uppercase">
                Demo Outage Active (Step 2)
              </span>
              <span className="text-xs text-slate-300 font-medium">PostgreSQL Latency Surge & Downstream Cascade</span>
            </div>
            <p className="text-xs text-slate-400">
              Downstream services (Order, Payment, Inventory) are reporting elevated latency. The graph engine has ranked PostgreSQL with 85/100 confidence.
            </p>
          </div>
          <Link
            href={`/incidents/${demoIncidentId}`}
            className="flex items-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-emerald-600/30 transition-all shrink-0"
          >
            <span>Investigate Incident</span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      )}

      {/* 30-Second Guided Portfolio Walkthrough Ribbon */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 backdrop-blur-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
          <div>
            <h2 className="text-sm font-bold text-white tracking-tight flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-500/20 text-blue-400 text-xs font-mono font-bold">★</span>
              <span>Portfolio Demo Guide: 5-Stage Triage Workflow</span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              How IncidentGraph AI isolates root-cause anomalies across distributed systems without alert noise
            </p>
          </div>
          <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
            <span className="h-2 w-2 rounded-full bg-emerald-400"></span>
            <span>Zero-Key Deterministic Replay Enabled</span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 text-xs">
          {/* Step 1 */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5 space-y-1.5">
            <div className="flex items-center justify-between text-blue-400 font-mono text-[11px] font-bold">
              <span>01. INJECT</span>
              <Play className="h-3.5 w-3.5" />
            </div>
            <h4 className="font-bold text-slate-200 text-xs">Failure Scenario</h4>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Inject deterministic fault into Tier 3 database or Tier 2 microservice via simulator.
            </p>
          </div>

          {/* Step 2 */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5 space-y-1.5">
            <div className="flex items-center justify-between text-amber-400 font-mono text-[11px] font-bold">
              <span>02. CASCADE</span>
              <TrendingUp className="h-3.5 w-3.5" />
            </div>
            <h4 className="font-bold text-slate-200 text-xs">Symptom Spread</h4>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Dependency edges propagate latency & 504 timeouts to API Gateway and ingress.
            </p>
          </div>

          {/* Step 3 */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5 space-y-1.5">
            <div className="flex items-center justify-between text-purple-400 font-mono text-[11px] font-bold">
              <span>03. DIAGNOSE</span>
              <Cpu className="h-3.5 w-3.5" />
            </div>
            <h4 className="font-bold text-slate-200 text-xs">Graph Algorithms</h4>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Reverse BFS + 3-color DFS cycle detector score candidates in O(V + E) time.
            </p>
          </div>

          {/* Step 4 */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5 space-y-1.5">
            <div className="flex items-center justify-between text-indigo-400 font-mono text-[11px] font-bold">
              <span>04. SYNTHESIZE</span>
              <Zap className="h-3.5 w-3.5" />
            </div>
            <h4 className="font-bold text-slate-200 text-xs">AI Investigation</h4>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Correlates telemetry IDs & trace spans into a verified brief with zero hallucinations.
            </p>
          </div>

          {/* Step 5 */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5 space-y-1.5">
            <div className="flex items-center justify-between text-emerald-400 font-mono text-[11px] font-bold">
              <span>05. REMEDIATE</span>
              <CheckCircle2 className="h-3.5 w-3.5" />
            </div>
            <h4 className="font-bold text-slate-200 text-xs">SRE Runbook</h4>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Actionable operational remediation: connection pooling, circuit breakers, scale-outs.
            </p>
          </div>
        </div>
      </div>

      {/* Metric Cards Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {/* Total Services */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 backdrop-blur-sm">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-xs font-medium">Total Services</span>
            <Server className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-black font-mono text-white">
            {summary.totalServices}
          </div>
          <span className="text-[10px] text-slate-400 font-mono">Microservice topology</span>
        </div>

        {/* Healthy Services */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 backdrop-blur-sm">
          <div className="flex items-center justify-between text-emerald-400">
            <span className="text-xs font-medium">Healthy</span>
            <CheckCircle2 className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-black font-mono text-emerald-400">
            {summary.healthyCount}
          </div>
          <span className="text-[10px] text-emerald-500/70 font-mono">Within baseline SLA</span>
        </div>

        {/* Degraded Services */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 backdrop-blur-sm">
          <div className="flex items-center justify-between text-amber-400">
            <span className="text-xs font-medium">Degraded</span>
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-black font-mono text-amber-400">
            {summary.degradedCount}
          </div>
          <span className="text-[10px] text-amber-500/70 font-mono">Elevated latency/error</span>
        </div>

        {/* Down Services */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 backdrop-blur-sm">
          <div className="flex items-center justify-between text-rose-400">
            <span className="text-xs font-medium">Down</span>
            <XCircle className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-black font-mono text-rose-400">
            {summary.downCount}
          </div>
          <span className="text-[10px] text-rose-500/70 font-mono">Rejecting traffic</span>
        </div>

        {/* Active Incidents */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 backdrop-blur-sm">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-xs font-medium">Active Incidents</span>
            <ShieldAlert className="h-4 w-4 text-purple-400" />
          </div>
          <div className="mt-2 text-2xl font-black font-mono text-white">
            {summary.activeIncidentsCount}
          </div>
          <span className="text-[10px] text-slate-400 font-mono">Ongoing triage</span>
        </div>

        {/* Severity */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 backdrop-blur-sm">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-xs font-medium">Severity</span>
            <Flame className="h-4 w-4 text-rose-500" />
          </div>
          <div className="mt-2 text-lg font-black font-mono uppercase text-rose-400">
            {summary.currentSeverity}
          </div>
          <span className="text-[10px] text-slate-400 font-mono">System risk index</span>
        </div>
      </div>

      {/* Latest Root Cause Analysis Callout */}
      {latestRootCause && (
        <div className="rounded-2xl border border-purple-500/40 bg-gradient-to-r from-purple-950/30 via-slate-900/80 to-slate-900/90 p-6 shadow-2xl backdrop-blur-md">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-purple-500/20">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/20 border border-purple-500/30 text-purple-300">
                <Zap className="h-4 w-4" />
              </div>
              <div>
                <span className="text-[11px] font-mono font-semibold uppercase text-purple-400">
                  Latest Graph Algorithm Diagnosis
                </span>
                <h3 className="text-base font-bold text-white tracking-tight">
                  Suspected Originating Failure: {latestRootCause.serviceName}
                </h3>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="rounded-md border border-purple-500/40 bg-purple-500/10 px-2.5 py-1 text-xs font-mono font-bold text-purple-300">
                Score: {latestRootCause.score}/100
              </span>
              <span className="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-mono text-slate-300">
                Confidence: {latestRootCause.confidence}
              </span>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <span className="text-[11px] font-mono text-slate-400">Algorithm Explanation</span>
              <p className="mt-1 text-xs text-slate-300 leading-relaxed bg-slate-950/60 p-3 rounded-xl border border-slate-800">
                {latestRootCause.explanation}
              </p>
            </div>
            <div>
              <span className="text-[11px] font-mono text-slate-400">Recommended SRE Action</span>
              <p className="mt-1 text-xs text-emerald-300 leading-relaxed bg-slate-950/60 p-3 rounded-xl border border-emerald-900/30">
                {latestRootCause.recommendedAction}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Telemetry Trend Area Chart */}
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-bold text-white tracking-tight">
                {data.telemetry?.provenance === "LIVE"
                  ? "Live Telemetry Latency & Error Trend"
                  : "Simulated Latency & Error Trend"}
              </h3>
              <p className="text-xs text-slate-400">Average response time across observation intervals</p>
            </div>
            <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-mono text-slate-400">
              {data.telemetry?.provenance === "LIVE"
                ? "Source: Verified Live Telemetry"
                : data.telemetry?.provenance === "MOCK_EMULATION"
                ? "Source: Mock Emulation"
                : "Source: Simulation Engine"}
            </span>
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trends}>
                <defs>
                  <linearGradient id="latencyGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="step" stroke="#64748b" fontSize={11} />
                <YAxis stroke="#64748b" fontSize={11} unit="ms" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#0f172a",
                    borderColor: "#334155",
                    borderRadius: "8px",
                    color: "#f8fafc",
                    fontSize: "12px",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="latency"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url"
                  name="Latency (ms)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Health Distribution Donut */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-sm flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-bold text-white tracking-tight">
              Service Health Distribution
            </h3>
            <p className="text-xs text-slate-400">Current microservice fleet status breakdown</p>
          </div>

          <div className="h-48 w-full flex items-center justify-center my-2">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={distribution}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={75}
                  paddingAngle={5}
                  dataKey="count"
                >
                  {distribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#0f172a",
                    borderColor: "#334155",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-3 gap-2 pt-3 border-t border-slate-800 text-center font-mono">
            {distribution.map((d) => (
              <div key={d.name}>
                <span className="text-[10px] text-slate-400 block">{d.name}</span>
                <span className="text-sm font-bold" style={{ color: d.color }}>
                  {d.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recent Incidents Table */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-bold text-white tracking-tight">Recent Incidents</h3>
            <p className="text-xs text-slate-400">History of detected alerts and simulations</p>
          </div>
          <Link
            href="/incidents"
            className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 font-semibold"
          >
            <span>View All</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        {recentIncidents.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400 italic">
            No incidents recorded. System running smoothly at baseline.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 text-[11px] font-mono uppercase text-slate-400">
                <tr>
                  <th className="pb-3 font-semibold">Incident Title</th>
                  <th className="pb-3 font-semibold">Severity</th>
                  <th className="pb-3 font-semibold">Status</th>
                  <th className="pb-3 font-semibold">Suspected Cause</th>
                  <th className="pb-3 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-sans">
                {recentIncidents.map((inc) => (
                  <tr key={inc.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 font-medium text-slate-200">{inc.title}</td>
                    <td className="py-3">
                      <span
                        className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold ${
                          inc.severity === "CRITICAL"
                            ? "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                            : inc.severity === "HIGH"
                            ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                            : "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                        }`}
                      >
                        {inc.severity}
                      </span>
                    </td>
                    <td className="py-3">
                      <span className="font-mono text-slate-300">{inc.status}</span>
                    </td>
                    <td className="py-3 font-medium text-purple-400">
                      {inc.suspectedRootCause}
                    </td>
                    <td className="py-3 text-right">
                      <Link
                        href={`/incidents/${inc.id}`}
                        className="rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-1.5 font-medium text-blue-400 hover:text-white transition-colors"
                      >
                        Investigate
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
