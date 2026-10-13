import prisma from "../db/prisma";
import { SIMULATION_SCENARIOS } from "./scenarios";
import { DirectedGraph } from "../algorithms/graph";
import { RootCauseEngine } from "../algorithms/rootCauseEngine";
import { ServiceNodeData, TelemetryPoint } from "../algorithms/types";
import { seedDatabase } from "../db/seed";

export interface InjectParams {
  scenarioId: string;
  targetServiceId?: string;
  severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
}

export class SimulationManager {
  private engine: RootCauseEngine;

  constructor() {
    this.engine = new RootCauseEngine(6);
  }

  /**
   * Injects a failure scenario into the system and advances to step 1.
   */
  public async injectFailure(params: InjectParams) {
    const scenario = SIMULATION_SCENARIOS[params.scenarioId];
    if (!scenario) {
      throw new Error(`Scenario '${params.scenarioId}' not found.`);
    }

    const targetServiceId = params.targetServiceId ?? scenario.targetServiceId;
    const severity = params.severity ?? scenario.defaultSeverity;

    // Create a new Incident record
    const incident = await prisma.incident.create({
      data: {
        title: `${scenario.name} Incident`,
        description: scenario.description,
        severity,
        status: "INVESTIGATING",
        simulationScenario: scenario.id,
        rootCauseStatus: "PENDING",
      },
    });

    // Update simulation state
    await prisma.simulationState.upsert({
      where: { id: "active_simulation" },
      update: {
        currentStep: 0,
        activeScenario: scenario.id,
        injectedServiceId: targetServiceId, // Simulator-internal metadata for reproducible generator
        failureType: scenario.failureType,
        severity,
        status: "ACTIVE",
      },
      create: {
        id: "active_simulation",
        currentStep: 0,
        activeScenario: scenario.id,
        injectedServiceId: targetServiceId,
        failureType: scenario.failureType,
        severity,
        status: "ACTIVE",
      },
    });

    // Advance to step 1
    return await this.advanceSimulation(incident.id);
  }

  /**
   * Advances the active simulation by one step.
   * Deterministically applies cascading failure propagation according to the scenario.
   */
  public async advanceSimulation(targetIncidentId?: string) {
    const simState = await prisma.simulationState.findUnique({
      where: { id: "active_simulation" },
    });

    if (!simState || simState.status !== "ACTIVE" || !simState.activeScenario) {
      throw new Error("No active simulation to advance. Please inject a failure first.");
    }

    const scenario = SIMULATION_SCENARIOS[simState.activeScenario];
    if (!scenario) {
      throw new Error(`Scenario definition '${simState.activeScenario}' missing.`);
    }

    const nextStepNumber = simState.currentStep + 1;
    // Find step rule or repeat maximum step degradation
    const stepRule =
      scenario.steps.find((s) => s.step === nextStepNumber) ??
      scenario.steps[scenario.steps.length - 1];

    // Find active incident
    const incident = targetIncidentId
      ? await prisma.incident.findUnique({ where: { id: targetIncidentId } })
      : await prisma.incident.findFirst({
          where: { status: { in: ["INVESTIGATING", "IDENTIFIED"] } },
          orderBy: { startedAt: "desc" },
        });

    if (!incident) {
      throw new Error("No active incident found for current simulation.");
    }

    // Apply service changes for this step
    for (const affected of stepRule.affectedServices) {
      const service = await prisma.service.findUnique({ where: { id: affected.serviceId } });
      if (!service) continue;

      const newLatency = Math.round(
        service.baselineLatency * affected.latencyMultiplier + affected.addedLatencyMs
      );
      const newErrorRate = Math.min(100, Math.max(affected.errorRate, service.baselineErrorRate));

      await prisma.service.update({
        where: { id: affected.serviceId },
        data: {
          status: affected.status,
          currentLatency: newLatency,
          currentErrorRate: newErrorRate,
        },
      });

      // Record telemetry sample
      await prisma.telemetrySample.create({
        data: {
          serviceId: affected.serviceId,
          simulationStep: nextStepNumber,
          timestamp: new Date(),
          latency: newLatency,
          errorRate: newErrorRate,
          requestCount: service.requestRate * (affected.status === "DOWN" ? 15 : 60),
          healthStatus: affected.status,
        },
      });

      // Record evidence
      await prisma.incidentEvidence.create({
        data: {
          incidentId: incident.id,
          serviceId: affected.serviceId,
          evidenceType:
            affected.status === "DOWN"
              ? "SERVICE_UNAVAILABLE"
              : newLatency >= service.baselineLatency * 2
              ? "LATENCY_SPIKE"
              : "ERROR_RATE_SPIKE",
          observedValue: newLatency,
          expectedValue: service.baselineLatency,
          threshold: service.baselineLatency * 2,
          unit: "ms",
          explanation: affected.reason,
        },
      });
    }

    // Generate baseline telemetry for unaffected services to maintain regular sample rates
    const affectedIds = new Set(stepRule.affectedServices.map((s) => s.serviceId));
    const allServices = await prisma.service.findMany();
    for (const svc of allServices) {
      if (!affectedIds.has(svc.id)) {
        await prisma.telemetrySample.create({
          data: {
            serviceId: svc.id,
            simulationStep: nextStepNumber,
            timestamp: new Date(),
            latency: svc.currentLatency,
            errorRate: svc.currentErrorRate,
            requestCount: svc.requestRate * 60,
            healthStatus: svc.status,
          },
        });
      }
    }

    // Update simulation state
    await prisma.simulationState.update({
      where: { id: "active_simulation" },
      data: { currentStep: nextStepNumber },
    });

    // Run Root Cause Analysis
    const analysis = await this.recalculateRootCauses(incident.id);

    return {
      step: nextStepNumber,
      scenarioName: scenario.name,
      stepDescription: stepRule.description,
      incidentId: incident.id,
      analysis,
    };
  }

  /**
   * Recalculates root-cause rankings using graph algorithms and recorded telemetry.
   * Follows the critical rule: does NOT access injectedRootCause ground truth.
   */
  public async recalculateRootCauses(incidentId: string) {
    const services = await prisma.service.findMany();
    const dependencies = await prisma.serviceDependency.findMany();
    const telemetry = await prisma.telemetrySample.findMany({
      orderBy: { simulationStep: "asc" },
      take: 200,
    });

    // Reconstruct in-memory DirectedGraph
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

    for (const dep of dependencies) {
      graph.addEdge(dep.sourceServiceId, dep.targetServiceId, {
        dependencyType: dep.dependencyType as "SYNC_HTTP" | "ASYNC_QUEUE" | "DATABASE_CONN",
        timeoutThreshold: dep.timeoutThreshold,
        criticality: dep.criticality as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      });
    }

    // Map telemetry samples to domain type
    const telemetryPoints: TelemetryPoint[] = telemetry.map((t) => ({
      serviceId: t.serviceId,
      simulationStep: t.simulationStep,
      timestamp: t.timestamp,
      latency: t.latency,
      errorRate: t.errorRate,
      requestCount: t.requestCount,
      healthStatus: t.healthStatus,
    }));

    const currentStates = new Map<
      string,
      { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }
    >();
    for (const s of services) {
      currentStates.set(s.id, {
        status: s.status as "HEALTHY" | "DEGRADED" | "DOWN",
        latency: s.currentLatency,
        errorRate: s.currentErrorRate,
      });
    }

    // Run RootCauseEngine
    const analysis = this.engine.analyzeIncident({
      incidentId,
      graph,
      telemetrySamples: telemetryPoints,
      currentServiceStates: currentStates,
    });

    // Delete existing candidates for this incident and persist newly ranked ones
    await prisma.rootCauseCandidate.deleteMany({ where: { incidentId } });

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

    // Update incident status
    await prisma.incident.update({
      where: { id: incidentId },
      data: {
        rootCauseStatus: analysis.isConclusive ? "ANALYZED" : "INCONCLUSIVE",
        suspectedRootCauseId: analysis.topRootCause?.serviceId ?? null,
        status: analysis.topRootCause ? "IDENTIFIED" : "INVESTIGATING",
      },
    });

    return analysis;
  }

  /**
   * Restores a specific service back to its healthy baseline.
   */
  public async restoreService(serviceId: string) {
    const service = await prisma.service.findUnique({ where: { id: serviceId } });
    if (!service) {
      throw new Error(`Service '${serviceId}' not found.`);
    }

    // Restore service values
    await prisma.service.update({
      where: { id: serviceId },
      data: {
        status: "HEALTHY",
        currentLatency: service.baselineLatency,
        currentErrorRate: service.baselineErrorRate,
      },
    });

    // Record recovery telemetry sample
    await prisma.telemetrySample.create({
      data: {
        serviceId,
        simulationStep: 99,
        timestamp: new Date(),
        latency: service.baselineLatency,
        errorRate: service.baselineErrorRate,
        requestCount: service.requestRate * 60,
        healthStatus: "HEALTHY",
      },
    });

    // Check if any other services are still unhealthy
    const unhealthyServices = await prisma.service.findMany({
      where: { status: { not: "HEALTHY" } },
    });

    if (unhealthyServices.length === 0) {
      // Resolve active incidents
      await prisma.incident.updateMany({
        where: { status: { in: ["INVESTIGATING", "IDENTIFIED", "MITIGATED"] } },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
        },
      });

      // Update simulation state
      await prisma.simulationState.update({
        where: { id: "active_simulation" },
        data: { status: "RESOLVED" },
      });
    }

    // Recalculate analysis for the latest incident
    const latestIncident = await prisma.incident.findFirst({
      orderBy: { startedAt: "desc" },
    });

    const analysis = latestIncident
      ? await this.recalculateRootCauses(latestIncident.id)
      : null;

    return {
      restoredServiceId: serviceId,
      allHealthy: unhealthyServices.length === 0,
      analysis,
    };
  }

  /**
   * Resets the entire system back to clean baseline state.
   */
  public async resetSimulation() {
    await seedDatabase();
    return { success: true, message: "System reset to healthy baseline topology." };
  }
}

export const simulator = new SimulationManager();
