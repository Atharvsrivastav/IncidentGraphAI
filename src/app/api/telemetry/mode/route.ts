import { NextResponse } from "next/server";
import { z } from "zod";
import { telemetryManager } from "@/lib/telemetry/telemetryManager";

const ModeSchema = z.object({
  mode: z.enum(["SIMULATION", "LIVE", "DEGRADED", "REAL"]),
});

export async function GET() {
  const mode = telemetryManager.getMode();
  const health = await telemetryManager.getBackendHealth();
  const lastIngestedAt = telemetryManager.getLastIngestedAt();
  return NextResponse.json({ mode, health, lastIngestedAt });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const validated = ModeSchema.parse(body);

    telemetryManager.setMode(validated.mode);
    const health = await telemetryManager.getBackendHealth();
    const currentMode = telemetryManager.getMode();

    return NextResponse.json({
      success: true,
      mode: currentMode,
      health,
      lastIngestedAt: telemetryManager.getLastIngestedAt(),
      message: `Telemetry mode switched to ${currentMode}`,
    });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid mode. Allowed: SIMULATION, LIVE, DEGRADED, REAL" }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to update mode" }, { status: 500 });
  }
}
