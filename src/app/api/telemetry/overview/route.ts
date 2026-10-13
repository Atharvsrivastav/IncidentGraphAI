import { NextResponse } from "next/server";
import { telemetryManager } from "@/lib/telemetry/telemetryManager";

export async function GET() {
  try {
    const data = await telemetryManager.getObservedServices();
    return NextResponse.json(data);
  } catch (error: unknown) {
    console.error("GET /api/telemetry/overview error:", error);
    return NextResponse.json(
      { error: "Failed to retrieve telemetry overview" },
      { status: 500 }
    );
  }
}
