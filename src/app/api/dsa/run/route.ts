import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";
import { DirectedGraph } from "@/lib/algorithms/graph";
import { PriorityQueue } from "@/lib/algorithms/priorityQueue";
import { SlidingWindowAnalyzer } from "@/lib/algorithms/slidingWindow";
import { RootCauseEngine } from "@/lib/algorithms/rootCauseEngine";
import { ServiceNodeData, TelemetryPoint } from "@/lib/algorithms/types";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { algorithm, selectedServiceId, windowSize = 5, injectTestCycle = false } = body;

    const services = await prisma.service.findMany();
    const dependencies = await prisma.serviceDependency.findMany();

    const graph = new DirectedGraph<ServiceNodeData>();
    for (const s of services) {
      graph.addNode(s.id, {
        id: s.id,
        name: s.name,
        serviceType: s.serviceType,
        tier: s.tier,
        status: s.status as "HEALTHY" | "DEGRADED" | "DOWN",
        baselineLatency: s.baselineLatency,
        currentLatency: s.currentLatency,
        baselineErrorRate: s.baselineErrorRate,
        currentErrorRate: s.currentErrorRate,
        requestRate: s.requestRate,
      });
    }

    for (const d of dependencies) {
      graph.addEdge(d.sourceServiceId, d.targetServiceId, {
        dependencyType: d.dependencyType as "SYNC_HTTP" | "ASYNC_QUEUE" | "DATABASE_CONN",
        timeoutThreshold: d.timeoutThreshold,
        criticality: d.criticality as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      });
    }

    if (injectTestCycle) {
      // Temporarily inject cycle for demonstration: postgres-db -> api-gateway
      graph.addEdge("postgres-db", "api-gateway", {
        dependencyType: "SYNC_HTTP",
        timeoutThreshold: 1000,
        criticality: "CRITICAL",
      });
    }

    const t0 = performance.now();

    if (algorithm === "BFS") {
      const startId = selectedServiceId || "postgres-db";
      const traversal = graph.findImpactedDependents(startId);
      const executionTimeMs = performance.now() - t0;
      return NextResponse.json({
        algorithm: "BFS (Breadth-First Search Impact Propagation)",
        startNode: startId,
        traversal,
        executionTimeMs: Math.round(executionTimeMs * 1000) / 1000,
        complexity: { time: "O(V + E)", space: "O(V)" },
      });
    }

    if (algorithm === "DFS_CYCLES") {
      const cycleResult = graph.findCycles();
      const executionTimeMs = performance.now() - t0;
      return NextResponse.json({
        algorithm: "3-Color DFS Cycle Detection",
        hasCycle: cycleResult.hasCycle,
        cycles: cycleResult.cycles,
        executionTimeMs: Math.round(executionTimeMs * 1000) / 1000,
        complexity: { time: "O(V + E)", space: "O(V)" },
      });
    }

    if (algorithm === "PRIORITY_QUEUE") {
      const pq = new PriorityQueue<{ id: string; name: string }>("MAX");
      pq.insert({ id: "postgres-db", name: "PostgreSQL Database" }, 92);
      pq.insert({ id: "order-service", name: "Order Service" }, 64);
      pq.insert({ id: "api-gateway", name: "API Gateway" }, 45);
      pq.insert({ id: "auth-service", name: "Auth Service" }, 12);
      pq.insert({ id: "notification-service", name: "Notification Service" }, 5);

      const extractedOrder = pq.extractTopK(5);
      const executionTimeMs = performance.now() - t0;
      return NextResponse.json({
        algorithm: "Binary Heap Priority Queue",
        extractedOrder,
        executionTimeMs: Math.round(executionTimeMs * 1000) / 1000,
        complexity: { time: "O(log N) insert/extract, O(K log N) top-K", space: "O(N)" },
      });
    }

    if (algorithm === "SLIDING_WINDOW") {
      const telemetry = await prisma.telemetrySample.findMany({
        where: selectedServiceId ? { serviceId: selectedServiceId } : undefined,
        orderBy: { simulationStep: "asc" },
      });

      const analyzer = new SlidingWindowAnalyzer(windowSize);
      const points: TelemetryPoint[] = telemetry.map((t) => ({
        serviceId: t.serviceId,
        simulationStep: t.simulationStep,
        timestamp: t.timestamp,
        latency: t.latency,
        errorRate: t.errorRate,
        requestCount: t.requestCount,
        healthStatus: t.healthStatus,
      }));

      const service = services.find((s) => s.id === (selectedServiceId || "postgres-db"));
      const stats = analyzer.analyzeServiceWindow(
        service?.id || "postgres-db",
        points.filter((p) => p.serviceId === (service?.id || "postgres-db")),
        service?.baselineLatency || 11,
        service?.baselineErrorRate || 0.02
      );

      const executionTimeMs = performance.now() - t0;
      return NextResponse.json({
        algorithm: "Sliding Window Telemetry Analyzer",
        windowSize,
        stats,
        executionTimeMs: Math.round(executionTimeMs * 1000) / 1000,
        complexity: { time: "O(W) where W is window size", space: "O(W)" },
      });
    }

    if (algorithm === "ROOT_CAUSE_ENGINE") {
      const telemetry = await prisma.telemetrySample.findMany({
        orderBy: { simulationStep: "asc" },
      });
      const points: TelemetryPoint[] = telemetry.map((t) => ({
        serviceId: t.serviceId,
        simulationStep: t.simulationStep,
        timestamp: t.timestamp,
        latency: t.latency,
        errorRate: t.errorRate,
        requestCount: t.requestCount,
        healthStatus: t.healthStatus,
      }));

      const currentStates = new Map<string, { status: "HEALTHY" | "DEGRADED" | "DOWN"; latency: number; errorRate: number }>();
      for (const s of services) {
        currentStates.set(s.id, {
          status: s.status as "HEALTHY" | "DEGRADED" | "DOWN",
          latency: s.currentLatency,
          errorRate: s.currentErrorRate,
        });
      }

      const engine = new RootCauseEngine(windowSize);
      const analysis = engine.analyzeIncident({
        incidentId: "dsa-lab-live-eval",
        graph,
        telemetrySamples: points,
        currentServiceStates: currentStates,
      });

      const executionTimeMs = performance.now() - t0;
      return NextResponse.json({
        algorithm: "Explainable Root-Cause Ranking Engine",
        analysis,
        executionTimeMs: Math.round(executionTimeMs * 1000) / 1000,
        complexity: {
          time: "O(V * (E + W) + V log V)",
          space: "O(V + E + W)",
        },
      });
    }

    return NextResponse.json({ error: "Unknown algorithm requested" }, { status: 400 });
  } catch (error: unknown) {
    console.error("DSA live run error:", error);
    const message = error instanceof Error ? error.message : "DSA evaluation failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
