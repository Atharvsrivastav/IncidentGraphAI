"use client";

import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import {
  Server,
  Database,
  Shield,
  Layers,
  CreditCard,
  Bell,
  Network,
  AlertTriangle,
  Zap,
} from "lucide-react";

export interface ServiceNodeCustomData {
  [key: string]: unknown;
  id: string;
  name: string;
  serviceType: string;
  tier: number;
  status: "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";
  latency: number | null;
  baselineLatency: number;
  errorRate: number | null;
  baselineErrorRate: number;
  requestRate: number | null;
  hasValidLatency?: boolean;
  hasValidErrorRate?: boolean;
  hasValidRequestRate?: boolean;
  isRootCause?: boolean;
  isAffected?: boolean;
}

const getServiceIcon = (type: string) => {
  switch (type) {
    case "DATABASE":
      return Database;
    case "AUTH":
      return Shield;
    case "PAYMENT":
      return CreditCard;
    case "NOTIFICATION":
      return Bell;
    case "GATEWAY":
      return Network;
    case "ORDER":
    case "INVENTORY":
      return Layers;
    default:
      return Server;
  }
};

export const ServiceNode = memo(({ data, selected }: NodeProps) => {
  const nodeData = data as unknown as ServiceNodeCustomData;
  const Icon = getServiceIcon(nodeData.serviceType);

  const isDown = nodeData.status === "DOWN";
  const isDegraded = nodeData.status === "DEGRADED";
  const isHealthy = nodeData.status === "HEALTHY";
  const isUnknown = nodeData.status === "UNKNOWN";

  let statusBorder = "border-slate-800 hover:border-slate-700";
  let statusBg = "bg-slate-900/90";
  let statusBadgeColor = "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";

  if (isDown) {
    statusBorder = "border-rose-500 shadow-lg shadow-rose-950/50";
    statusBg = "bg-rose-950/30";
    statusBadgeColor = "bg-rose-500/20 text-rose-300 border-rose-500/50";
  } else if (isDegraded) {
    statusBorder = "border-amber-500 shadow-lg shadow-amber-950/40";
    statusBg = "bg-amber-950/20";
    statusBadgeColor = "bg-amber-500/20 text-amber-300 border-amber-500/40";
  } else if (isUnknown) {
    statusBorder = "border-slate-700/80 shadow-md shadow-slate-950/40";
    statusBg = "bg-slate-900/70";
    statusBadgeColor = "bg-slate-700/50 text-slate-400 border-slate-600/50";
  } else if (isHealthy) {
    statusBorder = "border-emerald-600/40 hover:border-emerald-500/70";
  }

  const selectionBorder = selected ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-slate-950" : "";
  const rootCauseRing = nodeData.isRootCause ? "ring-2 ring-purple-500 shadow-xl shadow-purple-950/60" : "";

  const hasLatency = nodeData.hasValidLatency !== false && nodeData.latency !== null && nodeData.latency !== undefined;
  const hasError = nodeData.hasValidErrorRate !== false && nodeData.errorRate !== null && nodeData.errorRate !== undefined;
  const hasVolume = nodeData.hasValidRequestRate !== false && nodeData.requestRate !== null && nodeData.requestRate !== undefined;

  return (
    <div
      data-testid={`service-node-${nodeData.id}`}
      className={`relative min-w-[220px] rounded-xl border p-3 transition-all duration-200 backdrop-blur-md ${statusBg} ${statusBorder} ${selectionBorder} ${rootCauseRing}`}
    >
      {/* React Flow Connection Handles */}
      {/* Target: Handles incoming calls from upstream services */}
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2.5 !w-2.5 !bg-blue-400 !border-slate-900"
      />
      {/* Source: Handles outgoing calls to downstream dependencies */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2.5 !w-2.5 !bg-indigo-400 !border-slate-900"
      />

      {/* Root Cause Banner */}
      {nodeData.isRootCause && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full bg-purple-600 px-2.5 py-0.5 text-[10px] font-bold text-white shadow-md animate-pulse">
          <Zap className="h-3 w-3" />
          <span>SUSPECTED ROOT CAUSE</span>
        </div>
      )}

      {/* Affected Downstream Banner */}
      {nodeData.isAffected && !nodeData.isRootCause && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full bg-amber-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow-md">
          <AlertTriangle className="h-3 w-3" />
          <span>AFFECTED DOWNSTREAM</span>
        </div>
      )}

      {/* Header: Icon, Name, and Status Badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-lg border ${
              isDown
                ? "bg-rose-500/20 border-rose-500/40 text-rose-400"
                : isDegraded
                ? "bg-amber-500/20 border-amber-500/40 text-amber-400"
                : isUnknown
                ? "bg-slate-800/80 border-slate-700/80 text-slate-400"
                : "bg-slate-800 border-slate-700 text-blue-400"
            }`}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-xs font-bold text-slate-100 tracking-tight leading-tight">
              {nodeData.name}
            </h4>
            <span className="text-[10px] text-slate-400 font-mono">
              Tier {nodeData.tier} · {nodeData.serviceType}
            </span>
          </div>
        </div>

        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-mono font-semibold uppercase ${statusBadgeColor}`}
        >
          {nodeData.status}
        </span>
      </div>

      {/* Metrics Grid */}
      <div className="mt-3 grid grid-cols-2 gap-1.5 rounded-lg border border-slate-800/80 bg-slate-950/60 p-2 font-mono text-[11px]">
        <div>
          <span className="text-[10px] text-slate-400">Latency</span>
          <div className="flex items-baseline gap-1">
            {hasLatency ? (
              <>
                <span
                  className={`font-semibold ${
                    nodeData.latency! > nodeData.baselineLatency * 2
                      ? "text-rose-400"
                      : nodeData.latency! > nodeData.baselineLatency * 1.3
                      ? "text-amber-400"
                      : "text-slate-200"
                  }`}
                >
                  {Math.round(nodeData.latency!)}ms
                </span>
                <span className="text-[9px] text-slate-400">({nodeData.baselineLatency}ms)</span>
              </>
            ) : (
              <span className="text-slate-400 font-mono">N/A</span>
            )}
          </div>
        </div>

        <div>
          <span className="text-[10px] text-slate-400">Error Rate</span>
          <div className="flex items-baseline gap-1">
            {hasError ? (
              <span
                className={`font-semibold ${
                  nodeData.errorRate! > 10
                    ? "text-rose-400"
                    : nodeData.errorRate! > 1
                    ? "text-amber-400"
                    : "text-emerald-400"
                }`}
              >
                {nodeData.errorRate!.toFixed(1)}%
              </span>
            ) : (
              <span className="text-slate-400 font-mono">N/A</span>
            )}
          </div>
        </div>
      </div>

      {/* Request Volume Footer */}
      <div className="mt-2 flex items-center justify-between text-[10px] text-slate-400">
        <span>Volume:</span>
        <span className="font-mono text-slate-300">
          {hasVolume ? `${nodeData.requestRate} req/s` : "N/A"}
        </span>
      </div>
    </div>
  );
});

ServiceNode.displayName = "ServiceNode";
