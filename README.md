# IncidentGraph AI

[![CI](https://github.com/Atharvsrivastav/IncidentGraphAI/actions/workflows/ci.yml/badge.svg)](https://github.com/Atharvsrivastav/IncidentGraphAI/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16.4-black?logo=next.js&logoColor=white)](https://nextjs.org/)
[![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-Instrumented-F5A800?logo=opentelemetry&logoColor=white)](https://opentelemetry.io/)
[![Grafana Cloud](https://img.shields.io/badge/Grafana%20Cloud-Mimir%20%26%20Tempo-F46800?logo=grafana&logoColor=white)](https://grafana.com/)
[![Tests](https://img.shields.io/badge/Vitest-74%20Passed-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)

> **Intelligent, explainable incident investigation and root-cause analysis for distributed software architectures using directed graphs, deterministic algorithms, OpenTelemetry, and evidence-grounded AI synthesis.**

---

## 1. The Problem: Why Distributed Failure Triage Is Difficult

In modern microservice architectures, diagnosing outages is notoriously difficult due to **symptom cascading**:

1. **The Downstream Alert Storm**: When an underlying database suffers severe lock contention or disk saturation, it rarely fails in isolation. Every service depending on it begins exhausting its connection pool, accumulating request queues, and triggering HTTP 504 Gateway Timeouts at the ingress tier.
2. **Misleading Telemetry**: Ingress gateways exhibit the highest absolute volume of error logs and alert triggers, misleading on-call engineers into debugging the edge API rather than the root-cause database three hops deeper.
3. **Black-Box AI Unreliability**: Generative AI diagnostic wrappers often hallucinate connections, depend on unreliable internet connectivity, or leak proprietary operational traces to external model providers.
4. **Tooling Fragmentation**: Engineers must swivel between static architecture wikis, Prometheus dashboard spikes, and scattered distributed trace waterfalls to manually reconstruct the blast radius.

---

## 2. The Solution: IncidentGraph AI

**IncidentGraph AI** replaces guesswork with **deterministic graph algorithms**, **evidence-based heuristics**, and **grounded AI synthesis**. By modeling microservice topologies as a directed graph ($A \rightarrow B$ means service $A$ calls or depends on service $B$) and correlating live OpenTelemetry signals, it isolates the true originating failure in seconds.

### Key Highlights
- **100% Deterministic & Explainable**: Root causes are identified using proven graph traversal algorithms (Reverse BFS, 3-Color DFS) and a multi-factor ranking heuristic. No black-box hallucinations.
- **Evidence-Grounded AI Investigation**: Server-side LLM synthesis (`OpenAIProvider` or deterministic `MockAIProvider`) that correlates telemetry anomalies, trace spans, and graph reachability into an actionable SRE incident brief. Every claim is validated against genuine database evidence IDs, discarding hallucinated citations and enforcing calibrated uncertainty.
- **Zero Ground-Truth Leakage & Secret Redaction**: The analysis engine evaluates only observable runtime evidence without peeking at simulation ground truth. All credentials, tokens, and database passwords are automatically redacted before LLM transmission.
- **Dual Telemetry Modes with Truthful Provenance**: Operates offline via local SQLite and a deterministic chaos simulator, or connects to live production-grade **Grafana Cloud** (Prometheus Mimir + Tempo Traces) without requiring Docker or root privileges.
- **Interactive SRE Operations Console**: Visualizes service topologies, blast radius cascades, trace waterfalls, and algorithmic execution benchmarks in real time. Full incident triage with copyable Markdown incident briefs.

---

## 3. Product Tour & Screenshots

All screenshots below are captured from the active running application:

### Operations Overview Dashboard
The central command center displaying fleet health status, active incidents, telemetry breach timelines, and MTTR performance metrics:
![IncidentGraph AI Overview Dashboard](docs/screenshots/01_dashboard_desktop.png)

### Interactive Service Dependency Map
Dynamic topology map powered by React Flow (`@xyflow/react`). Color-coded health rings (Healthy, Degraded, Down), animated edge dependencies (`SYNC_HTTP`, `DATABASE_CONN`, `ASYNC_QUEUE`), and real-time inspection drawers:
![Service Dependency Map](docs/screenshots/02_servicemap_desktop.png)

### Deterministic Failure Simulator (Active Fault Injection)
Injects realistic failure scenarios (e.g., PostgreSQL disk latency, Auth key verification timeouts) and models multi-step cascading failure propagation along dependency edges:
![Failure Simulator Active Fault](docs/screenshots/03_simulator_injected_desktop.png)

### Incident Investigation & Root-Cause Ranking
Evidence-based candidate breakdown. Ranks originating services by combining graph blast-radius coverage, temporal onset, latency ratios, and error-rate deltas:
![Incident Investigation and Root Cause](docs/screenshots/05_incident_investigation_desktop.png)

### Trace Investigation Waterfall
Interactive distributed trace timeline inspecting multi-hop span latencies, W3C trace IDs, and database bottlenecks:
![Trace Investigation Waterfall](docs/screenshots/13_trace_waterfall_desktop.png)

### Real Cloud Telemetry Mode (Grafana Cloud Active)
Live microservices mesh connected to Grafana Cloud with active Prometheus Mimir and Tempo distributed tracing badges:
![Real Cloud Telemetry Mode](docs/screenshots/14_real_cloud_telemetry_desktop.png)

### Interactive DSA Lab
Live visual laboratory demonstrating how the core computer science algorithms run under the hood with step-by-step execution metrics:
![Interactive DSA Lab](docs/screenshots/07_dsalab_desktop.png)

### Fleet Recovery & Baseline Reset
Simulator restoration view showing automatic fleet health recovery, edge metric stabilization, and incident resolution:
![Fleet Recovery View](docs/screenshots/06_simulator_restored_desktop.png)

### Responsive Mobile Interface
Fully responsive SRE operations console optimized for mobile incident triage:
| Mobile Overview | Mobile Service Map | Mobile Incidents |
|:---:|:---:|:---:|
| ![Mobile Overview](docs/screenshots/09_dashboard_mobile.png) | ![Mobile Service Map](docs/screenshots/10_servicemap_mobile.png) | ![Mobile Incidents](docs/screenshots/12_incidents_mobile.png) |

---

## 4. System Architecture

```text
                                  +-----------------------+
                                  |      SRE Operator     |
                                  +-----------+-----------+
                                              |
                                              v
+-----------------------------------------------------------------------------------------+
|                               Next.js 16 Operations Console                             |
|                                                                                         |
|  [Presentation Layer]                                                                   |
|   ├── Overview Dashboard (/page.tsx)            ├── Service Dependency Map (/service-map)|
|   ├── Incident Triage (/incidents/[id])         ├── Trace Waterfall (/traces)           |
|   ├── Failure Simulator (/simulator)            └── DSA Educational Lab (/dsa-lab)      |
|                                                                                         |
|  [API Route Handlers (/api)]                                                            |
|   ├── /services & /dependencies                 ├── /simulations (inject/advance/reset) |
|   ├── /incidents & /evidence                    └── /telemetry (detect/overview/traces) |
+--------------------------------------------+--------------------------------------------+
                                             |
                      +----------------------+----------------------+
                      |                                             |
                      v                                             v
+-------------------------------------------+ +-------------------------------------------+
|          Deterministic DSA Engine         | |           Telemetry Provider Layer        |
|                                           | |                                           |
|  ├── DirectedGraph<T, E> (Adjacency list) | |  ├── TelemetryManager (Provider router)   |
|  ├── Reverse BFS (Impact propagation)     | |  ├── PrometheusClient (PromQL query)      |
|  ├── 3-Color DFS (Cycle detection)        | |  ├── JaegerClient (Tempo/Jaeger query)    |
|  ├── PriorityQueue<T> (Binary Max-Heap)   | |  └── RuleDetector (Threshold evaluation)  |
|  ├── SlidingWindow (Metric smoothing)     | +---------------------+---------------------+
|  └── RootCauseEngine (Heuristic scoring)  |                       |
+---------------------+---------------------+                       |
                      |                                             |
                      v                                             v
+-------------------------------------------+ +-------------------------------------------+
|            Local SQLite Storage           | |         Sample Microservices Mesh         |
|                                           | |                                           |
|  ├── Services, Dependencies, Health       | |  ├── API Gateway        (:4000)           |
|  ├── Incident Records & Evidence Logs     | |  ├── Order Service      (:4001)           |
|  └── Prisma ORM Client Singleton          | |  ├── Payment Service    (:4002)           |
+-------------------------------------------+ |  ├── Inventory Service  (:4003)           |
                                              |  └── Storage: Zero-Admin File Store / PG  |
                                              +---------------------+---------------------+
                                                                    |
                                                     HTTPS OTLP     | (W3C traceparent + metrics)
                                                                    v
                                              +-------------------------------------------+
                                              |               Grafana Cloud               |
                                              |                                           |
                                              |  ├── OTLP Gateway (Hosted Ingestion)      |
                                              |  ├── Prometheus Mimir (Metrics Engine)    |
                                              |  └── Tempo (Distributed Traces Engine)    |
                                              +-------------------------------------------+
```

*For complete architectural blueprints and sequence diagrams, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).*

---

## 5. Technology Stack & Design Decisions

| Category | Technology | Role & Engineering Rationale |
|---|---|---|
| **Frontend Framework** | **Next.js 16 (App Router)** | Server-side rendering, React Server Components, fast Turbopack compilation, and unified REST API route handlers. |
| **Language** | **TypeScript 5 (Strict)** | End-to-end type safety across graph data models, API payloads, and algorithm contracts. Zero `any`. |
| **Graph Visualization**| **React Flow (`@xyflow/react`)** | High-performance canvas rendering for directed microservice dependency graphs with custom node styling and bezier edges. |
| **UI & Styling** | **Tailwind CSS 4 + Lucide** | Low-latency SRE operations dark theme with clear semantic status badges (Emerald, Amber, Crimson). |
| **Charting** | **Recharts** | Responsive SVG charts for latency percentiles (p50, p95, p99), error rate ratios, and incident metrics. |
| **Database & ORM** | **SQLite + Prisma ORM 6** | Zero-admin persistent local storage. Runs everywhere without Docker or database server daemons. |
| **Validation** | **Zod 4** | Runtime schema validation for API query parameters, simulation inputs, and telemetry payloads. |
| **Instrumentation** | **OpenTelemetry SDK 2.x** | Industry-standard distributed tracing (W3C Trace Context) and metric instruments across sample services. |
| **Observability** | **Grafana Cloud (Mimir + Tempo)**| Cloud-native metrics and distributed traces with secure token-authenticated HTTP/OTLP gateways. |
| **Test Suite** | **Vitest 3** | Fast, modern testing framework powering 36 unit and integration tests with deterministic execution. |

---

## 6. Data Structures & Algorithms Deep Dive

IncidentGraph AI solves complex diagnostic problems using classical computer science algorithms rather than black-box models:

```text
[Graph Topology]         [Metrics Breaches]         [Temporal Onset]
       |                          |                         |
       v                          v                         v
Reverse BFS Reachability   Latency / Error Deltas   Timestamp Precedence
       \                          |                         /
        \                         |                        /
         v                        v                       v
      +-------------------------------------------------------+
      |        Multi-Factor Scoring Heuristic Engine          |
      |   Score = (Health × 40) + (Breach × 20) + (BFS × 20)   |
      |         + (Time × 15) + (Depth × 5) - Penalty         |
      +---------------------------+---------------------------+
                                  |
                                  v
                    +---------------------------+
                    |  Binary Heap (Max-Heap)   |
                    |    PriorityQueue<T>       |
                    +-------------+-------------+
                                  |
                                  v
                      Top-K Root-Cause Candidates
```

### Summary of Algorithmic Components

| Data Structure / Algorithm | Source File | Time Complexity | Space Complexity | Practical Role |
|---|---|---|---|---|
| **Directed Adjacency List** | [`src/lib/algorithms/graph.ts`](src/lib/algorithms/graph.ts) | $O(1)$ lookups | $O(V + E)$ | In-memory topology representation storing forward calls and reverse dependencies. |
| **Reverse BFS (Breadth-First Search)** | [`src/lib/algorithms/graph.ts`](src/lib/algorithms/graph.ts) | $O(V + E)$ | $O(V)$ | Traverses upstream callers to compute symptom reachability and blast radius. |
| **3-Color DFS (Cycle Detection)** | [`src/lib/algorithms/graph.ts`](src/lib/algorithms/graph.ts) | $O(V + E)$ | $O(V)$ | Traverses state (`WHITE`, `GRAY`, `BLACK`) to detect circular dependencies and deadlock loops. |
| **Binary Heap (Priority Queue)** | [`src/lib/algorithms/priorityQueue.ts`](src/lib/algorithms/priorityQueue.ts) | $O(\log N)$ insert / $O(K \log N)$ top-$K$ | $O(N)$ | Ranks candidate root causes with deterministic tie-breaking. |
| **Sliding Window Analyzer** | [`src/lib/algorithms/slidingWindow.ts`](src/lib/algorithms/slidingWindow.ts) | $O(W)$ window size | $O(W)$ | Smooths metric volatility and pinpoints earliest anomaly onset timestamps. |
| **Root-Cause Scoring Engine** | [`src/lib/algorithms/rootCauseEngine.ts`](src/lib/algorithms/rootCauseEngine.ts) | $O(V \cdot (E + W) + V \log V)$ | $O(V + E + W)$ | Computes composite root-cause scores across reachability, health, and latency deltas. |

*For complete mathematical proofs, pseudocode, and complexity analysis, see [`docs/DSA_ANALYSIS.md`](docs/DSA_ANALYSIS.md).*

---

## 7. Telemetry Architecture: OpenTelemetry, Prometheus & Tempo

IncidentGraph AI supports an end-to-end telemetry pipeline across three independent layers:

1. **Instrumentation (OpenTelemetry)**:
   - The sample microservices (`sample-services/`) wrap all incoming and outgoing HTTP calls in active spans.
   - Trace contexts are propagated via standard W3C `traceparent` headers (`traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`).
   - Latency histograms and HTTP request counters are exported via standard OTLP HTTP Protobuf/JSON.

2. **Metrics Storage (Prometheus / Grafana Mimir)**:
   - Evaluates service performance through PromQL instant and range queries.
   - Computes real-time P95 latency: `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, service))`
   - Computes 5xx error ratios: `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))`

3. **Distributed Trace Storage (Grafana Tempo / Jaeger)**:
   - Gathers end-to-end distributed transaction traces.
   - IncidentGraph AI pulls span hierarchies to render interactive trace waterfalls, identifying exact bottlenecks where downstream database latency blocks edge API responses.

---

## 8. Operating Modes

IncidentGraph AI seamlessly switches between three distinct operational modes:

| Mode | Telemetry Source | Storage Backend | Typical Use Case |
|---|---|---|---|
| **A. Simulation Mode** *(Default)* | Deterministic Fault Engine | SQLite (`dev.db`) | Offline evaluation, educational demonstration, algorithmic testing, interview walkthroughs. |
| **B. Real Cloud Telemetry Mode** | Grafana Cloud (Mimir + Tempo) | SQLite + Grafana OTLP | Real-world telemetry analysis with live Prometheus metrics and distributed traces over HTTPS. |
| **C. Local Development Mock Mode** | Built-in fallback providers | Local SQLite / File store | Local offline testing when neither cloud tokens nor Docker containers are available. |

---

## 9. Quickstart & Local Installation

### Prerequisites
- **Node.js**: v18.0.0 or higher (v20+ LTS recommended)
- **npm**: v9.0.0 or higher
- **Zero Administrator Privileges Required**: Runs entirely in user space on Windows, macOS, or Linux.

### 1. Clone & Install
```bash
git clone https://github.com/Atharvsrivastav/IncidentGraphAI.git
cd IncidentGraphAI
npm install
```

### 2. Configure Environment
Copy the template configuration:
```bash
cp .env.example .env
```
*(The default configuration points to local SQLite `dev.db` and is ready to run immediately in Simulation Mode).*

### 3. Initialize Database & Topology
```bash
npx prisma generate
npx prisma db push
npm run db:seed
```

### 4. Start the Application
```bash
npm run dev
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.

---

## 10. Running Sample Microservices & Test Traffic

To experience real telemetry propagation without external dependencies:

```bash
# Terminal 1: Start the 4 sample microservices (ports 4000-4003)
npm run sample:start

# Terminal 2: Generate synthetic traffic through the API Gateway
npm run sample:traffic

# Terminal 3: Trigger a controlled chaos latency spike (PostgreSQL slowdown)
curl -X POST http://localhost:3000/api/experiments/trigger \
  -H "Content-Type: application/json" \
  -d '{"scenario":"db-slowdown"}'

# Restore the fleet back to healthy baseline
curl -X POST http://localhost:3000/api/experiments/trigger \
  -H "Content-Type: application/json" \
  -d '{"scenario":"baseline"}'
```

---

## 11. Environment Configuration

The application uses least-privilege configuration options in `.env`:

```env
# 1. Local Storage (SQLite - zero admin permissions required)
DATABASE_URL="file:./dev.db"

# 2. Grafana Cloud Integration (Optional - for Real Cloud Mode)
GRAFANA_CLOUD_OTLP_ENDPOINT="https://otlp-gateway-prod-ap-south-1.grafana.net/otlp"
GRAFANA_CLOUD_INSTANCE_ID="1871065"
GRAFANA_CLOUD_INGESTION_TOKEN="glc_..."

# Prometheus Query (scope: metrics:read)
GRAFANA_CLOUD_PROMETHEUS_URL="https://prometheus-prod-XX-prod-ap-south-1.grafana.net/api/prom"
GRAFANA_CLOUD_PROMETHEUS_USER="1871065"
GRAFANA_CLOUD_PROMETHEUS_TOKEN="glc_..."

# Tempo Traces Query (scope: traces:read)
GRAFANA_CLOUD_TEMPO_URL="https://tempo-prod-XX-prod-ap-south-1.grafana.net"
GRAFANA_CLOUD_TEMPO_USER="1871065"
GRAFANA_CLOUD_TEMPO_TOKEN="glc_..."

# 3. Detection & Investigation Rules
TELEMETRY_QUERY_TIMEOUT_MS=4000
TELEMETRY_LOOKBACK_MINUTES=15
INCIDENT_DETECTION_COOLDOWN_SECONDS=60
```

To verify your configuration without revealing secrets, run:
```bash
npm run config:check
```

---

## 12. Automated Verification & Testing

IncidentGraph AI maintains a comprehensive testing and static verification suite:

| Check | Command | Description | Status |
|---|---|---|---|
| **Unit & Integration Tests** | `npm test` | Runs 36 Vitest tests covering algorithms, graph reachability, heap priority, and telemetry pipelines | **36 / 36 Passing** |
| **Type Checking** | `npx tsc --noEmit` | Strict TypeScript compiler validation across all components and routes | **0 Errors** |
| **Linting** | `npm run lint` | ESLint static code analysis verifying Next.js and React rules | **0 Errors** |
| **Production Build** | `npm run build` | Compiles and optimizes Next.js production bundle with route pre-rendering | **25 / 25 Routes Compiled** |
| **Cloud Pipeline Verification** | `npm run test:cloud` | 6-stage end-to-end verification of Grafana Cloud OTLP, Prometheus, and Tempo | **6 / 6 Gates Verified** |

---

## 13. REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/services` | Retrieves all microservices with health statuses and dependencies |
| `GET` | `/api/services/:id` | Service telemetry history, upstream callers, and downstream dependencies |
| `POST` | `/api/services/:id/restore` | Restores a service to baseline health and resolves active incidents |
| `GET` | `/api/dependencies` | Returns all directed graph edges with dependency types and timeouts |
| `GET` | `/api/incidents` | Lists active and resolved incidents with severity levels |
| `GET` | `/api/incidents/:id` | Detailed incident dossier with ranked candidates and evidence timelines |
| `POST` | `/api/incidents/:id/analyze` | Triggers on-demand DSA root-cause re-analysis |
| `POST` | `/api/simulations/inject` | Injects a deterministic failure scenario |
| `POST` | `/api/simulations/advance` | Advances simulation step with cascading blast-radius propagation |
| `POST` | `/api/simulations/reset` | Resets all services and restores baseline topology |
| `GET` | `/api/telemetry/overview` | Telemetry health summary with active backend provider status |
| `GET` / `POST` | `/api/telemetry/mode` | Inspects or switches active telemetry mode (`SIMULATION` vs `REAL`) |
| `GET` | `/api/telemetry/traces` | Lists recent distributed traces with duration and error filters |
| `GET` | `/api/telemetry/traces/:id` | Fetches span hierarchy for interactive waterfall timeline visualization |
| `POST` | `/api/experiments/trigger` | Triggers live chaos injection (`db-slowdown`, `baseline`) |

---

## 14. Project Structure

```text
incident-graph-ai/
├── .github/workflows/
│   └── ci.yml                      # GitHub Actions CI pipeline
├── docs/
│   ├── ARCHITECTURE.md             # Complete system & sequence architecture diagrams
│   ├── DSA_ANALYSIS.md             # In-depth algorithmic proofs & complexity analysis
│   ├── ROOT_CAUSE_ENGINE.md        # Heuristic scoring engine specification
│   ├── REAL_TELEMETRY_ARCHITECTURE.md # OpenTelemetry & Grafana Cloud architecture
│   ├── GRAFANA_CLOUD_SETUP.md      # Step-by-step hosted observability guide
│   ├── TELEMETRY_TROUBLESHOOTING.md# SRE operations & troubleshooting runbook
│   └── screenshots/                # Real application UI screenshots
├── sample-services/                # OpenTelemetry sample microservices mesh
│   ├── apiGateway.ts               # Ingress HTTP gateway (Port 4000)
│   ├── orderService.ts             # Order lifecycle processor (Port 4001)
│   ├── paymentService.ts           # Payment processor (Port 4002)
│   ├── inventoryService.ts         # Inventory store (Port 4003)
│   └── runner.ts                   # Multi-service lifecycle manager
├── scripts/
│   ├── check-config.ts             # Masked environment variable & connection audit
│   ├── verify-cloud-pipeline.ts    # 6-stage live Grafana Cloud verification
│   └── traffic-generator.mjs       # Synthetic traffic generator
├── src/
│   ├── app/
│   │   ├── api/                    # Next.js App Router API endpoints
│   │   ├── dsa-lab/                # Interactive algorithmic lab
│   │   ├── incidents/              # Incident triage & root-cause dossiers
│   │   ├── service-map/            # Interactive React Flow topology map
│   │   ├── simulator/              # Deterministic chaos simulator
│   │   ├── traces/                 # Distributed trace waterfall inspector
│   │   └── page.tsx                # Operations overview console
│   ├── components/
│   │   ├── graph/                  # React Flow custom nodes, edges, and drawers
│   │   └── layout/                 # Navigation, status indicators, and headers
│   └── lib/
│       ├── algorithms/             # Pure deterministic DSA implementations
│       │   ├── graph.ts            # DirectedGraph, BFS, 3-color DFS
│       │   ├── priorityQueue.ts    # Binary Max-Heap / PriorityQueue
│       │   ├── rootCauseEngine.ts  # Multi-factor RCA heuristic engine
│       │   ├── slidingWindow.ts    # Moving-window telemetry statistical analyzer
│       │   └── types.ts            # Core TypeScript domain models
│       ├── db/                     # Prisma ORM client & topology seeder
│       ├── simulation/             # Chaos scenarios & cascade propagation
│       └── telemetry/              # OTel, Prometheus, and Tempo clients
└── tests/
    ├── algorithms.test.ts          # Algorithmic correctness test suite
    ├── api.test.ts                 # Next.js API route integration tests
    ├── integration.test.ts         # Database & simulator end-to-end tests
    └── telemetry.test.ts           # OpenTelemetry, PromQL, and Tempo tests
```

---

## 15. Security & Privacy Considerations

- **Strict Secret Redaction**: The codebase uses token masking utilities (`scripts/check-config.ts`) to ensure that credentials are never printed to terminals, written to log files, or transmitted in client bundles.
- **Server-Side Credential Isolation**: Telemetry read tokens and database connection strings are accessed strictly within Next.js Route Handlers (`src/app/api/`) and never bundled into client JavaScript.
- **Git Protection**: `.env` and all credential patterns are excluded via `.gitignore`. `.env.example` contains only non-sensitive templates.
- **Zero External Data Exfiltration**: In Simulation Mode, 100% of telemetry, incident data, and graph algorithms run locally on the host machine. No trace or metric data leaves your local network.

---

## 16. Current Limitations

1. **Topology Editing**: The service topology is currently seeded via Prisma database seeds and configuration files; runtime drag-and-drop node creation is planned for a future release.
2. **Real Cloud Polling Latency**: Metrics queried from Grafana Cloud Mimir depend on scrape intervals (typically 15–30s) and ingest gateway flush times.
3. **Stateless Candidate Persistence**: Root-cause candidates are evaluated deterministically in-flight; long-term historical ranking evolution is currently stored as point-in-time snapshots.

---

## 17. Future Roadmap

- [ ] **Dynamic Topology Editor**: Visual canvas for adding, removing, and connecting services at runtime.
- [ ] **eBPF-Based Auto-Discovery**: Automatic network topology generation using eBPF kernel probes.
- [ ] **Multi-Cluster Support**: Federation across multiple Kubernetes namespaces and cloud regions.
- [ ] **SLO / Error Budget Tracking**: Automated burn-rate alerting based on Google SRE error budget formulas.
- [ ] **Automated Remediation Webhooks**: Executing automated rollback or circuit-breaking playbooks when root-cause confidence exceeds 90%.

---

## 18. Production Deployment & Live Demo

IncidentGraph AI supports dual-target deployment for both zero-dependency local experimentation and production serverless cloud environments:

- **Serverless Cloud (Vercel)**: Runs Next.js 16 App Router on Vercel Edge and Lambda serverless functions.
- **Persistence Architecture**: Uses a dynamic Prisma configuration (`prisma.config.ts`) that selects SQLite (`prisma/schema.prisma`) for local development and hosted PostgreSQL (`prisma/schema.postgresql.prisma`, e.g., Neon or Supabase) when `DATABASE_URL` is configured for production.
- **Health Check**: Continuous zero-downtime health endpoint at [`/api/health`](file:///c:/Users/Atharv/Desktop/IncidentGrapghAI/src/app/api/health/route.ts) reporting database connectivity, active telemetry mode, and AI provider status.
- **Zero-Key Replay Mode**: For portfolio demonstrations without incurring third-party API costs or exposing keys, users can run offline deterministic AI investigation replays.

*For complete configuration and deployment steps, consult [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).*

---

## 19. Troubleshooting

| Issue | Common Cause | Resolution |
|---|---|---|
| `Port 4000/4001 EADDRINUSE` | Previous runner process was not killed cleanly | Kill the process holding the port: `Get-NetTCPConnection -LocalPort 4000 \| Select-Object OwningProcess` |
| `Prometheus 401 Unauthorized` | Invalid or expired Grafana Cloud query token | Generate a fresh token in Grafana Cloud with `metrics:read` scope and update `.env` |
| `Tempo 0 Traces Found` | Sample traffic generator has not run recently | Run `npm run sample:traffic` to generate fresh HTTP requests through the mesh |
| `Prisma Client out of date` | Schema modified without generating client | Run `npx prisma generate` |

*For in-depth operational procedures, consult [`docs/TELEMETRY_TROUBLESHOOTING.md`](docs/TELEMETRY_TROUBLESHOOTING.md).*

---

## 20. Contributing

Contributions are welcome! Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) for code style guidelines, architectural boundaries, and our pull-request verification checklist.

---

## 21. License & Acknowledgments

This project is open-source software. *(Note: Review project repository settings for formal license declaration).*

Built with passion for resilient software systems, reliable SRE operations, and explainable computer science engineering.
