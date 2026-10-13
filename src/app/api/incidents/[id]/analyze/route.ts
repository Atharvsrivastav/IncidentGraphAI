import { NextResponse } from "next/server";
import { simulator } from "@/lib/simulation/simulator";

export async function POST(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await props.params;
    const analysis = await simulator.recalculateRootCauses(id);
    return NextResponse.json({ success: true, analysis });
  } catch (error: unknown) {
    console.error("POST /api/incidents/[id]/analyze error:", error);
    const message = error instanceof Error ? error.message : "Failed to analyze incident.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
