import { NextResponse } from "next/server";
import { simulator } from "@/lib/simulation/simulator";

export async function POST() {
  try {
    const result = await simulator.resetSimulation();
    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("POST /api/simulations/reset error:", error);
    const message = error instanceof Error ? error.message : "Failed to reset simulation.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
