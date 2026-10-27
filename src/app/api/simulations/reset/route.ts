import { NextResponse } from "next/server";
import { simulator } from "@/lib/simulation/simulator";

export async function POST(request?: Request) {
  try {
    const isProduction =
      process.env.NODE_ENV === "production" ||
      process.env.VERCEL_ENV === "production";

    if (isProduction) {
      const adminSecret = process.env.ADMIN_API_KEY;
      const authHeader = request ? request.headers.get("authorization") : null;
      const providedToken = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : null;

      // In production, reject unless a verified admin secret is configured and matches
      if (!adminSecret || !providedToken || providedToken !== adminSecret) {
        return NextResponse.json(
          {
            error: "Destructive reset operations are disabled in production environments.",
            code: "FORBIDDEN",
          },
          { status: 403 }
        );
      }
    }

    const result = await simulator.resetSimulation({ allowInProduction: true });
    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("POST /api/simulations/reset error:", error);
    const message = error instanceof Error ? error.message : "Failed to reset simulation.";
    const status = message.includes("prohibited in production") ? 403 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
