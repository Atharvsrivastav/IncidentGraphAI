import { NextResponse } from "next/server";
import { z } from "zod";
import { telemetryManager } from "@/lib/telemetry/telemetryManager";

const ModeSchema = z.object({
  mode: z.enum(["SIMULATION", "REAL"]),
});

export async function GET() {
  const mode = telemetryManager.getMode();
  const health = await telemetryManager.getBackendHealth();
  return NextResponse.json({ mode, health });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const validated = ModeSchema.parse(body);

    telemetryManager.setMode(validated.mode);
    const health = await telemetryManager.getBackendHealth();

    return NextResponse.json({
      success: true,
      mode: validated.mode,
      health,
      message: `Telemetry mode switched to ${validated.mode}`,
    });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid mode. Allowed: SIMULATION, REAL" }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to update mode" }, { status: 500 });
  }
}
