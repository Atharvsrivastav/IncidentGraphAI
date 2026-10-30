# IncidentGraph AI — Real Telemetry Architecture & Multi-Service RCA

## 1. Executive Summary & Telemetry Pipeline

IncidentGraph AI incorporates a production-minded, read-only telemetry ingestion pipeline capable of consuming actual telemetry from Prometheus/Mimir and Grafana Tempo backends, normalizing disparate schemas into a validated unified structure, connecting evidence to the service dependency graph, and deriving explainable root-cause rankings.

### End-to-End Ingestion & RCA Pipeline

```text
               +-------------------------------------------------------------+
               |               Sample Microservices Ecosystem                |
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
               |  - Hosted Mimir      |                |    (Local / Docker)  |
               |  - Hosted Tempo      |                |  - Prometheus Scrape |
               |  - OTLP Gateway      |                |  - Jaeger gRPC       |
               +----------+-----------+                +----------+-----------+
                          |                                       |
                          +-------------------+-------------------+
                                              |
                                              v
               +-------------------------------------------------------------+
               |             IncidentGraph AI Ingestion Pipeline             |
               |                                                             |
               |  Provider Adapters (Read-Only):                             |
               |  - PrometheusClient (Instant & range PromQL, timeout-bound) |
               |  - JaegerClient (Tempo v1/v2 OTLP & search, span tree)      |
               |                                                             |
               |  Normalization Layer (Strict Zod Validation):               |
               |  - NormalizedMetricRecord (service, metricType, timestamp)  |
               |  - NormalizedTraceSpan (traceId, spanId, parent, depth)     |
               |  - NormalizedTelemetryBatch (metrics, spans, diagnostics)   |
               |                                                             |
               |  Telemetry Mode Routing (TelemetryManager):                 |
               |  - SIMULATION: Replayed / generated demonstration data      |
               |  - LIVE: Successfully retrieved telemetry from backends     |
               |  - DEGRADED: Configured backends unreachable / partial      |
               |                                                             |
               |  Multi-Service Root Cause Engine:                           |
               |  - DirectedGraph (topological traversal, reverse edges)     |
               |  - SlidingWindowAnalyzer (temporal anomaly precedence)      |
               |  - Trace Evidence Correlator (leaf span error & duration)   |
               |  - PriorityQueue ranking & blast radius BFS calculation     |
               +-------------------------------------------------------------+
```

---

## 2. Ingestion Providers & Read-Only Connectivity

### A. Prometheus / Grafana Cloud Metrics Adapter (`PrometheusClient`)
- **Supported Backends:** Local Prometheus, Docker Compose stack, Grafana Cloud hosted Mimir.
- **Capabilities:**
  - Time-bounded queries with configurable timeout (`TELEMETRY_QUERY_TIMEOUT_MS`, default 4000ms).
  - Retrieves service metrics: Request Rate (`http_requests_total`), Error Rate (`http_request_errors_total`), Average / P95 Latency (`http_request_duration_seconds`), CPU utilization, Memory utilization, Database connection contention.
  - Safe diagnostics with typed error categorization:
    - `AUTH_FAILURE` (HTTP 401/403)
    - `RATE_LIMITED` (HTTP 429)
    - `TIMEOUT` (AbortController deadline breach)
    - `UNAVAILABLE` (HTTP 500/502/503/network disconnect)
    - `MALFORMED_RESPONSE` (invalid payload syntax)
  - Zero credential exposure: Authorization headers and tokens are never printed in logs, UI responses, or error strings.

### B. Grafana Tempo / Distributed Traces Adapter (`JaegerClient`)
- **Supported Backends:** Local Jaeger, OpenTelemetry Collector trace exporter, Grafana Cloud Tempo (v1 search and v2 OTLP batches).
- **Capabilities:**
  - Trace search by service name with bounded query limit.
  - OTLP batch detail parsing (`batches`, `resourceSpans`, `scopeSpans`) into `DistributedTrace` and `NormalizedTraceSpan[]`.
  - Span parent-child hierarchy reconstruction and depth assignment.
  - Error identification (`statusCode === "ERROR"`, status code 2, error tags).
  - Duration calculation from start/end unix timestamps.

---

## 3. Telemetry Normalization Model

All incoming telemetry passes through runtime Zod schema validation defined in `src/lib/telemetry/normalization.ts`:

1. **`NormalizedMetricRecord`:**
   - `id`: Unique record identifier
   - `provider`: `"PROMETHEUS" | "GRAFANA_CLOUD" | "MOCK_EMULATION" | "SIMULATION"`
   - `serviceName`: String matching topology node or flagged as unmapped
   - `metricType`: `"REQUEST_RATE" | "ERROR_RATE" | "LATENCY_P95" | "LATENCY_AVG" | "CPU_UTILIZATION" | "MEMORY_UTILIZATION" | "DB_CONNECTION_PRESSURE" | "CUSTOM"`
   - `metricName`: Underlying query string
   - `timestamp`: ISO-8601 string
   - `value`: Number
   - `unit`: `"ms" | "%" | "req/s" | "connections" | "count"`
   - `labels`: Key-value attribute dictionary
   - `hasAnomaly`: Boolean threshold flag

2. **`NormalizedTraceSpan`:**
   - `traceId`, `spanId`, `parentSpanId`: W3C trace identifiers
   - `serviceName`, `operationName`: Service and HTTP/DB operation
   - `startTimeIso`: ISO-8601 start timestamp
   - `durationMs`: Span execution duration
   - `statusCode`: `"OK" | "ERROR" | "UNSET"`
   - `errorMessage`: Optional error string
   - `attributes`: Typed attributes dictionary
   - `childSpanIds`: IDs of immediate child spans
   - `depth`: Tree depth (0 for root)

3. **`NormalizedTelemetryBatch`:**
   - Contains `batchId`, `collectedAt`, active `mode`, `metrics[]`, `spans[]`, and `diagnostics[]`.

---

## 4. Truthful Telemetry Modes & State Management

The `TelemetryManager` enforces three distinct modes:

| Mode | Condition | Behavior |
|---|---|---|
| **`SIMULATION`** | Explicitly set by operator or default demo state. | Telemetry is generated or replayed from deterministic database scenarios. No external network requests are dispatched. |
| **`LIVE`** | Configured backends are healthy and successfully responding. | Real metrics and traces are ingested. `lastIngestedAt` timestamp is updated on each successful collection cycle. |
| **`DEGRADED`** | Live mode is requested, but backends are unreachable, return errors, or lack credentials. | Telemetry status is reported as `UNKNOWN` or degraded. **Never silently falls back to simulation data while claiming to be live.** |

### Mode Transition Rules
- Missing credentials never imply live mode.
- A passing health probe alone does not imply successful ingestion; ingestion must yield verified metric/trace samples.
- The legacy `"REAL"` mode identifier is preserved as an alias mapping to `"LIVE"` for backward API compatibility.

---

## 5. Multi-Service Incident Validation Scenario

The deterministic multi-service incident scenario (`src/lib/telemetry/multiServiceIncident.ts`) provides a reproducible benchmark topology:

```text
API Gateway (Tier 1)
       │ (SYNC_HTTP, timeout: 2000ms)
       ▼
Order Service (Tier 2)
       │ (SYNC_HTTP, timeout: 2000ms)
       ▼
Payment Service (Tier 3)
       │ (DATABASE_CONN, timeout: 1500ms)
       ▼
PostgreSQL Database (Tier 4)
```

### Incident Timeline Phases
1. **Healthy Baseline (Steps 1–3):** All services report nominal latencies (DB: 12ms, Payment: 45ms, Order: 35ms, Gateway: 15ms) and 0% errors. Traces succeed in <50ms.
2. **Fault Onset at PostgreSQL (Step 4):** Database connection contention causes DB query latency to surge to 1850ms. Dependent services remain temporarily within baseline before downstream buffers fill.
3. **Cascading Propagation (Step 5):** Payment Service stalls waiting for DB (latency 1950ms, 14% errors). Order Service checkout requests timeout waiting for Payment (latency 2100ms, 22% errors).
4. **Peak Blast Radius (Step 6):** API Gateway breaches timeout threshold (latency 2250ms, 32% errors, HTTP 504 Gateway Timeout). Failure trace waterfall captures the full failure chain from Gateway down to the PostgreSQL lock contention span.
5. **Recovery Period (Steps 7–8):** DB pool contention clears (latency returns to 12ms), and upstream services recover sequentially.

### Root-Cause Ranking & Evidence Attribution
- **Derivation:** The `RootCauseEngine` derives `postgres-db` as the #1 candidate using temporal onset precedence (step 4 vs 5/6) and deepest dependency position.
- **Blast Radius:** Correctly computes affected dependents count (3 services impacted upstream).
- **Inconclusive Handling:** When fed telemetry with healthy baselines or no detectable anomalies, the engine returns `isConclusive: false` and `topRootCause: null`.

---

## 6. Supported Environment Variables

All telemetry provider credentials remain strictly server-side:

| Variable Name | Required For | Description |
|---|---|---|
| `GRAFANA_CLOUD_PROMETHEUS_URL` | Grafana Cloud | HTTPS PromQL endpoint (e.g. `https://prometheus-prod-....grafana.net/api/prom`) |
| `GRAFANA_CLOUD_PROMETHEUS_USER` | Grafana Cloud | Numeric instance ID / username |
| `GRAFANA_CLOUD_PROMETHEUS_TOKEN` | Grafana Cloud | Read-only Grafana Cloud API token with `metrics:read` scope |
| `GRAFANA_CLOUD_TEMPO_URL` | Grafana Cloud | HTTPS Tempo endpoint (e.g. `https://tempo-prod-....grafana.net`) |
| `GRAFANA_CLOUD_TEMPO_USER` | Grafana Cloud | Numeric instance ID / username |
| `GRAFANA_CLOUD_TEMPO_TOKEN` | Grafana Cloud | Read-only Grafana Cloud API token with `traces:read` scope |
| `PROMETHEUS_URL` | Local Dev | Self-hosted Prometheus base URL (default: `http://localhost:9090`) |
| `JAEGER_URL` | Local Dev | Self-hosted Jaeger UI/API base URL (default: `http://localhost:16686`) |
| `TELEMETRY_QUERY_TIMEOUT_MS` | Optional | Query timeout limit in milliseconds (default: `4000`) |

> [!IMPORTANT]
> Never commit actual tokens or credentials to source control. Ingestion requires only read permissions (`metrics:read` and `traces:read`).

---

## 7. Verification & Testing

The telemetry suite includes deterministic mocked provider tests, normalization validation, multi-service incident evaluations, and mode transitions that run without external network dependencies:

```bash
# Run the dedicated live telemetry test suite
npx vitest run tests/live-telemetry.test.ts

# Run the complete test suite (98 tests across 8 suites)
npm test

# Run the algorithmic benchmark suite (22 tests)
npm run test:benchmark

# Verify TypeScript type safety
npx tsc --noEmit

# Verify linting
npm run lint

# Verify production build
npm run build
```

---

## 8. Known Limitations & Scope Boundaries

1. **Read-Only Ingestion:** IncidentGraph AI does not modify, write to, or configure external Grafana Cloud or Prometheus dashboards. It strictly reads telemetry through standardized PromQL and trace query APIs.
2. **Clock Drift:** When correlating timestamps across disparate microservices in live mode, systems must synchronize clocks via NTP; large clock skew (>500ms) may affect sliding window temporal precedence calculations.
3. **External Infrastructure Dependency:** Full end-to-end live testing with real Grafana Cloud endpoints requires valid user-supplied credentials. When credentials are not supplied, the application operates deterministically in simulation mode or safely reports degraded status without crashing or fabricating data.
