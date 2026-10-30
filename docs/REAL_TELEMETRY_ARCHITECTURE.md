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
               |  - PrometheusClient (Instant & bounded range PromQL)        |
               |  - JaegerClient (Tempo v1/v2 OTLP & search, span tree)      |
               |                                                             |
               |  Normalization Layer (Strict Zod Validation):               |
               |  - NormalizedMetricRecord (service, metricType, timestamp)  |
               |  - NormalizedTraceSpan (traceId, spanId, parent, depth)     |
               |  - NormalizedTelemetryBatch (metrics, spans, diagnostics)   |
               |                                                             |
               |  Truthful Mode Routing (TelemetryManager):                  |
               |  - SIMULATION: Replayed / generated demonstration data      |
               |  - LIVE: Valid telemetry retrieved from providers          |
               |  - DEGRADED: Configured backends unreachable / empty data   |
               |                                                             |
               |  Multi-Service Root Cause Engine:                           |
               |  - DirectedGraph (topological traversal, reverse edges)     |
               |  - SlidingWindowAnalyzer (temporal anomaly precedence)      |
               |  - Trace Evidence Correlator (leaf span error & duration)   |
               |  - PriorityQueue ranking & blast radius BFS calculation     |
               +-------------------------------------------------------------+
```

---

## 2. Ingestion Providers & Mathematical Semantics

### A. Prometheus / Grafana Cloud Metrics Adapter (`PrometheusClient`)
- **Supported Backends:** Local Prometheus, Docker Compose stack, Grafana Cloud hosted Mimir.
- **Metric Mathematics & Semantic Normalization:**
  - **Latency Normalization (Seconds to Milliseconds):** Prometheus standard metric `http_request_duration_seconds` reports values in seconds. The normalization layer consistently multiplies values by `1000` to convert to milliseconds with unit `"ms"`. For example, `0.045` seconds is converted to `45.00` milliseconds.
  - **Histogram Average Latency:** When histogram data is queried, average latency is derived from the windowed rate of sums divided by the windowed rate of counts:
    $$\text{Average Latency (ms)} = \left(\frac{\text{rate}(http\_request\_duration\_seconds\_sum[1m])}{\text{rate}(http\_request\_duration\_seconds\_count[1m])}\right) \times 1000$$
    If request count rate is 0, average latency evaluates safely to 0 ms.
  - **P95 Latency:** Derived via `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[1m])) by (le, service))` with values converted from seconds to ms.
  - **Request Rate:** Evaluated using `sum(rate(http_requests_total[1m])) by (service)` and normalized to requests per second (`req/s`).
  - **Error Rate Percentage:** Evaluated as the ratio of error rate to total request rate multiplied by 100:
    $$\text{Error Rate (\%)} = \left(\frac{\text{rate}(http\_request\_errors\_total[1m])}{\text{rate}(http\_requests\_total[1m])}\right) \times 100$$
    If total request rate is 0, the error rate is safely returned as `0.0%` (avoiding `NaN` or division-by-zero errors). Raw counter totals are never confused with instantaneous percentages.
- **Bounded Range Queries (`/api/v1/query_range`):**
  - Explicit parameter validation: `startSec < endSec`, `stepSec > 0`.
  - Lookback safety bound: `(endSec - startSec) <= 86400` (max 24 hours).
  - Point count safety limit: `Math.floor((endSec - startSec) / stepSec) <= 11000` data points.
  - Time-bounded execution: The request timeout covers both HTTP header arrival and complete JSON response body parsing (`res.json()`). Abort timeouts during body streaming are correctly classified as `TIMEOUT` rather than `MALFORMED_RESPONSE`.
- **Diagnostic Error Categorization:**
  - `AUTH_FAILURE` (HTTP 401/403)
  - `RATE_LIMITED` (HTTP 429)
  - `TIMEOUT` (AbortController deadline breach during fetch or body stream)
  - `UNAVAILABLE` (HTTP 500/502/503/network disconnect)
  - `BAD_REQUEST` (HTTP 400 or invalid range query bounds)
  - `MALFORMED_RESPONSE` (invalid payload syntax)
- **Zero Credential Exposure:** Authorization headers and tokens are never printed in logs, UI responses, or diagnostic messages.

### B. Grafana Tempo / Distributed Traces Adapter (`JaegerClient`)
- **Supported Backends:** Local Jaeger, OpenTelemetry Collector trace exporter, Grafana Cloud Tempo (search API and OTLP v2 batch endpoints).
- **Span Hierarchy & Depth Calculation:**
  - Full parent-child relationship graph reconstruction via `spanMap`.
  - Roots identified as spans having no `parentSpanId` or whose `parentSpanId` does not exist in the trace.
  - Recursive tree depth assignment:
    - Root span: `depth = 0`
    - Immediate child: `depth = 1`
    - Grandchild: `depth = 2`
    - Leaf / database call: `depth = 3` (e.g., `api-gateway (0) -> order-service (1) -> payment-service (2) -> postgres-db (3)`).
  - Missing-parent resilience: Missing parents are safely treated as candidate roots with `depth = 0` without crashing.
  - Cycle detection: Visited set tracking prevents stack overflow / infinite recursion if malformed trace spans contain circular parent references.
  - Error identification: Spans with status code `ERROR` (or OTLP status code 2) retain error flags and descriptive error messages.

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
   - `depth`: Accurately calculated hierarchical tree depth (0 for root)

3. **`NormalizedTelemetryBatch`:**
   - Contains `batchId`, `collectedAt`, active `mode`, `metrics[]`, `spans[]`, and `diagnostics[]`.

---

## 4. Truthful Telemetry Mode Selection

The `TelemetryManager` strictly enforces truthful mode selection:

| Mode | Condition | Behavior |
|---|---|---|
| **`SIMULATION`** | Explicitly selected by operator. | Deterministic simulated telemetry generated from database scenarios. No external network queries dispatched. |
| **`LIVE`** | Required providers are configured AND queries succeed AND return non-empty verified telemetry records. | Live metrics and traces are ingested. `lastIngestedAt` timestamp is updated to current ISO time. |
| **`DEGRADED`** | Live mode was requested, but one or more required providers failed, returned errors, or returned empty matching series. | Services report `UNKNOWN` or degraded status. `lastIngestedAt` is NOT updated. **Never silently falls back to simulation data while claiming to be live.** |

### Ingestion Validation Decision Rules
- **Connectivity Probes Are Insufficient:** A successful health check probe (e.g. `up` or `vector(1)`) alone does NOT transition the system to `LIVE`. Only successful retrieval of actual metric points and spans establishes `LIVE` mode.
- **Empty Query Result Semantics:** If queries succeed but return zero matching series (`data.result: []`), the system enters `DEGRADED` mode with status `UNKNOWN` (`"Empty query response (No series matching)"`). It does not invent synthetic metrics.
- **Partial Failure:** If Prometheus succeeds but Tempo fails (or vice versa), the system truthfully reports `DEGRADED`.
- **Freshness Assurance:** `lastIngestedAt` updates only on validated live cycles.

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
2. **Fault Onset at PostgreSQL (Step 4):** Database connection contention causes DB query latency to surge to 1850ms.
3. **Cascading Propagation (Step 5):** Payment Service stalls waiting for DB (latency 1950ms, 14% errors). Order Service checkout requests timeout waiting for Payment (latency 2100ms, 22% errors).
4. **Peak Blast Radius (Step 6):** API Gateway breaches timeout threshold (latency 2250ms, 32% errors, HTTP 504 Gateway Timeout). Failure trace captures the 4-tier propagation waterfall down to the PostgreSQL lock contention span.
5. **Recovery Period (Steps 7–8):** DB pool contention clears, and upstream services recover sequentially.

### Root-Cause Ranking & Evidence Attribution
- **Derivation:** The `RootCauseEngine` identifies `postgres-db` as the #1 candidate using temporal onset precedence (step 4 vs 5/6) and deepest dependency position.
- **Blast Radius:** Correctly computes affected dependents count (3 services impacted upstream).
- **Inconclusive Handling:** When fed telemetry with healthy baselines or no detectable anomalies, the engine returns `isConclusive: false` and `topRootCause: null`.

---

## 6. Implementation & Verification Status Matrix

To maintain total documentation integrity, the capabilities of IncidentGraph AI are explicitly distinguished across four validation tiers:

| Component / Feature | Implemented in Code | Mock-Tested in CI | Live Provider Verified | Remaining Configuration |
|---|:---:|:---:|:---:|---|
| **Prometheus Instant Adapter** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Set `GRAFANA_CLOUD_PROMETHEUS_TOKEN` |
| **Prometheus Bounded Range Query** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Max lookback 24h & 11k point bounds |
| **Seconds-to-Milliseconds Conversion** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Normalizes `0.045s -> 45ms` |
| **Histogram Avg & P95 Derivation** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | `rate(_sum)/rate(_count)*1000` |
| **Request Counter Rate Math** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | `rate(http_requests_total[1m])` |
| **Error Rate % Safe Denominator** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | `(rate(errors)/rate(requests))*100` |
| **Tempo OTLP v2 Hierarchy Parser** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Set `GRAFANA_CLOUD_TEMPO_TOKEN` |
| **Recursive Span Depth (0 to 3+)** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Cycle-safe DFS with visited set |
| **Truthful Mode (LIVE vs DEGRADED)** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Requires both providers & non-empty data |
| **Sample Microservice Stack** | ✅ Yes | ✅ Yes (E2E Test) | N/A (Local In-Memory / Docker) | Express HTTP & OpenTelemetry instrumentation |

> [!NOTE]
> Live end-to-end verification against external Grafana Cloud hosted infrastructure requires genuine cloud API tokens (`metrics:read` and `traces:read`). When running in CI or offline developer workstations without external credentials, the entire test suite executes deterministically against rigorous mocked provider responses with zero network leakage.

---

## 7. Supported Environment Variables

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

## 8. Verification & Testing

The telemetry suite includes deterministic mocked provider tests, normalization validation, multi-service incident evaluations, and mode transitions that run without external network dependencies:

```bash
# Run the dedicated live telemetry test suite
npx vitest run tests/live-telemetry.test.ts

# Run the complete test suite (108 tests across 8 suites)
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
