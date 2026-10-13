import { NextResponse } from "next/server";
import { z } from "zod";

const FaultExperimentSchema = z.object({
  type: z.enum(["db-slowdown", "order-timeout", "payment-failure", "inventory-slowdown", "restore"]),
  latencyMs: z.number().optional(),
  delayMs: z.number().optional(),
  failureRate: z.number().optional(),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const validated = FaultExperimentSchema.parse(body);

    const gatewayUrl = process.env.SAMPLE_GATEWAY_URL || `http://localhost:${process.env.SAMPLE_GATEWAY_PORT || 4000}`;

    const endpoint = validated.type === "restore" ? "/debug/restore" : "/debug/inject-fault";
    const res = await fetch(`${gatewayUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validated),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Sample Gateway returned HTTP ${res.status}. Ensure sample microservices are running.` },
        { status: 502 }
      );
    }

    const data = await res.json();
    return NextResponse.json({
      success: true,
      experiment: validated.type,
      details: data,
    });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid experiment parameters", issues: err.issues }, { status: 400 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to trigger fault experiment: ${msg}. Is sample-gateway running on :4000?` },
      { status: 500 }
    );
  }
}
