import { NextResponse } from "next/server";
import { simulator } from "@/lib/simulation/simulator";

export async function POST(request: Request) {
  try {
    let incidentId: string | undefined = undefined;
    try {
      const body = await request.json();
      incidentId = body.incidentId;
    } catch {
      // Body is optional
    }

    const result = await simulator.advanceSimulation(incidentId);
    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("POST /api/simulations/advance error:", error);
    const message = error instanceof Error ? error.message : "Failed to advance simulation.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
