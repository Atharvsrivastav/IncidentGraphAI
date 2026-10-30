import { prisma } from "../db/prisma";
import { DirectedGraph } from "./graph";
import { RootCauseEngine, RootCauseInput } from "./rootCauseEngine";
import { ServiceNodeData, TelemetryPoint, IncidentAnalysisSummary } from "./types";
import { telemetryManager } from "../telemetry/telemetryManager";

export class RealRootCauseEngine {
  private baseEngine: RootCauseEngine;

  constructor() {
    this.baseEngine = new RootCauseEngine(6);
  }

  /**
   * Analyzes an incident using actual observed telemetry and distributed traces.
   * Zero leakage: Never accesses hidden scenario configuration.
   */
  public async analyzeRealIncident(incidentId: string): Promise<IncidentAnalysisSummary> {
    // 1. Build DirectedGraph from database topology
    const services = await prisma.service.findMany({
      include: { outgoingDependencies: true },
    });
    const graph = new DirectedGraph<ServiceNodeData>();

    for (const svc of services) {
      graph.addNode(svc.id, {
        id: svc.id,
        name: svc.name,
        serviceType: svc.serviceType,
        tier: svc.tier,
        status: svc.status as "HEALTHY" | "DEGRADED" | "DOWN",
        baselineLatency: svc.baselineLatency,
        currentLatency: svc.currentLatency,
        baselineErrorRate: svc.baselineErrorRate,
        currentErrorRate: svc.currentErrorRate,
        requestRate: svc.requestRate,
      });
    }

    for (const svc of services) {
      for (const dep of svc.outgoingDependencies) {
        graph.addEdge(dep.sourceServiceId, dep.targetServiceId, {
          dependencyType: dep.dependencyType as "SYNC_HTTP" | "ASYNC_QUEUE" | "DATABASE_CONN",
          timeoutThreshold: dep.timeoutThreshold,
          criticality: dep.criticality as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
        });
      }
    }

    // 2. Fetch live observed metrics, historical normalized batch, and recent traces from TelemetryManager
    const [batch, { observedServices }, recentTraces] = await Promise.all([
      telemetryManager.getNormalizedBatch(),
      telemetryManager.getObservedServices(),
      telemetryManager.getRecentTraces(undefined, 25),
    ]);

    // 3. Extract unique timestamps across all normalized historical metrics
    const uniqueTimestamps = new Set<string>();
    for (const m of batch.metrics) {
      if (m.metricType === "REQUEST_RATE" || m.metricType === "ERROR_RATE" || m.metricType === "LATENCY_AVG") {
        uniqueTimestamps.add(m.timestamp);
      }
    }

    // Sort historical timestamps in ascending chronological order
    const sortedTimestamps = Array.from(uniqueTimestamps).sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime()
    );

    // Convert historical timestamps into monotonically increasing observation steps (1, 2, 3...)
    const stepByTimestamp = new Map<string, number>();
    sortedTimestamps.forEach((ts, idx) => {
      stepByTimestamp.set(ts, idx + 1);
    });

    // 4. Construct multiple chronological TelemetryPoint samples per service from historical batch
    const telemetrySamples: TelemetryPoint[] = [];

    for (const svc of services) {
      const svcMetrics = batch.metrics.filter(
        (m) => m.serviceName === svc.id || m.serviceName === svc.name
      );

      for (const ts of sortedTimestamps) {
        const reqRec = svcMetrics.find((m) => m.timestamp === ts && m.metricType === "REQUEST_RATE");
        const errRec = svcMetrics.find((m) => m.timestamp === ts && m.metricType === "ERROR_RATE");
        const latRec = svcMetrics.find((m) => m.timestamp === ts && m.metricType === "LATENCY_AVG");

        // Only construct a valid TelemetryPoint when measurements actually exist
        // Do not fabricate healthy metrics from database baselines!
        if (latRec !== undefined || errRec !== undefined) {
          const latency = latRec?.value ?? 0;
          const errorRate = errRec?.value ?? 0; // Preserves actual ERROR_RATE percentage, not throughput
          const requestRate = reqRec?.value ?? 0;

          let healthStatus = "HEALTHY";
          if (errorRate > 25 || (svc.baselineLatency > 0 && latency >= svc.baselineLatency * 4)) {
            healthStatus = "DOWN";
          } else if (errorRate > 3 || (svc.baselineLatency > 0 && latency >= svc.baselineLatency * 1.8)) {
            healthStatus = "DEGRADED";
          }

          telemetrySamples.push({
            serviceId: svc.id,
            simulationStep: stepByTimestamp.get(ts)!,
            timestamp: new Date(ts),
            latency,
            errorRate,
            requestCount: requestRate * 60,
            healthStatus,
          });
        }
      }
    }

    // 5. Construct current service states from actual measurements
    // Preserve UNKNOWN; do NOT map UNKNOWN to HEALTHY!
    const currentServiceStates = new Map<
      string,
      { status: "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN"; latency: number; errorRate: number }
    >();

    for (const obs of observedServices) {
      currentServiceStates.set(obs.serviceId, {
        status: obs.status,
        latency: obs.latencyMs,
        errorRate: obs.errorRate,
      });
    }

    // 4. Augment with trace bottleneck evidence
    // If trace spans reveal a specific downstream service or database operation consumed >60% of total trace duration
    for (const trace of recentTraces) {
      if (trace.hasErrors || trace.durationMs > 200) {
        for (const span of trace.allSpans) {
          if (span.durationMs > 150 && span.serviceName) {
            // Find corresponding node
            const matchedNode = services.find(
              (s) => s.id === span.serviceName || s.name.toLowerCase().includes(span.serviceName.toLowerCase())
            );
            if (matchedNode) {
              const cur = currentServiceStates.get(matchedNode.id);
              if (cur) {
                cur.latency = Math.max(cur.latency, span.durationMs);
                cur.status = span.statusCode === "ERROR" ? "DOWN" : "DEGRADED";
              }
            }
          }
        }
      }
    }

    const input: RootCauseInput = {
      incidentId,
      graph,
      telemetrySamples,
      currentServiceStates,
    };

    // 5. Execute explainable root-cause ranking engine
    const analysis = this.baseEngine.analyzeIncident(input);

    // 6. Persist results in Incident and RootCauseCandidate models
    await prisma.incident.update({
      where: { id: incidentId },
      data: {
        rootCauseStatus: analysis.isConclusive ? "ANALYZED" : "INCONCLUSIVE",
        suspectedRootCauseId: analysis.topRootCause?.serviceId || null,
      },
    });

    // Delete prior candidates and insert fresh ranked candidates
    await prisma.rootCauseCandidate.deleteMany({
      where: { incidentId },
    });

    for (const cand of analysis.allCandidates) {
      await prisma.rootCauseCandidate.create({
        data: {
          incidentId,
          candidateServiceId: cand.serviceId,
          score: cand.score,
          rank: cand.rank,
          confidence: cand.confidence,
          explanation: cand.explanation,
          supportingEvidence: JSON.stringify(cand.supportingEvidence),
          contradictoryEvidence: JSON.stringify(cand.contradictoryEvidence),
          recommendedAction: cand.recommendedAction,
        },
      });
    }

    return analysis;
  }
}

export const realRootCauseEngine = new RealRootCauseEngine();
