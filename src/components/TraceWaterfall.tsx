"use client";

import React, { useState } from "react";
import { DistributedTrace } from "@/lib/telemetry/types";
import { ChevronRight, ChevronDown, AlertTriangle, CheckCircle, Database, Globe, Layers } from "lucide-react";

interface TraceWaterfallProps {
  trace: DistributedTrace;
}

export function TraceWaterfall({ trace }: TraceWaterfallProps) {
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const totalDuration = Math.max(1, trace.durationMs);

  const getServiceColor = (serviceName: string) => {
    if (serviceName.includes("postgres") || serviceName.includes("db")) return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
    if (serviceName.includes("order")) return "bg-blue-500/20 text-blue-400 border-blue-500/30";
    if (serviceName.includes("payment")) return "bg-purple-500/20 text-purple-400 border-purple-500/30";
    if (serviceName.includes("inventory")) return "bg-amber-500/20 text-amber-400 border-amber-500/30";
    return "bg-slate-700/40 text-slate-300 border-slate-600/40";
  };

  const getServiceIcon = (serviceName: string) => {
    if (serviceName.includes("postgres") || serviceName.includes("db")) return <Database className="h-3.5 w-3.5" />;
    if (serviceName.includes("gateway")) return <Globe className="h-3.5 w-3.5" />;
    return <Layers className="h-3.5 w-3.5" />;
  };

  return (
    <div className="space-y-6">
      {/* Trace Overview Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-slate-400">Trace ID:</span>
            <span className="font-mono text-xs font-bold text-white selection:bg-blue-500">{trace.traceId}</span>
            {trace.hasErrors ? (
              <span className="flex items-center gap-1 rounded bg-rose-500/20 px-2 py-0.5 text-[10px] font-bold text-rose-400 border border-rose-500/30">
                <AlertTriangle className="h-3 w-3" />
                <span>Error Detected</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-400 border border-emerald-500/30">
                <CheckCircle className="h-3 w-3" />
                <span>Success</span>
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-slate-300">
            Root: <strong className="text-white">{trace.rootServiceName}</strong> · {trace.operationName}
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs font-mono">
          <div>
            <span className="text-slate-400 block text-[10px]">TOTAL DURATION</span>
            <span className={`text-base font-bold ${trace.durationMs > 500 ? "text-amber-400" : "text-slate-100"}`}>
              {trace.durationMs}ms
            </span>
          </div>
          <div>
            <span className="text-slate-400 block text-[10px]">SPANS</span>
            <span className="text-base font-bold text-slate-100">{trace.totalSpans}</span>
          </div>
          <div>
            <span className="text-slate-400 block text-[10px]">SERVICES</span>
            <span className="text-base font-bold text-slate-100">{trace.servicesInvolved.length}</span>
          </div>
        </div>
      </div>

      {/* Waterfall Visualization */}
      <div className="rounded-xl border border-slate-800 bg-slate-950/60 overflow-hidden">
        {/* Timeline ruler */}
        <div className="flex border-b border-slate-800/80 bg-slate-900/40 px-4 py-2 text-[10px] font-mono text-slate-400">
          <div className="w-1/2">Operation & Hierarchy</div>
          <div className="w-1/2 flex justify-between">
            <span>0ms</span>
            <span>{Math.round(totalDuration * 0.5)}ms</span>
            <span>{totalDuration}ms</span>
          </div>
        </div>

        {/* Spans rows */}
        <div className="divide-y divide-slate-800/40">
          {trace.allSpans.map((span) => {
            const isSelected = selectedSpanId === span.spanId;
            const barWidthPercent = Math.max(2, Math.min(100, (span.durationMs / totalDuration) * 100));
            // Calculate offset based on span depth or estimate
            const barOffsetPercent = Math.min(95, span.depth * 10);

            return (
              <div key={span.spanId} className="flex flex-col">
                <div
                  onClick={() => setSelectedSpanId(isSelected ? null : span.spanId)}
                  className={`flex items-center px-4 py-2.5 cursor-pointer hover:bg-slate-800/50 transition-colors text-xs ${
                    isSelected ? "bg-slate-800/60 border-l-2 border-blue-500" : ""
                  }`}
                >
                  {/* Left Column: Operation & Hierarchy */}
                  <div className="w-1/2 flex items-center gap-1.5 overflow-hidden pr-2">
                    <div style={{ marginLeft: `${span.depth * 16}px` }} className="flex items-center gap-1.5">
                      {isSelected ? (
                        <ChevronDown className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      )}
                      <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono border ${getServiceColor(span.serviceName)}`}>
                        {getServiceIcon(span.serviceName)}
                        <span>{span.serviceName}</span>
                      </span>
                      <span className="font-semibold text-slate-200 truncate font-mono text-[11px]">
                        {span.operationName}
                      </span>
                      {span.statusCode === "ERROR" && (
                        <span className="rounded bg-rose-500/20 px-1 text-[9px] font-bold text-rose-400 border border-rose-500/30">
                          ERR
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Right Column: Waterfall Bar */}
                  <div className="w-1/2 relative flex items-center h-5">
                    <div
                      style={{
                        marginLeft: `${barOffsetPercent}%`,
                        width: `${barWidthPercent}%`,
                      }}
                      className={`h-3.5 rounded transition-all flex items-center px-1 text-[9px] font-mono font-bold ${
                        span.statusCode === "ERROR"
                          ? "bg-rose-500/80 text-white"
                          : span.durationMs > 300
                          ? "bg-amber-500/80 text-white"
                          : "bg-blue-500/80 text-white"
                      }`}
                    >
                      <span className="truncate">{span.durationMs}ms</span>
                    </div>
                  </div>
                </div>

                {/* Expanded Span Details Drawer */}
                {isSelected && (
                  <div className="bg-slate-900/90 border-t border-slate-800/80 p-4 font-mono text-xs space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                      <div>
                        <span className="text-slate-400 block text-[10px]">SPAN ID</span>
                        <span className="text-white">{span.spanId}</span>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[10px]">PARENT SPAN ID</span>
                        <span className="text-white">{span.parentSpanId || "None (Root Span)"}</span>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[10px]">DURATION</span>
                        <span className="text-white font-bold">{span.durationMs}ms</span>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[10px]">STATUS</span>
                        <span className={span.statusCode === "ERROR" ? "text-rose-400 font-bold" : "text-emerald-400"}>
                          {span.statusCode}
                        </span>
                      </div>
                    </div>

                    {/* Attributes */}
                    <div className="rounded-lg bg-slate-950 p-3 border border-slate-800">
                      <span className="text-slate-400 text-[10px] block mb-1">ATTRIBUTES</span>
                      <pre className="text-slate-300 text-[11px] overflow-x-auto whitespace-pre-wrap">
                        {JSON.stringify(span.attributes, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
