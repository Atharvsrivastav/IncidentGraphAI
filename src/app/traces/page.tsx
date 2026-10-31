"use client";

import React, { useState, useEffect, useCallback } from "react";
import { DistributedTrace } from "@/lib/telemetry/types";
import { TraceWaterfall } from "@/components/TraceWaterfall";
import { RefreshCw, AlertCircle, ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function TracesPage() {
  const [traces, setTraces] = useState<DistributedTrace[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<DistributedTrace | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [serviceFilter, setServiceFilter] = useState<string>("ALL");
  const [errorOnly, setErrorOnly] = useState<boolean>(false);

  const fetchTraces = useCallback(async () => {
    try {
      const res = await fetch("/api/telemetry/traces?limit=30");
      if (res.ok) {
        const data = await res.json();
        const list = data.traces || [];
        setTraces(list);
        if (list.length > 0) {
          setSelectedTrace((prev) => prev ?? list[0]);
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/telemetry/traces?limit=30");
        if (res.ok && active) {
          const data = await res.json();
          const list = data.traces || [];
          setTraces(list);
          if (list.length > 0) {
            setSelectedTrace((prev) => prev ?? list[0]);
          }
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const filteredTraces = traces.filter((t) => {
    const matchesService =
      serviceFilter === "ALL" || t.servicesInvolved.includes(serviceFilter);
    const matchesError = !errorOnly || t.hasErrors;
    return matchesService && matchesError;
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-indigo-500/20 px-2.5 py-0.5 text-xs font-semibold text-indigo-400 border border-indigo-500/30">
              Distributed Tracing
            </span>
            <span className="text-xs text-slate-400 font-mono">OpenTelemetry, Grafana Cloud Tempo & Jaeger Engine</span>
          </div>
          <h1 className="mt-1.5 text-2xl font-black text-white tracking-tight sm:text-3xl">
            Trace Waterfall Investigation
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            End-to-end request latency breakdown, parent-child span hierarchy, and database query timings.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => void fetchTraces()}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 px-4 py-2.5 text-xs font-semibold text-slate-200 transition-all border border-slate-700/80 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            <span>Refresh Traces</span>
          </button>
          <Link
            href="/service-map"
            className="flex items-center gap-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-blue-600/30 transition-all"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Service Map</span>
          </Link>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 backdrop-blur-md">
        <div className="flex items-center gap-3 text-xs">
          <span className="text-slate-400 font-mono">Filter by Service:</span>
          {["ALL", "api-gateway", "order-service", "payment-service", "inventory-service", "postgres-db"].map((svc) => (
            <button
              key={svc}
              onClick={() => setServiceFilter(svc)}
              className={`rounded-lg px-2.5 py-1 font-mono text-[11px] transition-colors ${
                serviceFilter === svc
                  ? "bg-blue-600 text-white font-bold"
                  : "text-slate-400 hover:text-slate-200 bg-slate-950/60 border border-slate-800"
              }`}
            >
              {svc}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-xs font-medium text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={errorOnly}
            onChange={(e) => setErrorOnly(e.target.checked)}
            className="rounded border-slate-700 bg-slate-900 text-rose-500 focus:ring-rose-500"
          />
          <span>Show Errored Traces Only</span>
        </label>
      </div>

      {/* Main Grid: Left List + Right Waterfall Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Trace List */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 backdrop-blur-md space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-slate-800">
            <span className="text-xs font-bold text-white uppercase font-mono">
              Observed Traces ({filteredTraces.length})
            </span>
          </div>

          {loading ? (
            <div className="py-12 text-center text-xs font-mono text-slate-400">Loading traces from Jaeger...</div>
          ) : filteredTraces.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400 italic space-y-2">
              <AlertCircle className="h-6 w-6 text-slate-400 mx-auto" />
              <p>No traces recorded yet.</p>
              <p className="text-[11px] text-slate-400">
                Run sample microservices and generate traffic to record live spans.
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
              {filteredTraces.map((t) => {
                const isSelected = selectedTrace?.traceId === t.traceId;
                return (
                  <div
                    key={t.traceId}
                    onClick={() => setSelectedTrace(t)}
                    className={`cursor-pointer rounded-xl border p-3.5 transition-all text-xs ${
                      isSelected
                        ? "border-blue-500 bg-blue-950/30 shadow-lg shadow-blue-950/40"
                        : "border-slate-800/80 bg-slate-950/40 hover:border-slate-700"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold text-slate-100 truncate">{t.operationName}</span>
                      <span
                        className={`font-mono text-[11px] font-bold ${
                          t.durationMs > 500 ? "text-amber-400" : "text-slate-300"
                        }`}
                      >
                        {t.durationMs}ms
                      </span>
                    </div>

                    <div className="mt-2 flex items-center justify-between text-[10px] font-mono text-slate-400">
                      <span>{t.rootServiceName}</span>
                      <span>{t.totalSpans} span(s)</span>
                    </div>

                    {t.hasErrors && (
                      <div className="mt-2 text-[10px] font-semibold text-rose-400 font-mono">
                        ⚠ Upstream Failure Recorded
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Column: Waterfall Inspector */}
        <div className="lg:col-span-2 space-y-4">
          {selectedTrace ? (
            <TraceWaterfall trace={selectedTrace} />
          ) : (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-12 text-center text-xs text-slate-400 italic">
              Select a trace from the left panel to inspect its waterfall timeline.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
