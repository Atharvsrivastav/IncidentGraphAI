import { NextResponse } from "next/server";
import { telemetryManager } from "@/lib/telemetry/telemetryManager";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const service = url.searchParams.get("service") || undefined;
    const limit = Number(url.searchParams.get("limit")) || 20;

    const traces = await telemetryManager.getRecentTraces(service, limit);
    return NextResponse.json({ traces, total: traces.length });
  } catch (error: unknown) {
    if ((error as { digest?: string })?.digest?.startsWith("NEXT_")) {
      throw error;
    }
    console.error("GET /api/telemetry/traces error:", error);
    return NextResponse.json({ error: "Failed to fetch traces" }, { status: 500 });
  }
}
