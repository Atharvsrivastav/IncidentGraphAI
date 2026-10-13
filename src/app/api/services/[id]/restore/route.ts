import { NextResponse } from "next/server";
import { simulator } from "@/lib/simulation/simulator";

export async function POST(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await props.params;
    const result = await simulator.restoreService(id);
    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("POST /api/services/[id]/restore error:", error);
    const message = error instanceof Error ? error.message : "Failed to restore service.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
