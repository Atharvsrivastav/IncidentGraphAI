import { NextResponse } from "next/server";
import { z } from "zod";
import { simulator } from "@/lib/simulation/simulator";

const InjectSchema = z.object({
  scenarioId: z.string().min(1),
  targetServiceId: z.string().optional(),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).optional(),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const validated = InjectSchema.parse(body);

    const result = await simulator.injectFailure({
      scenarioId: validated.scenarioId,
      targetServiceId: validated.targetServiceId,
      severity: validated.severity,
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid injection parameters", details: error.issues }, { status: 400 });
    }
    console.error("POST /api/simulations/inject error:", error);
    const message = error instanceof Error ? error.message : "Failed to inject failure.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
