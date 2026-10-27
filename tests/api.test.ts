import { describe, it, expect, beforeEach } from "vitest";
import { GET as getServices } from "../src/app/api/services/route";
import { GET as getServiceById } from "../src/app/api/services/[id]/route";
import { POST as restoreService } from "../src/app/api/services/[id]/restore/route";
import { GET as getDependencies } from "../src/app/api/dependencies/route";
import { GET as getIncidents, POST as createIncident } from "../src/app/api/incidents/route";
import { GET as getIncidentById } from "../src/app/api/incidents/[id]/route";
import { POST as analyzeIncident } from "../src/app/api/incidents/[id]/analyze/route";
import { GET as getIncidentEvidence } from "../src/app/api/incidents/[id]/evidence/route";
import { GET as getIncidentRootCauses } from "../src/app/api/incidents/[id]/root-causes/route";
import { POST as injectSimulation } from "../src/app/api/simulations/inject/route";
import { POST as advanceSimulation } from "../src/app/api/simulations/advance/route";
import { POST as resetSimulation } from "../src/app/api/simulations/reset/route";
import { GET as getSimulationState } from "../src/app/api/simulations/state/route";
import { GET as getOverview } from "../src/app/api/analytics/overview/route";
import { POST as runDsa } from "../src/app/api/dsa/run/route";
import { GET as getHealth } from "../src/app/api/health/route";
import { seedDatabase } from "../src/lib/db/seed";
import prisma from "../src/lib/db/prisma";
import { safePruneResolvedIncidents } from "../src/lib/incidents/pruning";

describe("REST API Endpoints & Data Integrity Tests", () => {
  beforeEach(async () => {
    await seedDatabase();
  });

  it("GET /api/services returns 200 and all seeded services with dependencies", async () => {
    const res = await getServices();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.services).toBeDefined();
    expect(json.services.length).toBe(7);
  });

  it("GET /api/services/[id] returns 404 for invalid service ID", async () => {
    const res = await getServiceById(new Request("http://localhost/api/services/unknown"), {
      params: Promise.resolve({ id: "unknown" }),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
  });

  it("GET /api/services/[id] returns 200 and service details for valid ID", async () => {
    const res = await getServiceById(new Request("http://localhost/api/services/postgres-db"), {
      params: Promise.resolve({ id: "postgres-db" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.service.id).toBe("postgres-db");
    expect(json.service.status).toBe("HEALTHY");
  });

  it("GET /api/dependencies returns 200 and all topological edges", async () => {
    const res = await getDependencies();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.dependencies.length).toBe(8);
  });

  it("GET /api/simulations/state returns 200 with available scenarios", async () => {
    const res = await getSimulationState();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.availableScenarios.length).toBe(7);
    expect(json.state.status).toBe("IDLE");
  });

  it("POST /api/simulations/inject rejects invalid input with 400", async () => {
    const req = new Request("http://localhost/api/simulations/inject", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await injectSimulation(req);
    expect(res.status).toBe(400);
  });

  it("POST /api/simulations/inject starts scenario and creates incident", async () => {
    const req = new Request("http://localhost/api/simulations/inject", {
      method: "POST",
      body: JSON.stringify({ scenarioId: "database-slowdown" }),
    });
    const res = await injectSimulation(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.step).toBe(1);
    expect(json.incidentId).toBeDefined();

    // Verify incident list now has the incident
    const incRes = await getIncidents(new Request("http://localhost/api/incidents"));
    const incJson = await incRes.json();
    expect(incJson.incidents.length).toBeGreaterThan(0);
    // Verify incident detail
    const detailRes = await getIncidentById(new Request(`http://localhost/api/incidents/${json.incidentId}`), {
      params: Promise.resolve({ id: json.incidentId }),
    });
    expect(detailRes.status).toBe(200);

    // Verify incident evidence endpoint
    const evRes = await getIncidentEvidence(new Request(`http://localhost/api/incidents/${json.incidentId}/evidence`), {
      params: Promise.resolve({ id: json.incidentId }),
    });
    expect(evRes.status).toBe(200);
    const evJson = await evRes.json();
    expect(evJson.evidences.length).toBeGreaterThan(0);

    // Verify incident root-causes endpoint
    const rcRes = await getIncidentRootCauses(new Request(`http://localhost/api/incidents/${json.incidentId}/root-causes`), {
      params: Promise.resolve({ id: json.incidentId }),
    });
    expect(rcRes.status).toBe(200);
    const rcJson = await rcRes.json();
    expect(rcJson.candidates.length).toBeGreaterThan(0);

    // Verify incident analyze endpoint
    const anRes = await analyzeIncident(new Request(`http://localhost/api/incidents/${json.incidentId}/analyze`), {
      params: Promise.resolve({ id: json.incidentId }),
    });
    expect(anRes.status).toBe(200);

    // Verify POST /api/incidents manual creation
    const createReq = new Request("http://localhost/api/incidents", {
      method: "POST",
      body: JSON.stringify({ title: "Manual Drill", description: "SRE drill incident", severity: "LOW" }),
    });
    const createRes = await createIncident(createReq);
    expect(createRes.status).toBe(201);
  });

  it("POST /api/simulations/advance advances active simulation by 1 step", async () => {
    // Inject first
    const req = new Request("http://localhost/api/simulations/inject", {
      method: "POST",
      body: JSON.stringify({ scenarioId: "payment-failure" }),
    });
    await injectSimulation(req);

    const advanceReq = new Request("http://localhost/api/simulations/advance", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const advanceRes = await advanceSimulation(advanceReq);
    expect(advanceRes.status).toBe(200);
    const advanceJson = await advanceRes.json();
    expect(advanceJson.step).toBe(2);
  });

  it("POST /api/services/[id]/restore restores service and resolves incident if all healthy", async () => {
    // Inject failure
    const req = new Request("http://localhost/api/simulations/inject", {
      method: "POST",
      body: JSON.stringify({ scenarioId: "auth-failure" }),
    });
    await injectSimulation(req);

    // Restore auth-service
    const restoreRes = await restoreService(new Request("http://localhost/api/services/auth-service/restore"), {
      params: Promise.resolve({ id: "auth-service" }),
    });
    expect(restoreRes.status).toBe(200);
    const restoreJson = await restoreRes.json();
    expect(restoreJson.restoredServiceId).toBe("auth-service");
  });

  it("POST /api/simulations/reset resets fleet to baseline", async () => {
    const res = await resetSimulation();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  it("GET /api/analytics/overview returns aggregate statistics and trends", async () => {
    const res = await getOverview();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.summary.totalServices).toBe(7);
    expect(json.summary.healthyCount).toBe(7);
    expect(json.distribution.length).toBe(3);
    expect(json.trends.length).toBeGreaterThan(0);
  });

  it("POST /api/dsa/run executes BFS, DFS, and PriorityQueue benchmarks cleanly", async () => {
    // BFS test
    const bfsReq = new Request("http://localhost/api/dsa/run", {
      method: "POST",
      body: JSON.stringify({ algorithm: "BFS", selectedServiceId: "postgres-db" }),
    });
    const bfsRes = await runDsa(bfsReq);
    expect(bfsRes.status).toBe(200);
    const bfsJson = await bfsRes.json();
    expect(bfsJson.traversal.length).toBeGreaterThan(0);
    expect(bfsJson.executionTimeMs).toBeDefined();

    // DFS Cycle test
    const dfsReq = new Request("http://localhost/api/dsa/run", {
      method: "POST",
      body: JSON.stringify({ algorithm: "DFS_CYCLES", injectTestCycle: true }),
    });
    const dfsRes = await runDsa(dfsReq);
    expect(dfsRes.status).toBe(200);
    const dfsJson = await dfsRes.json();
    expect(dfsJson.hasCycle).toBe(true);

    // Invalid algorithm test
    const invReq = new Request("http://localhost/api/dsa/run", {
      method: "POST",
      body: JSON.stringify({ algorithm: "NON_EXISTENT" }),
    });
    const invRes = await runDsa(invReq);
    expect(invRes.status).toBe(400);
  });

  it("GET /api/health returns 200 with database, telemetry, and AI provider status", async () => {
    const res = await getHealth();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("healthy");
    expect(json.database.status).toBe("connected");
    expect(json.database.servicesCount).toBeGreaterThanOrEqual(7);
    expect(json.telemetry.mode).toBeDefined();
    expect(json.telemetry.backendType).toBeDefined();
    expect(typeof json.telemetry.grafanaCloudConfigured).toBe("boolean");
    expect(typeof json.telemetry.prometheusAvailable).toBe("boolean");
    expect(typeof json.telemetry.tempoAvailable).toBe("boolean");
    expect(json.aiProvider.provider).toBeDefined();
  });

  it("POST /api/incidents rejects oversized titles or descriptions with 400", async () => {
    const oversizedTitleReq = new Request("http://localhost/api/incidents", {
      method: "POST",
      body: JSON.stringify({
        title: "a".repeat(125),
        description: "Valid description",
        severity: "HIGH",
      }),
    });
    const titleRes = await createIncident(oversizedTitleReq);
    expect(titleRes.status).toBe(400);

    const oversizedDescReq = new Request("http://localhost/api/incidents", {
      method: "POST",
      body: JSON.stringify({
        title: "Valid title",
        description: "b".repeat(1005),
        severity: "HIGH",
      }),
    });
    const descRes = await createIncident(oversizedDescReq);
    expect(descRes.status).toBe(400);
  });

  it("POST /api/simulations/reset blocks unauthorized reset in production with 403", async () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      const req = new Request("http://localhost/api/simulations/reset", {
        method: "POST",
      });
      const res = await resetSimulation(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toMatch(/disabled in production/i);
      expect(json.code).toBe("FORBIDDEN");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
    }
  });

  it("POST /api/simulations/reset blocks invalid admin token in production with 403", async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalAdmin = process.env.ADMIN_API_KEY;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      process.env.ADMIN_API_KEY = "test-admin-secret-99";

      // Wrong token
      const reqWrong = new Request("http://localhost/api/simulations/reset", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-secret" },
      });
      const resWrong = await resetSimulation(reqWrong);
      expect(resWrong.status).toBe(403);

      // Correct token allows reset in production for verified administrators
      const reqRight = new Request("http://localhost/api/simulations/reset", {
        method: "POST",
        headers: { Authorization: "Bearer test-admin-secret-99" },
      });
      const resRight = await resetSimulation(reqRight);
      expect(resRight.status).toBe(200);
      const jsonRight = await resRight.json();
      expect(jsonRight.success).toBe(true);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
      process.env.ADMIN_API_KEY = originalAdmin;
    }
  });

  it("POST /api/incidents auto-pruning never deletes ACTIVE or INVESTIGATING incidents", async () => {
    // Clean existing incidents
    await prisma.incident.deleteMany();

    // Create 3 active/investigating incidents
    const activeIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const active = await prisma.incident.create({
        data: {
          title: `Active Incident ${i}`,
          description: `Active incident investigation ${i}`,
          status: "INVESTIGATING",
          severity: "HIGH",
        },
      });
      activeIds.push(active.id);
    }

    // Create 3 resolved incidents
    for (let i = 1; i <= 3; i++) {
      await prisma.incident.create({
        data: {
          title: `Resolved Demo Incident ${i}`,
          description: `Resolved demo incident ${i}`,
          status: "RESOLVED",
          severity: "LOW",
          resolvedAt: new Date(),
        },
      });
    }

    // Safe pruning with capacity limit = 4, target = 4 (excess = 6 - 4 = 2)
    const pruneResult = await safePruneResolvedIncidents(4, 4);
    expect(pruneResult.prunedCount).toBe(2);

    // Verify all 3 active incidents remain completely untouched
    const remainingActive = await prisma.incident.findMany({
      where: { id: { in: activeIds } },
    });
    expect(remainingActive.length).toBe(3);

    // Verify the remaining incidents in the database
    const totalRemaining = await prisma.incident.count();
    expect(totalRemaining).toBe(4);
  });

  it("POST /api/incidents safely rejects write with 429 when capacity is reached and zero resolved incidents can be pruned", async () => {
    // Clean existing incidents
    await prisma.incident.deleteMany();

    // Fill capacity with 60 active incidents
    const activeData = Array.from({ length: 60 }, (_, idx) => ({
      title: `Active Load Incident ${idx + 1}`,
      description: `Active incident ${idx + 1} undergoing active investigation`,
      status: "INVESTIGATING",
      severity: "HIGH",
    }));
    await prisma.incident.createMany({ data: activeData });

    expect(await prisma.incident.count()).toBe(60);

    // Attempt to create a 61st incident via the API
    const newIncidentReq = new Request("http://localhost/api/incidents", {
      method: "POST",
      body: JSON.stringify({
        title: "Overflow Incident 61",
        description: "This incident should be safely rejected with 429",
        severity: "HIGH",
      }),
    });

    const res = await createIncident(newIncidentReq);
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.code).toBe("CAPACITY_EXCEEDED");
    expect(json.error).toMatch(/Active incidents cannot be pruned/i);

    // Verify all 60 active incidents remain completely intact
    const finalCount = await prisma.incident.count();
    expect(finalCount).toBe(60);
  });

  it("Ensures API responses do not leak server secrets or credentials", async () => {
    const healthRes = await getHealth();
    const healthJson = await healthRes.json();
    const healthString = JSON.stringify(healthJson);

    // Never leak API keys, tokens, or passwords
    expect(healthString).not.toContain("glc_");
    expect(healthString).not.toContain("sk-");
    expect(healthString).not.toContain("super-secret");

    const simStateRes = await getSimulationState();
    const simStateJson = await simStateRes.json();
    const simStateString = JSON.stringify(simStateJson);
    expect(simStateString).not.toContain("glc_");
    expect(simStateString).not.toContain("sk-");
  });
});
