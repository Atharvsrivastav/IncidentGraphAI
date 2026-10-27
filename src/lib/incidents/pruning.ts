import prisma from "@/lib/db/prisma";

export interface PruneResult {
  readonly prunedCount: number;
  readonly totalRemaining: number;
  readonly capacityReached: boolean;
}

export const INCIDENT_CAPACITY_LIMIT = 60;
export const INCIDENT_TARGET_AFTER_PRUNE = 50;

/**
 * Safely prunes oldest RESOLVED incidents when incident count reaches capacity.
 * Under NO circumstances are ACTIVE, INVESTIGATING, IDENTIFIED, or MITIGATED
 * incidents pruned or deleted.
 *
 * If capacity is reached and no resolved incidents are eligible to prune,
 * capacityReached will be true and the caller must reject the new write safely.
 */
export async function safePruneResolvedIncidents(
  maxCapacity: number = INCIDENT_CAPACITY_LIMIT,
  targetAfterPrune: number = INCIDENT_TARGET_AFTER_PRUNE
): Promise<PruneResult> {
  const totalCount = await prisma.incident.count();
  if (totalCount < maxCapacity) {
    return {
      prunedCount: 0,
      totalRemaining: totalCount,
      capacityReached: false,
    };
  }

  const excess = Math.max(1, totalCount - targetAfterPrune);
  const eligibleToPrune = await prisma.incident.findMany({
    where: { status: "RESOLVED" },
    select: { id: true },
    orderBy: { startedAt: "asc" },
    take: excess,
  });

  if (eligibleToPrune.length > 0) {
    const idsToDelete = eligibleToPrune.map((incident) => incident.id);

    await prisma.$transaction(async (tx) => {
      await tx.aiInvestigation.deleteMany({
        where: { incidentId: { in: idsToDelete } },
      });
      await tx.incidentEvidence.deleteMany({
        where: { incidentId: { in: idsToDelete } },
      });
      await tx.rootCauseCandidate.deleteMany({
        where: { incidentId: { in: idsToDelete } },
      });
      await tx.incident.deleteMany({
        where: { id: { in: idsToDelete } },
      });
    });
  }

  const totalRemaining = totalCount - eligibleToPrune.length;
  return {
    prunedCount: eligibleToPrune.length,
    totalRemaining,
    capacityReached: totalRemaining >= maxCapacity,
  };
}
