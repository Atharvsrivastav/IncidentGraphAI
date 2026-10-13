# IncidentGraph AI — Real Telemetry Architecture (Phase 2)

## 1. Executive Summary & Architecture Overview

Phase 2 introduces an end-to-end real telemetry pipeline to IncidentGraph AI with support for both **self-hosted local stacks** and **cloud-hosted Grafana Cloud backends** designed for restricted zero-admin environments.

### Complete Architecture Pipeline (Dual-Mode Support)

```text
               +-------------------------------------------------------------+
               |               Sample Microservices System                   |
               |                                                             |
               |  +-------------+     W3C TraceContext     +--------------+  |
               |  | API Gateway | -----------------------> | Order Svc    |  |
               |  +------+------+                          +---+------+---+  |
               |         |                                     |      |      |
               |         | W3C TraceContext                    |      |      |
               |         v                                     v      v      |
               |  +---------------+      +-----------------------+  +----+   |
               |  | Inventory Svc |      | Payment Service       |  | DB |   |
               |  +---------------+      +-----------------------+  +----+   |
               +-------------------------------------------------------------+
                                              |
                          +-------------------+-------------------+
                          | Direct HTTPS OTLP                     | Local OTLP
                          v                                       v
               +----------------------+                +----------------------+
               |    Grafana Cloud     |                |     OTel Collector   |
               |  (Restricted Hosts)  |                |    (Local / Docker)  |
               |  - OTLP Gateway      |                |  - Ports 4318 / 4317 |
               |  - Hosted Mimir      |                |  - Prometheus Scrape |
               |  - Hosted Tempo      |                |  - Jaeger gRPC       |
               +----------+-----------+                +----------+-----------+
                          |                                       |
                          +-------------------+-------------------+
                                              |
                                              v
               +-------------------------------------------------------------+
               |                      IncidentGraph AI                       |
               |                                                             |
               |  Telemetry Provider Interface:                              |
               |  - PrometheusClient (Grafana Cloud Mimir / Local PromQL)    |
               |  - JaegerClient (Grafana Cloud Tempo / Local Jaeger API)    |
               |  - TelemetryManager (SIMULATION vs REAL mode toggle)        |
               |                                                             |
               |  Detection & Root-Cause Pipeline:                           |
               |  - RuleDetector (Latency breach, error rates, cooldowns)    |
               |  - RealRootCauseEngine (Topology BFS + span bottlenecks)    |
               |                                                             |
               |  Operator Presentation Layer:                               |
               |  - Real-time Service Map with freshness & cloud badge       |
               |  - Trace Investigation Waterfall (/traces & /traces/:id)    |
               |  - Evidence-backed Incident Detail view                     |
               +-------------------------------------------------------------+
```

---

## 2. Sample Microservices Mesh

The sample microservices system runs independently from the IncidentGraph control plane and models an e-commerce order fulfillment platform.

### Service Inventory

1. **API Gateway (`gateway/server.ts`, Port 4000):**
   - Entry point for ingress traffic.
   - Routes `/api/orders` to Order Service and `/api/inventory/:sku` to Inventory Service.
   - Creates root spans for ingress calls and injects W3C `traceparent` headers into downstream requests.

2. **Order Service (`order/server.ts`, Port 4001):**
   - Orchestrates multi-service order processing.
   - Flow: Validates order $\rightarrow$ reserves stock via Inventory Service $\rightarrow$ authorizes payment via Payment Service $\rightarrow$ writes confirmed order to PostgreSQL.
   - Propagates trace context across all child HTTP and DB operations.

3. **Payment Service (`payment/server.ts`, Port 4002):**
   - Simulates card payment authorization with risk assessment.
   - Supports deterministic, safe local execution (no live payment providers).
   - Records transaction records into PostgreSQL.

4. **Inventory Service (`inventory/server.ts`, Port 4003):**
   - Manages stock levels (`ITEM-101`, `ITEM-102`, `ITEM-103`).
   - Supports SKU lookups and atomic stock reservations in PostgreSQL.

5. **PostgreSQL Client Simulation (`shared/database.ts`):**
   - Simulates connection pooling, query executions, and schema tables (`orders`, `inventory_items`, `payment_logs`).
   - Generates dedicated OpenTelemetry DB client spans (`db.system: postgresql`, `db.operation`, `db.statement`).
   - Exposes dynamic fault injection (`latencyMs`, `failureRate`) for reproducible chaos experiments.

---

## 3. OpenTelemetry Instrumentation

All services utilize the official `@opentelemetry/sdk-node` and `@opentelemetry/api` packages configured via `sample-services/shared/telemetry.ts`.

### Distributed Traces
- **W3C TraceContext Propagation:** Every outgoing HTTP request calls `injectTraceContext()` to serialize `traceparent: 00-{traceId}-{spanId}-{flags}` headers. Every incoming request calls `extractTraceContext()` to restore span parentage.
- **Span Hierarchy:**
  ```text
  [api-gateway] POST /api/orders (duration: 38ms)
     └── [order-service] POST /orders (duration: 35ms)
            ├── [inventory-service] POST /reserve (duration: 10ms)
            │      └── [sample-postgres] UPDATE inventory_items (duration: 8ms)
            ├── [payment-service] POST /authorize (duration: 12ms)
            │      └── [sample-postgres] INSERT INTO payment_logs (duration: 9ms)
            └── [sample-postgres] INSERT INTO orders (duration: 6ms)
  ```
- **Semantic Conventions:** Spans follow OpenTelemetry conventions (`http.method`, `http.status_code`, `http.url`, `db.system`, `db.operation`).
- **Privacy & Redaction:** Sensitive attributes (credit cards, PII, user passwords) are strictly excluded from span tags.

### Metric Instruments
- `http_requests_total` (Counter): Total incoming HTTP requests partitioned by `service`, `method`, `route`, and `status`.
- `http_request_errors_total` (Counter): Total HTTP 5xx failures.
- `http_request_duration_seconds` (Histogram): Request latency distribution across standard Prometheus buckets (`0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0`).
- `db_operation_duration_seconds` (Histogram): Database execution latency per table and operation.

### Correlated Structured Logging
Structured JSON logs include active trace identifiers:
```json
{
  "timestamp": "2026-10-12T20:27:14.353Z",
  "level": "info",
  "serviceName": "order-service",
  "traceId": "01b976023356f63fe9e383b691ca1071",
  "spanId": "4a16b94fbd1f7f64",
  "message": "Order created and confirmed successfully",
  "dbDuration": 15
}
```

---

## 4. OpenTelemetry Collector & Observability Backends

### Collector Configuration (`docker/otel-collector-config.yaml`)
- **Receivers:**
  - OTLP gRPC on `0.0.0.0:4317`
  - OTLP HTTP on `0.0.0.0:4318`
- **Processors:**
  - `memory_limiter`: Prevents OOM by dropping or throttling traffic if Collector usage exceeds 80% (limit: 512MiB).
  - `batch`: Aggregates spans and metric samples into 200ms or 8192-item batches.
- **Exporters:**
  - `prometheus`: Serves metric scrape endpoint on `0.0.0.0:8889`.
  - `otlp/jaeger`: Pushes trace spans via gRPC to Jaeger `jaeger:4317`.

### Observability Backends
- **Prometheus (`docker/prometheus.yml`, Port 9090):**
  - Scrapes OTel Collector on `otel-collector:8889` every 5 seconds.
  - Exposes standard PromQL API at `http://localhost:9090/api/v1/query`.
- **Jaeger (Port 16686 / 4317):**
  - Ingests distributed traces from Collector.
  - Exposes trace query API at `http://localhost:16686/api/traces`.
- **Host Fallback (`sample-services/mock-observability.ts`):**
  - For environments without Docker, a lightweight zero-dependency Node.js server serves genuine OTLP HTTP (4318), Prometheus PromQL (9090), and Jaeger traces (16686) so the pipeline runs identically.

---

## 5. Dual-Mode Telemetry Architecture

IncidentGraph AI maintains a strict separation between simulated and real telemetry.

```text
                           +----------------------+
                           |   Operator Toggle    |
                           +----------+-----------+
                                      |
                     +----------------+----------------+
                     |                                 |
                     v                                 v
        [SIMULATION MODE]                       [REAL TELEMETRY MODE]
        - Driven by SQLite seed data            - Driven by Prometheus & Jaeger
        - Deterministic failure steps           - Real OTel metrics & traces
        - In-memory cascade simulator           - Offline states if backend down
        - Synthetic scenarios                   - Discovers unmapped services
```

### Telemetry Provider Interface (`src/lib/telemetry/telemetryManager.ts`)
- `getMode()` / `setMode('SIMULATION' | 'REAL')`
- `getRealTelemetryOverview()`: Fetches Prometheus health, rate, and latency metrics; falls back gracefully with explicit `isBackendAvailable: false` if backends are unreachable.
- `getTraces(options)`: Fetches traces from Jaeger, reconstructs parent-child trees, and identifies root-cause candidates based on span error status.
- `getTraceById(traceId)`: Fetches trace details and produces waterfall tree nodes for UI inspection.

---

## 6. Real Incident Detection & Anti-Flapping

The `RuleDetector` (`src/lib/detection/ruleDetector.ts`) analyzes normalized live telemetry against configurable SRE thresholds:

1. **Elevated Error Rate:** Triggers when `errorRate > 0.05` (5% error rate).
2. **Excessive Latency:** Triggers when `p95LatencyMs > 500ms` or `p99LatencyMs > 1000ms`.
3. **Repeated Downstream Timeouts:** Triggers on observed HTTP 504 Gateway Timeouts.
4. **Anti-Flapping Cooldown:**
   - Enforces a 60-second cooldown per `serviceId:ruleName` key.
   - Prevents duplicate incidents from flooding the dashboard during a sustained incident.
   - Auto-resolves incidents when observed metrics return below thresholds for more than 2 consecutive check intervals.

---

## 7. Evidence-Based Root Cause Analysis

The `RealRootCauseEngine` (`src/lib/algorithms/realRootCauseEngine.ts`) discovers originating failures using observed runtime telemetry, graph topology, and span traces—**without ever reading internal test scenario metadata**.

### Scoring Algorithm
$$Score(S) = W_{health} \cdot S_{health} + W_{latency} \cdot S_{latency} + W_{error} \cdot S_{error} + W_{trace} \cdot S_{trace} + W_{depth} \cdot S_{depth} - Penalties$$

- **$S_{trace}$ (Span Bottleneck Score):** If distributed trace waterfall analysis indicates that an innermost downstream span (e.g., PostgreSQL query) failed or consumed $>80\%$ of total trace duration, the corresponding service is prioritized.
- **$S_{depth}$ (Topological Precedence):** In dependency chain $A \rightarrow B \rightarrow C$, Service $C$ is deepest. If both $A$ and $C$ exhibit errors, $C$ receives higher priority because $A$'s error is likely a cascading symptom of $C$'s failure.
- **Zero Scenario Leakage:** The engine evaluates only:
  1. Observed error counts & latency deltas.
  2. Span hierarchy and duration distribution.
  3. Topological reachability in the service graph.

---

## 8. Failure Experiments & Recovery

Four controlled experiments demonstrate observable failure and automated recovery:

| Scenario ID | Injected Fault | Primary Service Affected | Dependent Impact | Observable Evidence |
|---|---|---|---|---|
| `db-slowdown` | 800ms query latency on Postgres | `sample-postgres` | Order Service, Gateway | Gateway latency $>850$ms, DB spans $>800$ms |
| `downstream-timeout` | 1500ms latency on Inventory | `inventory-service` | Order Service | Order Service HTTP 504 timeouts |
| `payment-errors` | 100% failure rate on Payment | `payment-service` | Order Service | Payment 500 Internal Error, Order cancellation |
| `baseline` | 0ms added delay, 0% errors | None | Fleet healthy | All services return HTTP 200, latency $<50$ms |

Faults are triggered via `POST /api/experiments/trigger` and restored cleanly via the same endpoint with `scenario: "baseline"`.
