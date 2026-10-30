"use client";

import { useEffect, useState, useCallback } from "react";
import { ServiceGraph } from "@/components/graph/ServiceGraph";
import {
  Search,
  RefreshCw,
  GitFork,
  CheckCircle2,
  AlertTriangle,
  Radio,
  ExternalLink,
  HelpCircle,
  AlertCircle,
} from "lucide-react";
import Link from "next/link";
import { BackendHealthStatus, ObservedServiceMetric } from "@/lib/telemetry/types";
import {
  ServiceMapItem,
  ServiceDependencyItem,
  TelemetryUIMode,
  normalizeTelemetryMode,
  mergeServiceMetrics,
} from "@/lib/telemetry/mergeServiceMetrics";

interface ActiveIncidentItem {
  id: string;
  suspectedRootCauseId?: string | null;
}

export default function ServiceMapPage() {
  const [services, setServices] = useState<ServiceMapItem[]>([]);
  const [dependencies, setDependencies] = useState<ServiceDependencyItem[]>([]);
  const [activeIncident, setActiveIncident] = useState<ActiveIncidentItem | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [loading, setLoading] = useState(true);

  // Telemetry Mode & Backend Status
  const [telemetryMode, setTelemetryMode] = useState<TelemetryUIMode>("SIMULATION");
  const [backendHealth, setBackendHealth] = useState<BackendHealthStatus | null>(null);
  const [lastCollectedAt, setLastCollectedAt] = useState<string | null>(null);
  const [unknownServices, setUnknownServices] = useState<ObservedServiceMetric[]>([]);

  const fetchData = useCallback(async () => {
    try {
      const [svcRes, depRes, simRes, telRes] = await Promise.all([
        fetch("/api/services"),
        fetch("/api/dependencies"),
        fetch("/api/simulations/state"),
        fetch("/api/telemetry/overview"),
      ]);

      let normalizedMode: TelemetryUIMode = "SIMULATION";
      let observedMetrics: ObservedServiceMetric[] = [];

      if (telRes.ok) {
        const telData = await telRes.json();
        normalizedMode = normalizeTelemetryMode(telData.mode);
        setTelemetryMode(normalizedMode);
        setBackendHealth(telData.backendHealth || null);
        setLastCollectedAt(telData.lastCollectedAt || null);
        setUnknownServices(telData.unknownServices || []);
        observedMetrics = telData.observedServices || [];
      }

      if (svcRes.ok) {
        const rawSvcData = await svcRes.json();
        const dbServices: ServiceMapItem[] = rawSvcData.services ?? [];
        const merged = mergeServiceMetrics(dbServices, observedMetrics, normalizedMode);
        setServices(merged);
      }

      if (depRes.ok) {
        const data = await depRes.json();
        setDependencies(data.dependencies ?? []);
      }
      if (simRes.ok) {
        const data = await simRes.json();
        setActiveIncident(data.activeIncident ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (active) await fetchData();
    };
    void poll();
    const interval = setInterval(poll, 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [fetchData]);

  const filteredServices = services.filter((svc) => {
    const matchesStatus = statusFilter === "ALL" || svc.status === statusFilter;
    const matchesSearch =
      svc.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      svc.id.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="rounded bg-indigo-500/20 px-2.5 py-0.5 text-xs font-semibold text-indigo-400 border border-indigo-500/30">
              Topology Visualization
            </span>
            {telemetryMode === "SIMULATION" ? (
              <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-mono font-semibold text-slate-400 border border-slate-700">
                ⚙ Simulation Mode
              </span>
            ) : telemetryMode === "DEGRADED" || backendHealth?.backendType === "UNAVAILABLE" ? (
              <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-mono font-bold text-amber-300 border border-amber-500/30">
                ⚠ Telemetry Pipeline Degraded
              </span>
            ) : backendHealth?.backendType === "MOCK_EMULATION" ? (
              <span className="rounded bg-purple-500/20 px-2 py-0.5 text-[10px] font-mono font-bold text-purple-300 border border-purple-500/30">
                ● Mock Telemetry Emulation
              </span>
            ) : backendHealth?.backendType === "GRAFANA_CLOUD" ? (
              <span className="rounded bg-sky-500/20 px-2 py-0.5 text-[10px] font-mono font-bold text-sky-300 border border-sky-500/30">
                ☁ Grafana Cloud Telemetry
              </span>
            ) : (
              <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-mono font-bold text-emerald-300 border border-emerald-500/30">
                ● Genuine Local Telemetry
              </span>
            )}
          </div>
          <h1 className="mt-1.5 text-2xl font-black text-white tracking-tight sm:text-3xl">
            Service Dependency Map
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            {telemetryMode === "SIMULATION"
              ? "Simulated microservices topology and causal failure propagation graph."
              : telemetryMode === "DEGRADED" || backendHealth?.backendType === "UNAVAILABLE"
              ? "Observability backends are degraded or partially unreachable. Displaying available partial signals with UNKNOWN states."
              : backendHealth?.backendType === "MOCK_EMULATION"
              ? "Synthetic metrics and distributed traces generated by local development mock server. Non-production emulation."
              : backendHealth?.backendType === "GRAFANA_CLOUD"
              ? "Observing verified live runtime measurements from hosted Grafana Cloud OTLP and Prometheus/Tempo stack."
              : "Observing verified live runtime measurements from genuine local Prometheus and Jaeger observability stack."}
          </p>
        </div>

        {/* Quick Toolbar */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search service..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="rounded-xl border border-slate-800 bg-slate-900/90 pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {/* Status Filter */}
          <div className="flex items-center rounded-xl border border-slate-800 bg-slate-900/90 p-1 text-xs">
            {["ALL", "HEALTHY", "DEGRADED", "DOWN", "UNKNOWN"].map((filter) => (
              <button
                key={filter}
                onClick={() => setStatusFilter(filter)}
                className={`rounded-lg px-2.5 py-1 font-mono transition-colors ${
                  statusFilter === filter
                    ? "bg-slate-800 text-blue-400 font-bold"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {filter}
              </button>
            ))}
          </div>

          <button
            onClick={fetchData}
            title="Refresh topology"
            className="rounded-xl border border-slate-800 bg-slate-900/90 p-2 text-slate-400 hover:text-white transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Verified LIVE Telemetry Observation Banner */}
      {telemetryMode === "LIVE" && (
        <div
          className={`rounded-2xl border p-4 backdrop-blur-md ${
            backendHealth?.backendType === "MOCK_EMULATION"
              ? "border-purple-500/40 bg-gradient-to-r from-purple-950/30 via-slate-900/80 to-slate-950"
              : backendHealth?.backendType === "GRAFANA_CLOUD"
              ? "border-sky-500/40 bg-gradient-to-r from-sky-950/40 via-slate-900/80 to-slate-950"
              : "border-emerald-500/40 bg-gradient-to-r from-emerald-950/40 via-slate-900/80 to-slate-950"
          }`}
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-3">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-lg border ${
                  backendHealth?.backendType === "MOCK_EMULATION"
                    ? "bg-purple-600/30 border-purple-500/40 text-purple-400"
                    : backendHealth?.backendType === "GRAFANA_CLOUD"
                    ? "bg-sky-600/30 border-sky-500/40 text-sky-400"
                    : "bg-emerald-600/30 border-emerald-500/40 text-emerald-400"
                }`}
              >
                <Radio className="h-4 w-4 animate-pulse" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-white">
                    {backendHealth?.backendType === "MOCK_EMULATION"
                      ? "Mock Telemetry Emulation Active (Dev Server)"
                      : backendHealth?.backendType === "GRAFANA_CLOUD"
                      ? "Grafana Cloud Telemetry Active"
                      : "Genuine Local Telemetry Active"}
                  </span>
                  {backendHealth?.backendType === "GRAFANA_CLOUD" && (
                    <span className="rounded bg-sky-500/20 px-2 py-0.5 text-[10px] font-mono font-bold text-sky-300 border border-sky-500/30">
                      ☁ Grafana Cloud (Hosted)
                    </span>
                  )}
                  {backendHealth?.backendType === "GENUINE_STACK" && (
                    <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-mono font-bold text-emerald-300 border border-emerald-500/30">
                      Genuine Docker Stack
                    </span>
                  )}
                  {backendHealth?.backendType === "MOCK_EMULATION" && (
                    <span
                      className="rounded bg-purple-500/20 px-2 py-0.5 text-[10px] font-mono font-bold text-purple-300 border border-purple-500/40"
                      title="Connected to in-process development mock server, not Docker containers."
                    >
                      MOCK EMULATION — NOT PRODUCTION TELEMETRY
                    </span>
                  )}
                  <span className="text-[10px] font-mono text-slate-400">
                    Latest poll: {lastCollectedAt ? new Date(lastCollectedAt).toLocaleTimeString() : "just now"}
                  </span>
                </div>
                <div className="text-[11px] text-slate-300 flex items-center gap-3 mt-1 flex-wrap">
                  <span>
                    Metrics Backend:{" "}
                    <strong className={backendHealth?.prometheusAvailable ? "text-emerald-400" : "text-rose-400"}>
                      {backendHealth?.prometheusAvailable
                        ? backendHealth?.isCloudBackend
                          ? "Connected (Grafana Cloud)"
                          : backendHealth?.isMockBackend
                          ? "Connected (Mock Emulation)"
                          : "Connected (Live)"
                        : "Offline"}
                    </strong>
                  </span>
                  <span>
                    Traces Backend:{" "}
                    <strong className={backendHealth?.jaegerAvailable ? "text-emerald-400" : "text-rose-400"}>
                      {backendHealth?.jaegerAvailable
                        ? backendHealth?.isCloudBackend
                          ? "Connected (Grafana Cloud Tempo)"
                          : backendHealth?.isMockBackend
                          ? "Connected (Mock Emulation)"
                          : "Connected (Live)"
                        : "Offline"}
                    </strong>
                  </span>
                </div>
                {backendHealth?.details && (
                  <p className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    {backendHealth.details}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Link
                href="/traces"
                className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 font-semibold text-white shadow-md transition-all text-xs ${
                  backendHealth?.backendType === "MOCK_EMULATION"
                    ? "bg-amber-600 hover:bg-amber-500 shadow-amber-600/30"
                    : "bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/30"
                }`}
              >
                <span>Inspect {backendHealth?.backendType === "MOCK_EMULATION" ? "Mock Traces" : "Live Traces"}</span>
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Honest DEGRADED Telemetry Banner */}
      {telemetryMode === "DEGRADED" && (
        <div className="rounded-2xl border border-amber-500/40 bg-gradient-to-r from-amber-950/40 via-slate-900/80 to-slate-950 p-4 backdrop-blur-md">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-600/30 border border-amber-500/40 text-amber-400">
                <AlertCircle className="h-4 w-4" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-amber-200">Telemetry Ingestion Degraded — Live Telemetry Incomplete</span>
                  {backendHealth?.backendType === "UNAVAILABLE" && (
                    <span className="rounded bg-rose-500/20 px-2 py-0.5 text-[10px] font-mono font-bold text-rose-300 border border-rose-500/30">
                      Backends Offline
                    </span>
                  )}
                  {backendHealth?.backendType === "MOCK_EMULATION" && (
                    <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-mono font-bold text-amber-300 border border-amber-500/40">
                      MOCK EMULATION — NOT PRODUCTION TELEMETRY
                    </span>
                  )}
                  <span className="text-[10px] font-mono text-slate-400">
                    Latest poll: {lastCollectedAt ? new Date(lastCollectedAt).toLocaleTimeString() : "just now"}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-slate-300">
                  Live telemetry ingestion was requested, but one or more required backends failed, timed out, or returned no matching series. Displaying available partial measurements with UNKNOWN states for missing signals.
                </p>
                <div className="text-[11px] text-slate-300 flex items-center gap-3 mt-1.5 flex-wrap">
                  <span>
                    Metrics Backend:{" "}
                    <strong className={backendHealth?.prometheusAvailable ? "text-emerald-400" : "text-rose-400"}>
                      {backendHealth?.prometheusAvailable
                        ? backendHealth?.isCloudBackend
                          ? "Connected (Grafana Cloud)"
                          : backendHealth?.isMockBackend
                          ? "Connected (Mock Emulation)"
                          : "Connected (Live)"
                        : "Offline"}
                    </strong>
                  </span>
                  <span>
                    Traces Backend:{" "}
                    <strong className={backendHealth?.jaegerAvailable ? "text-emerald-400" : "text-rose-400"}>
                      {backendHealth?.jaegerAvailable
                        ? backendHealth?.isCloudBackend
                          ? "Connected (Grafana Cloud Tempo)"
                          : backendHealth?.isMockBackend
                          ? "Connected (Mock Emulation)"
                          : "Connected (Live)"
                        : "Offline"}
                    </strong>
                  </span>
                </div>
                {backendHealth?.details && (
                  <p className="text-[10px] text-amber-300/80 mt-1 font-mono">
                    Diagnostic: {backendHealth.details}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Link
                href="/traces"
                className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600/80 hover:bg-amber-600 px-3.5 py-2 font-semibold text-white shadow-md shadow-amber-600/30 transition-all text-xs"
              >
                <span>Inspect Traces</span>
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Unknown Services Warning Banner */}
      {unknownServices.length > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-4 text-xs text-amber-200">
          <div className="flex items-center gap-2 font-bold">
            <HelpCircle className="h-4 w-4 text-amber-400" />
            <span>Unknown Services Discovered in Telemetry Stream:</span>
          </div>
          <p className="mt-1 text-slate-300">
            The following services are transmitting OpenTelemetry metrics but are not configured in the static database topology:
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {unknownServices.map((u) => {
              const reqText = u.hasValidRequestRate === true ? `${u.requestRate} req/s` : "N/A req/s";
              const latText = u.hasValidLatency === true ? `${u.latencyMs}ms` : "N/A ms";
              return (
                <span
                  key={u.serviceId}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-amber-500/50 bg-slate-900/90 px-2.5 py-1 font-mono text-[11px] text-amber-200 shadow-sm"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  <span className="font-semibold text-slate-200">{u.serviceName}</span>
                  <span className="text-slate-400">({reqText}, {latText})</span>
                  <span className="rounded bg-amber-500/10 px-1 py-0.2 text-[9px] text-amber-400 border border-amber-500/20">
                    Unregistered
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Interactive Service Graph */}
      {loading ? (
        <div className="flex h-[620px] items-center justify-center rounded-2xl border border-slate-800 bg-slate-950">
          <div className="flex items-center gap-3 text-slate-400">
            <RefreshCw className="h-5 w-5 animate-spin text-blue-500" />
            <span className="font-mono text-sm">Rendering topology graph...</span>
          </div>
        </div>
      ) : (
        <ServiceGraph
          services={filteredServices}
          dependencies={dependencies}
          suspectedRootCauseId={activeIncident?.suspectedRootCauseId}
          onServiceRestored={fetchData}
        />
      )}

      {/* Architecture Topology Info Card */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center gap-2 text-blue-400 text-xs font-semibold uppercase font-mono">
            <GitFork className="h-4 w-4" />
            <span>Edge Direction Convention</span>
          </div>
          <p className="mt-2 text-xs text-slate-400 leading-relaxed">
            <strong className="text-slate-200 font-mono">A → B</strong> denotes that Service A
            calls or depends on Service B. Impact propagates in reverse along callers.
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center gap-2 text-purple-400 text-xs font-semibold uppercase font-mono">
            <AlertTriangle className="h-4 w-4" />
            <span>Root Cause Isolation</span>
          </div>
          <p className="mt-2 text-xs text-slate-400 leading-relaxed">
            The active incident highlights the suspected root-cause node with a purple beacon,
            isolating the originating failure from downstream victim cascades.
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold uppercase font-mono">
            <CheckCircle2 className="h-4 w-4" />
            <span>Interactive Node Inspection</span>
          </div>
          <p className="mt-2 text-xs text-slate-400 leading-relaxed">
            Click any service node to slide out its inspection drawer, verify latency vs baseline,
            and view live OpenTelemetry metrics.
          </p>
        </div>
      </div>
    </div>
  );
}
