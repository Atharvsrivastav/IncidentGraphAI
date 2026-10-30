# IncidentGraph AI — Technical Architecture Overview

> **Repository**: [https://github.com/Atharvsrivastav/IncidentGraphAI](https://github.com/Atharvsrivastav/IncidentGraphAI)  
> **Production Deployment**: [https://incident-graph-ai.vercel.app](https://incident-graph-ai.vercel.app)  
> **Architecture Focus**: Distributed Systems Observability, Graph Algorithms, and Evidence-Grounded AI

---

## 1. High-Level System Architecture

IncidentGraph AI is a root-cause analysis platform that correlates distributed telemetry against an in-memory directed dependency graph to localize originating fault candidates during cascading microservice failures.

```
                           +---------------------------+
                           |   Next.js 16 App Router   |
                           |   (Vercel Edge / Node)    |
                           +-------------+-------------+
                                         |
     +-----------------------------------+-----------------------------------+
     |                                   |                                   |
     v                                   v                                   v
+-------------------+       +-------------------------+     +-------------------+
| Telemetry Ingest  |       | Graph & DSA Core        |     | AI Investigation  |
| OpenTelemetry SDK |       | In-Memory Directed      |     | Evidence-Grounded |
| Grafana Cloud OTLP|       | Dependency Graph        |     | Zod Guardrails    |
| PromQL & Tempo    |       | Priority Queue Ranker   |     | Replay Fallback   |
+---------+---------+       +------------+------------+     +---------+---------+
          |                              |                            |
          +------------------------------+----------------------------+
                                         |
                                         v
                       +-----------------------------------+
                       |   Prisma ORM & PostgreSQL DB      |
                       |   (Neon Serverless / SQLite Local)|
                       +-----------------------------------+
```

---

## 2. Core Architectural Pillars

### A. Directed Dependency Graph & Topology Engine
Microservices and their synchronous/asynchronous relationships are modeled as a weighted directed graph $G = (V, E)$:
- **Vertices ($V$)**: Individual microservices, each with operational metadata (Tier 1 Edge, Tier 2 Core, Tier 3 Storage), baseline latencies, and moving error rates.
- **Edges ($E$)**: Dependency calls (e.g. `order-service` $\rightarrow$ `postgres-db`) annotated with communication protocol (`SYNC_HTTP`, `ASYNC_QUEUE`, `DATABASE_CONN`), timeout thresholds, and criticality tiers.
- **Algorithmic Traversals**:
  - **BFS Blast-Radius Search**: Traverses downstream dependency edges from degraded services to compute graph reachability, blast radius, and topological impact scores.
  - **DFS Cycle Detection**: Implements 3-color DFS (WHITE/GRAY/BLACK recursion stack tracking) to detect circular dependency cycles in microservice topology and prevent infinite traversal loops.

### B. Dual-Mode Observability & Ingestion Pipeline
IncidentGraph AI supports both live cloud telemetry and deterministic simulation replay:
1. **Live OpenTelemetry & Grafana Cloud (Hosted Mode)**:
   - Uses `@opentelemetry/sdk-node` with HTTP OTLP metric and trace exporters.
   - Microservices stream metrics directly to Grafana Cloud Prometheus (`/api/prom`) and traces to Grafana Cloud Tempo (`/otlp`).
   - Query engine fetches Prometheus instant vectors via PromQL and parses Tempo trace span hierarchies.
   - *Public Production Status*: In the public deployment on Vercel, the application reports `mode: SIMULATION` while Grafana Cloud Prometheus and Tempo probes are verified active. Live autonomous stream ingestion is inactive in public production to prevent third-party egress charges.
2. **Deterministic Fault Simulator (Simulation Mode)**:
   - Built-in simulation engine featuring 7 real-world failure scenarios (`database-slowdown`, `database-outage`, `payment-failure`, `inventory-timeout`, `auth-failure`, `gateway-errors`, `network-latency`).
   - Generates deterministic telemetry updates along dependency edges, allowing controlled stepping ($t_0 \rightarrow t_1 \rightarrow t_2$) to inspect cascade dynamics without incurring cloud compute costs.

### C. Deterministic DSA Root-Cause Ranking Engine
Unlike black-box heuristics or stochastic LLM guesses, the core root-cause analysis is driven by a mathematical ranking formula executed via a binary heap priority queue:

$$\text{Score}(v) = w_1 \cdot Z_{\text{latency}}(v) + w_2 \cdot Z_{\text{error}}(v) + w_3 \cdot \text{Depth}(v) + w_4 \cdot T_{\text{precedence}}(v)$$

- **Statistical Z-Score**: Measures how many standard deviations current latency and error rates depart from baseline.
- **Topological Depth Weighting**: Rewards upstream deep storage/infrastructure nodes (Tier 3) over shallow edge reverse proxies (Tier 1).
- **Synthetic Benchmark Evaluation**: Evaluated on the documented synthetic test suite (117 total test cases across 5 topology families—distinct from the 7 interactive failure scenarios in the simulator), the ranking algorithm achieved 100% Top-1 root-cause recall among the 65 evaluable definitive failure scenarios (and 100% suite acceptance across all 117 cases) with mean per-scenario algorithm execution latency of 0.14ms (P95: 0.13ms; <400ms total Vitest suite test runner execution time). These metrics evaluate deterministic synthetic scenarios rather than arbitrary production incidents; see [Root-Cause Benchmark Methodology](docs/ROOT_CAUSE_BENCHMARK.md) for full experimental setup.

> [!NOTE]
> **Reconciliation of Counts — 7 Simulator Scenarios vs. 5 Benchmark Topology Families vs. 117 Total Benchmark Scenarios**:
> - **7 Simulator Failure Scenarios**: The interactive simulator provides 7 concrete failure scenarios injected into the primary 7-node microservice graph (`database-slowdown`, `database-outage`, `payment-failure`, `inventory-timeout`, `auth-failure`, `gateway-errors`, and `network-latency`).
> - **5 Benchmark Topology Families**: The algorithmic robustness benchmark generates scenarios across 5 structural graph architectures (Canonical E-Commerce, Linear Pipeline, Microservices Mesh, Hub-and-Spoke, and Cyclic Graph).
> - **117 Total Benchmark Scenarios**: Partitioned into 65 evaluable definitive failure scenarios (where 100% Top-1 / Top-3 hit rate is evaluated), 13 healthy baselines (0% false alarms), 5 recovery cycles (100% resolution verification), and 34 ambiguous / noisy scenarios (70.59% appropriate inconclusive abstention, 10 valid multi-root identifications). All 117/117 scenarios pass their configured acceptance criteria.

### D. Evidence-Grounded AI Investigator
When AI triage is invoked, strict reliability boundaries are enforced:
- **Zod Schema Validation**: AI outputs must conform to `AIInvestigationReport` schemas with required fields: `verifiedImpact`, `rankedHypotheses`, `recommendedChecks`, `remediationOptions`, and `missingEvidence`.
- **Evidence-ID Validation**: Every hypothesis cites specific telemetry anomaly evidence IDs recorded during the incident. Non-matching or fabricated IDs are stripped during post-generation schema validation. Note that while syntactic evidence-ID validation ensures every cited ID corresponds to an existing database evidence record, it does not guarantee semantic accuracy or domain correctness of the generated textual claims; human SRE review remains strictly necessary.
- **Standby & Deterministic Replay**: Deterministic replay does not require a live LLM API. In public production, where no external OpenAI key is configured, the system transparently indicates standby mode and executes the deterministic simulation replay provider. All incident summaries are cross-checked against runtime evidence records.

---

## 3. Production Security & Data Integrity

The production deployment on Vercel incorporates enterprise defense-in-depth controls:

| Security Domain | Implementation | Verification Status |
| :--- | :--- | :--- |
| **Destructive Reset Guard** | `POST /api/simulations/reset` requires verified `ADMIN_API_KEY` in production; public unauthenticated requests are blocked with **HTTP 403 Forbidden**. | **Verified Active on Production** |
| **Incident Pruning Safety** | Transactional pruning in `src/lib/incidents/pruning.ts` strictly queries `where: { status: 'RESOLVED' }`. Active, investigating, and identified incidents are immune to pruning. | **Verified Active on Production** |
| **Zero Secret Leakage** | All Grafana Cloud tokens, OpenAI API keys, and admin secrets are isolated in server environment variables. Zero credentials exposed in client bundles or public GET responses. | **Audited & Clean** |
| **Read-Only SRE Actions** | AI investigation recommendations are explicitly partitioned into read-only diagnostic checks vs. guarded remediation options requiring human approval. | **Enforced by Schema** |

---

## 4. Technology Stack Summary

- **Frontend & Framework**: Next.js 16.4.3 (App Router, Turbopack, React 19, Server Components)
- **Styling**: Tailwind CSS v4, Lucide Icons
- **Database & Data Layer**: Neon Serverless PostgreSQL / SQLite, Prisma ORM 6.19
- **Observability Standards**: OpenTelemetry JS SDK 0.223, Prometheus PromQL, Grafana Cloud Tempo Traces
- **Testing & Verification**: Vitest (Unit & Integration, 81 tests passing), Playwright Core (E2E browser automation & 1080p recording), FFmpeg (H.264 video encoding)
