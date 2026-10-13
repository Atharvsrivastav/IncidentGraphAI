import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";

export async function GET() {
  try {
    const services = await prisma.service.findMany({
      include: {
        outgoingDependencies: {
          include: { targetService: { select: { id: true, name: true, status: true } } },
        },
        incomingDependencies: {
          include: { sourceService: { select: { id: true, name: true, status: true } } },
        },
      },
      orderBy: { tier: "asc" },
    });

    return NextResponse.json({ services });
  } catch (error) {
    console.error("GET /api/services error:", error);
    return NextResponse.json({ error: "Failed to retrieve services." }, { status: 500 });
  }
}
