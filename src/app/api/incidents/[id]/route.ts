import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";

export async function GET(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await props.params;

    const incident = await prisma.incident.findUnique({
      where: { id },
      include: {
        evidences: {
          include: {
            service: { select: { id: true, name: true, status: true, tier: true } },
          },
          orderBy: { timestamp: "asc" },
        },
        rootCauseCandidates: {
          include: {
            service: { select: { id: true, name: true, status: true, tier: true, serviceType: true } },
          },
          orderBy: { rank: "asc" },
        },
      },
    });

    if (!incident) {
      return NextResponse.json({ error: `Incident '${id}' not found.` }, { status: 404 });
    }

    return NextResponse.json({ incident });
  } catch (error) {
    console.error("GET /api/incidents/[id] error:", error);
    return NextResponse.json({ error: "Failed to retrieve incident details." }, { status: 500 });
  }
}
