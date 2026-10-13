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

    // 2. Fetch live observed metrics & traces from TelemetryManager
    const { observedServices } = await telemetryManager.getObservedServices();
    const recentTraces = await telemetryManager.getRecentTraces(undefined, 25);

    // 3. Construct TelemetryPoints and current states from actual measurements
    const currentServiceStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>();
    const telemetrySamples: TelemetryPoint[] = [];

    const now = new Date();
    for (const obs of observedServices) {
      const stateStatus = obs.status === "UNKNOWN" ? "HEALTHY" : obs.status;
      currentServiceStates.set(obs.serviceId, {
        status: stateStatus,
        latency: obs.latencyMs,
        errorRate: obs.errorRate,
      });

      // Synthetic sample step 1
      telemetrySamples.push({
        serviceId: obs.serviceId,
        simulationStep: 1,
        timestamp: now,
        latency: obs.latencyMs,
        errorRate: obs.errorRate,
        requestCount: obs.requestRate * 60,
        healthStatus: stateStatus,
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
