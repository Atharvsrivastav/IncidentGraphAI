import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";

export async function GET(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await props.params;

    const evidences = await prisma.incidentEvidence.findMany({
      where: { incidentId: id },
      include: {
        service: { select: { id: true, name: true, status: true, tier: true } },
      },
      orderBy: { timestamp: "asc" },
    });

    return NextResponse.json({ evidences });
  } catch (error) {
    console.error("GET /api/incidents/[id]/evidence error:", error);
    return NextResponse.json({ error: "Failed to retrieve evidence." }, { status: 500 });
  }
}
