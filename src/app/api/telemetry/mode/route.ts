import { NextResponse } from "next/server";
import { z } from "zod";
import { telemetryManager } from "@/lib/telemetry/telemetryManager";

const ModeSchema = z.object({
  mode: z.enum(["SIMULATION", "LIVE", "DEGRADED", "REAL"]),
});

export async function GET() {
  const requestedMode = telemetryManager.getRequestedMode();
  const effectiveMode = telemetryManager.getEffectiveMode();
  const health = await telemetryManager.getBackendHealth();
  const lastIngestedAt = telemetryManager.getLastIngestedAt();
  return NextResponse.json({
    mode: effectiveMode,
    requestedMode,
    effectiveMode,
    health,
    lastIngestedAt,
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const validated = ModeSchema.parse(body);

    telemetryManager.setMode(validated.mode);

    let effectiveMode = telemetryManager.getEffectiveMode();
    let health = await telemetryManager.getBackendHealth();

    // If LIVE or REAL was requested, probe observation to determine truthful initial operational state
    if (validated.mode === "LIVE" || validated.mode === "REAL") {
      const observation = await telemetryManager.getObservedServices(true);
      effectiveMode = observation.effectiveMode ?? observation.mode;
      health = observation.backendHealth;
    }

    const requestedMode = telemetryManager.getRequestedMode();

    return NextResponse.json({
      success: true,
      mode: effectiveMode,
      requestedMode,
      effectiveMode,
      health,
      lastIngestedAt: telemetryManager.getLastIngestedAt(),
      message: `Telemetry mode switched to ${requestedMode} (effective: ${effectiveMode})`,
    });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid mode. Allowed: SIMULATION, LIVE, DEGRADED, REAL" }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to update mode" }, { status: 500 });
  }
}
