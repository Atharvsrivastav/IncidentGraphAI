"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Server, Activity, Cpu, ShieldCheck, Lock } from "lucide-react";

interface HealthData {
  status: string;
  environment: string;
  latencyMs: number;
  database: {
    status: string;
    provider: string;
    servicesCount: number;
  };
  telemetry: {
    mode: string;
    backendType: string;
    grafanaCloudConfigured: boolean;
    prometheusAvailable: boolean;
    tempoAvailable: boolean;
    details: string;
  };
  aiProvider: {
    provider: string;
    model: string;
    isConfigured: boolean;
    details: string;
  };
}

export default function SettingsPage() {
  const [resetting, setResetting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      if (res.ok) {
        const data = await res.json();
        setHealth(data);
      }
    } catch {
      // Ignored
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/health");
        if (res.ok && !cancelled) {
          const data = await res.json();
          setHealth(data);
        }
      } catch {
        // Ignored
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleReset = async () => {
    if (health?.environment === "production") {
      setMessage("Database reset is disabled in production environments.");
      return;
    }
    setResetting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/simulations/reset", { method: "POST" });
      if (res.ok) {
        setMessage("Database successfully re-seeded with 7 services and 8 dependencies.");
        await fetchHealth();
      } else {
        const data = await res.json().catch(() => null);
        setMessage(data?.error || "Failed to reset database.");
      }
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 space-y-8">
      {/* Header */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <span className="rounded bg-slate-800 px-2.5 py-0.5 text-xs font-semibold text-slate-300 border border-slate-700">
            System Administration
          </span>
          <span className="text-xs text-slate-400 font-mono">Platform Configuration & Health</span>
        </div>
        <h1 className="mt-1.5 text-2xl font-black text-white tracking-tight sm:text-3xl">
          Settings & Diagnostics
        </h1>
        <p className="mt-1 text-xs text-slate-400">
          Runtime infrastructure status, telemetry connections, and baseline reset utilities.
        </p>
      </div>

      {message && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-4 text-xs font-mono text-emerald-300">
          {message}
        </div>
      )}

      {/* Live Health Diagnostics Grid */}
      {health && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Database */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-2 backdrop-blur-sm">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-xs font-bold font-mono uppercase">Database Layer</span>
              <Server className="h-4 w-4 text-emerald-400" />
            </div>
            <div className="text-lg font-black font-mono text-white capitalize">
              {health.database.provider === "postgresql" ? "Neon PostgreSQL" : "SQLite"}
            </div>
            <div className="flex items-center gap-2 text-xs text-emerald-400 font-mono">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <span>{health.database.status} ({health.database.servicesCount} services)</span>
            </div>
          </div>

          {/* Telemetry Backend */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-2 backdrop-blur-sm">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-xs font-bold font-mono uppercase">Telemetry Backend</span>
              <Activity className="h-4 w-4 text-purple-400" />
            </div>
            <div className="text-lg font-black font-mono text-white">
              {health.telemetry.backendType === "GRAFANA_CLOUD" ? "Grafana Cloud" : "Simulation Stack"}
            </div>
            <div className="flex items-center gap-2 text-xs text-purple-300 font-mono">
              <span className="h-2 w-2 rounded-full bg-purple-400"></span>
              <span>Prometheus: {health.telemetry.prometheusAvailable ? "Online" : "Offline"} · Tempo: {health.telemetry.tempoAvailable ? "Online" : "Offline"}</span>
            </div>
          </div>

          {/* AI Investigation Engine */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-2 backdrop-blur-sm">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-xs font-bold font-mono uppercase">AI Investigator</span>
              <Cpu className="h-4 w-4 text-blue-400" />
            </div>
            <div className="text-lg font-black font-mono text-white">
              {health.aiProvider.isConfigured ? "OpenAI Live" : "Deterministic Replay"}
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-300 font-mono">
              <ShieldCheck className="h-3.5 w-3.5 text-blue-400" />
              <span>Evidence-Grounded (Zero Key Req.)</span>
            </div>
          </div>
        </div>
      )}

      {/* Database Reset Action */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-md space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-white tracking-tight uppercase font-mono">
                Reset & Re-Seed Database
              </h3>
              {health?.environment === "production" && (
                <span
                  data-testid="protected-in-production-badge"
                  className="rounded bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 text-[10px] font-mono font-semibold text-amber-400"
                >
                  Protected in Production
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-400 leading-relaxed max-w-xl">
              {health?.environment === "production"
                ? "Destructive database reset operations are restricted in production environments to safeguard active incident history, telemetry samples, and service topologies."
                : `Restores the active database (${health?.database.provider === "postgresql" ? "Neon PostgreSQL" : "Local SQLite"}) to the initial clean baseline topology (7 microservices, 8 dependencies). Clears all historical simulated faults, incident records, and telemetry logs.`}
            </p>
          </div>

          {health?.environment === "production" ? (
            <button
              disabled
              data-testid="reset-database-button"
              title="Database reset is disabled in production"
              className="flex items-center gap-2 rounded-xl bg-slate-800/80 border border-slate-700/60 px-4 py-2.5 text-xs font-bold text-slate-400 cursor-not-allowed shrink-0"
            >
              <Lock className="h-4 w-4 text-slate-400" />
              <span>Reset Protected</span>
            </button>
          ) : (
            <button
              onClick={handleReset}
              disabled={resetting}
              data-testid="reset-database-button"
              className="flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-blue-600/30 transition-all shrink-0"
            >
              <RefreshCw className={`h-4 w-4 ${resetting ? "animate-spin" : ""}`} />
              <span>Reset Database</span>
            </button>
          )}
        </div>
      </div>

      {/* System Architecture Specifications */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-md space-y-4">
        <h3 className="text-sm font-bold text-white tracking-tight uppercase font-mono">
          System Topology Specifications
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-2">
            <span className="text-slate-400 font-mono text-[11px] uppercase block font-semibold">
              Microservices Fleet (7 Nodes)
            </span>
            <ul className="space-y-1.5 text-slate-300 font-mono text-[11px]">
              <li>• API Gateway (Tier 1 Edge Proxy)</li>
              <li>• Authentication Service (Tier 2 JWT Provider)</li>
              <li>• Order Service (Tier 2 Core Processing)</li>
              <li>• Payment Gateway Service (Tier 2 FinTech Connector)</li>
              <li>• Inventory Service (Tier 2 Stock Catalog)</li>
              <li>• PostgreSQL Cluster (Tier 3 Relational Storage)</li>
              <li>• Notification Service (Tier 2 Async Messaging)</li>
            </ul>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-2">
            <span className="text-slate-400 font-mono text-[11px] uppercase block font-semibold">
              Algorithmic Guarantees
            </span>
            <ul className="space-y-1.5 text-slate-300 text-xs">
              <li>
                <strong className="text-blue-400 font-mono">No Injected Root-Cause Leak:</strong> RCA engine operates solely on observed graph signals.
              </li>
              <li>
                <strong className="text-blue-400 font-mono">3-Color Cycle Detection:</strong> Safely handles circular dependencies in O(V + E) time.
              </li>
              <li>
                <strong className="text-blue-400 font-mono">Binary Max-Heap:</strong> Extracts Top-K candidates in O(K log N) time.
              </li>
              <li>
                <strong className="text-blue-400 font-mono">Deterministic Simulation:</strong> Exact reproducible cascading faults across steps.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
