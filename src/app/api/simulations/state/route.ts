import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";
import { SIMULATION_SCENARIOS } from "@/lib/simulation/scenarios";

export async function GET() {
  try {
    const state = await prisma.simulationState.findUnique({
      where: { id: "active_simulation" },
    });

    const activeIncident = await prisma.incident.findFirst({
      where: { status: { in: ["INVESTIGATING", "IDENTIFIED"] } },
      orderBy: { startedAt: "desc" },
    });

    return NextResponse.json({
      state,
      activeIncident,
      availableScenarios: Object.values(SIMULATION_SCENARIOS).map((s) => ({
        id: s.id,
        name: s.name,
        targetServiceId: s.targetServiceId,
        defaultSeverity: s.defaultSeverity,
        failureType: s.failureType,
        description: s.description,
        totalSteps: s.steps.length,
      })),
    });
  } catch (error) {
    console.error("GET /api/simulations/state error:", error);
    return NextResponse.json({ error: "Failed to retrieve simulation state." }, { status: 500 });
  }
}
