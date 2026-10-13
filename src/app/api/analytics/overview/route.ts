import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";

export async function GET() {
  try {
    const services = await prisma.service.findMany({
      orderBy: { name: "asc" },
    });

    const totalServices = services.length;
    const healthyCount = services.filter((s) => s.status === "HEALTHY").length;
    const degradedCount = services.filter((s) => s.status === "DEGRADED").length;
    const downCount = services.filter((s) => s.status === "DOWN").length;

    const activeIncidents = await prisma.incident.findMany({
      where: { status: { in: ["INVESTIGATING", "IDENTIFIED", "MITIGATED"] } },
      orderBy: { startedAt: "desc" },
      include: {
        rootCauseCandidates: {
          orderBy: { rank: "asc" },
          take: 1,
          include: { service: { select: { id: true, name: true } } },
        },
      },
    });

    const recentIncidents = await prisma.incident.findMany({
      take: 5,
      orderBy: { startedAt: "desc" },
      include: {
        rootCauseCandidates: {
          orderBy: { rank: "asc" },
          take: 1,
          include: { service: { select: { id: true, name: true } } },
        },
      },
    });

    // Recent telemetry samples for timeline trends
    const recentTelemetry = await prisma.telemetrySample.findMany({
      take: 50,
      orderBy: { simulationStep: "asc" },
    });

    // Aggregate trends by simulation step
    const stepAggregates = new Map<number, { step: number; avgLatency: number; avgErrorRate: number; count: number }>();
    for (const sample of recentTelemetry) {
      const existing = stepAggregates.get(sample.simulationStep) ?? {
        step: sample.simulationStep,
        avgLatency: 0,
        avgErrorRate: 0,
        count: 0,
      };
      existing.avgLatency += sample.latency;
      existing.avgErrorRate += sample.errorRate;
      existing.count += 1;
      stepAggregates.set(sample.simulationStep, existing);
    }

    const trends = Array.from(stepAggregates.values()).map((agg) => ({
      step: `Step ${agg.step}`,
      latency: Math.round(agg.avgLatency / Math.max(1, agg.count)),
      errorRate: Math.round((agg.avgErrorRate / Math.max(1, agg.count)) * 10) / 10,
    }));

    // If trends are sparse, provide initial baseline step
    if (trends.length === 0) {
      trends.push({ step: "Step 0 (Baseline)", latency: 28, errorRate: 0.1 });
    }

    const currentSeverity = activeIncidents.length > 0 ? activeIncidents[0].severity : "NONE";

    const latestIncident = activeIncidents[0] ?? recentIncidents[0] ?? null;
    let latestRootCause = null;
    if (latestIncident && latestIncident.rootCauseCandidates.length > 0) {
      const top = latestIncident.rootCauseCandidates[0];
      latestRootCause = {
        serviceId: top.candidateServiceId,
        serviceName: top.service.name,
        score: top.score,
        confidence: top.confidence,
        explanation: top.explanation,
        recommendedAction: top.recommendedAction,
      };
    }

    return NextResponse.json({
      summary: {
        totalServices,
        healthyCount,
        degradedCount,
        downCount,
        activeIncidentsCount: activeIncidents.length,
        currentSeverity,
      },
      distribution: [
        { name: "Healthy", count: healthyCount, color: "#10b981" },
        { name: "Degraded", count: degradedCount, color: "#f59e0b" },
        { name: "Down", count: downCount, color: "#ef4444" },
      ],
      trends,
      recentIncidents: recentIncidents.map((inc) => ({
        id: inc.id,
        title: inc.title,
        severity: inc.severity,
        status: inc.status,
        startedAt: inc.startedAt,
        suspectedRootCause: inc.rootCauseCandidates[0]?.service.name ?? "Analyzing...",
      })),
      latestRootCause,
    });
  } catch (error) {
    console.error("GET /api/analytics/overview error:", error);
    return NextResponse.json({ error: "Failed to retrieve analytics overview." }, { status: 500 });
  }
}
