import { prisma } from "./prisma";
import { INITIAL_SERVICES, INITIAL_DEPENDENCIES } from "./seedData";

export async function seedDatabase(): Promise<{
  servicesCount: number;
  dependenciesCount: number;
}> {
  return await prisma.$transaction(async (tx) => {
    // Clear existing tables in strict foreign-key order
    await tx.rootCauseCandidate.deleteMany();
    await tx.incidentEvidence.deleteMany();
    await tx.incident.deleteMany();
    await tx.telemetrySample.deleteMany();
    await tx.serviceDependency.deleteMany();
    await tx.service.deleteMany();
    await tx.simulationState.deleteMany();

    // Seed services
    for (const svc of INITIAL_SERVICES) {
      await tx.service.create({
        data: {
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

      // Create initial baseline telemetry sample
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

    // Seed dependencies
    for (const dep of INITIAL_DEPENDENCIES) {
      await tx.serviceDependency.create({
        data: {
          sourceServiceId: dep.sourceServiceId,
          targetServiceId: dep.targetServiceId,
          dependencyType: dep.dependencyType,
          timeoutThreshold: dep.timeoutThreshold,
          criticality: dep.criticality,
        },
      });
    }

    // Seed initial simulation state
    await tx.simulationState.upsert({
      where: { id: "active_simulation" },
      update: {
        currentStep: 0,
        activeScenario: null,
        injectedServiceId: null,
        failureType: null,
        severity: null,
        status: "IDLE",
      },
      create: {
        id: "active_simulation",
        currentStep: 0,
        activeScenario: null,
        injectedServiceId: null,
        failureType: null,
        severity: null,
        status: "IDLE",
      },
    });

    return {
      servicesCount: INITIAL_SERVICES.length,
      dependenciesCount: INITIAL_DEPENDENCIES.length,
    };
  });
}

if (process.argv[1]?.endsWith("seed.ts") || process.argv[1]?.endsWith("seed.mjs")) {
  seedDatabase()
    .then((result) => {
      console.log(`Database seeded: ${result.servicesCount} services, ${result.dependenciesCount} dependencies.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
