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
  - **Zero Raw Counter Fallback Policy:** The client strictly queries rate expressions (`rate(...[1m])`). It never falls back to raw cumulative counter values (`http_requests_total` or `http_request_errors_total`) or unaggregated base metrics. If rate queries fail or return no series, the missing-data state is preserved and an error diagnostic is emitted. Cumulative counters are never silently converted into rates or percentages.
  - **Strict Multi-Query Diagnostics:**
    - Every required metric query (`REQUEST_RATE`, `ERROR_THROUGHPUT`, `LATENCY_AVG`, `LATENCY_P95`) is tracked independently.
    - If any required query encounters an HTTP error, timeout, or network failure, overall collection reports `success: false` without silently defaulting missing metrics to zero.
    - Failed queries are cleanly distinguished from successful queries returning no matching series (HTTP 200 with empty vector).
    - Provider failures for P95 (HTTP 500, timeout) strictly cause `success: false`. Genuine absence of histogram buckets (HTTP 200 with empty series) safely sets `p95Supported: false` while allowing overall collection to succeed if other required metrics pass.
  - **Semantic Separation of Error Throughput and Error Percentage:**
    - Raw error throughput from `rate(http_request_errors_total[1m])` is normalized as `metricType: "ERROR_THROUGHPUT"` with unit `"errors/s"`. Raw throughput is never labeled as a percentage.
    - Calculated error rate records are generated by correlating request rate and error throughput points matching on `(serviceName, timestamp)`:
      $$\text{errorPercentage} = \frac{\text{errorRequestsPerSecond}}{\text{totalRequestsPerSecond}} \times 100$$
    - Normalized records with `metricType: "ERROR_RATE"` carry unit `"%"` and are returned in `NormalizedTelemetryBatch.metrics`.
    - Zero request volume is handled safely without producing `NaN` or `Infinity` (defaults to `0.0%`).
  - **Full Numeric Precision (No Premature Request-Rate Rounding):**
    - Request rates retain full IEEE-754 double precision internally and are never rounded via `Math.round()` prior to division or aggregation.
    - Low-volume traffic (e.g. 0.4 req/s with 0.1 errors/s) produces exact error percentages (25%) rather than rounding 0.4 to 0 and dropping the outage signal.
  - **Fixed 60-Second PromQL Range Lookback Window (`evaluateMockPromQlRange`):**
    - The range vector `[1m]` strictly enforces an exact 60-second observation lookback window $[t - 60\text{s}, t]$ and rate divisor $60$, regardless of the query evaluation `step` size.
    - Evaluated across query step sizes of 15s, 30s, 60s, and 120s: range step controls only the interval between matrix evaluation timestamps ($t_0, t_0 + \text{step}, \dots$), never the PromQL range-vector lookback window.
    - Instant queries (`/api/v1/query`) evaluate strictly within $[nowSec - 60, nowSec]$. If the current one-minute window is empty, queries return empty vectors (`result: []`) rather than recycling stale historical observations.
    - Stored observations maintain explicit timestamps and instance labels. Responses are clearly marked with provider `MOCK_EMULATION`.
  - **Strict Error Rate Matching & Missing-Series Handling:**
    - `metricType: "ERROR_RATE"` percentage records are generated *only* when both request-rate and error-rate observations exist for the exact service identity and timestamp AND total request rate is strictly positive (`reqPerSec > 0`).
    - Zero traffic (`reqPerSec === 0`) is preserved as an explicit no-traffic condition; it is never converted into a synthetic 0% "healthy" measurement.
    - Absent error metric series are distinguished from genuine 0% error conditions (when requests > 0 and errors = 0).
    - `metricType: "ERROR_THROUGHPUT"` is tracked independently with unit `"errors/s"`.
  - **Zero Database Baseline Manufacturing for Missing Metrics:**
    - Services with trace observations but absent Prometheus metrics are labeled `UNKNOWN` (`"Trace observations present, but metric telemetry missing"` with `source: "JAEGER"`, `latencyMs: 0`, and `isStale: true`).
    - The engine never manufactures healthy telemetry (e.g., 0% error rate or synthetic nominal latency) from topology database baselines.
  - **Histogram Average Latency:** Derived from the windowed rate of sums divided by the windowed rate of counts:
    $$\text{Average Latency (ms)} = \left(\frac{\text{sum by (service)} (\text{rate}(http\_request\_duration\_seconds\_sum[1m]))}{\text{sum by (service)} (\text{rate}(http\_request\_duration\_seconds\_count[1m]))}\right) \times 1000$$
    If request count rate is 0, average latency evaluates safely to 0 ms.
  - **Actual P95 Histogram Quantile & Bucket Consistency:**
    - Evaluated via:
      $$\text{histogram\_quantile}(0.95, \text{sum by (le, service)} (\text{rate}(http\_request\_duration\_seconds\_bucket[1m])))$$
    - The `le` bucket label is strictly preserved during aggregation. Seconds are normalized to milliseconds exactly once.
    - Multi-instance aggregation: Bucket counts are aggregated across instances before linear quantile interpolation is applied.
    - When histogram bucket series do not exist in the TSDB, `hasValidP95: false` is returned and P95 latency is left `undefined` rather than inventing an unverified estimate.
- **Temporally Meaningful Mock Range History (`evaluateMockPromQlRange`):**
  - Observations stored in `obsStore` maintain explicit timestamps, service identities, and instance labels (`${service}-inst-1` and `${service}-inst-2`).
  - Range queries (`/api/v1/query_range`) evaluate step windows $[t - stepSec, t]$ dynamically, returning changing values across time rather than cloning a single end-time snapshot across the matrix.
  - Cumulative histogram buckets are monotonically non-decreasing with `+Inf` containing all observations. P95 latency is calculated strictly via Prometheus-compatible histogram quantile linear interpolation from the exact bucket distribution.
  - If stored history is empty, range queries truthfully return an empty matrix (`result: []`) rather than inventing synthetic trends.
  - Unsupported expressions are rejected with HTTP 400 Bad Request.
- **Bounded Range Queries (`/api/v1/query_range`):**
  - Explicit finite numeric parameter validation: `Number.isFinite(startSec)`, `Number.isFinite(endSec)`, `Number.isFinite(stepSec)`.
  - Range bounds: `startSec < endSec`, `stepSec > 0`.
  - Lookback safety bound: `(endSec - startSec) <= 86400` (maximum 24 hours).
  - Point count inclusive endpoint limit: Standard Prometheus evaluation includes both endpoints:
    $$\text{Point Count} = \left\lfloor\frac{endSec - startSec}{stepSec}\right\rfloor + 1 \le 11000$$
    For instance, `start=0, end=11000, step=1` yields 11,001 points and is rejected with `BAD_REQUEST`.
  - Time-bounded execution: The request timeout covers both HTTP header arrival and complete JSON response body parsing (`res.json()`). Abort timeouts during body streaming are correctly classified as `TIMEOUT` rather than `MALFORMED_RESPONSE`.
  - Real Collection Path Integration: `getServiceMetricsHistory({ lookbackSec, stepSec })` queries all 4 key metric dimensions over time and populates historical matrix points into the normalized telemetry batch for temporal root-cause correlation.
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
- **Empty Trace Window Semantics:** An HTTP 200 response with `traces: []` indicates zero distributed traces were captured during the search window. This is treated as missing evidence and causes the pipeline to transition to `DEGRADED` mode rather than falsely certifying `LIVE` operation.

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
- **Empty Query Result Semantics:** If queries succeed but return zero matching series (`data.result: []`) or empty trace search windows (`traces: []`), the system enters `DEGRADED` mode with status `UNKNOWN` (`"Empty query response (No series matching)"`). It does not invent synthetic metrics.
- **Partial Failure:** If Prometheus succeeds but Tempo fails (or vice versa), the system truthfully reports `DEGRADED`.
- **Strict Simulation Isolation:** When mode is `SIMULATION`, the `TelemetryManager` executes zero external network requests (`fetch` calls) across all collection entry points (`getNormalizedBatch`, `getObservedServices`, `getRecentTraces`, `getTraceDetail`). Telemetry is derived deterministically from scenario models and marked with provider `"SIMULATION"`. `lastIngestedAt` is never updated during simulation.
- **Freshness Assurance:** `lastIngestedAt` updates only on fully validated live cycles where required metrics and distributed traces have been verified.

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

### Incident Timeline Phases (6-Step Cascading Recovery Scenario)
1. **Step 1 (t1 = now - 300s): Healthy Baseline (All Normal):** All four services report nominal latencies (`postgres-db`: 11ms, `payment-service`: 45ms, `order-service`: 35ms, `api-gateway`: 18ms) and 0% errors. Traces succeed in nominal time.
2. **Step 2 (t2 = now - 240s): Originating Fault Onset at PostgreSQL:** Database connection lock contention causes `postgres-db` query latency to surge to 1850ms (~168x baseline, 0% error rate). Upstream services remain nominal.
3. **Step 3 (t3 = now - 180s): Payment Contention Cascading:** Payment Service stalls waiting for DB (latency 1950ms, 15% errors). PostgreSQL remains elevated at 1900ms. Order and Gateway remain nominal.
4. **Step 4 (t4 = now - 120s): Order Checkout Timeout Surge:** Order Service checkout requests timeout waiting on Payment (latency 2100ms, 25% errors). Payment continues stalling (2000ms, 22% errors) and PostgreSQL remains high (1920ms).
5. **Step 5 (t5 = now - 60s): Peak Ingress Blast Radius at API Gateway:** API Gateway breaches ingress timeout threshold (latency 2250ms, 35% errors, HTTP 504 Gateway Timeout). Cascading failure spans all 4 tiers: Order (2150ms, 28% errors), Payment (1980ms, 25% errors), PostgreSQL (1900ms).
6. **Step 6 (t6 = now): System-wide Recovery & Post-Incident State:** Database pool contention clears, and all four services recover to baseline performance (`postgres-db`: 12ms, `payment-service`: 50ms, `order-service`: 40ms, `api-gateway`: 22ms, 0% errors). Current observed services at t6 truthfully report `HEALTHY` statuses and nominal latency/error metrics, matching the historical t6 sample without contradiction.

### Root-Cause Ranking & Evidence Attribution
- **Temporal Onset Precedence:** The `RootCauseEngine` identifies `postgres-db` as the #1 candidate using earliest abnormality onset precedence (detected at observation step 2, preceding dependent upstream services).
- **Post-Recovery Anomaly Identification:** Historical sliding-window anomaly evidence successfully identifies the originating cause even after services recover to nominal `HEALTHY` states, without false contradictory-status penalties.
- **Blast Radius & Topology:** Deepest dependency position explains cascading symptoms; upstream services (`payment-service`, `order-service`, `api-gateway`) are recognized as affected dependents rather than originating causes.
- **Persistence Verification:** Persisted `Incident` (`rootCauseStatus: "ANALYZED"`, `suspectedRootCauseId: "postgres-db"`) and `RootCauseCandidate` records (rank 1: `postgres-db`) match the engine's findings.
- **Inconclusive Handling:** When fed telemetry with healthy baselines or no confirmed metric anomalies, the engine returns `isConclusive: false` and `topRootCause: null`.

---

## 6. Implementation & Verification Status Matrix

To maintain total documentation integrity, the capabilities of IncidentGraph AI are explicitly distinguished across four validation tiers:

| Component / Feature | Implemented in Code | Mock-Tested in CI | Live Provider Verified | Remaining Configuration |
|---|:---:|:---:|:---:|---|
| **Prometheus Instant Adapter** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Set `GRAFANA_CLOUD_PROMETHEUS_TOKEN` |
| **Prometheus Bounded Range Query** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Max lookback 24h & 11k point bounds |
| **Seconds-to-Milliseconds Conversion** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Normalizes `0.045s -> 45ms` |
| **Histogram Avg & Sum/Count Derivation** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | `rate(_sum)/rate(_count)*1000` |
| **P95 Histogram Quantile Calculation** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | `histogram_quantile(0.95, rate(_bucket))` |
| **Multi-Instance Aggregation** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | PromQL `sum by (service)` & client accumulation |
| **Zero Raw Counter Fallback** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Rates preserved; missing data reported |
| **Strict Multi-Query Diagnostics** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | All required queries must succeed independently |
| **Error Throughput vs Rate Separation** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | `errors/s` throughput vs `%` percentage records |
| **Unrounded Request-Rate Precision** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Retains floating-point precision for low volume |
| **Temporally Meaningful Range History** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Dynamic step window aggregation over time |
| **Histogram Bucket & P95 Quantile Consistency**| ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Cumulative buckets + Prometheus quantile formula |
| **Partial Metric Validity Flags** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | `hasValidLatency` & `hasValidErrorRate` tracked independently |
| **Non-Diluting Sliding Window** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Averages computed over valid samples only |
| **Post-Recovery Root-Cause Analysis** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Detects historical root cause when current state is HEALTHY |
| **Tempo OTLP v2 Hierarchy Parser** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Set `GRAFANA_CLOUD_TEMPO_TOKEN` |
| **Recursive Span Depth (0 to 3+)** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Cycle-safe DFS with visited set |
| **Truthful Mode (LIVE vs DEGRADED)** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Requires both providers & non-empty data |
| **Strict Simulation Isolation** | ✅ Yes | ✅ Yes (Vitest) | N/A (Offline / In-Memory) | Zero fetch calls across all entry points |
| **Mock Observability Server** | ✅ Yes | ✅ Yes (Vitest) | N/A (In-Memory Emulation) | Explicit PromQL evaluator & per-second rates |
| **Historical Batch RCA Evidence** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | Feeds multi-step chronological samples to RCA engine |
| **Fixed 60s Range Lookback Window** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | 60s window across 15, 30, 60, 120s step queries |
| **Strict Missing-Metric Semantics** | ✅ Yes | ✅ Yes (Vitest) | ⚠️ Pending Real Cloud Creds | No fabricated healthy metrics; partial stays UNKNOWN |
| **Sample Microservice Stack** | ✅ Yes | ✅ Yes (E2E Test) | N/A (Local In-Memory / Docker) | Express HTTP & OpenTelemetry instrumentation |
| **React Flow State Synchronization** | ✅ Yes | ✅ Yes (Vitest) | N/A (Client-Side State) | Preserves user-dragged coordinates while updating node metrics |
| **Live / Degraded Service Map UI** | ✅ Yes | ✅ Yes (Vitest) | N/A (Client-Side Rendering) | Honest LIVE vs DEGRADED banners and UNKNOWN metric states |
| **Requested vs Effective Mode** | ✅ Yes | ✅ Yes (Vitest) | N/A (Operational State) | Separates requested mode from verified operational telemetry state |
| **Navigation Failure Guard** | ✅ Yes | ✅ Yes (Vitest) | N/A (Client-Side State) | Failed mode switches never set status to LIVE |
| **Mock Emulation Honest Attribution** | ✅ Yes | ✅ Yes (Vitest) | N/A (Client-Side UI) | Prominent MOCK EMULATION badge; never claims production status |
| **Unknown Services Metric Validity** | ✅ Yes | ✅ Yes (Vitest) | N/A (Client-Side UI) | Renders N/A for missing metrics, preserves genuine zeroes |

> [!NOTE]
> Live end-to-end verification against external Grafana Cloud hosted infrastructure requires genuine cloud API tokens (`metrics:read` and `traces:read`). When running in CI or offline developer workstations without external credentials, the entire test suite executes deterministically against rigorous mocked provider responses with zero network leakage. Genuine live Grafana Cloud validation remains pending configuration of production credentials.

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

The telemetry suite includes deterministic mocked provider tests, normalization validation, multi-service incident evaluations, mode transitions, and pure utility/state-logic tests that run without external network dependencies:

```bash
# Run the dedicated live telemetry test suite (63 tests)
npx vitest run tests/live-telemetry.test.ts

# Run the service map utility & state-logic unit test suite (42 tests)
npx vitest run tests/service-map-ui.test.ts

```bash
# Run the dedicated live telemetry test suite (63 tests)
npx vitest run tests/live-telemetry.test.ts

# Run the service map utility & state-logic unit test suite (42 tests)
npx vitest run tests/service-map-ui.test.ts

# Run the telemetry provenance & hardening test suite (47 tests)
npx vitest run tests/observability-provenance.test.ts

# Run the complete test suite (254 tests across 11 suites)
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

> [!NOTE]
> `tests/service-map-ui.test.ts` exercises pure data-transformation, metric-merging, React Flow node/edge builder functions, Navigation state handling, failed-request guard, mode transition logic, and AI telemetry provenance branching. It is strictly a pure utility and state-logic unit test suite and does not mount React DOM components or claim browser lifecycle execution. Dedicated browser automation scripts (`node tests/browser-e2e.mjs`) remain separate.

---

## 9. Telemetry Provenance & Live Observability Pipeline (Phase 2.2 Hardened)

### A. Five-State Telemetry Provenance Model

To eliminate ambiguity and prevent mock or local data from falsely claiming production verification, IncidentGraph AI enforces an explicit 5-state provenance model across the application:

| Provenance State | Meaning | Verification Criteria | Dashboard Indicator |
|---|---|---|---|
| **`LIVE`** | Genuine External Backend Ingestion | Both Prometheus query backend AND Tempo trace query backend are configured for Grafana Cloud (`bothAreCloud === true`), AND verified recent data (< 30m) matching monitored topology is retrieved. Direct OTLP exporter endpoints do not infer cloud query status. | Emerald badge (`PROVENANCE: LIVE (Grafana Cloud Verified)`) |
| **`MOCK_EMULATION`** | Development Synthetic Telemetry | Data generated by the in-process mock observability server (`sample-services/mock-observability.ts`). Clearly labeled as non-production emulation. | Purple badge (`PROVENANCE: MOCK_EMULATION (Synthetic)`) |
| **`LOCAL`** | Local Unverified Stack or Partial Cloud | Data emitted from local Prometheus and local Jaeger, or partial cloud configurations (e.g. only Prometheus is cloud while Tempo is local). Local query backends remain `LOCAL` even if direct OTLP exporters send to Grafana Cloud. | Blue badge (`PROVENANCE: LOCAL (Unverified)`) |
| **`DISABLED`** | Telemetry Ingestion Disabled | Application operates in isolated Simulation Mode with zero external network probes. | Slate badge (`PROVENANCE: DISABLED (Simulation)`) |
| **`ERROR`** | Telemetry Pipeline Degraded | Telemetry backends unreachable, authentication failed (HTTP 401/403), or one backend is failing in requested `LIVE` mode. | Rose/Amber badge (`PROVENANCE: ERROR (Degraded)`) |

### B. Strict Provenance Decoupling & Independent Provider Auditing

In Phase 2.2, telemetry provenance was strictly hardened against false `LIVE` assumptions:
1. **Independent Query Provider Resolution:** The manager derives cloud status directly from `prometheusClient.isCloudBackend()` and `jaegerClient.isCloudBackend()`. It never infers cloud query provenance from the presence of `GRAFANA_CLOUD_OTLP_ENDPOINT`.
2. **Local Remains Local:** When local Prometheus (`http://localhost:9090`) and local Jaeger (`http://localhost:16686`) are queried, provenance is strictly `LOCAL`, even if sample microservices are configured to export OTLP directly to Grafana Cloud.
3. **Partial Cloud Configurations:** If only one backend is configured for Grafana Cloud (e.g., Prometheus is cloud but Tempo is local, or vice versa), the system treats this as a partial cloud configuration and reports `provenance: "LOCAL"`, never `LIVE`.
4. **Mode Transition Resets:** On switching to `SIMULATION` or setting modes in `TelemetryManager.setMode()`, `lastVerifiedAt` and `lastIngestedAt` are immediately reset to `null`, ensuring unverified environments never default to `LIVE`.

### C. Dedicated Live Observability Smoke-Test (`npm run test:observability:live`)

Run the dedicated live smoke-test to verify end-to-end telemetry ingestion against configured external endpoints:

```bash
npm run test:observability:live
```

**Verification Architecture & Strict Rules:**
1. **Path A (Direct OTLP Metrics Ingestion):**
   - Generates a unique test counter `incidentgraph_live_verification_total` with `verification_id`.
   - Exports directly to Grafana Cloud OTLP HTTPS gateway (`/v1/metrics`).
   - Verifies ingestion by querying Grafana Cloud Prometheus via PromQL (`incidentgraph_live_verification_total{verification_id="..."}`) matching the exact verification ID, metric name, and value $\ge 1$.
2. **Path B (Prometheus Scrape -> Remote-Write Ingestion):**
   - Emits a unique synthetic metric via an actual running sample-service HTTP endpoint (`POST http://localhost:4001/test/record-metric`).
   - Confirms that the actual running service exposes the metric on its `/metrics` endpoint.
   - Independently detects and reports exact pipeline states:
     - **`Prometheus unavailable`**: Local Prometheus (`http://localhost:9090/-/healthy`) is unreachable.
     - **`Target not scraped`**: Local Prometheus is online, but the target scrape is down or the metric was not scraped within the polling window.
     - **`Local scrape succeeded`**: Local Prometheus PromQL query confirms scrape of the exact verification ID.
     - **`Remote-write not configured`**: Scrape succeeded, but remote-write URL or dedicated write credentials are not configured in environment.
     - **`Remote-write delivery failed`**: Remote-write is configured, but Grafana Cloud query failed with an HTTP error.
     - **`Remote-write delivery pending`**: Scraped locally, but remote-written sample has not yet propagated to Grafana Cloud TSDB.
     - **`External Grafana Cloud read-back confirmed`**: Exact verification ID, service name, and value confirmed in Grafana Cloud TSDB.
   - Only the final state counts as externally verified remote-write ingestion.
3. **Path C (Strict Tempo Trace Validation):**
   - Generates an OpenTelemetry span with unique 128-bit trace ID and `verification.id`.
   - Exports via OTLP HTTPS to Grafana Cloud Tempo (`/v1/traces`).
   - Queries Tempo API directly with strict rules:
     - Preserves actual trace ID returned by backend without overwriting with caller-requested ID.
     - Validates root trace ID and individual span trace IDs against expected trace ID.
     - Rejects mismatched trace IDs, empty spans, and fallback traces (`isFallback: true`).
     - Requires exact `verification.id` attribute in the returned span hierarchy.
4. **Strict Decision & Zero False Claims:**
   - Pending queries or timeouts report `NOT_VERIFIED` and exit non-zero (exit code 1).
   - Missing credentials report `NOT_VERIFIED_AWAITING_CONFIG`.
   - If remote-write credentials are missing or Prometheus is offline, the report strictly indicates `NOT VERIFIED — CREDENTIALS/BACKEND UNAVAILABLE` without claiming an unverified pass.

### D. Prometheus Remote-Write Configuration & Strict Credential Enforcement (Phase 2.4 & 2.5 Hardened)

- **Dedicated Remote-Write Credentials Only:**
  - `GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL`: Dedicated remote-write push URL (e.g. `https://prometheus-prod-XX-prod-ap-south-1.grafana.net/api/prom/push`).
  - `GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_USER`: Remote-write username / instance ID (requires `GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_USER` or `GRAFANA_CLOUD_INSTANCE_ID`; never falls back to read-only query user `GRAFANA_CLOUD_PROMETHEUS_USER`).
  - `GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_TOKEN`: Dedicated write token with `metrics:write` scope.
  - **Zero Read-Token / OTLP Fallback:** The configuration strictly rejects `GRAFANA_CLOUD_PROMETHEUS_TOKEN` (metrics read token) and `GRAFANA_CLOUD_INGESTION_TOKEN` (OTLP token) from authorizing remote-write.
- **Dynamic File-Based Target Discovery (`file_sd_configs`):**
  - Rather than relying on fixed ports 4000–4003, Prometheus configuration incorporates file-based service discovery (`file_sd_configs`) scanning `/etc/prometheus/file_sd/*.json` (and `./docker/file_sd/*.json`).
  - Dynamic test services register their dynamically bound ephemeral port in this directory prior to scrape verification.
  - Verification runner confirms the target appears in `/api/v1/targets` and reports health `up` before proceeding.
- **Real YAML Parsing vs Semantic Promtool Validation:**
  - `validateGeneratedYaml()` uses a real YAML parser (`yaml` package) to verify structural validity, non-empty mapping roots, and valid `scrape_configs` arrays. Local AST parsing validates schema layout and scalar escaping.
  - Semantic configuration checks (such as verifying PromQL scrape interval expressions and TLS options) are evaluated via Prometheus's native `promtool check config` CLI when the tool is installed in the local environment. When `promtool` is not installed on the host, the system truthfully notes that semantic promtool validation was skipped due to missing host binary.
  - All URLs, usernames, and secret tokens are serialized as safely escaped YAML double-quoted scalars rather than raw string interpolation, handling quotes, colons, hashes, newlines, and backslashes without YAML injection.
- **Docker Compose Integration:**
  - In `docker-compose.yml`, Prometheus entrypoint injects remote-write only when `GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_URL` and `GRAFANA_CLOUD_PROMETHEUS_REMOTE_WRITE_TOKEN` are explicitly set.
  - Mounts `./docker/file_sd:/etc/prometheus/file_sd` for dynamic target discovery.
  - Read credentials and query tokens are completely excluded from the Prometheus container environment.
  - When omitted, Prometheus operates safely in local standalone scrape mode without cloud credentials.
  - Dynamic configuration generation tool: `npx tsx scripts/generate-prometheus-config.ts`.

### E. Secure Synthetic Test Metric Endpoint, True Cardinality Bounds & Process Isolation (Phase 2.5 Hardened)

- **Gated Access (`POST /test/record-metric` on `order-service`):**
  - **Default Disabled:** Disabled by default unless `ENABLE_TEST_METRIC_ENDPOINT="true"`. Returns HTTP 403 `{ disabled: true }`.
  - **Production Guard:** Strictly forbidden and returns HTTP 403 if `NODE_ENV === "production"` or `DEPLOYMENT_ENVIRONMENT === "production"`.
  - **Zero Default Password / Fail-Closed Auth:** Completely removed hard-coded default token fallback. If enabled without a configured `TEST_METRIC_ENDPOINT_TOKEN`, fails closed with HTTP 500 (`misconfigured: true`).
  - **Timing-Safe Auth Without Length Leaks:** Auth verification uses fixed-length SHA-256 cryptographic digests compared via `crypto.timingSafeEqual` in `safeTokenEquals()`, eliminating early-exit timing leaks that reveal token length. Zero secrets or hashes are logged.
  - **Payload Ceilings:** Strictly limits request bodies to 1,024 bytes (returns HTTP 413 for oversized payloads) across both recording and cleanup routes.
  - **Strict JSON Parsing:** Rejects malformed JSON payloads with HTTP 400 Bad Request instead of silently ignoring parse failures.
  - **Identifier & Count Bounds:** Validates `verification_id` format (`^[a-zA-Z0-9_-]{8,64}$`) and requires `count` to be a finite positive integer between 1 and 1000.
  - **Bounded Status Allowlist:** Caller cannot supply arbitrary status labels; status is strictly restricted to `['synthetic', 'test_verified', 'smoke_test']`.
- **Bounded Cardinality & Deterministic TTL Expiry (Phase 2.6 Hardened):**
  - **Prometheus Smoke-Test Registry:** The dedicated custom Prometheus registry caps active verification IDs to a maximum of 100 (`MAX_ACTIVE_SYNTHETIC_VERIFICATION_IDS = 100`).
  - **Deterministic Expiry via Scrape Path Pruning:** Active IDs have a 5-minute TTL (`DEFAULT_SYNTHETIC_ID_TTL_MS = 300,000ms`). In Phase 2.6, `PrometheusRegistry.toPrometheusFormat()` invokes `pruneExpiredSyntheticIds()` prior to exposition generation, guaranteeing expired IDs are stripped from Prometheus scrape responses even if no new registration or manual cleanup has occurred.
  - **Deterministic Time Injection:** `PrometheusRegistry.setTimeProvider(fn: () => number)` enables millisecond-precision deterministic time advancement in unit tests without depending on real-time sleep.
  - **Manual Cleanup Release:** Authenticated `DELETE /test/record-metric` or `POST /test/cleanup-metric` (as well as `clearSyntheticVerificationId(id)` / `clearSyntheticVerificationIds()`) explicitly removes metrics from the custom Prometheus registry and releases capacity.
  - **Safe Re-registration:** Expired or cleaned-up IDs can be registered again. Repeated requests using an active ID succeed without consuming additional slots and refresh the TTL timestamp. The 101st unique active ID is rejected with HTTP 429 (`{ error, ceiling: 100 }`).
  - **OpenTelemetry Metric Stream Protection:** The long-lived OpenTelemetry Counter metric strictly records across bounded, stable dimensions (`service`, `method`, `route`, `status`), never attaching arbitrary unique `verification_id` values. This protects the OpenTelemetry SDK aggregator from unbounded lifetime memory growth while preserving the Prometheus smoke-test registry's exact `verification_id` read-back.
- **Child-Process Lifecycle & Parent Environment Preservation (Phase 2.6 Hardened):**
  - `startDisposableOrderService()` executes the disposable order service in a real child process using `child_process.spawn`.
  - **Cryptographically Secure Disposable Tokens:** Generates 32 bytes of cryptographically secure randomness via `crypto.randomBytes(32).toString("hex")`, keeping verification IDs strictly decoupled from authentication tokens.
  - **Parent Environment Preservation:** Ephemeral credentials (`TEST_METRIC_ENDPOINT_TOKEN`, `ENABLE_TEST_METRIC_ENDPOINT="true"`) are passed exclusively through `childEnv`. Parent `process.env` is never modified or deleted, preserving existing configuration. Tokens are never logged or written to target files.
  - **True Process Termination & Escalation:** Replaces reliance on `child.killed` with true process exit tracking (`exitCode`, `signalCode`, `'exit'`/`'close'` events). `stop()` is idempotent, sends `SIGTERM`, awaits exit within a 1500ms grace period, escalates to `SIGKILL` if the child ignores termination, and awaits final termination before resolving.
  - **Dynamic Target Discovery via Host Gateway:** Registers dynamic target `host.docker.internal:${boundPort}` in `./docker/file_sd/` (avoiding container-loopback `127.0.0.1`), with `extra_hosts: ["host.docker.internal:host-gateway"]` in `docker-compose.yml` to support Docker host routing. Dynamic target files are deterministically cleaned up on stop. Target health is confirmed via `/api/v1/targets` and exact verification ID via PromQL prior to remote-write verification.

### F. Strict Tempo Search-to-Detail Verification (Phase 2.5 Hardened)

- **Search Results Treated Strictly as Candidate Discovery:**
  - Tempo search results (`/api/search`) do not return complete span hierarchies or individual span trace IDs. Consequently, `parseTempoSearchTrace()` marks returned traces with `isSearchSummary: true`.
  - Search results are used solely to discover candidate trace IDs. The verification runner extracts candidate trace IDs and executes full backend retrieval via `jaegerClient.getTraceDetail(candidateId, { allowFallback: false })`.
  - `verifyLiveTrace()` strictly rejects search-summary traces (`isSearchSummary: true`) with `"Search-derived summary traces cannot be accepted for strict verification; full trace detail must be retrieved"`.
  - Ordinary dashboard search behavior remains intact, supporting both Jaeger-style and Tempo-style payloads while preventing unverified search summaries from passing live verification.
- **Backend Trace ID & Span ID Preservation in Detail Responses:**
  - When `allowFallback: false` (strict live verification), `parseTempoTraceDetail()` requires an actual non-empty backend root trace ID returned by the backend (`json.traceId` or `json.traceID`). Fails strict verification if missing, even if spans have trace IDs.
  - Requires every span to contain its own genuine backend-returned `traceId` or `traceID`. Never substitutes batch IDs, root IDs, requested IDs, or synthetic values for missing span IDs or trace IDs.
  - Rejects conflicting root, batch, and individual span identifiers (including conflicting `traceId` vs `traceID` spellings).
  - Rejects missing span IDs and duplicate span IDs within a trace.
  - Strictly verifies both Jaeger-style (`json.data[0]`) and Tempo-style payloads.
  - Preserves fallback parsing strictly for non-strict dashboard displays (`allowFallback: true`).

### G. Service Health Gauge Semantics & Fault Cycles

In `sample-services/shared/telemetry.ts`:
- **Correct Gauge Values:**
  - `HEALTHY`: `1`
  - `DEGRADED`: `0.5`
  - `DOWN`: `0`
- **Validation:** Numeric inputs are strictly validated (`1`, `0.5`, `0`); invalid numbers (e.g. `2`, `-1`, `0.7`) throw an `Error`.
- **Exposition Format:** Exposes `service_health_status` with `# HELP service_health_status Health status of the service (1=healthy, 0.5=degraded, 0=down)`.
- **Fault Injection Cycles:** Verified across normal operation (1), fault-injected degraded state (0.5), severe outage (0), and service restoration (1).

### H. Signal-Separated Export Tracking

- Metric and trace export outcomes are tracked independently via `SignalExportStatus`:
  - `metrics: SignalExportStatus` (tracks metric exporter outcomes, counts, errors, and timestamps)
  - `traces: SignalExportStatus` (tracks trace exporter outcomes, counts, errors, and timestamps)
- Exporters never overwrite each other's status or error details.
- Error messages are sanitized via `sanitizeErrorMessage()` to redact `Bearer` tokens, `Basic` tokens, `glc_` keys, and passwords before logging or storing.

### I. Current External Verification Status & Remaining Blockers

IncidentGraph AI distinguishes between deterministic local/CI test suites and genuine external cloud verification:
1. **Local Test Suites (100% Passing):** All 354 unit and integration tests across 11 suites pass locally and in GitHub Actions CI with zero external secrets. Includes Phase 2.7 real Node.js operating-system child process lifecycle tests (cooperative SIGTERM exit, uncooperative SIGKILL escalation, concurrent stop coalescing, idempotent stops on already-exited processes, and OS process table verification via `process.kill(pid, 0)` throwing `ESRCH`).
2. **Algorithmic Benchmark (`npm run test:benchmark`):** 22 tests passing covering core graph algorithms.
3. **Root-Cause Robustness Benchmark (`npm run benchmark`):** 117/117 reproducible scenarios passing (100% Top-1 hit rate, 0% false-positive rate on healthy workloads).
4. **Local Configuration Validation (`npm run config:check`):** Successfully verifies environment variables, ports, and live connectivity probes to Grafana Cloud Prometheus and Tempo query engines.
5. **Path A (Direct OTLP Metrics):** Verified via live OTLP export and PromQL read-back confirming the exact synthetic metric and verification identifier in Grafana Cloud Mimir.
6. **Path B (Prometheus Remote-Write):** Currently reported as **`NOT VERIFIED — CREDENTIALS/BACKEND UNAVAILABLE`** because local Docker Prometheus is not running on this host, dynamic scrape discovery requires the container, and remote-write credentials are unset in local environment. This is an external environment blocker until dedicated remote-write credentials and a running Prometheus instance are provisioned.
7. **Path C (Tempo Distributed Traces):** Currently reported as **`NOT VERIFIED`** pending Tempo block storage propagation and trace indexing delay (up to 10 minutes in free-tier cloud configurations). Search-derived summaries and fallback traces are strictly rejected in live verification.
8. **Simulation Provenance:** In Simulation Mode, the application truthfully reports `source: "SIMULATION"`, `provenance: "DISABLED"` with zero external network calls. `MOCK_EMULATION` is only assigned when mock observability servers (`x-observability-provider: mock-observability-server`) are active during local testing.
