import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";

export async function GET(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await props.params;

    const candidates = await prisma.rootCauseCandidate.findMany({
      where: { incidentId: id },
      include: {
        service: {
          select: {
            id: true,
            name: true,
            status: true,
            serviceType: true,
            currentLatency: true,
            currentErrorRate: true,
          },
        },
      },
      orderBy: { rank: "asc" },
    });

    const parsedCandidates = candidates.map((cand) => ({
      ...cand,
      supportingEvidence: JSON.parse(cand.supportingEvidence || "[]"),
      contradictoryEvidence: JSON.parse(cand.contradictoryEvidence || "[]"),
    }));

    return NextResponse.json({ candidates: parsedCandidates });
  } catch (error) {
    console.error("GET /api/incidents/[id]/root-causes error:", error);
    return NextResponse.json({ error: "Failed to retrieve root cause candidates." }, { status: 500 });
  }
}
