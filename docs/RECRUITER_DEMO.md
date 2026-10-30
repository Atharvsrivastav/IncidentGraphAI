# IncidentGraph AI — Recruiter & Hiring Manager 3-Minute Demo Walkthrough

> **Live Production URL**: [https://incident-graph-ai.vercel.app](https://incident-graph-ai.vercel.app)  
> **Source Repository**: [https://github.com/Atharvsrivastav/IncidentGraphAI](https://github.com/Atharvsrivastav/IncidentGraphAI)  
> **Target Audience**: Senior Engineering Recruiters, Staff SRE / Platform Engineering Hiring Managers  
> **Demo Duration**: Approximately 3 minutes (180 seconds)  
> **Recording Artifact**: `docs/recordings/incident_graph_ai_recruiter_demo.mp4` (1080p, 60fps)

---

## Executive Summary for Hiring Teams

**IncidentGraph AI** solves a pervasive distributed systems challenge: **alert storms and cascading failures in microservice architectures**.

When a foundational database or cache degrades, dozens of upstream microservices emit simultaneous alerts. On-call engineers waste 45+ minutes triaging symptoms at Tier 1 (the API Gateway) instead of identifying the true culprit at Tier 3 (the Database).

IncidentGraph AI combines **directed graph algorithms (BFS blast-radius traversal, DFS cycle detection, priority-queue ranking)** with **OpenTelemetry distributed tracing** and an **evidence-grounded AI investigator** to diagnose cascading root causes in under 300 milliseconds.

---

## 3-Minute Click-by-Click Demo Script

### Scene 1 (0:00–0:25) — The Real-World Problem: Alert Storms
* **URL**: `/` (Overview Dashboard)
* **Goal**: Establish the engineering problem and show production observability baseline.
* **Click Actions**:
  1. Navigate to `/`.
  2. Observe the **Guided Demo Ribbon** at the top showing the 6-stage workflow.
  3. Review the top KPI cards: **7 Monitored Services**, **Cluster Status: HEALTHY**, **Avg Latency: ~12ms**, **Error Rate: 0.0%**.
  4. Point out the **Live Telemetry & Diagnostics Feed** showing real-time health checks.
* **Visual Cue**: Screenshot `docs/screenshots/01_hero_dashboard.png`.
* **Talking Point**:
  > *"In modern microservices, an unindexed query or connection leak in a database cascades into timeout exceptions in the order service, inventory service, and API gateway. Traditional monitoring tools alert on all 10 services at once. IncidentGraph AI constructs an in-memory topological dependency DAG to trace the blast radius back to the true origin."*

---

### Scene 2 (0:25–0:55) — Inject a Deterministic Failure
* **URL**: `/simulator` (Failure Simulator)
* **Goal**: Inject a real-world failure without guessing or flaky mocks.
* **Click Actions**:
  1. Click **Simulator** in the top navigation bar.
  2. Click the scenario card **"PostgreSQL Database Slowdown"** (`database-slowdown`).
  3. Click **Inject Selected Scenario**.
  4. Notice the **Active Simulation Banner** transition to **Step 1: Origin Failure** (`postgres-db` latency surges to 800ms+).
  5. Click **Advance Step** to advance to **Step 2: Upstream Propagation** (`inventory-service` and `order-service` latencies surge).
* **Visual Cue**: Screenshot `docs/screenshots/03_failure_simulation.png`.
* **Talking Point**:
  > *"We select our PostgreSQL Connection Pool Exhaustion scenario. Step 1 injects an 800ms query latency spike at the database tier. Advancing to Step 2 demonstrates realistic cascade: synchronous connection pools saturate, blocking the Inventory and Order services."*

---

### Scene 3 (0:55–1:25) — Visualize the Cascade: Dependency DAG
* **URL**: `/service-map` (Service Dependency Map)
* **Goal**: Demonstrate graph traversal and blast-radius visualization.
* **Click Actions**:
  1. Click **Service Map** in the top navigation.
  2. Observe the interactive SVG topology DAG:
     - Tier 3: `postgres-db` (in state `DEGRADED` / `DOWN`).
     - Tier 2: `order-service`, `inventory-service` (latencies elevated).
     - Tier 1: `api-gateway` (edge ingress).
  3. Click the node **`postgres-db`** to highlight downstream paths and blast-radius edges.
* **Visual Cue**: Screenshot `docs/screenshots/02_service_dependency_map.png`.
* **Talking Point**:
  > *"On the interactive Service Map, the system maps dependencies as a directed acyclic graph. Rather than viewing flat alert tables, on-call engineers visually inspect the upstream blast radius. Critical paths are highlighted in amber and red based on live latency percentiles."*

---

### Scene 4 (1:25–2:00) — Explain the Diagnosis: DSA Root-Cause Engine
* **URL**: `/incidents` → Click **Investigate** on the active incident
* **Goal**: Demonstrate deterministic algorithmic ranking over black-box guessing.
* **Click Actions**:
  1. Navigate to `/incidents`. Note the auto-detected incident: *PostgreSQL Database Slowdown*.
  2. Click **Investigate**.
  3. Click the **Ranked Root Causes** tab.
  4. Review candidate #1: `postgres-db` with a **94%+ confidence score**.
  5. Click **Re-Run DSA Root-Cause Engine** to execute the priority queue re-weighting live.
  6. Switch to the **Evidence Timeline** tab to inspect the timestamped anomaly sequence.
* **Visual Cue**: Screenshot `docs/screenshots/04_root_cause_diagnosis.png`.
* **Talking Point**:
  > *"Here is the algorithmic core: the engine runs a weighted traversal combining anomaly z-score, topological depth, and temporal precedence. The edge gateway exhibits errors at time T+4 seconds, but postgres-db showed latency spikes at T+0 seconds at depth 3. The engine ranks postgres-db #1 with 94% confidence, correctly dismissing edge symptoms."*

---

### Scene 5 (2:00–2:35) — AI Investigation: Evidence-Grounded Replay
* **URL**: `/incidents/[id]` → **AI Investigation** tab
* **Goal**: Show production-grade AI guardrails and zero-hallucination design.
* **Click Actions**:
  1. Click the **AI Investigation** tab.
  2. Note the banner: **AI Provider Standby (Deterministic Engine Active)**.
  3. Click **Run Simulation Replay Demo** (or test live OpenAI if configured).
  4. Inspect the synthesized report:
     - **Verified Impact**: Exact service IDs and latency deltas.
     - **Ranked Hypotheses**: Linked directly to evidence IDs.
     - **Recommended Diagnostic Checks**: Concrete read-only CLI commands (e.g. `pg_stat_activity`).
     - **Safe Remediation Options**: Guarded actions with prerequisites.
* **Visual Cue**: Screenshot `docs/screenshots/05_ai_replay_investigation.png`.
* **Talking Point**:
  > *"For AI incident triage, production safety requires strict zero-hallucination boundaries. Every statement in this report is strictly grounded in telemetry evidence IDs validated by Zod schemas. If no LLM API key is present, our deterministic simulation replay engine produces exact, verified incident briefs with zero external cost."*

---

### Scene 6 (2:35–3:00) — Engineering Architecture & Production Hardening
* **URL**: `/settings` & `/api/health`
* **Goal**: Highlight enterprise architecture, OpenTelemetry, Grafana Cloud, and security hotfixes.
* **Click Actions**:
  1. Open `/settings` or inspect `/api/health`.
  2. Review the live integration status:
     - **OpenTelemetry OTLP Exporter**: Active.
     - **Grafana Cloud**: Hosted Prometheus & Tempo connected over HTTPS.
     - **Database**: Neon Serverless PostgreSQL with Prisma ORM.
     - **Security Hotfix**: Destructive reset endpoint (`POST /api/simulations/reset`) protected with 403 Forbidden in production; active incidents protected from pruning.
  3. Return to `/` for clean conclusion.
* **Talking Point**:
  > *"IncidentGraph AI is built on Next.js 16 App Router, TypeScript, Prisma ORM, and full OpenTelemetry standards exporting directly to Grafana Cloud. It features enterprise security hotfixes: production reset is blocked with HTTP 403, and active incidents are protected against automated pruning. Thank you for watching!"*

---

## Feature-to-Engineering-Skills Interview Map

| Product Feature | Technical Implementation | Relevant Senior Engineering Competencies |
| :--- | :--- | :--- |
| **Topological Service Map** | Directed graph DAG, custom SVG canvas, zoom/pan navigation | **Distributed Systems Architecture**, Graph Data Structures, Frontend Systems |
| **Cascade Blast-Radius Traversal** | Breadth-First Search (BFS) with depth-weighted latency propagation | **DSA Algorithms & Complexity**, Graph Theory, Microservice Fault Isolation |
| **Root-Cause Ranking Engine** | Min/Max Binary Heap Priority Queue, Z-score anomaly scoring, Temporal precedence sorting | **Applied Algorithm Design**, SRE Root-Cause Analysis, Anomaly Detection |
| **OpenTelemetry Integration** | OpenTelemetry Node SDK, OTLP HTTP trace/metric exporters, Prometheus PromQL querying | **Modern Observability Standards**, SRE Best Practices, Distributed Tracing |
| **Grafana Cloud Integration** | Hosted Tempo traces, PromQL instant metric normalization, multi-tenant HTTP headers | **Cloud Infrastructure**, SaaS Monitoring, Third-Party Telemetry Pipelines |
| **Evidence-Grounded AI Replay** | Zod schema validation, deterministic fallback synthesis, evidence ID provenance linking | **AI Safety & Alignment**, Structured Output Parsing, Zero-Cost Testing |
| **Production Security Hotfix** | Route handler authentication guards, HTTP 403 enforcement, transactional incident pruning | **Enterprise Security**, Defense-in-Depth, Database Transaction Integrity |
