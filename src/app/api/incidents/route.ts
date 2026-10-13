import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db/prisma";

const CreateIncidentSchema = z.object({
  title: z.string().min(3),
  description: z.string().min(5),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).default("HIGH"),
});

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const severity = searchParams.get("severity");

    const where: Record<string, string> = {};
    if (status) where.status = status;
    if (severity) where.severity = severity;

    const incidents = await prisma.incident.findMany({
      where,
      include: {
        rootCauseCandidates: {
          orderBy: { rank: "asc" },
          take: 3,
          include: {
            service: { select: { id: true, name: true, status: true } },
          },
        },
        _count: {
          select: {
            evidences: true,
            rootCauseCandidates: true,
          },
        },
      },
      orderBy: { startedAt: "desc" },
    });

    return NextResponse.json({ incidents });
  } catch (error) {
    console.error("GET /api/incidents error:", error);
    return NextResponse.json({ error: "Failed to retrieve incidents." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const validated = CreateIncidentSchema.parse(body);

    const incident = await prisma.incident.create({
      data: {
        title: validated.title,
        description: validated.description,
        severity: validated.severity,
        status: "INVESTIGATING",
        rootCauseStatus: "PENDING",
      },
    });

    return NextResponse.json({ incident }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation error", details: error.issues }, { status: 400 });
    }
    console.error("POST /api/incidents error:", error);
    return NextResponse.json({ error: "Failed to create incident." }, { status: 500 });
  }
}
