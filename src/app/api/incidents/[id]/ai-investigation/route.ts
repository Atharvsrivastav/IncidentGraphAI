import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";
import { investigateIncident } from "@/lib/ai/investigator";
import { getAIProviderStatus } from "@/lib/ai/providers/factory";
import { MockAIProvider } from "@/lib/ai/providers/mock";
import { AIProviderError } from "@/lib/ai/providers/types";

export async function GET(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await props.params;

    const providerStatus = getAIProviderStatus();

    const incident = await prisma.incident.findUnique({
      where: { id },
      include: {
        aiInvestigation: true,
        evidences: { select: { id: true } },
        rootCauseCandidates: {
          select: { candidateServiceId: true, rank: true },
          orderBy: { rank: "asc" },
        },
      },
    });

    if (!incident) {
      return NextResponse.json({ error: `Incident '${id}' not found.` }, { status: 404 });
    }

    if (!incident.aiInvestigation) {
      return NextResponse.json({
        investigation: null,
        providerStatus,
      });
    }

    // Call investigateIncident without forceRefresh to get full parsed report
    const investigation = await investigateIncident(id, { forceRefresh: false });

    return NextResponse.json({
      investigation,
      providerStatus,
    });
  } catch (error: unknown) {
    console.error("GET /api/incidents/[id]/ai-investigation error:", error);
    const message = error instanceof Error ? error.message : "Failed to retrieve AI investigation.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await props.params;

    let body: { forceRefresh?: boolean; provider?: string } = {};
    try {
      body = await request.json();
    } catch {
      // Body is optional
    }

    const providerOverride = body.provider === "mock" ? new MockAIProvider() : undefined;

    const investigation = await investigateIncident(id, {
      forceRefresh: body.forceRefresh ?? true,
      provider: providerOverride,
    });

    return NextResponse.json({
      success: true,
      investigation,
      providerStatus: getAIProviderStatus(providerOverride),
    });
  } catch (error: unknown) {
    console.error("POST /api/incidents/[id]/ai-investigation error:", error);

    if (error instanceof AIProviderError) {
      const headers: Record<string, string> = {};
      if (error.retryAfterSeconds) {
        headers["Retry-After"] = String(error.retryAfterSeconds);
      }

      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          providerStatus: getAIProviderStatus(),
          retryAfter: error.retryAfterSeconds,
        },
        { status: error.status, headers }
      );
    }

    const message = error instanceof Error ? error.message : "Failed to synthesize AI incident investigation.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
