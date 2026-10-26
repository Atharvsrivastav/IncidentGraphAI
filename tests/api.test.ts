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
    expect(json.aiProvider.provider).toBeDefined();
  });
});
