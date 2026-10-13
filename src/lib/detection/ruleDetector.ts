import { prisma } from "../db/prisma";
import { telemetryManager } from "../telemetry/telemetryManager";

export interface DetectionResult {
  incidentCreated: boolean;
  incidentId?: string;
  triggeredRules: Array<{
    serviceId: string;
    ruleName: string;
    observedValue: number;
    threshold: number;
    description: string;
  }>;
  skippedReason?: string;
}

export class RealIncidentDetector {
  private static instance: RealIncidentDetector;
  private lastIncidentCreatedAt: number = 0;
  private cooldownMs: number = (Number(process.env.INCIDENT_DETECTION_COOLDOWN_SECONDS) || 60) * 1000;

  public static getInstance(): RealIncidentDetector {
    if (!RealIncidentDetector.instance) {
      RealIncidentDetector.instance = new RealIncidentDetector();
    }
    return RealIncidentDetector.instance;
  }

  public setCooldownSeconds(seconds: number) {
    this.cooldownMs = seconds * 1000;
  }

  public async evaluateTelemetry(): Promise<DetectionResult> {
    const { observedServices, backendHealth } = await telemetryManager.getObservedServices();

    if (!backendHealth.prometheusAvailable && !backendHealth.jaegerAvailable) {
      return {
        incidentCreated: false,
        triggeredRules: [],
        skippedReason: "Observability backends unreachable; no live telemetry to evaluate.",
      };
    }

    const now = Date.now();
    const triggeredRules: DetectionResult["triggeredRules"] = [];

    // Query baseline services from database
    const services = await prisma.service.findMany();
    const serviceMap = new Map(services.map((s) => [s.id, s]));

    for (const obs of observedServices) {
      const base = serviceMap.get(obs.serviceId);
      if (!base) continue;

      // Rule 1: High Latency Anomaly (> 2.5x baseline or > 400ms)
      const latencyThreshold = Math.max(300, base.baselineLatency * 2.5);
      if (obs.latencyMs > latencyThreshold && obs.requestRate > 0) {
        triggeredRules.push({
          serviceId: obs.serviceId,
          ruleName: "ELEVATED_LATENCY_THRESHOLD_BREACH",
          observedValue: obs.latencyMs,
          threshold: latencyThreshold,
          description: `Observed p95 latency (${obs.latencyMs}ms) exceeds anomaly threshold (${latencyThreshold}ms). Baseline is ${base.baselineLatency}ms.`,
        });
      }

      // Rule 2: Elevated Error Rate (> 5% error rate)
      const errorThreshold = Math.max(5.0, base.baselineErrorRate * 3.0);
      if (obs.errorRate > errorThreshold && obs.requestRate > 0) {
        triggeredRules.push({
          serviceId: obs.serviceId,
          ruleName: "ELEVATED_ERROR_RATE_SPIKE",
          observedValue: obs.errorRate,
          threshold: errorThreshold,
          description: `Observed HTTP error rate (${obs.errorRate}%) breached acceptable SLA threshold (${errorThreshold}%).`,
        });
      }
    }

    if (triggeredRules.length === 0) {
      return {
        incidentCreated: false,
        triggeredRules: [],
        skippedReason: "All observed services operating within normal SLA thresholds.",
      };
    }

    // Check deduplication cooldown window
    const timeSinceLast = now - this.lastIncidentCreatedAt;
    if (timeSinceLast < this.cooldownMs) {
      return {
        incidentCreated: false,
        triggeredRules,
        skippedReason: `Active incident cooldown active (${Math.round((this.cooldownMs - timeSinceLast) / 1000)}s remaining) to prevent flapping alert fatigue.`,
      };
    }

    // Determine primary service involved
    const primaryBreach = triggeredRules[0];
    const targetService = serviceMap.get(primaryBreach.serviceId);

    // Persist new Incident in database
    const incident = await prisma.incident.create({
      data: {
        title: `Real Telemetry Anomaly Detected: ${targetService?.name || primaryBreach.serviceId}`,
        description: `Automated rule detector triggered on live metrics from OpenTelemetry. ${triggeredRules.length} anomaly signal(s) confirmed.`,
        severity: triggeredRules.some((r) => r.ruleName.includes("ERROR")) ? "CRITICAL" : "HIGH",
        status: "INVESTIGATING",
        simulationScenario: "live-telemetry-observation",
        rootCauseStatus: "PENDING",
      },
    });

    this.lastIncidentCreatedAt = now;

    // Persist incident evidence
    for (const rule of triggeredRules) {
      await prisma.incidentEvidence.create({
        data: {
          incidentId: incident.id,
          serviceId: rule.serviceId,
          evidenceType: rule.ruleName.includes("LATENCY") ? "LATENCY_SPIKE" : "ERROR_RATE_SPIKE",
          observedValue: rule.observedValue,
          expectedValue: rule.threshold / 2,
          threshold: rule.threshold,
          unit: rule.ruleName.includes("LATENCY") ? "ms" : "%",
          explanation: rule.description,
        },
      });
    }

    return {
      incidentCreated: true,
      incidentId: incident.id,
      triggeredRules,
    };
  }
}

export const realIncidentDetector = RealIncidentDetector.getInstance();
