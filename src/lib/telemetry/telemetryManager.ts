import { prisma } from "../db/prisma";
import { prometheusClient } from "./prometheusClient";
import { jaegerClient } from "./jaegerClient";
import {
  TelemetryMode,
  BackendHealthStatus,
  ObservedServiceMetric,
  DistributedTrace,
} from "./types";

export class TelemetryManager {
  private static instance: TelemetryManager;
  private currentMode: TelemetryMode = "SIMULATION";
  private lastHealthCheck: BackendHealthStatus | null = null;

  public static getInstance(): TelemetryManager {
    if (!TelemetryManager.instance) {
      TelemetryManager.instance = new TelemetryManager();
    }
    return TelemetryManager.instance;
  }

  public getMode(): TelemetryMode {
    return this.currentMode;
  }

  public setMode(mode: TelemetryMode): void {
    this.currentMode = mode;
    console.log(`[TelemetryManager] Telemetry mode switched to: ${mode}`);
  }

  public async getBackendHealth(): Promise<BackendHealthStatus> {
    const cloudConfigured = Boolean(
      (process.env.GRAFANA_CLOUD_OTLP_ENDPOINT && process.env.GRAFANA_CLOUD_OTLP_ENDPOINT.trim().length > 0) ||
      (process.env.GRAFANA_CLOUD_PROMETHEUS_URL && process.env.GRAFANA_CLOUD_PROMETHEUS_URL.trim().length > 0)
    );

    const [promHealth, jaegerHealth] = await Promise.all([
      prometheusClient.checkHealth(),
      jaegerClient.checkHealth(),
    ]);

    const isAvailable = promHealth.available || jaegerHealth.available;
    const isMock = Boolean(promHealth.isMock || jaegerHealth.isMock);
    const isCloud = Boolean(promHealth.isCloud || jaegerHealth.isCloud || cloudConfigured);

    let backendType: "GRAFANA_CLOUD" | "GENUINE_STACK" | "MOCK_EMULATION" | "UNAVAILABLE" = "UNAVAILABLE";
    if (isAvailable) {
      if (isCloud && !isMock) {
        backendType = "GRAFANA_CLOUD";
      } else if (isMock) {
        backendType = "MOCK_EMULATION";
      } else {
        backendType = "GENUINE_STACK";
      }
    }

    let details = "";
    if (cloudConfigured) {
      if (promHealth.available && jaegerHealth.available) {
        details = "Connected to Grafana Cloud hosted observability stack (Prometheus metrics & Tempo distributed traces over HTTPS).";
      } else if (promHealth.available) {
        details = "Grafana Cloud Prometheus metrics connected; Tempo trace backend pending or unreachable.";
      } else if (jaegerHealth.available) {
        details = "Grafana Cloud Tempo traces connected; Prometheus metrics backend pending or unreachable.";
      } else {
        details = promHealth.error || jaegerHealth.error || "Grafana Cloud configured but unreachable. Check API token and network connection.";
      }
    } else if (!promHealth.available && !jaegerHealth.available) {
      details = "No telemetry backends are connected. Configure Grafana Cloud in .env or run local dev services.";
    } else if (isMock) {
      details = "Connected to local mock observability server (MOCK_EMULATION mode for dev/testing). NOT genuine Docker or Grafana Cloud.";
    } else if (!promHealth.available) {
      details = "Jaeger tracing backend is connected, but Prometheus metrics backend is unreachable.";
    } else if (!jaegerHealth.available) {
      details = "Prometheus metrics backend is connected, but Jaeger tracing backend is unreachable.";
    } else {
      details = "Connected to genuine local Prometheus and Jaeger observability stack.";
    }

    const status: BackendHealthStatus = {
      prometheusAvailable: promHealth.available,
      jaegerAvailable: jaegerHealth.available,
      prometheusUrl: prometheusClient.getBaseUrl(),
      jaegerUrl: jaegerClient.getBaseUrl(),
      isMockBackend: isMock,
      isCloudBackend: isCloud,
      cloudConfigured,
      backendType,
      lastChecked: new Date().toISOString(),
      details,
    };

    this.lastHealthCheck = status;
    return status;
  }

  public async getObservedServices(): Promise<{
    mode: TelemetryMode;
    backendHealth: BackendHealthStatus;
    observedServices: ObservedServiceMetric[];
    unknownServices: ObservedServiceMetric[];
    lastCollectedAt: string;
  }> {
    const backendHealth = await this.getBackendHealth();
    const dbServices = await prisma.service.findMany();
    const topologyIds = new Set(dbServices.map((s) => s.id));

    // If in SIMULATION mode, return simulated states
    if (this.currentMode === "SIMULATION") {
      const observed = dbServices.map((s) => ({
        serviceId: s.id,
        serviceName: s.name,
        source: "SIMULATION" as const,
        status: s.status as "HEALTHY" | "DEGRADED" | "DOWN",
        latencyMs: s.currentLatency,
        errorRate: s.currentErrorRate,
        requestRate: s.requestRate,
        lastObserved: s.updatedAt.toISOString(),
        traceCount: 0,
        isStale: false,
        isKnownInTopology: true,
      }));

      return {
        mode: "SIMULATION",
        backendHealth,
        observedServices: observed,
        unknownServices: [],
        lastCollectedAt: new Date().toISOString(),
      };
    }

    // In REAL mode: Query actual Prometheus metrics and Jaeger traces
    if (!backendHealth.prometheusAvailable && !backendHealth.jaegerAvailable) {
      // Both backends unreachable: Mark as UNKNOWN without fabricating data
      const unavailable = dbServices.map((s) => ({
        serviceId: s.id,
        serviceName: s.name,
        source: "PROMETHEUS" as const,
        status: "UNKNOWN" as const,
        latencyMs: 0,
        errorRate: 0,
        requestRate: 0,
        lastObserved: "N/A (Backends Offline)",
        traceCount: 0,
        isStale: true,
        isKnownInTopology: true,
      }));

      return {
        mode: "REAL",
        backendHealth,
        observedServices: unavailable,
        unknownServices: [],
        lastCollectedAt: new Date().toISOString(),
      };
    }

    const [promMetrics, recentTraces] = await Promise.all([
      prometheusClient.getServiceMetrics(),
      jaegerClient.getRecentTraces(undefined, 30),
    ]);

    // Count traces per service
    const traceCountByService = new Map<string, number>();
    for (const trace of recentTraces) {
      for (const svc of trace.servicesInvolved) {
        traceCountByService.set(svc, (traceCountByService.get(svc) || 0) + 1);
      }
    }

    const observedServices: ObservedServiceMetric[] = [];
    const unknownServices: ObservedServiceMetric[] = [];

    // Map database topology services
    for (const svc of dbServices) {
      const metric = promMetrics.get(svc.id) || promMetrics.get(svc.name);
      const traceCount = traceCountByService.get(svc.id) || traceCountByService.get(svc.name) || 0;

      if (!metric && traceCount === 0) {
        // No telemetry observed yet for this service
        observedServices.push({
          serviceId: svc.id,
          serviceName: svc.name,
          source: "PROMETHEUS",
          status: "UNKNOWN",
          latencyMs: 0,
          errorRate: 0,
          requestRate: 0,
          lastObserved: "No observations received",
          traceCount: 0,
          isStale: true,
          isKnownInTopology: true,
        });
        continue;
      }

      const latency = metric?.latencyMs ?? svc.baselineLatency;
      const errorRate = metric?.errorRate ?? 0;
      const requestRate = metric?.requestRate ?? 0;

      // Determine health status from real measurements
      let status: "HEALTHY" | "DEGRADED" | "DOWN" = "HEALTHY";
      if (errorRate > 25 || latency > svc.baselineLatency * 4) {
        status = "DOWN";
      } else if (errorRate > 3 || latency > svc.baselineLatency * 1.8) {
        status = "DEGRADED";
      }

      observedServices.push({
        serviceId: svc.id,
        serviceName: svc.name,
        source: "PROMETHEUS",
        status,
        latencyMs: latency,
        errorRate,
        requestRate,
        lastObserved: new Date().toISOString(),
        traceCount,
        isStale: false,
        isKnownInTopology: true,
      });
    }

    // Identify unknown services reporting telemetry that are not in the database topology
    for (const [serviceName, metric] of promMetrics.entries()) {
      if (!topologyIds.has(serviceName)) {
        unknownServices.push({
          serviceId: serviceName,
          serviceName,
          source: "PROMETHEUS",
          status: metric.errorRate > 5 ? "DEGRADED" : "HEALTHY",
          latencyMs: metric.latencyMs,
          errorRate: metric.errorRate,
          requestRate: metric.requestRate,
          lastObserved: new Date().toISOString(),
          traceCount: traceCountByService.get(serviceName) || 0,
          isStale: false,
          isKnownInTopology: false,
        });
      }
    }

    return {
      mode: "REAL",
      backendHealth,
      observedServices,
      unknownServices,
      lastCollectedAt: new Date().toISOString(),
    };
  }

  public async getRecentTraces(serviceId?: string, limit: number = 20): Promise<DistributedTrace[]> {
    return await jaegerClient.getRecentTraces(serviceId, limit);
  }

  public async getTraceDetail(traceId: string): Promise<DistributedTrace | null> {
    return await jaegerClient.getTraceById(traceId);
  }
}

export const telemetryManager = TelemetryManager.getInstance();
