import { prisma } from "../db/prisma";
import { ensureDatabaseSeeded } from "../db/ensure-seeded";
import { prometheusClient, ServiceMetricsSummary } from "./prometheusClient";
import { jaegerClient } from "./jaegerClient";
import {
  TelemetryMode,
  TelemetryProvenanceState,
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
  private requestedMode: TelemetryMode = "SIMULATION";
  private effectiveMode: TelemetryMode = "SIMULATION";
  private lastHealthCheck: BackendHealthStatus | null = null;
  private lastIngestedAt: string | null = null;
  private lastVerifiedAt: string | null = null;
  private metricsIngested: boolean = false;
  private tracesIngested: boolean = false;
  private cachedObservation: {
    timestamp: number;
    data: {
      mode: TelemetryMode;
      requestedMode: TelemetryMode;
      effectiveMode: TelemetryMode;
      backendHealth: BackendHealthStatus;
      observedServices: ObservedServiceMetric[];
      unknownServices: ObservedServiceMetric[];
      lastCollectedAt: string;
      lastIngestedAt: string | null;
    };
  } | null = null;

  public static getInstance(): TelemetryManager {
    if (!TelemetryManager.instance) {
      TelemetryManager.instance = new TelemetryManager();
    }
    return TelemetryManager.instance;
  }

  public getMode(): TelemetryMode {
    return this.requestedMode;
  }

  public getRequestedMode(): TelemetryMode {
    return this.requestedMode;
  }

  public getEffectiveMode(): TelemetryMode {
    return this.effectiveMode;
  }

  public getOperationalState(): {
    requestedMode: TelemetryMode;
    effectiveMode: TelemetryMode;
    lastIngestedAt: string | null;
  } {
    return {
      requestedMode: this.requestedMode,
      effectiveMode: this.effectiveMode,
      lastIngestedAt: this.lastIngestedAt,
    };
  }

  public setMode(mode: TelemetryMode): void {
    const normalized = mode === "REAL" ? "LIVE" : mode;
    this.requestedMode = normalized;
    this.cachedObservation = null;

    if (normalized === "SIMULATION") {
      this.effectiveMode = "SIMULATION";
      this.metricsIngested = false;
      this.tracesIngested = false;
      this.lastVerifiedAt = null;
    } else {
      // LIVE mode requires confirmed telemetry observations; starts at DEGRADED until verified
      this.effectiveMode = "DEGRADED";
    }
  }

  public markDegraded(): void {
    if (this.requestedMode !== "SIMULATION") {
      this.effectiveMode = "DEGRADED";
    }
    this.cachedObservation = null;
  }

  public getLastIngestedAt(): string | null {
    return this.lastIngestedAt;
  }

  public async getBackendHealth(forceProbe: boolean = false): Promise<BackendHealthStatus> {
    if (!forceProbe && this.cachedObservation && Date.now() - this.cachedObservation.timestamp < 3000) {
      return this.cachedObservation.data.backendHealth;
    }

    const cloudConfigured = Boolean(
      (process.env.GRAFANA_CLOUD_OTLP_ENDPOINT && process.env.GRAFANA_CLOUD_OTLP_ENDPOINT.trim().length > 0) ||
      (process.env.GRAFANA_CLOUD_PROMETHEUS_URL && process.env.GRAFANA_CLOUD_PROMETHEUS_URL.trim().length > 0)
    );

    if (this.requestedMode === "SIMULATION" && !forceProbe) {
      const status: BackendHealthStatus = {
        prometheusAvailable: false,
        jaegerAvailable: false,
        prometheusUrl: prometheusClient.getBaseUrl(),
        jaegerUrl: jaegerClient.getBaseUrl(),
        isMockBackend: false,
        isCloudBackend: false,
        cloudConfigured,
        backendType: "SIMULATION",
        provenance: "DISABLED",
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

    let provenance: TelemetryProvenanceState = "DISABLED";
    if (this.requestedMode === "SIMULATION") {
      provenance = "DISABLED";
    } else if (isMock) {
      provenance = "MOCK_EMULATION";
    } else if (!promHealth.available && !jaegerHealth.available) {
      provenance = cloudConfigured ? "ERROR" : "DISABLED";
    } else if (!promHealth.available || !jaegerHealth.available) {
      provenance = "ERROR";
    } else if (isCloud && !isMock) {
      provenance = (this.effectiveMode === "LIVE" && this.metricsIngested && this.tracesIngested && this.lastVerifiedAt) ? "LIVE" : "LOCAL";
    } else {
      provenance = "LOCAL";
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
      provenance,
      lastChecked: new Date().toISOString(),
      lastIngestedAt: this.lastIngestedAt || undefined,
      lastVerifiedAt: this.lastVerifiedAt || undefined,
      metricsIngested: this.metricsIngested,
      tracesIngested: this.tracesIngested,
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
      return "Connected to local mock observability server (MOCK_EMULATION). Dev mock emulation - not production telemetry.";
    }
    return "Connected to genuine local Prometheus and Jaeger observability stack.";
  }

  public async getObservedServices(forceRefresh: boolean = false): Promise<{
    mode: TelemetryMode;
    requestedMode?: TelemetryMode;
    effectiveMode?: TelemetryMode;
    backendHealth: BackendHealthStatus;
    observedServices: ObservedServiceMetric[];
    unknownServices: ObservedServiceMetric[];
    lastCollectedAt: string;
    lastIngestedAt: string | null;
  }> {
    // Reuse fresh cached observation snapshot to avoid duplicating expensive provider queries on every navigation poll
    if (!forceRefresh && this.cachedObservation && Date.now() - this.cachedObservation.timestamp < 3000) {
      return this.cachedObservation.data;
    }

    let dbServices = await prisma.service.findMany();
    if (dbServices.length === 0) {
      await ensureDatabaseSeeded();
      dbServices = await prisma.service.findMany();
    }

    // 1. Strict Simulation Isolation: zero network requests
    if (this.requestedMode === "SIMULATION") {
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

    const knownServiceIds = new Set(dbServices.map((s) => s.id));
    const knownServiceNames = new Set(dbServices.map((s) => s.name));

    // Verify metrics: must match known topology service and contain valid non-empty data
    let validMonitoredMetricsCount = 0;
    for (const [key, metric] of promMetricsDetailed.metrics.entries()) {
      if (
        (knownServiceIds.has(key) || knownServiceNames.has(key)) &&
        (metric.hasValidLatency || metric.hasValidErrorRate || metric.hasValidRequestRate)
      ) {
        validMonitoredMetricsCount++;
      }
    }
    const promMetricsVerified = promMetricsDetailed.success && validMonitoredMetricsCount > 0;

    // Verify traces: must have actual spans, not be fallback, belong to monitored services, and be recent
    const verifiedRecentTraces = traceDetailed.traces.filter((t) => {
      if (t.isFallback) return false;
      if (!t.allSpans || t.allSpans.length === 0) return false;
      const involvesMonitored = t.servicesInvolved.some((s) => knownServiceIds.has(s) || knownServiceNames.has(s));
      if (!involvesMonitored) return false;
      const ts = new Date(t.startTime).getTime();
      return !isNaN(ts) && Date.now() - ts < 30 * 60 * 1000;
    });
    const tempoTracesVerified = traceDetailed.success && verifiedRecentTraces.length > 0;

    this.metricsIngested = promMetricsVerified;
    this.tracesIngested = tempoTracesVerified;

    const hasData = promMetricsVerified || tempoTracesVerified;

    // Truthful mode decision: requires BOTH backends to be connected, queries to succeed, and verified recent data returned
    const isTrulyLive = backendHealth.prometheusAvailable && backendHealth.jaegerAvailable && promMetricsVerified && tempoTracesVerified;
    const effectiveMode: TelemetryMode = isTrulyLive ? "LIVE" : "DEGRADED";
    this.effectiveMode = effectiveMode;

    if (isTrulyLive) {
      this.lastIngestedAt = new Date().toISOString();
      this.lastVerifiedAt = new Date().toISOString();
    }

    return this.buildLiveObservedServices(
      dbServices,
      backendHealth,
      effectiveMode,
      promMetricsDetailed.metrics,
      traceDetailed.traces,
      hasData,
      promMetricsDetailed.success
    );
  }

  private buildSimulatedObservedServices(
    dbServices: Array<{ id: string; name: string; status: string; currentLatency: number; currentErrorRate: number; requestRate: number; updatedAt: Date }>,
    backendHealth: BackendHealthStatus
  ) {
    backendHealth.provenance = "DISABLED";
    backendHealth.metricsIngested = false;
    backendHealth.tracesIngested = false;
    backendHealth.lastVerifiedAt = undefined;
    const observed: ObservedServiceMetric[] = dbServices.map((s) => ({
      serviceId: s.id,
      serviceName: s.name,
      source: "SIMULATION" as const,
      provenance: "DISABLED" as const,
      status: s.status as "HEALTHY" | "DEGRADED" | "DOWN",
      latencyMs: s.currentLatency,
      hasValidLatency: true,
      errorRate: s.currentErrorRate,
      hasValidErrorRate: true,
      requestRate: s.requestRate,
      hasValidRequestRate: true,
      lastObserved: s.updatedAt.toISOString(),
      traceCount: 0,
      isStale: false,
      isKnownInTopology: true,
    }));

    this.effectiveMode = "SIMULATION";
    const result = {
      mode: "SIMULATION" as const,
      requestedMode: "SIMULATION" as const,
      effectiveMode: "SIMULATION" as const,
      backendHealth,
      observedServices: observed,
      unknownServices: [],
      lastCollectedAt: new Date().toISOString(),
      lastIngestedAt: this.lastIngestedAt,
    };

    this.cachedObservation = {
      timestamp: Date.now(),
      data: result,
    };
    return result;
  }

  private buildDegradedOfflineObservedServices(
    dbServices: Array<{ id: string; name: string }>,
    backendHealth: BackendHealthStatus
  ) {
    const offlineProvenance: TelemetryProvenanceState = backendHealth.cloudConfigured ? "ERROR" : "DISABLED";
    backendHealth.provenance = offlineProvenance;
    backendHealth.metricsIngested = false;
    backendHealth.tracesIngested = false;
    backendHealth.lastVerifiedAt = undefined;
    const unavailable: ObservedServiceMetric[] = dbServices.map((s) => ({
      serviceId: s.id,
      serviceName: s.name,
      source: "PROMETHEUS" as const,
      provenance: offlineProvenance,
      status: "UNKNOWN" as const,
      latencyMs: 0,
      hasValidLatency: false,
      errorRate: 0,
      hasValidErrorRate: false,
      requestRate: 0,
      hasValidRequestRate: false,
      lastObserved: "N/A (Backends Offline)",
      traceCount: 0,
      isStale: true,
      isKnownInTopology: true,
    }));

    this.effectiveMode = "DEGRADED";
    const result = {
      mode: "DEGRADED" as const,
      requestedMode: this.requestedMode,
      effectiveMode: "DEGRADED" as const,
      backendHealth,
      observedServices: unavailable,
      unknownServices: [],
      lastCollectedAt: new Date().toISOString(),
      lastIngestedAt: this.lastIngestedAt,
    };

    this.cachedObservation = {
      timestamp: Date.now(),
      data: result,
    };
    return result;
  }

  private buildLiveObservedServices(
    dbServices: Array<{ id: string; name: string; baselineLatency: number }>,
    backendHealth: BackendHealthStatus,
    effectiveMode: TelemetryMode,
    promMetrics: Map<string, ServiceMetricsSummary>,
    recentTraces: DistributedTrace[],
    hasTelemetryData: boolean,
    promQuerySuccess: boolean = true
  ) {
    const liveProvenance: TelemetryProvenanceState = backendHealth.isMockBackend
      ? "MOCK_EMULATION"
      : backendHealth.isCloudBackend
      ? (effectiveMode === "LIVE" ? "LIVE" : backendHealth.prometheusAvailable && backendHealth.jaegerAvailable ? "LOCAL" : "ERROR")
      : (effectiveMode === "LIVE" ? "LOCAL" : "ERROR");

    backendHealth.provenance = liveProvenance;
    backendHealth.metricsIngested = this.metricsIngested;
    backendHealth.tracesIngested = this.tracesIngested;
    backendHealth.lastVerifiedAt = this.lastVerifiedAt || undefined;
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

      // When Prometheus metric is missing or both latency and error rate observations are absent:
      // Keep trace evidence separate from metric evidence.
      // Missing latency must remain unknown. Missing error rate must not silently become healthy 0%.
      if (!metric || (!metric.hasValidLatency && !metric.hasValidErrorRate)) {
        let lastObserved = traceCount > 0
          ? "Trace observations present, but metric telemetry missing"
          : (hasTelemetryData ? "No metric observations received" : "Empty query response (No series matching)");
        if (!promQuerySuccess) {
          lastObserved = "Prometheus query failed (Incomplete or failed metric telemetry)";
        }
        observedServices.push({
          serviceId: svc.id,
          serviceName: svc.name,
          source: traceCount > 0 ? "JAEGER" : "PROMETHEUS",
          provenance: liveProvenance,
          status: "UNKNOWN",
          latencyMs: 0,
          hasValidLatency: false,
          errorRate: 0,
          hasValidErrorRate: false,
          requestRate: metric?.requestRate ?? 0,
          hasValidRequestRate: Boolean(metric?.hasValidRequestRate),
          lastObserved,
          traceCount,
          isStale: true,
          isKnownInTopology: true,
        });
        continue;
      }

      const hasValidLatency = Boolean(metric.hasValidLatency);
      const hasValidErrorRate = Boolean(metric.hasValidErrorRate);
      const hasValidRequestRate = Boolean(metric.hasValidRequestRate);

      const latency = hasValidLatency ? metric.latencyMs : 0;
      const errorRate = hasValidErrorRate ? metric.errorRate : 0;
      const requestRate = hasValidRequestRate ? metric.requestRate : 0;

      // Status determination with independent metric evaluation:
      // Confirmed severe anomaly on either valid metric -> DOWN
      // Confirmed moderate anomaly on either valid metric -> DEGRADED
      // Partial metric evidence without confirmed anomaly -> UNKNOWN (cannot certify HEALTHY without complete evidence)
      // Both metrics valid and within normal baseline bounds -> HEALTHY
      let status: "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN" = "HEALTHY";
      let lastObserved = new Date().toISOString();
      let isStale = false;

      const isLatencyDown = hasValidLatency && svc.baselineLatency > 0 && latency >= svc.baselineLatency * 4;
      const isErrorDown = hasValidErrorRate && errorRate > 25;
      const isLatencyDegraded = hasValidLatency && svc.baselineLatency > 0 && latency >= svc.baselineLatency * 1.8;
      const isErrorDegraded = hasValidErrorRate && errorRate > 3;

      if (isLatencyDown || isErrorDown) {
        status = "DOWN";
      } else if (isLatencyDegraded || isErrorDegraded) {
        status = "DEGRADED";
      } else if (!hasValidLatency || !hasValidErrorRate) {
        // Partial evidence: e.g. latency is normal, but error rate is uninstrumented/missing (or vice versa)
        // Cannot certify HEALTHY without complete evidence!
        status = "UNKNOWN";
        isStale = true;
        lastObserved = !hasValidLatency
          ? "Partial metric telemetry: Latency metrics missing or unavailable"
          : "Partial metric telemetry: Error rate metrics missing or unavailable";
      }

      observedServices.push({
        serviceId: svc.id,
        serviceName: svc.name,
        source: "PROMETHEUS",
        provenance: liveProvenance,
        status,
        latencyMs: latency,
        hasValidLatency,
        latencyP95Ms: metric.latencyP95Ms,
        hasValidP95: metric.hasValidP95,
        errorRate,
        hasValidErrorRate,
        requestRate,
        hasValidRequestRate,
        lastObserved,
        traceCount,
        isStale,
        isKnownInTopology: true,
      });
    }

    for (const [serviceName, metric] of promMetrics.entries()) {
      if (!topologyIds.has(serviceName)) {
        const hasValidLatency = Boolean(metric.hasValidLatency);
        const hasValidErrorRate = Boolean(metric.hasValidErrorRate);
        let status: "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN" = "HEALTHY";
        if (hasValidErrorRate && metric.errorRate > 5) {
          status = "DEGRADED";
        } else if (!hasValidLatency || !hasValidErrorRate) {
          status = "UNKNOWN";
        }

        unknownServices.push({
          serviceId: serviceName,
          serviceName,
          source: "PROMETHEUS",
          provenance: liveProvenance,
          status,
          latencyMs: hasValidLatency ? metric.latencyMs : 0,
          hasValidLatency,
          latencyP95Ms: metric.latencyP95Ms,
          hasValidP95: metric.hasValidP95,
          errorRate: hasValidErrorRate ? metric.errorRate : 0,
          hasValidErrorRate,
          requestRate: metric.requestRate,
          hasValidRequestRate: Boolean(metric.hasValidRequestRate),
          lastObserved: new Date().toISOString(),
          traceCount: traceCountByService.get(serviceName) || 0,
          isStale: !hasValidLatency || !hasValidErrorRate,
          isKnownInTopology: false,
        });
      }
    }

    const result = {
      mode: effectiveMode,
      requestedMode: this.requestedMode,
      effectiveMode,
      backendHealth,
      observedServices,
      unknownServices,
      lastCollectedAt: new Date().toISOString(),
      lastIngestedAt: this.lastIngestedAt,
    };

    this.cachedObservation = {
      timestamp: Date.now(),
      data: result,
    };

    return result;
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
    if (this.requestedMode === "SIMULATION") {
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
    if (this.requestedMode === "SIMULATION") {
      return [];
    }
    return await jaegerClient.getRecentTraces(serviceId, limit);
  }

  public async getTraceDetail(traceId: string): Promise<DistributedTrace | null> {
    if (this.requestedMode === "SIMULATION") {
      return null;
    }
    return await jaegerClient.getTraceById(traceId);
  }
}

export const telemetryManager = TelemetryManager.getInstance();
