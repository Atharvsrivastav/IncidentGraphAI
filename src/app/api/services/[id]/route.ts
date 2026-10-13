import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";

export async function GET(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await props.params;

    const service = await prisma.service.findUnique({
      where: { id },
      include: {
        outgoingDependencies: {
          include: { targetService: true },
        },
        incomingDependencies: {
          include: { sourceService: true },
        },
        telemetrySamples: {
          orderBy: { simulationStep: "desc" },
          take: 20,
        },
      },
    });

    if (!service) {
      return NextResponse.json({ error: `Service '${id}' not found.` }, { status: 404 });
    }

    return NextResponse.json({ service });
  } catch (error) {
    console.error("GET /api/services/[id] error:", error);
    return NextResponse.json({ error: "Failed to retrieve service." }, { status: 500 });
  }
}
