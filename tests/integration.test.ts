import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../src/lib/db/prisma";
import { seedDatabase } from "../src/lib/db/seed";
import { simulator } from "../src/lib/simulation/simulator";

describe("Simulation & Data Integration Tests", () => {
  beforeEach(async () => {
    // Reset DB before tests
    await seedDatabase();
  });

  // Test 1: Seeded services can be retrieved
  it("1. Seeded services can be retrieved with dependencies", async () => {
    const services = await prisma.service.findMany({
      include: { outgoingDependencies: true },
    });
    expect(services.length).toBe(7);

    const gateway = services.find((s) => s.id === "api-gateway");
    expect(gateway).toBeDefined();
    expect(gateway?.status).toBe("HEALTHY");
    expect(gateway?.outgoingDependencies.length).toBe(2); // auth-service and order-service
  });

  // Test 2 & 3: Simulated database slowdown produces correlated telemetry and incident evidence
  it("2 & 3. Simulated database slowdown produces correlated telemetry changes and persisted evidence", async () => {
    const step1Result = await simulator.injectFailure({
      scenarioId: "database-slowdown",
    });

    expect(step1Result.step).toBe(1);
    expect(step1Result.incidentId).toBeDefined();

    // Verify postgres-db was updated
    const dbSvc = await prisma.service.findUnique({ where: { id: "postgres-db" } });
    expect(dbSvc?.status).toBe("DEGRADED");
    expect(dbSvc!.currentLatency).toBeGreaterThan(400);

    // Verify telemetry samples persisted
    const telemetry = await prisma.telemetrySample.findMany({
      where: { serviceId: "postgres-db" },
    });
    expect(telemetry.length).toBeGreaterThan(1);

    // Verify incident evidence persisted
    const evidences = await prisma.incidentEvidence.findMany({
      where: { incidentId: step1Result.incidentId },
    });
    expect(evidences.length).toBeGreaterThan(0);
    expect(evidences.some((e) => e.serviceId === "postgres-db")).toBe(true);
  });

  // Test 4: Likely root cause is ranked using observed signals
  it("4. Likely root cause is ranked using observed signals", async () => {
    const injectRes = await simulator.injectFailure({
      scenarioId: "database-slowdown",
    });
    // Advance to step 2 to simulate cascading impact
    const advanceRes = await simulator.advanceSimulation(injectRes.incidentId);

    expect(advanceRes.analysis.isConclusive).toBe(true);
    expect(advanceRes.analysis.topRootCause?.serviceId).toBe("postgres-db");
    expect(advanceRes.analysis.topRootCause?.confidence).toMatch(/HIGH|MEDIUM/);

    // Check persisted candidate records in database
    const candidates = await prisma.rootCauseCandidate.findMany({
      where: { incidentId: injectRes.incidentId },
      orderBy: { rank: "asc" },
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].candidateServiceId).toBe("postgres-db");
  });

  // Test 5: An unaffected, unrelated service is not automatically marked down
  it("5. An unaffected, unrelated service is not automatically marked down", async () => {
    // In database-slowdown, auth-service does not depend on database or order-service
    await simulator.injectFailure({ scenarioId: "database-slowdown" });

    const authSvc = await prisma.service.findUnique({ where: { id: "auth-service" } });
    expect(authSvc?.status).toBe("HEALTHY");
    expect(authSvc?.currentLatency).toBe(authSvc?.baselineLatency);
  });

  // Test 6: Restoration returns the simulation to its expected healthy state
  it("6. Restoration returns the simulation to its expected healthy state", async () => {
    await simulator.injectFailure({ scenarioId: "auth-failure" });

    // Verify auth is down
    let authSvc = await prisma.service.findUnique({ where: { id: "auth-service" } });
    expect(authSvc?.status).toBe("DOWN");

    // Restore auth-service
    await simulator.restoreService("auth-service");
    authSvc = await prisma.service.findUnique({ where: { id: "auth-service" } });
    expect(authSvc?.status).toBe("HEALTHY");
    expect(authSvc?.currentLatency).toBe(authSvc?.baselineLatency);

    // Reset whole system
    const resetRes = await simulator.resetSimulation();
    expect(resetRes.success).toBe(true);

    const allServices = await prisma.service.findMany();
    const allHealthy = allServices.every((s) => s.status === "HEALTHY");
    expect(allHealthy).toBe(true);
  });

  // Test 7: Invalid simulation requests return proper errors
  it("7. Invalid simulation requests return proper errors", async () => {
    await expect(
      simulator.injectFailure({ scenarioId: "non-existent-scenario" })
    ).rejects.toThrow("Scenario 'non-existent-scenario' not found.");
  });
});
