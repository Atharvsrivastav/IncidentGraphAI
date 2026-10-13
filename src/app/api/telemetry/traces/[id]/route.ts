import { NextResponse } from "next/server";
import { telemetryManager } from "@/lib/telemetry/telemetryManager";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const trace = await telemetryManager.getTraceDetail(id);

    if (!trace) {
      return NextResponse.json({ error: "Trace not found or unavailable in Jaeger" }, { status: 404 });
    }

    return NextResponse.json({ trace });
  } catch (error: unknown) {
    if ((error as { digest?: string })?.digest?.startsWith("NEXT_")) {
      throw error;
    }
    console.error("GET /api/telemetry/traces/[id] error:", error);
    return NextResponse.json({ error: "Failed to fetch trace details" }, { status: 500 });
  }
}
