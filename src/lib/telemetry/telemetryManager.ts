import { prisma } from "../db/prisma";
import { ensureDatabaseSeeded } from "../db/ensure-seeded";
import { prometheusClient, ServiceMetricsSummary } from "./prometheusClient";
import { jaegerClient } from "./jaegerClient";
import {
  TelemetryMode,
  BackendHealthStatus,
  ObservedServiceMetric,
  DistributedTrace,
} from "./types";
import {
  NormalizedTelemetryBatch,
  NormalizedMetricRecord,
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

  public async getBackendHealth(forceProbe: boolean = false): Promise<BackendHealthStatus> {
    const cloudConfigured = Boolean(
      (process.env.GRAFANA_CLOUD_OTLP_ENDPOINT && process.env.GRAFANA_CLOUD_OTLP_ENDPOINT.trim().length > 0) ||
      (process.env.GRAFANA_CLOUD_PROMETHEUS_URL && process.env.GRAFANA_CLOUD_PROMETHEUS_URL.trim().length > 0)
    );

    if (this.currentMode === "SIMULATION" && !forceProbe) {
      const status: BackendHealthStatus = {
        prometheusAvailable: false,
        jaegerAvailable: false,
        prometheusUrl: prometheusClient.getBaseUrl(),
        jaegerUrl: jaegerClient.getBaseUrl(),
        isMockBackend: false,
        isCloudBackend: false,
        cloudConfigured,
        backendType: "SIMULATION",
        lastChecked: new Date().toISOString(),
        lastIngestedAt: this.lastIngestedAt || undefined,
        details: "Simulation mode active. Live network telemetry probes are disabled.",
      };
      this.lastHealthCheck = status;
      return status;
    }

    const [promHealth, jaegerHealth] = await Promise.all([
      prometheusClient.checkHealth(),
      jaegerClient.checkHealth(),
    ]);

    const isMock = Boolean(promHealth.isMock || jaegerHealth.isMock);
    const isCloud = Boolean(promHealth.isCloud || jaegerHealth.isCloud || cloudConfigured);

    let backendType: BackendHealthStatus["backendType"] = "UNAVAILABLE";
    if (promHealth.available && jaegerHealth.available) {
      backendType = isCloud && !isMock ? "GRAFANA_CLOUD" : isMock ? "MOCK_EMULATION" : "GENUINE_STACK";
    } else if (promHealth.available || jaegerHealth.available) {
      // Partial availability
      backendType = isMock ? "MOCK_EMULATION" : "GENUINE_STACK";
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
    if (promHealth.available && !jaegerHealth.available) {
      return `Prometheus connected, but Tempo/Jaeger is offline (${jaegerHealth.error || "unreachable"}).`;
    }
    if (!promHealth.available && jaegerHealth.available) {
      return `Tempo/Jaeger connected, but Prometheus is offline (${promHealth.error || "unreachable"}).`;
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
    let dbServices = await prisma.service.findMany();
    if (dbServices.length === 0) {
      await ensureDatabaseSeeded();
      dbServices = await prisma.service.findMany();
    }

    // 1. Strict Simulation Isolation: zero network requests
    if (this.currentMode === "SIMULATION") {
      const mockHealth: BackendHealthStatus = {
        prometheusAvailable: false,
        jaegerAvailable: false,
        prometheusUrl: prometheusClient.getBaseUrl(),
        jaegerUrl: jaegerClient.getBaseUrl(),
        isMockBackend: false,
        isCloudBackend: false,
        cloudConfigured: false,
        backendType: "SIMULATION",
        lastChecked: new Date().toISOString(),
        details: "Simulation mode active. Zero external network telemetry probes are issued.",
      };
      return this.buildSimulatedObservedServices(dbServices, mockHealth);
    }

    // 2. LIVE / REAL mode collection
    const backendHealth = await this.getBackendHealth(true);

    if (!backendHealth.prometheusAvailable && !backendHealth.jaegerAvailable) {
      return this.buildDegradedOfflineObservedServices(dbServices, backendHealth);
    }

    // Query both Prometheus and Jaeger with comprehensive diagnostics
    const [promMetricsDetailed, traceDetailed] = await Promise.all([
      prometheusClient.getServiceMetricsDetailed(),
      jaegerClient.getRecentTracesDetailed(undefined, 30),
    ]);

    const promSuccess = promMetricsDetailed.success && promMetricsDetailed.metrics.size > 0;
    const tempoSuccess = traceDetailed.success && traceDetailed.traces.length > 0;
    const hasData = promSuccess || tempoSuccess;

    // Truthful mode decision: requires BOTH backends to be connected, queries to succeed, and verified data returned
    const isTrulyLive = backendHealth.prometheusAvailable && backendHealth.jaegerAvailable && promSuccess && tempoSuccess;
    const effectiveMode: TelemetryMode = isTrulyLive ? "LIVE" : "DEGRADED";

    if (isTrulyLive) {
      this.lastIngestedAt = new Date().toISOString();
    }

    return this.buildLiveObservedServices(
      dbServices,
      backendHealth,
      effectiveMode,
      promMetricsDetailed.metrics,
      traceDetailed.traces,
      hasData
    );
  }

  private buildSimulatedObservedServices(
    dbServices: Array<{ id: string; name: string; status: string; currentLatency: number; currentErrorRate: number; requestRate: number; updatedAt: Date }>,
    backendHealth: BackendHealthStatus
  ) {
    const observed: ObservedServiceMetric[] = dbServices.map((s) => ({
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
    const unavailable: ObservedServiceMetric[] = dbServices.map((s) => ({
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
    promMetrics: Map<string, ServiceMetricsSummary>,
    recentTraces: DistributedTrace[],
    hasTelemetryData: boolean
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
          lastObserved: hasTelemetryData ? "No observations received" : "Empty query response (No series matching)",
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
        latencyP95Ms: metric?.latencyP95Ms,
        hasValidP95: metric?.hasValidP95,
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
          latencyP95Ms: metric.latencyP95Ms,
          hasValidP95: metric.hasValidP95,
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

  /**
   * Retrieves a normalized telemetry batch.
   * In SIMULATION mode: builds deterministic simulation batch with zero network requests.
   * In LIVE mode: runs bounded range queries and distributed trace queries, verifying evidence and truthfulness.
   */
  public async getNormalizedBatch(): Promise<NormalizedTelemetryBatch> {
    const batchId = `batch-${Date.now()}`;
    const collectedAt = new Date().toISOString();

    // 1. Strict Simulation Isolation: zero network calls
    if (this.currentMode === "SIMULATION") {
      let dbServices = await prisma.service.findMany();
      if (dbServices.length === 0) {
        await ensureDatabaseSeeded();
        dbServices = await prisma.service.findMany();
      }
      return this.buildSimulatedBatch(dbServices, batchId, collectedAt);
    }

    // 2. LIVE / REAL mode: verify health, range history, snapshots, and traces
    const backendHealth = await this.getBackendHealth(true);

    const [promDetailed, promHistoryDetailed, traceResult] = await Promise.all([
      prometheusClient.getServiceMetricsDetailed(),
      prometheusClient.getServiceMetricsHistory({ lookbackSec: 300, stepSec: 60 }),
      jaegerClient.getRecentTracesDetailed(undefined, 25),
    ]);

    const diagnostics: ProviderDiagnostic[] = [
      ...promDetailed.diagnostics,
      ...promHistoryDetailed.diagnostics,
      traceResult.diagnostic,
    ];

    const promConnected = backendHealth.prometheusAvailable;
    const promSnapshotOk = promDetailed.success && promDetailed.metrics.size > 0;
    const promRangeOk = promHistoryDetailed.success && promHistoryDetailed.records.length > 0;
    const promOk = promConnected && promSnapshotOk && promRangeOk;

    const tempoConnected = backendHealth.jaegerAvailable;
    const tempoOk = tempoConnected && traceResult.success && traceResult.traces.length > 0 && traceResult.normalizedSpans.length > 0;

    const isTrulyLive = promOk && tempoOk;
    const mode: "LIVE" | "DEGRADED" = isTrulyLive ? "LIVE" : "DEGRADED";

    if (isTrulyLive) {
      this.lastIngestedAt = new Date().toISOString();
    }

    return {
      batchId,
      collectedAt,
      mode,
      metrics: promHistoryDetailed.records.length > 0 ? promHistoryDetailed.records : [],
      spans: traceResult.normalizedSpans,
      diagnostics,
    };
  }

  private buildSimulatedBatch(
    dbServices: Array<{ id: string; name: string; currentLatency: number; currentErrorRate: number; requestRate: number; updatedAt: Date }>,
    batchId: string,
    collectedAt: string
  ): NormalizedTelemetryBatch {
    const metrics: NormalizedMetricRecord[] = [];

    for (const s of dbServices) {
      metrics.push({
        id: `sim-metric-req-${s.id}-${Date.now()}`,
        provider: "SIMULATION",
        serviceName: s.name,
        metricType: "REQUEST_RATE",
        metricName: "http_requests_total (simulated)",
        timestamp: s.updatedAt.toISOString(),
        value: s.requestRate,
        unit: "req/s",
        labels: { env: "simulation", source: "scenario" },
        hasAnomaly: false,
      });
      metrics.push({
        id: `sim-metric-err-${s.id}-${Date.now()}`,
        provider: "SIMULATION",
        serviceName: s.name,
        metricType: "ERROR_RATE",
        metricName: "http_request_errors_total (simulated)",
        timestamp: s.updatedAt.toISOString(),
        value: s.currentErrorRate,
        unit: "%",
        labels: { env: "simulation", source: "scenario" },
        hasAnomaly: s.currentErrorRate > 5,
      });
      metrics.push({
        id: `sim-metric-lat-${s.id}-${Date.now()}`,
        provider: "SIMULATION",
        serviceName: s.name,
        metricType: "LATENCY_AVG",
        metricName: "http_request_duration_seconds (simulated)",
        timestamp: s.updatedAt.toISOString(),
        value: s.currentLatency,
        unit: "ms",
        labels: { env: "simulation", source: "scenario" },
        hasAnomaly: s.currentLatency > 100,
      });
    }

    const diagnostics: ProviderDiagnostic[] = [
      {
        provider: "SIMULATION",
        endpoint: "in-memory-simulation",
        status: "OK",
        message: "Simulation mode active. Telemetry derived deterministically from scenario database without network requests.",
        latencyMs: 0,
        timestamp: collectedAt,
      },
    ];

    return {
      batchId,
      collectedAt,
      mode: "SIMULATION",
      metrics,
      spans: [],
      diagnostics,
    };
  }

  public async getRecentTraces(serviceId?: string, limit: number = 20): Promise<DistributedTrace[]> {
    if (this.currentMode === "SIMULATION") {
      return [];
    }
    return await jaegerClient.getRecentTraces(serviceId, limit);
  }

  public async getTraceDetail(traceId: string): Promise<DistributedTrace | null> {
    if (this.currentMode === "SIMULATION") {
      return null;
    }
    return await jaegerClient.getTraceById(traceId);
  }
}

export const telemetryManager = TelemetryManager.getInstance();
