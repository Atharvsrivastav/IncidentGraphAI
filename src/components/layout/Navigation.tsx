"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  GitFork,
  AlertTriangle,
  PlayCircle,
  Binary,
  Settings,
  RefreshCw,
  Cpu,
  Radio,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: Activity },
  { href: "/service-map", label: "Service Map", icon: GitFork },
  { href: "/incidents", label: "Incidents", icon: AlertTriangle },
  { href: "/traces", label: "Traces", icon: Radio },
  { href: "/simulator", label: "Failure Simulator", icon: PlayCircle },
  { href: "/dsa-lab", label: "DSA Lab", icon: Binary },
  { href: "/settings", label: "Settings", icon: Settings },
];

import { TelemetryUIMode, normalizeTelemetryMode } from "@/lib/telemetry/mergeServiceMetrics";

export function Navigation() {
  const pathname = usePathname();
  const [systemStatus, setSystemStatus] = useState<string>("HEALTHY");
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [activeScenario, setActiveScenario] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [canReset, setCanReset] = useState<boolean>(false);
  const [requestedMode, setRequestedMode] = useState<TelemetryUIMode>("SIMULATION");
  const [effectiveMode, setEffectiveMode] = useState<TelemetryUIMode>("SIMULATION");
  const [backendType, setBackendType] = useState<string>("SIMULATION");
  const [isSwitchingMode, setIsSwitchingMode] = useState<boolean>(false);

  const fetchStatus = useCallback(async () => {
    try {
      const [simRes, modeRes] = await Promise.all([
        fetch("/api/simulations/state"),
        fetch("/api/telemetry/mode"),
      ]);
      if (simRes.ok) {
        const data = await simRes.json();
        setCurrentStep(data.state?.currentStep ?? 0);
        setActiveScenario(data.state?.activeScenario ?? null);
        if (typeof data.canReset === "boolean") {
          setCanReset(data.canReset);
        }
        if (data.activeIncident) {
          setSystemStatus("INCIDENT");
        } else {
          setSystemStatus("HEALTHY");
        }
      }
      if (modeRes.ok) {
        const modeData = await modeRes.json();
        const eff = normalizeTelemetryMode(modeData.effectiveMode ?? modeData.mode);
        const req = normalizeTelemetryMode(modeData.requestedMode ?? modeData.mode);
        setEffectiveMode(eff);
        setRequestedMode(req);
        if (modeData.health?.backendType) {
          setBackendType(modeData.health.backendType);
        }
      }
    } catch {
      // Ignored in background polling
    }
  }, []);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (active) await fetchStatus();
    };
    void poll();
    const interval = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [pathname, fetchStatus]);

  const handleReset = async () => {
    if (!canReset) return;
    setIsResetting(true);
    try {
      const res = await fetch("/api/simulations/reset", { method: "POST" });
      if (res.ok) {
        await fetchStatus();
        window.location.reload();
      }
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        {/* Brand */}
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 shadow-md shadow-blue-500/20 group-hover:scale-105 transition-transform">
              <Cpu className="h-5 w-5 text-white" />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-base tracking-tight text-white">IncidentGraph</span>
                <span className="rounded bg-blue-500/20 px-1.5 py-0.2 text-[10px] font-semibold text-blue-400 border border-blue-500/30">
                  AI MVP
                </span>
              </div>
              <span className="text-[11px] font-medium text-slate-400">SRE Topology & RCA Engine</span>
            </div>
          </Link>

          {/* Navigation Links */}
          <nav className="hidden md:flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-slate-800 text-blue-400 font-semibold border border-slate-700 shadow-sm"
                      : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"
                  }`}
                >
                  <Icon className={`h-4 w-4 ${isActive ? "text-blue-400" : "text-slate-400"}`} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Right Status & Controls */}
        <div className="flex items-center gap-3">
          {/* Telemetry Mode Selector */}
          <div className="flex items-center rounded-lg border border-slate-800 bg-slate-900/90 p-0.5 text-xs font-mono">
            <button
              onClick={async () => {
                setIsSwitchingMode(true);
                try {
                  const res = await fetch("/api/telemetry/mode", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ mode: "SIMULATION" }),
                  });
                  if (res.ok) {
                    const data = await res.json();
                    setEffectiveMode(normalizeTelemetryMode(data.effectiveMode ?? data.mode));
                    setRequestedMode("SIMULATION");
                    if (data.health?.backendType) {
                      setBackendType(data.health.backendType);
                    } else {
                      setBackendType("SIMULATION");
                    }
                  }
                } catch {
                  // Keep current state on error; never fabricate mode
                } finally {
                  setIsSwitchingMode(false);
                }
              }}
              disabled={isSwitchingMode}
              className={`rounded px-2 py-1 text-[10px] font-semibold transition-colors ${
                requestedMode === "SIMULATION"
                  ? "bg-blue-600 text-white font-bold shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Simulation
            </button>
            <button
              onClick={async () => {
                setIsSwitchingMode(true);
                try {
                  const res = await fetch("/api/telemetry/mode", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ mode: "LIVE" }),
                  });
                  if (res.ok) {
                    const data = await res.json();
                    setEffectiveMode(normalizeTelemetryMode(data.effectiveMode ?? data.mode));
                    setRequestedMode("LIVE");
                    if (data.health?.backendType) {
                      setBackendType(data.health.backendType);
                    }
                  } else {
                    // Under NO circumstance does a failed request set status to LIVE!
                    console.error("Failed to switch telemetry mode to LIVE");
                  }
                } catch {
                  // Under NO circumstance does a network failure set status to LIVE!
                  console.error("Network error switching telemetry mode");
                } finally {
                  setIsSwitchingMode(false);
                }
              }}
              disabled={isSwitchingMode}
              className={`rounded px-2 py-1 text-[10px] font-semibold transition-colors ${
                isSwitchingMode
                  ? "bg-slate-800 text-slate-300 font-bold shadow-sm animate-pulse"
                  : requestedMode === "LIVE" && (effectiveMode === "DEGRADED" || backendType === "UNAVAILABLE")
                  ? "bg-amber-600 text-white font-bold shadow-sm"
                  : requestedMode === "LIVE" && backendType === "MOCK_EMULATION"
                  ? "bg-purple-600 text-white font-bold shadow-sm"
                  : requestedMode === "LIVE" && backendType === "GRAFANA_CLOUD"
                  ? "bg-sky-600 text-white font-bold shadow-sm"
                  : requestedMode === "LIVE" && effectiveMode === "LIVE"
                  ? "bg-emerald-600 text-white font-bold shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {isSwitchingMode
                ? "Connecting..."
                : requestedMode === "LIVE" && (effectiveMode === "DEGRADED" || backendType === "UNAVAILABLE")
                ? "OTel (Degraded)"
                : requestedMode === "LIVE" && backendType === "MOCK_EMULATION"
                ? "Mock Emulation"
                : requestedMode === "LIVE" && backendType === "GRAFANA_CLOUD"
                ? "Grafana Cloud (Connected)"
                : requestedMode === "LIVE" && effectiveMode === "LIVE"
                ? "Live OTel (Connected)"
                : "Live OTel"}
            </button>
          </div>

          {/* Status Badge */}
          <div className="hidden sm:flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/90 px-3 py-1 text-xs">
            <div
              className={`h-2 w-2 rounded-full ${
                systemStatus === "INCIDENT"
                  ? "bg-red-500 animate-pulse"
                  : effectiveMode === "DEGRADED" || backendType === "UNAVAILABLE"
                  ? "bg-amber-500 animate-pulse"
                  : requestedMode === "LIVE" && backendType === "MOCK_EMULATION"
                  ? "bg-purple-400"
                  : requestedMode === "LIVE" && backendType === "GRAFANA_CLOUD"
                  ? "bg-sky-400"
                  : requestedMode === "SIMULATION"
                  ? "bg-blue-400"
                  : "bg-emerald-500"
              }`}
            />
            <span className="font-medium text-slate-300">
              {systemStatus === "INCIDENT"
                ? `Active Incident (${activeScenario ?? (requestedMode === "SIMULATION" ? "Simulated" : "Live")})`
                : effectiveMode === "DEGRADED" || backendType === "UNAVAILABLE"
                ? "Telemetry Pipeline Degraded"
                : requestedMode === "LIVE" && backendType === "MOCK_EMULATION"
                ? "Mock Telemetry Emulation"
                : requestedMode === "LIVE" && backendType === "GRAFANA_CLOUD"
                ? "Grafana Cloud Telemetry"
                : requestedMode === "LIVE" && backendType === "GENUINE_STACK"
                ? "Genuine Local Telemetry"
                : requestedMode === "SIMULATION"
                ? "Simulation Mode"
                : "All Systems Operational"}
            </span>
            {currentStep > 0 && requestedMode === "SIMULATION" && (
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-400">
                Step {currentStep}
              </span>
            )}
          </div>

          {/* Quick Reset Baseline Button (Dev/Test only) */}
          {canReset && (
            <button
              onClick={handleReset}
              disabled={isResetting}
              title="Reset system to healthy baseline"
              className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/80 hover:bg-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isResetting ? "animate-spin text-blue-400" : "text-slate-400"}`} />
              <span className="hidden sm:inline">Reset Baseline</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
