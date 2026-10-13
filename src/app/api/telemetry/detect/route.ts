import { NextResponse } from "next/server";
import { realIncidentDetector } from "@/lib/detection/ruleDetector";
import { realRootCauseEngine } from "@/lib/algorithms/realRootCauseEngine";

export async function POST() {
  try {
    const result = await realIncidentDetector.evaluateTelemetry();

    if (result.incidentCreated && result.incidentId) {
      // Automatically run explainable root-cause ranking for the newly created incident
      const analysis = await realRootCauseEngine.analyzeRealIncident(result.incidentId);
      return NextResponse.json({
        ...result,
        analysis,
      });
    }

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("POST /api/telemetry/detect error:", error);
    return NextResponse.json(
      { error: "Failed to execute real incident detector" },
      { status: 500 }
    );
  }
}
