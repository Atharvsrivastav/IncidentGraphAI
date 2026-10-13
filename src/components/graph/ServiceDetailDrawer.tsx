"use client";

import React, { useState } from "react";
import { X, RefreshCw, ArrowUpRight, ArrowDownLeft, Clock } from "lucide-react";

interface ServiceDetailDrawerProps {
  service: {
    id: string;
    name: string;
    serviceType: string;
    tier: number;
    status: "HEALTHY" | "DEGRADED" | "DOWN";
    currentLatency: number;
    baselineLatency: number;
    currentErrorRate: number;
    baselineErrorRate: number;
    requestRate: number;
    description: string;
  };
  dependencies: {
    sourceServiceId: string;
    targetServiceId: string;
    dependencyType: string;
    timeoutThreshold: number;
  }[];
  allServices: {
    id: string;
    name: string;
    status: string;
  }[];
  onClose: () => void;
  onRestore: () => void;
}

export function ServiceDetailDrawer({
  service,
  dependencies,
  allServices,
  onClose,
  onRestore,
}: ServiceDetailDrawerProps) {
  const [isRestoring, setIsRestoring] = useState(false);

  // Incoming callers (services that depend on this service)
  const incomingCallers = dependencies
    .filter((d) => d.targetServiceId === service.id)
    .map((d) => ({
      service: allServices.find((s) => s.id === d.sourceServiceId),
      type: d.dependencyType,
    }));

  // Outgoing dependencies (services this service depends on)
  const outgoingDependencies = dependencies
    .filter((d) => d.sourceServiceId === service.id)
    .map((d) => ({
      service: allServices.find((s) => s.id === d.targetServiceId),
      type: d.dependencyType,
      timeout: d.timeoutThreshold,
    }));

  const handleRestore = async () => {
    setIsRestoring(true);
    try {
      await fetch(`/api/services/${service.id}/restore`, { method: "POST" });
      onRestore();
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <div className="absolute top-0 right-0 z-30 h-full w-full max-w-md border-l border-slate-800 bg-slate-900/95 p-6 shadow-2xl backdrop-blur-xl overflow-y-auto animate-in slide-in-from-right duration-200">
      {/* Drawer Header */}
      <div className="flex items-start justify-between pb-4 border-b border-slate-800">
        <div>
          <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-slate-400">
            Tier {service.tier} · {service.serviceType}
          </span>
          <h3 className="mt-1 text-lg font-bold text-white tracking-tight">{service.name}</h3>
          <p className="mt-1 text-xs text-slate-400 leading-relaxed">{service.description}</p>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Telemetry Metrics Comparison */}
      <div className="mt-5 space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 font-mono">
          Observed Telemetry
        </h4>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
            <span className="text-[11px] text-slate-400">Response Latency</span>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-xl font-bold font-mono text-slate-100">
                {Math.round(service.currentLatency)}ms
              </span>
              <span className="text-[10px] font-mono text-slate-400">
                base: {service.baselineLatency}ms
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
            <span className="text-[11px] text-slate-400">Error Rate</span>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-xl font-bold font-mono text-slate-100">
                {service.currentErrorRate.toFixed(1)}%
              </span>
              <span className="text-[10px] font-mono text-slate-400">
                base: {service.baselineErrorRate}%
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 flex items-center justify-between">
          <div>
            <span className="text-[11px] text-slate-400">Throughput Volume</span>
            <div className="text-sm font-bold font-mono text-slate-100">
              {service.requestRate} requests / sec
            </div>
          </div>
          <Clock className="h-5 w-5 text-slate-400" />
        </div>
      </div>

      {/* Dependency Relations */}
      <div className="mt-6 space-y-4">
        {/* Callers */}
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400 font-mono">
            <ArrowDownLeft className="h-3.5 w-3.5 text-blue-400" />
            <span>Upstream Callers ({incomingCallers.length})</span>
          </div>
          <div className="mt-2 space-y-1.5">
            {incomingCallers.length === 0 ? (
              <p className="text-xs text-slate-400 italic">No upstream callers (Edge ingress or isolated).</p>
            ) : (
              incomingCallers.map((c, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg border border-slate-800/80 bg-slate-950/50 px-3 py-2 text-xs"
                >
                  <span className="font-medium text-slate-200">{c.service?.name ?? "Unknown"}</span>
                  <span className="font-mono text-[10px] text-slate-400">{c.type}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Dependencies */}
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400 font-mono">
            <ArrowUpRight className="h-3.5 w-3.5 text-indigo-400" />
            <span>Downstream Dependencies ({outgoingDependencies.length})</span>
          </div>
          <div className="mt-2 space-y-1.5">
            {outgoingDependencies.length === 0 ? (
              <p className="text-xs text-slate-400 italic">No outgoing dependencies (Terminal data store).</p>
            ) : (
              outgoingDependencies.map((d, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg border border-slate-800/80 bg-slate-950/50 px-3 py-2 text-xs"
                >
                  <div>
                    <span className="font-medium text-slate-200">{d.service?.name ?? "Unknown"}</span>
                    <span className="ml-2 font-mono text-[10px] text-slate-400">({d.type})</span>
                  </div>
                  <span className="font-mono text-[10px] text-slate-400">{d.timeout}ms timeout</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-8 pt-4 border-t border-slate-800 flex gap-3">
        <button
          onClick={handleRestore}
          disabled={isRestoring || service.status === "HEALTHY"}
          className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-400 py-2.5 text-xs font-semibold text-white transition-colors"
        >
          <RefreshCw className={`h-4 w-4 ${isRestoring ? "animate-spin" : ""}`} />
          <span>Restore Service Baseline</span>
        </button>
      </div>
    </div>
  );
}
