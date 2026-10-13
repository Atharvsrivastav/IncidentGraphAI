import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";

export async function GET() {
  try {
    const dependencies = await prisma.serviceDependency.findMany({
      include: {
        sourceService: { select: { id: true, name: true, status: true, tier: true } },
        targetService: { select: { id: true, name: true, status: true, tier: true } },
      },
    });

    return NextResponse.json({ dependencies });
  } catch (error) {
    console.error("GET /api/dependencies error:", error);
    return NextResponse.json({ error: "Failed to retrieve dependencies." }, { status: 500 });
  }
}
