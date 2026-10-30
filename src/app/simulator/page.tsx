"use client";

import { useEffect, useState, useCallback } from "react";
import {
  RotateCcw,
  FastForward,
  Flame,
  ArrowRight,
} from "lucide-react";
import Link from "next/link";

interface Scenario {
  id: string;
  name: string;
  targetServiceId: string;
  defaultSeverity: string;
  failureType: string;
  description: string;
  totalSteps: number;
}

interface SimulatorService {
  id: string;
  name: string;
  tier: number;
  status: "HEALTHY" | "DEGRADED" | "DOWN";
  currentLatency: number;
  baselineLatency: number;
  currentErrorRate: number;
  baselineErrorRate: number;
  requestRate: number;
}

interface SimStateModel {
  status: string;
  currentStep: number;
  activeScenario: string;
  severity: string;
}

interface ActiveIncidentModel {
  id: string;
}

export default function SimulatorPage() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>("database-slowdown");
  const [services, setServices] = useState<SimulatorService[]>([]);
  const [simState, setSimState] = useState<SimStateModel | null>(null);
  const [activeIncident, setActiveIncident] = useState<ActiveIncidentModel | null>(null);
  const [actionInProgress, setActionInProgress] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [canReset, setCanReset] = useState<boolean>(false);

  const fetchState = useCallback(async () => {
    try {
      const [stateRes, svcRes] = await Promise.all([
        fetch("/api/simulations/state"),
        fetch("/api/services"),
      ]);

      if (stateRes.ok) {
        const data = await stateRes.json();
        setScenarios(data.availableScenarios ?? []);
        setSimState(data.state);
        setActiveIncident(data.activeIncident);
        if (typeof data.canReset === "boolean") {
          setCanReset(data.canReset);
        }
      }
      if (svcRes.ok) {
        const data = await svcRes.json();
        setServices(data.services ?? []);
      }
    } catch {
      // Ignored
    }
  }, []);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (active) await fetchState();
    };
    void poll();
    const interval = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [fetchState]);

  const handleInject = async () => {
    setActionInProgress(true);
    setStatusMessage("Injecting deterministic failure scenario...");
    try {
      const res = await fetch("/api/simulations/inject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioId: selectedScenarioId }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatusMessage(`Scenario started: ${data.scenarioName} (Step ${data.step})`);
        await fetchState();
      } else {
        setStatusMessage(`Error: ${data.error}`);
      }
    } finally {
      setActionInProgress(false);
    }
  };

  const handleAdvance = async () => {
    setActionInProgress(true);
    setStatusMessage("Advancing simulation step (propagating cascading effects)...");
    try {
      const res = await fetch("/api/simulations/advance", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setStatusMessage(`Advanced to Step ${data.step}: ${data.stepDescription}`);
        await fetchState();
      } else {
        setStatusMessage(`Error: ${data.error}`);
      }
    } finally {
      setActionInProgress(false);
    }
  };

  const handleReset = async () => {
    if (!canReset) {
      setStatusMessage("Database reset is disabled in production environments.");
      return;
    }
    setActionInProgress(true);
    setStatusMessage("Resetting system to clean baseline...");
    try {
      const res = await fetch("/api/simulations/reset", { method: "POST" });
      if (res.ok) {
        setStatusMessage("System successfully restored to baseline.");
        await fetchState();
      } else {
        const data = await res.json().catch(() => null);
        setStatusMessage(data?.error || "Failed to reset database.");
      }
    } finally {
      setActionInProgress(false);
    }
  };

  const handleRestoreService = async (serviceId: string) => {
    setActionInProgress(true);
    try {
      await fetch(`/api/services/${serviceId}/restore`, { method: "POST" });
      setStatusMessage(`Restored service '${serviceId}' to baseline.`);
      await fetchState();
    } finally {
      setActionInProgress(false);
    }
  };

  const isSimActive = simState?.status === "ACTIVE";

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-8">
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-gradient-to-r from-slate-900/90 via-slate-900/60 to-slate-950 p-6 shadow-xl backdrop-blur-md">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-rose-500/20 px-2.5 py-0.5 text-xs font-semibold text-rose-400 border border-rose-500/30">
              Chaos & Failure Injection
            </span>
            <span className="text-xs text-slate-400 font-mono">
              Deterministic Simulation Engine
            </span>
          </div>
          <h1 className="mt-1.5 text-2xl font-black text-white tracking-tight sm:text-3xl">
            Failure Simulator
          </h1>
          <p className="mt-1 text-xs text-slate-400 max-w-2xl">
            Inject realistic faults, watch latency and error rates propagate across microservice
            dependencies step-by-step, and evaluate root-cause detection algorithms.
          </p>
        </div>

        {/* Global Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleAdvance}
            disabled={actionInProgress || !isSimActive}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-indigo-600/30 transition-all"
          >
            <FastForward className="h-4 w-4" />
            <span>Advance Step</span>
          </button>

          {canReset && (
            <button
              onClick={handleReset}
              disabled={actionInProgress}
              data-testid="reset-baseline-btn"
              className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 px-4 py-2.5 text-xs font-bold text-slate-200 transition-colors"
            >
              <RotateCcw className="h-4 w-4" />
              <span>Reset Baseline</span>
            </button>
          )}
        </div>
      </div>

      {/* Status Feedback Toast/Banner */}
      {statusMessage && (
        <div className="flex items-center justify-between rounded-xl border border-blue-500/30 bg-blue-950/40 px-4 py-3 text-xs text-blue-200 backdrop-blur-sm font-mono">
          <span>{statusMessage}</span>
          <button onClick={() => setStatusMessage(null)} className="text-slate-400 hover:text-white">
            ×
          </button>
        </div>
      )}

      {/* Active Simulation Status Card */}
      {isSimActive && (
        <div className="rounded-2xl border border-rose-500/50 bg-gradient-to-r from-rose-950/20 via-slate-900/80 to-slate-900/90 p-5 shadow-xl backdrop-blur-md">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500" />
              </span>
              <div>
                <span className="text-[11px] font-mono text-rose-400 uppercase font-semibold">
                  Active Simulation: Step {simState.currentStep}
                </span>
                <h3 className="text-base font-bold text-white">
                  Scenario: {simState.activeScenario} ({simState.severity} severity)
                </h3>
              </div>
            </div>

            {activeIncident && (
              <Link
                href={`/incidents/${activeIncident.id}`}
                className="inline-flex items-center gap-1 rounded-xl bg-purple-600/30 border border-purple-500/40 hover:bg-purple-600 px-3.5 py-2 text-xs font-semibold text-purple-200 hover:text-white transition-all"
              >
                <span>Inspect Active Incident</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Scenario Selection Grid */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-white tracking-tight uppercase font-mono">
              Select Failure Scenario
            </h3>
            <p className="text-xs text-slate-400">Choose a deterministic fault pattern to inject</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {scenarios.map((sc) => {
            const isSelected = selectedScenarioId === sc.id;
            return (
              <div
                key={sc.id}
                onClick={() => setSelectedScenarioId(sc.id)}
                className={`cursor-pointer rounded-2xl border p-5 transition-all ${
                  isSelected
                    ? "border-blue-500 bg-blue-950/20 shadow-xl shadow-blue-950/40"
                    : "border-slate-800 bg-slate-900/60 hover:border-slate-700"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-[10px] font-mono font-bold ${
                      sc.defaultSeverity === "CRITICAL"
                        ? "bg-rose-500/20 text-rose-400"
                        : sc.defaultSeverity === "HIGH"
                        ? "bg-amber-500/20 text-amber-400"
                        : "bg-blue-500/20 text-blue-400"
                    }`}
                  >
                    {sc.defaultSeverity}
                  </span>
                  <span className="text-[10px] font-mono text-slate-400">
                    {sc.totalSteps} steps cascade
                  </span>
                </div>

                <h4 className="mt-2 text-sm font-bold text-slate-100">{sc.name}</h4>
                <p className="mt-1 text-xs text-slate-400 line-clamp-3 leading-relaxed">
                  {sc.description}
                </p>

                <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-400">
                  <span>Target: <strong className="text-slate-200">{sc.targetServiceId}</strong></span>
                  <span className="text-indigo-400">{sc.failureType}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end pt-2">
          <button
            onClick={handleInject}
            disabled={actionInProgress}
            className="flex items-center gap-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 px-6 py-3 text-xs font-bold text-white shadow-xl shadow-rose-600/30 transition-all hover:scale-[1.02]"
          >
            <Flame className="h-4 w-4" />
            <span>Inject Selected Scenario (Start Step 1)</span>
          </button>
        </div>
      </div>

      {/* Live Services Telemetry Table (Simulated) */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-md space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-white tracking-tight uppercase font-mono">
                Live Fleet Telemetry
              </h3>
              <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-mono text-amber-400 border border-amber-500/30">
                Simulated Observability
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Current vs baseline metrics. Unhealthy services can be individually restored.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800 text-[11px] font-mono uppercase text-slate-400">
              <tr>
                <th className="pb-3 px-3">Service</th>
                <th className="pb-3 px-3">Tier</th>
                <th className="pb-3 px-3">Status</th>
                <th className="pb-3 px-3">Response Latency</th>
                <th className="pb-3 px-3">Error Rate</th>
                <th className="pb-3 px-3">Throughput</th>
                <th className="pb-3 px-3 text-right">Remediation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {services.map((svc) => (
                <tr key={svc.id} data-testid={`service-row-${svc.id}`} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-3 px-3 font-semibold text-slate-200">
                    <div>{svc.name}</div>
                    <span className="font-mono text-[10px] text-slate-400">{svc.id}</span>
                  </td>
                  <td className="py-3 px-3 font-mono text-slate-400">Tier {svc.tier}</td>
                  <td className="py-3 px-3">
                    <span
                      data-testid={`service-status-${svc.id}`}
                      className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold ${
                        svc.status === "DOWN"
                          ? "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                          : svc.status === "DEGRADED"
                          ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                          : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                      }`}
                    >
                      {svc.status}
                    </span>
                  </td>
                  <td className="py-3 px-3 font-mono">
                    <span
                      className={`font-bold ${
                        svc.currentLatency > svc.baselineLatency * 2
                          ? "text-rose-400"
                          : svc.currentLatency > svc.baselineLatency * 1.3
                          ? "text-amber-400"
                          : "text-slate-200"
                      }`}
                    >
                      {Math.round(svc.currentLatency)}ms
                    </span>
                    <span className="text-[10px] text-slate-400 ml-1.5">
                      (base: {svc.baselineLatency}ms)
                    </span>
                  </td>
                  <td className="py-3 px-3 font-mono">
                    <span
                      className={`font-bold ${
                        svc.currentErrorRate > 10
                          ? "text-rose-400"
                          : svc.currentErrorRate > 1
                          ? "text-amber-400"
                          : "text-emerald-400"
                      }`}
                    >
                      {svc.currentErrorRate.toFixed(1)}%
                    </span>
                    <span className="text-[10px] text-slate-400 ml-1.5">
                      (base: {svc.baselineErrorRate}%)
                    </span>
                  </td>
                  <td className="py-3 px-3 font-mono text-slate-300">
                    {svc.requestRate} req/s
                  </td>
                  <td className="py-3 px-3 text-right">
                    <button
                      data-testid={`restore-service-btn-${svc.id}`}
                      onClick={() => handleRestoreService(svc.id)}
                      disabled={actionInProgress || svc.status === "HEALTHY"}
                      className="rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-30 px-3 py-1 text-[11px] font-medium text-blue-400 hover:text-white transition-colors"
                    >
                      Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
