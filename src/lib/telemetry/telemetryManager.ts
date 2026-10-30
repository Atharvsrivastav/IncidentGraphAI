import { prisma } from "../db/prisma";
import { prometheusClient } from "./prometheusClient";
import { jaegerClient } from "./jaegerClient";
import {
  TelemetryMode,
  BackendHealthStatus,
  ObservedServiceMetric,
  DistributedTrace,
} from "./types";
import {
  NormalizedTelemetryBatch,
  ProviderDiagnostic,
} from "./normalization";

export class TelemetryManager {
  private static instance: TelemetryManager;
  private currentMode: TelemetryMode = "SIMULATION";
  private lastHealthCheck: BackendHealthStatus | null = null;
  private lastIngestedAt: string | null = null;

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
    if (mode === "REAL") {
      this.currentMode = "LIVE";
    } else {
      this.currentMode = mode;
    }
  }

  public getLastIngestedAt(): string | null {
    return this.lastIngestedAt;
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

    let backendType: BackendHealthStatus["backendType"] = "UNAVAILABLE";
    if (isAvailable) {
      if (isCloud && !isMock) {
        backendType = "GRAFANA_CLOUD";
      } else if (isMock) {
        backendType = "MOCK_EMULATION";
      } else {
        backendType = "GENUINE_STACK";
      }
    }

    const details = this.formatHealthDetails(cloudConfigured, isMock, promHealth, jaegerHealth);

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
      lastIngestedAt: this.lastIngestedAt || undefined,
      details,
    };

    this.lastHealthCheck = status;
    return status;
  }

  private formatHealthDetails(
    cloudConfigured: boolean,
    isMock: boolean,
    promHealth: { available: boolean; error?: string },
    jaegerHealth: { available: boolean; error?: string }
  ): string {
    if (cloudConfigured) {
      if (promHealth.available && jaegerHealth.available) {
        return "Connected to Grafana Cloud hosted observability stack (Prometheus & Tempo).";
      }
      return promHealth.error || jaegerHealth.error || "Grafana Cloud configured but unreachable.";
    }
    if (!promHealth.available && !jaegerHealth.available) {
      return "No telemetry backends are connected. Configure Grafana Cloud in .env or run local dev services.";
    }
    if (isMock) {
      return "Connected to local mock observability server (MOCK_EMULATION).";
    }
    return "Connected to genuine local Prometheus and Jaeger observability stack.";
  }

  public async getObservedServices(): Promise<{
    mode: TelemetryMode;
    backendHealth: BackendHealthStatus;
    observedServices: ObservedServiceMetric[];
    unknownServices: ObservedServiceMetric[];
    lastCollectedAt: string;
    lastIngestedAt: string | null;
  }> {
    const backendHealth = await this.getBackendHealth();
    const dbServices = await prisma.service.findMany();

    if (this.currentMode === "SIMULATION") {
      return this.buildSimulatedObservedServices(dbServices, backendHealth);
    }

    // In LIVE / REAL mode:
    if (!backendHealth.prometheusAvailable && !backendHealth.jaegerAvailable) {
      return this.buildDegradedOfflineObservedServices(dbServices, backendHealth);
    }

    const [promMetrics, recentTraces] = await Promise.all([
      prometheusClient.getServiceMetrics(),
      jaegerClient.getRecentTraces(undefined, 30),
    ]);

    if (promMetrics.size > 0 || recentTraces.length > 0) {
      this.lastIngestedAt = new Date().toISOString();
    }

    const effectiveMode: TelemetryMode =
      backendHealth.prometheusAvailable && backendHealth.jaegerAvailable ? "LIVE" : "DEGRADED";

    return this.buildLiveObservedServices(dbServices, backendHealth, effectiveMode, promMetrics, recentTraces);
  }

  private buildSimulatedObservedServices(
    dbServices: Array<{ id: string; name: string; status: string; currentLatency: number; currentErrorRate: number; requestRate: number; updatedAt: Date }>,
    backendHealth: BackendHealthStatus
  ) {
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
      mode: "SIMULATION" as const,
      backendHealth,
      observedServices: observed,
      unknownServices: [],
      lastCollectedAt: new Date().toISOString(),
      lastIngestedAt: this.lastIngestedAt,
    };
  }

  private buildDegradedOfflineObservedServices(
    dbServices: Array<{ id: string; name: string }>,
    backendHealth: BackendHealthStatus
  ) {
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
      mode: "DEGRADED" as const,
      backendHealth,
      observedServices: unavailable,
      unknownServices: [],
      lastCollectedAt: new Date().toISOString(),
      lastIngestedAt: this.lastIngestedAt,
    };
  }

  private buildLiveObservedServices(
    dbServices: Array<{ id: string; name: string; baselineLatency: number }>,
    backendHealth: BackendHealthStatus,
    effectiveMode: TelemetryMode,
    promMetrics: Map<string, { latencyMs: number; errorRate: number; requestRate: number }>,
    recentTraces: DistributedTrace[]
  ) {
    const topologyIds = new Set(dbServices.map((s) => s.id));
    const traceCountByService = new Map<string, number>();

    for (const trace of recentTraces) {
      for (const svc of trace.servicesInvolved) {
        traceCountByService.set(svc, (traceCountByService.get(svc) || 0) + 1);
      }
    }

    const observedServices: ObservedServiceMetric[] = [];
    const unknownServices: ObservedServiceMetric[] = [];

    for (const svc of dbServices) {
      const metric = promMetrics.get(svc.id) || promMetrics.get(svc.name);
      const traceCount = traceCountByService.get(svc.id) || traceCountByService.get(svc.name) || 0;

      if (!metric && traceCount === 0) {
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
      mode: effectiveMode,
      backendHealth,
      observedServices,
      unknownServices,
      lastCollectedAt: new Date().toISOString(),
      lastIngestedAt: this.lastIngestedAt,
    };
  }

  public async getNormalizedBatch(): Promise<NormalizedTelemetryBatch> {
    const health = await this.getBackendHealth();
    const batchId = `batch-${Date.now()}`;
    const collectedAt = new Date().toISOString();

    const [promResult, traceResult] = await Promise.all([
      prometheusClient.queryInstantDetailed("http_request_duration_seconds", "LATENCY_AVG"),
      jaegerClient.getRecentTracesDetailed(undefined, 25),
    ]);

    const diagnostics: ProviderDiagnostic[] = [promResult.diagnostic, traceResult.diagnostic];

    let mode: "SIMULATION" | "LIVE" | "DEGRADED" = "SIMULATION";
    if (this.currentMode === "LIVE" || this.currentMode === "REAL") {
      mode = health.prometheusAvailable && health.jaegerAvailable ? "LIVE" : "DEGRADED";
    }

    return {
      batchId,
      collectedAt,
      mode,
      metrics: promResult.records,
      spans: traceResult.normalizedSpans,
      diagnostics,
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
