# IncidentGraph AI — Telemetry Troubleshooting & Operations Guide

This guide provides operational troubleshooting steps for running, debugging, and verifying the OpenTelemetry pipeline, sample microservices mesh, and IncidentGraph AI observability backends.

---

## 1. Quick Verification Commands

| Component | Target URL | Expected Response |
|---|---|---|
| **IncidentGraph Web UI** | `http://localhost:3000` | IncidentGraph Operations Console (HTTP 200) |
| **API Gateway** | `http://localhost:4000/health` | `{"service":"api-gateway","status":"healthy"}` |
| **Order Service** | `http://localhost:4001/health` | `{"service":"order-service","status":"healthy"}` |
| **Payment Service** | `http://localhost:4002/health` | `{"service":"payment-service","status":"healthy"}` |
| **Inventory Service** | `http://localhost:4003/health` | `{"service":"inventory-service","status":"healthy"}` |
| **Prometheus Query API** | `http://localhost:9090/api/v1/query?query=up` | `{"status":"success","data":{"resultType":"vector",...}}` |
| **Jaeger Traces API** | `http://localhost:16686/api/traces?service=api-gateway` | `{"data":[{"traceID":"...", "spans":[...]}], ...}` |
| **OTLP HTTP Receiver** | `http://localhost:4318/v1/traces` | HTTP 200 / 202 (OTLP JSON/Protobuf payload) |

---

## 2. Port Mappings & Conflicts

IncidentGraph AI and its ecosystem use the following standard ports:

| Port | Service | Protocol | Process / Component |
|---|---|---|---|
| **3000** | Next.js Dashboard | HTTP | IncidentGraph Web UI |
| **4000** | API Gateway | HTTP | Sample Microservices Egress/Ingress |
| **4001** | Order Service | HTTP | Sample Order Processing |
| **4002** | Payment Service | HTTP | Sample Payment Processor |
| **4003** | Inventory Service | HTTP | Sample Inventory Catalog |
| **4317** | OTel Collector gRPC | gRPC | Ingestion of traces and metrics |
| **4318** | OTel Collector HTTP | HTTP | Ingestion of traces and metrics |
| **8889** | OTel Collector Exporter | HTTP | Prometheus metrics scrape endpoint |
| **9090** | Prometheus | HTTP | Metrics database and PromQL query API |
| **16686** | Jaeger UI / Query | HTTP | Distributed trace investigation and query API |

### Port Conflict Diagnostics (Windows PowerShell)

If any port fails with `EADDRINUSE`:

```powershell
# Identify the process occupying a specific port (e.g., 4000)
Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue | Select-Object OwningProcess

# Terminate an orphaned process by PID
Stop-Process -Id <PID> -Force
```

---

## 3. Running with Docker Compose vs Host Mode

### Mode A: Docker Compose (Production / Full Stack)
When Docker is installed and running:
```bash
# 1. Start OpenTelemetry Collector, Prometheus, Jaeger, and PostgreSQL
docker-compose up -d

# 2. Verify containers are running healthy
docker-compose ps

# 3. Start sample microservices
npm run sample:start
```

### Mode B: Host Standalone Mode (Zero Docker Dependency)
When Docker daemon is unavailable:
```bash
# Unified command boots sample services + integrated OTLP HTTP receiver (4318),
# Prometheus PromQL endpoint (9090), and Jaeger traces endpoint (16686):
npm run sample:start
# or explicitly:
npm run sample:mock
```
- In this mode, the servers return headers:
  `X-Observability-Provider: mock-observability-server`
  `X-Observability-Type: MOCK_EMULATION`
- The IncidentGraph Service Map prominently flags:
  `"Dev Mock Emulation Stack"` to ensure this in-process development mock is never mistaken for genuine Docker containers.

### Mode C: PostgreSQL Database Integration & Diagnostics
The sample services connect via a `pg.Pool` client configured with `SAMPLE_DATABASE_URL` (defaulting to `postgresql://postgres:postgres@localhost:5432/sample_ecommerce`):
- When PostgreSQL is running, the client initializes real database tables (`inventory_items`, `orders`, `payment_transactions`) and executes real SQL operations.
- When PostgreSQL is unreachable (e.g., container not started), `SamplePostgresClient` reports:
  `"PostgreSQL offline (connection refused). Microservices operating with in-memory DB fallback and diagnostic reporting."`
- The system never pretends that offline PostgreSQL is connected.

---

## 4. Multi-Tier Telemetry Pipeline Audit (`npm run test:live`)

Run the dedicated live verification audit:
```bash
npm test:live
```

This command tests across 4 separate tiers:
1. **Unit & Algorithmic Tests:** Directed graph traversal, reverse BFS blast radius, binary heap ordering.
2. **Mocked / Isolated Integration Tests:** W3C `traceparent` serialization and child span context propagation.
3. **Live Infrastructure Smoke Tests:** Validates Docker engine availability, genuine Prometheus scrape targets, genuine Jaeger API, and PostgreSQL connection pool. (Accurately reported as `[NOT RUN]` with environmental blockers when Docker daemon is not running).
4. **Full End-to-End Telemetry Tests:** Boots microservices, issues real HTTP requests traversing Gateway $\rightarrow$ Order $\rightarrow$ Inventory $\rightarrow$ Payment $\rightarrow$ DB, verifies multi-span traces and metric updates, executes fault injection (`db-slowdown`), tests root-cause ranking with zero scenario ground-truth leakage, and verifies baseline recovery.

### Verifying Prometheus Metrics Ingestion

Run a PromQL query via curl or PowerShell to verify that requests are being recorded:

```powershell
Invoke-RestMethod -Uri "http://localhost:9090/api/v1/query?query=http_requests_total"
```

Expected output:
```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": { "service": "api-gateway", "route": "/api/orders", "status": "200" },
        "value": [ 1776098000, "42" ]
      }
    ]
  }
}
```

### Verifying Jaeger Trace Collection

Retrieve recent distributed traces for `api-gateway`:

```powershell
Invoke-RestMethod -Uri "http://localhost:16686/api/traces?service=api-gateway&limit=5"
```

Verify that each trace contains child spans from `order-service`, `inventory-service`, and `payment-service`.

---

## 5. Investigating "Unknown Services" in IncidentGraph AI

If you see an **"Unknown Services Discovered"** warning banner on the Service Map (`/service-map`):

- **Why it happens:** The Prometheus or Jaeger query returned telemetry for a service name that does not exist in the configured SQLite topology (`dev.db`).
- **How to resolve:**
  1. Inspect the service name reported in the warning banner.
  2. Verify if the service is a new microservice added to `sample-services/`.
  3. Register the service in the topology via `POST /api/services` or update `prisma/seed.ts` and run `npx prisma db seed`.
  4. Ensure your OpenTelemetry `service.name` attribute matches the service name in the database.

---

## 6. Investigating "Telemetry Offline" or Stale Data

If the Service Map displays **Telemetry Backend: Offline**:

1. Check whether Prometheus (9090) or Jaeger (16686) are reachable:
   ```powershell
   Test-NetConnection -ComputerName localhost -Port 9090
   Test-NetConnection -ComputerName localhost -Port 16686
   ```
2. If unreachable, ensure `npm run sample:start` or `docker-compose up -d` is running.
3. IncidentGraph AI **never fabricates data** when backends are offline. It will safely display an explicit offline indicator while preserving all Simulation Mode capabilities.

---

## 7. Chaos Fault Experiments & Clean Reset

To inject a controlled failure into the running sample system:

### 1. Database Slowdown (800ms Latency)
```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/experiments/trigger" -Method Post -ContentType "application/json" -Body '{"scenario":"db-slowdown"}'
```
- **Observed telemetry:** Latency on Order Service and API Gateway surges; DB query spans jump from 12ms to 812ms.

### 2. Downstream Service Timeout (1500ms Delay on Inventory)
```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/experiments/trigger" -Method Post -ContentType "application/json" -Body '{"scenario":"downstream-timeout"}'
```
- **Observed telemetry:** Order Service reports HTTP 504 Gateway Timeouts on `/orders`.

### 3. Payment Service Outage (100% Errors)
```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/experiments/trigger" -Method Post -ContentType "application/json" -Body '{"scenario":"payment-errors"}'
```
- **Observed telemetry:** Payment Service returns HTTP 500; Error count metrics spike.

### 4. Restore to Healthy Baseline
```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/experiments/trigger" -Method Post -ContentType "application/json" -Body '{"scenario":"baseline"}'
```
- **Observed telemetry:** All services return to 12ms baseline latency and 0% errors within 1 request cycle.
