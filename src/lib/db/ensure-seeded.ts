import { prisma } from "./prisma";
import { INITIAL_SERVICES, INITIAL_DEPENDENCIES } from "./seedData";

/**
 * Ensures the database has base services and dependencies initialized.
 * Unlike destructive reset, this preserves any existing incidents and telemetry.
 */
export async function ensureDatabaseSeeded(): Promise<{
  alreadySeeded: boolean;
  servicesCount: number;
  dependenciesCount: number;
}> {
  try {
    const existingCount = await prisma.service.count();
    if (existingCount > 0) {
      return {
        alreadySeeded: true,
        servicesCount: existingCount,
        dependenciesCount: await prisma.serviceDependency.count(),
      };
    }

    // Seed base services and dependencies in a transaction
    await prisma.$transaction(async (tx) => {
      for (const svc of INITIAL_SERVICES) {
        await tx.service.upsert({
          where: { id: svc.id },
          update: {},
          create: {
            id: svc.id,
            name: svc.name,
            serviceType: svc.serviceType,
            description: svc.description,
            status: svc.status,
            baselineLatency: svc.baselineLatency,
            currentLatency: svc.currentLatency,
            baselineErrorRate: svc.baselineErrorRate,
            currentErrorRate: svc.currentErrorRate,
            requestRate: svc.requestRate,
            tier: svc.tier,
          },
        });

        // Initial baseline telemetry sample
        await tx.telemetrySample.create({
          data: {
            serviceId: svc.id,
            simulationStep: 0,
            timestamp: new Date(),
            latency: svc.baselineLatency,
            errorRate: svc.baselineErrorRate,
            requestCount: svc.requestRate * 60,
            healthStatus: "HEALTHY",
            cpuUsage: 18.5,
            memoryUsage: 32.0,
          },
        });
      }

      for (const dep of INITIAL_DEPENDENCIES) {
        await tx.serviceDependency.upsert({
          where: {
            sourceServiceId_targetServiceId: {
              sourceServiceId: dep.sourceServiceId,
              targetServiceId: dep.targetServiceId,
            },
          },
          update: {},
          create: {
            sourceServiceId: dep.sourceServiceId,
            targetServiceId: dep.targetServiceId,
            dependencyType: dep.dependencyType,
            timeoutThreshold: dep.timeoutThreshold,
            criticality: dep.criticality,
          },
        });
      }

      await tx.simulationState.upsert({
        where: { id: "active_simulation" },
        update: {},
        create: {
          id: "active_simulation",
          currentStep: 0,
          status: "IDLE",
        },
      });
    });

    return {
      alreadySeeded: false,
      servicesCount: INITIAL_SERVICES.length,
      dependenciesCount: INITIAL_DEPENDENCIES.length,
    };
  } catch (error) {
    console.error("ensureDatabaseSeeded error:", error);
    throw error;
  }
}
