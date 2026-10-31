import { NextResponse } from "next/server";
import { telemetryManager } from "@/lib/telemetry/telemetryManager";
import { prisma } from "@/lib/db/prisma";

export async function GET() {
  try {
    const services = await prisma.service.findMany();
    const activeIncidents = await prisma.incident.count({
      where: { status: { in: ["OPEN", "INVESTIGATING"] } },
    });
    const health = await telemetryManager.getBackendHealth();
    const mode = telemetryManager.getMode();

    const healthyCount = services.filter((s) => s.status === "HEALTHY").length;
    const degradedCount = services.filter((s) => s.status === "DEGRADED").length;
    const downCount = services.filter((s) => s.status === "DOWN").length;

    const lines: string[] = [];

    lines.push("# HELP incidentgraph_monitored_services_total Total number of services monitored by IncidentGraphAI");
    lines.push("# TYPE incidentgraph_monitored_services_total gauge");
    lines.push(`incidentgraph_monitored_services_total ${services.length}`);

    lines.push("# HELP incidentgraph_service_health_count Number of services in each health state");
    lines.push("# TYPE incidentgraph_service_health_count gauge");
    lines.push(`incidentgraph_service_health_count{state="healthy"} ${healthyCount}`);
    lines.push(`incidentgraph_service_health_count{state="degraded"} ${degradedCount}`);
    lines.push(`incidentgraph_service_health_count{state="down"} ${downCount}`);

    lines.push("# HELP incidentgraph_active_incidents_total Number of active incidents currently under investigation");
    lines.push("# TYPE incidentgraph_active_incidents_total gauge");
    lines.push(`incidentgraph_active_incidents_total ${activeIncidents}`);

    lines.push("# HELP incidentgraph_backend_status Status of telemetry backend integration (1=available, 0=unavailable)");
    lines.push("# TYPE incidentgraph_backend_status gauge");
    lines.push(`incidentgraph_backend_status{type="prometheus"} ${health.prometheusAvailable ? 1 : 0}`);
    lines.push(`incidentgraph_backend_status{type="tempo"} ${health.jaegerAvailable ? 1 : 0}`);

    lines.push("# HELP incidentgraph_telemetry_mode Active telemetry operating mode (1=active)");
    lines.push("# TYPE incidentgraph_telemetry_mode gauge");
    lines.push(`incidentgraph_telemetry_mode{mode="${mode.toLowerCase()}"} 1`);

    for (const svc of services) {
      lines.push(`incidentgraph_service_current_latency_ms{service="${svc.id}"} ${svc.currentLatency ?? 0}`);
      lines.push(`incidentgraph_service_current_error_rate{service="${svc.id}"} ${svc.currentErrorRate ?? 0}`);
    }

    return new NextResponse(lines.join("\n") + "\n", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new NextResponse(`# Error generating metrics: ${msg}\n`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
