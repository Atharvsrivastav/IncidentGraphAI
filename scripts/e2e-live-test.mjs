// Autonomous E2E Live Server Verification Script
// Tests all pages and end-to-end workflows against http://localhost:3000

const BASE_URL = "http://localhost:3000";

async function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
}

async function run() {
  console.log("=== IncidentGraph AI: Starting Live E2E Verification against http://localhost:3000 ===");

  // 1. Test All Pages
  const pages = [
    { path: "/", titleCheck: "IncidentGraph" },
    { path: "/service-map", titleCheck: "Service Dependency Map" },
    { path: "/incidents", titleCheck: "Incidents" },
    { path: "/simulator", titleCheck: "Failure Simulator" },
    { path: "/dsa-lab", titleCheck: "Algorithms Lab" },
    { path: "/settings", titleCheck: "Settings" },
  ];

  for (const page of pages) {
    const res = await fetch(`${BASE_URL}${page.path}`);
    assert(res.status === 200, `Page '${page.path}' responded with HTTP 200`);
    const html = await res.text();
    assert(html.includes(page.titleCheck) || html.includes("IncidentGraph"), `Page '${page.path}' rendered content`);
  }

  // 2. Workflow A: Healthy Baseline Verification
  console.log("\n=== Workflow A: Testing Healthy Baseline State ===");
  const resetRes = await fetch(`${BASE_URL}/api/simulations/reset`, { method: "POST" });
  assert(resetRes.status === 200, "Reset baseline responded with 200");

  const servicesRes = await fetch(`${BASE_URL}/api/services`);
  const servicesData = await servicesRes.json();
  assert(servicesData.services.length === 7, "All 7 microservices present in topology");
  const allHealthy = servicesData.services.every((s) => s.status === "HEALTHY");
  assert(allHealthy, "All 7 microservices are initially in HEALTHY status");

  // 3. Workflow B: PostgreSQL Database Slowdown & Cascading Propagation
  console.log("\n=== Workflow B: PostgreSQL Database Slowdown & Cascading Propagation ===");
  const injectDbRes = await fetch(`${BASE_URL}/api/simulations/inject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId: "database-slowdown" }),
  });
  assert(injectDbRes.status === 200, "Injected 'database-slowdown' scenario successfully");
  const injectDbData = await injectDbRes.json();
  const incidentId = injectDbData.incidentId;
  assert(injectDbData.step === 1, "Simulation started at Step 1");
  assert(Boolean(incidentId), `Incident created with ID: ${incidentId}`);

  // Advance to Step 2
  const advanceRes = await fetch(`${BASE_URL}/api/simulations/advance`, { method: "POST" });
  assert(advanceRes.status === 200, "Advanced simulation to Step 2");
  const advanceData = await advanceRes.json();
  assert(advanceData.step === 2, "Simulation is now at Step 2");

  // Inspect Incident Evidence & Root-Cause Candidates
  const rcRes = await fetch(`${BASE_URL}/api/incidents/${incidentId}/root-causes`);
  assert(rcRes.status === 200, "Fetched incident root-causes with 200");
  const rcData = await rcRes.json();
  assert(rcData.candidates.length > 0, `Ranked ${rcData.candidates.length} candidate services`);
  assert(rcData.candidates[0].candidateServiceId === "postgres-db", "PostgreSQL DB ranked as #1 Suspected Root Cause");
  assert(rcData.candidates[0].score >= 70, `Root cause score is strong (${rcData.candidates[0].score}/100)`);
  assert(rcData.candidates[0].supportingEvidence.length > 0, "Supporting evidence signals present");

  // 4. Workflow C: Service Remediation & Baseline Recovery
  console.log("\n=== Workflow C: Service Remediation & Baseline Recovery ===");
  const restoreRes = await fetch(`${BASE_URL}/api/services/postgres-db/restore`, { method: "POST" });
  assert(restoreRes.status === 200, "Restored postgres-db service successfully");

  // Reset fleet
  const cleanReset = await fetch(`${BASE_URL}/api/simulations/reset`, { method: "POST" });
  assert(cleanReset.status === 200, "Clean reset executed successfully");

  // 5. Workflow D: Non-Database Failure (Authentication Service Outage)
  console.log("\n=== Workflow D: Non-Database Failure (Authentication Service Outage) ===");
  const injectAuthRes = await fetch(`${BASE_URL}/api/simulations/inject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId: "auth-failure" }),
  });
  assert(injectAuthRes.status === 200, "Injected 'auth-failure' scenario");
  const injectAuthData = await injectAuthRes.json();

  const authRcRes = await fetch(`${BASE_URL}/api/incidents/${injectAuthData.incidentId}/root-causes`);
  const authRcData = await authRcRes.json();
  assert(authRcData.candidates[0].candidateServiceId === "auth-service", "Auth Service correctly ranked as #1 Root Cause");

  // Verify non-dependent services like database remain healthy!
  const servicesCheck = await fetch(`${BASE_URL}/api/services`);
  const servicesCheckData = await servicesCheck.json();
  const dbService = servicesCheckData.services.find((s) => s.id === "postgres-db");
  assert(dbService.status === "HEALTHY", "PostgreSQL DB remained unaffected during Auth Service outage");

  // 6. Workflow E: DSA Lab Live Algorithm Execution
  console.log("\n=== Workflow E: DSA Lab Live Algorithm Execution ===");
  // BFS Traversal
  const bfsRes = await fetch(`${BASE_URL}/api/dsa/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ algorithm: "BFS", selectedServiceId: "postgres-db" }),
  });
  assert(bfsRes.status === 200, "DSA BFS run returned 200");
  const bfsData = await bfsRes.json();
  assert(bfsData.traversal.length > 0, `BFS discovered ${bfsData.traversal.length} downstream caller services`);

  // DFS Cycle Detection with Injected Cycle
  const dfsRes = await fetch(`${BASE_URL}/api/dsa/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ algorithm: "DFS_CYCLES", injectTestCycle: true }),
  });
  assert(dfsRes.status === 200, "DSA DFS run returned 200");
  const dfsData = await dfsRes.json();
  assert(dfsData.hasCycle === true, "3-Color DFS correctly detected injected directed cycle");

  // Final Reset to Leave System Clean
  await fetch(`${BASE_URL}/api/simulations/reset`, { method: "POST" });
  console.log("\n=== ALL LIVE E2E WORKFLOW TESTS PASSED SUCCESSFULLY ===");
}

run().catch((err) => {
  console.error("Live test encountered error:", err);
  process.exit(1);
});
