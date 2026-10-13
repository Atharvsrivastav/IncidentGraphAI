"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";

export default function SettingsPage() {
  const [resetting, setResetting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleReset = async () => {
    setResetting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/simulations/reset", { method: "POST" });
      if (res.ok) {
        setMessage("Database successfully re-seeded with 7 services and 8 dependencies.");
      } else {
        setMessage("Failed to reset database.");
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
          <span className="text-xs text-slate-400 font-mono">Platform Configuration</span>
        </div>
        <h1 className="mt-1.5 text-2xl font-black text-white tracking-tight sm:text-3xl">
          Settings & Environment
        </h1>
        <p className="mt-1 text-xs text-slate-400">
          Local SQLite persistence configuration, schema versioning, and baseline reset utilities.
        </p>
      </div>

      {message && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-4 text-xs font-mono text-emerald-300">
          {message}
        </div>
      )}

      {/* Database Reset Action */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-md space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-bold text-white tracking-tight uppercase font-mono">
              Reset & Re-Seed Database
            </h3>
            <p className="mt-1 text-xs text-slate-400 leading-relaxed max-w-xl">
              Restores the local SQLite database (`dev.db`) to the initial clean baseline topology.
              Clears all historical simulated faults, incident records, and telemetry logs.
            </p>
          </div>

          <button
            onClick={handleReset}
            disabled={resetting}
            className="flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-blue-600/30 transition-all"
          >
            <RefreshCw className={`h-4 w-4 ${resetting ? "animate-spin" : ""}`} />
            <span>Reset Database</span>
          </button>
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
