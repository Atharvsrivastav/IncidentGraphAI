# IncidentGraph AI — System Architecture & Data Flow

IncidentGraph AI is a hybrid Site Reliability Engineering (SRE) observability and automated root-cause analysis platform. It models microservice topologies using directed graphs, collects distributed telemetry via OpenTelemetry, and ranks probable failure origins using deterministic graph-traversal algorithms and statistical scoring.

---

## 1. High-Level System Architecture

The following diagram illustrates the complete logical architecture, data boundaries, and network relationships across IncidentGraph AI.

```mermaid
flowchart TB
    subgraph Users ["Client & Operations Layer"]
        Operator["SRE Engineer / Operator\n(Web Browser)"]
    end

    subgraph FrontendApp ["IncidentGraph AI — Next.js Application"]
        UI["React 19 App Router Frontend\n(/service-map, /simulator, /traces, /incidents, /dsa-lab)"]
        API["Next.js Route Handlers (Serverless/Node.js API)\n(/api/services, /api/simulations, /api/telemetry/*)"]
    end

    subgraph AppData ["Application Persistence"]
        SQLiteDB[("Application Database\n(SQLite via Prisma: dev.db)\n• Service Topology\n• Incident Records\n• Candidate Rankings")]
    end

    subgraph DSACore ["Deterministic Algorithmic Engine"]
        GraphModel["Directed Dependency Graph\n(Adjacency Lists: Forward & Reverse)"]
        BFS["BFS Traversal\n(Blast Radius & Cascade Impact)"]
        DFS["DFS Traversal\n(Cycle & Circular Dependency Detection)"]
        SlidingWin["Sliding Window Analyzer\n(Rate of Change & Telemetry Spikes)"]
        MaxHeap["Binary Max-Heap / Priority Queue\n(Top-K Candidate Extraction)"]
        RCAEngine["Real Root Cause Engine\n(Multi-Signal Evidence Scoring)"]
    end

    subgraph TelemetrySubsystem ["Observability & Ingestion Layer"]
        TelManager["Telemetry Manager\n(Mode Routing: SIMULATION vs REAL)"]
        PromClient["Prometheus Client\n(HTTP PromQL Instant Queries)"]
        TempoClient["Tempo / Jaeger Client\n(HTTP Span Search & Waterfalls)"]
    end

    subgraph SampleFleet ["Sample Microservices Ecosystem (Port 4000-4003)"]
        Gateway["API Gateway (:4000)"]
        OrderSvc["Order Service (:4001)"]
        PaymentSvc["Payment Service (:4002)"]
        InventorySvc["Inventory Service (:4003)"]
        LocalStorage[("Sample Dev Storage\n(Zero-Admin sample_store.json\nor Hosted Postgres)")]
        OTelSDK["OpenTelemetry Node SDK\n(W3C TraceContext Ingestion)"]
    end

    subgraph HostedCloud ["Hosted Backend (Grafana Cloud Free Tier)"]
        OTLPGateway["OTLP Ingestion Gateway\n(otlp-gateway-prod-ap-south-1.grafana.net)"]
        MimirProm["Hosted Prometheus / Mimir\n(prometheus-prod-43-prod-ap-south-1.grafana.net)"]
        TempoTraces["Hosted Tempo Traces\n(tempo-prod-19-prod-ap-south-1.grafana.net)"]
    end

    subgraph LocalMock ["Optional Dev Mock Observability (:4318, :9090, :16686)"]
        MockOTel["In-Process Mock OTLP Receiver"]
        MockProm["In-Process Mock PromQL Server"]
        MockJaeger["In-Process Mock Jaeger Server"]
    end

    %% User Interactions
    Operator -->|HTTPS / UI Interaction| UI
    UI -->|Internal Fetch / SWR| API

    %% API Layer Operations
    API -->|Read / Write Topology & Incidents| SQLiteDB
    API -->|Load Services into Memory| GraphModel
    API -->|Route Telemetry Requests| TelManager

    %% Algorithmic Pipeline
    GraphModel --> BFS
    GraphModel --> DFS
    SlidingWin --> RCAEngine
    BFS --> RCAEngine
    RCAEngine --> MaxHeap

    %% Telemetry Layer Routing
    TelManager -->|Real Cloud Mode: Query Metrics| PromClient
    TelManager -->|Real Cloud Mode: Query Spans| TempoClient
    TelManager -->|Dev Mock Mode| MockProm
    TelManager -->|Dev Mock Mode| MockJaeger

    PromClient -->|HTTPS Basic Auth: metrics:read| MimirProm
    TempoClient -->|HTTPS Basic Auth: traces:read| TempoTraces

    %% Sample Fleet Execution & Export
    Gateway -->|HTTP + traceparent| OrderSvc
    OrderSvc -->|HTTP + traceparent| PaymentSvc
    OrderSvc -->|HTTP + traceparent| InventorySvc
    InventorySvc --> LocalStorage
    OrderSvc --> LocalStorage

    Gateway -.->|OTel Spans & Metrics| OTelSDK
    OrderSvc -.->|OTel Spans & Metrics| OTelSDK
    PaymentSvc -.->|OTel Spans & Metrics| OTelSDK
    InventorySvc -.->|OTel Spans & Metrics| OTelSDK

    OTelSDK -->|HTTPS OTLP: metrics:write, traces:write| OTLPGateway
    OTelSDK -.->|Fallback if Cloud disabled| MockOTel

    OTLPGateway --> MimirProm
    OTLPGateway --> TempoTraces
```

---

## 2. Operating Modes & Data Isolation

IncidentGraph AI strictly distinguishes three operating environments to ensure test reproducibility, data integrity, and zero telemetry fabrication:

| Dimension | Simulation Mode | Real Cloud Telemetry Mode | Dev Mock Mode |
| :--- | :--- | :--- | :--- |
| **Telemetry Source** | In-memory deterministic state engine (`dev.db`). | Hosted Grafana Cloud (Prometheus & Tempo over HTTPS). | In-process HTTP test servers on `:4318`, `:9090`, `:16686`. |
| **Microservices Requirement** | None (runs standalone). | Sample services running (`npm run sample:start`). | Sample services emitting locally. |
| **Cloud Credentials** | None required. | `GRAFANA_CLOUD_*` tokens in local `.env`. | None required. |
| **Handling Unobserved Nodes** | Returns simulated status (HEALTHY / DEGRADED / DOWN). | Explicitly marked `UNKNOWN` with `No observations received`. | Emulated response format. |
| **Root-Cause Analysis Input** | Simulated step metrics and topological graph. | Actual PromQL query values, live latency anomalies, real trace span durations. | Emulated metrics and traces. |
| **Cloud Network Egress** | Zero network egress. | HTTPS calls to `prod-ap-south-1.grafana.net`. | Zero network egress. |

---

## 3. Incident Investigation & Root-Cause Analysis Workflow

The following sequence details how an incident transitions from physical HTTP request latency to verified root-cause remediation:

```mermaid
sequenceDiagram
    autonumber
    actor Client as Synthetic Traffic / User
    participant Gateway as Sample API Gateway (:4000)
    participant Services as Downstream Microservices
    participant Storage as Sample Database / Storage
    participant OTel as OpenTelemetry SDK
    participant Cloud as Grafana Cloud (OTLP / Mimir / Tempo)
    participant Detector as Real Incident Detector
    participant Engine as Real Root Cause Engine
    participant Graph as Directed Topology Graph (DSA)
    participant UI as SRE Dashboard (/incidents/[id])
    actor SRE as SRE Operator

    %% Step 1: Traffic & Fault
    Note over Storage: Controlled Fault Injected (e.g. 700ms Storage Latency)
    Client->>Gateway: POST /api/orders (traceparent: 00-traceId-spanId-01)
    Gateway->>Services: Order Fulfillment Chain (propagating W3C context)
    Services->>Storage: Read/Write Database Query
    Storage-->>Services: High Latency Delay (700ms)
    Services-->>Gateway: Delayed Response (201 Created)
    Gateway-->>Client: HTTP 201 Response

    %% Step 2: Telemetry Export
    Services->>OTel: End Spans & Record Histograms
    OTel->>Cloud: POST /otlp/v1/traces & /v1/metrics (HTTPS OTLP)
    Note over Cloud: Ingestion Gateway stores spans in Tempo & metrics in Mimir

    %% Step 3: Anomaly Detection
    Detector->>Cloud: GET /api/v1/query (Rate, Error, Latency PromQL)
    Cloud-->>Detector: Observed Latency Vector (>500ms Threshold)
    Detector->>Detector: Check Cooldown & Anomaly Rules
    Detector->>UI: Create Incident Record (HIGH Severity)

    %% Step 4: Evidence-Based Root Cause Analysis
    SRE->>UI: Click "Investigate Incident"
    UI->>Engine: POST /api/incidents/[id]/analyze
    Engine->>Cloud: Query Tempo Spans for Trace Waterfall
    Cloud-->>Engine: Raw Span Trees & Self-Time Measurements
    Engine->>Graph: Query Adjacency List & Reverse BFS
    Graph-->>Engine: Dependency Depths & Topological Order
    Engine->>Engine: Calculate Heuristic Scores (Self-Time + Depth + Anomaly Spike)
    Engine->>Engine: Sift into Binary Max-Heap & Extract Top-K

    %% Step 5: Dashboard Presentation & Verification
    Engine-->>UI: Ranked Candidates (postgres-db / inventory-service) with Evidence Summary
    UI-->>SRE: Display Visual Graph, Anomaly Confidence, and Recommended Action
    SRE->>Storage: Restore Baseline / Flush Storage
    Storage-->>SRE: Baseline Restored (12ms Latency)
    SRE->>UI: Verify Recovery via New Live Telemetry
```

---

## 4. Key Architectural Guarantees

1. **Zero State Fabrication**: When Real Telemetry Mode is enabled, unobserved services are never populated with fake values. They are marked `UNKNOWN` with actionable diagnostics.
2. **Zero Admin & Local Execution**: The entire stack (Next.js, SQLite, sample services, local storage, test suites) executes on standard user permissions without Docker, WSL, or administrator privileges.
3. **Strict Credential Containment**: Cloud tokens are strictly consumed by server-side clients ([prometheusClient.ts](file:///c:/Users/Atharv/Desktop/IncidentGrapghAI/src/lib/telemetry/prometheusClient.ts), [jaegerClient.ts](file:///c:/Users/Atharv/Desktop/IncidentGrapghAI/src/lib/telemetry/jaegerClient.ts), [telemetry.ts](file:///c:/Users/Atharv/Desktop/IncidentGrapghAI/sample-services/shared/telemetry.ts)). No secrets are exposed to the browser or bundled into client code.
4. **Decoupled Database Boundaries**: The application database (`prisma/dev.db`) stores incident graph topology and UI state. The sample microservices persist business transactions independently in `sample-services/data/sample_store.json` (or a dedicated external Postgres instance). Telemetry is stored exclusively in Grafana Cloud.
