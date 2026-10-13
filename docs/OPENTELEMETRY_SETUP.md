# OpenTelemetry & Observability Pipeline Setup

This guide documents the installation, startup, port allocations, and verification procedures for the **IncidentGraph AI** Phase 2 OpenTelemetry observability pipeline.

---

## 1. Architecture Overview

```
Instrumented Microservices
        │
        │ OpenTelemetry NodeSDK (W3C TraceContext)
        ▼
OpenTelemetry Collector (:4317 gRPC, :4318 HTTP)
        │
        ├─── Processors (memory_limiter, batch)
        │
        ├───► Prometheus (:8889 scrape -> :9090 PromQL)
        │
        └───► Jaeger (:4317 OTLP -> :16686 Query API)
                  │
                  ▼
          IncidentGraph AI (:3000)
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
Service Map (Live OTel)  Trace Waterfall
```

---

## 2. Port Allocations & Endpoints

| Service / Component | Port | Protocol | Description |
| :--- | :--- | :--- | :--- |
| **IncidentGraph AI** | `3000` | HTTP | Next.js Control Plane & SRE Dashboard |
| **API Gateway** | `4000` | HTTP | Sample ingress edge proxy |
| **Order Service** | `4001` | HTTP | Transactional order processing |
| **Payment Service** | `4002` | HTTP | Deterministic payment authorization |
| **Inventory Service** | `4003` | HTTP | Stock reservations and catalog queries |
| **Sample PostgreSQL** | `5433` (or 5432) | TCP | Database storage cluster |
| **OTel Collector (HTTP)** | `4318` | HTTP | OTLP HTTP receiver (`/v1/traces`, `/v1/metrics`) |
| **OTel Collector (gRPC)** | `4317` | gRPC | OTLP gRPC receiver |
| **Prometheus** | `9090` | HTTP | PromQL Query API & Metrics Dashboard |
| **Jaeger** | `16686` | HTTP | Jaeger UI & Trace Query API (`/api/traces`) |

---

## 3. Starting the Observability Environment

### Option A: Standalone Node.js Mode (Zero Docker Requirement)

For environments where the Docker daemon is not installed, IncidentGraph AI includes a standalone OpenTelemetry bridge and microservices runner:

1. **Start all sample microservices & observability receivers:**
   ```powershell
   npm run sample:start
   ```
   This automatically binds:
   - OTLP Receiver on `http://localhost:4318`
   - Prometheus API on `http://localhost:9090`
   - Jaeger Trace API on `http://localhost:16686`
   - Gateway on `http://localhost:4000`
   - Order Service on `http://localhost:4001`
   - Payment Service on `http://localhost:4002`
   - Inventory Service on `http://localhost:4003`

2. **Generate Repeatable Traffic:**
   ```powershell
   npm run sample:traffic
   ```
   Sends real HTTP orders and inventory checks through API Gateway, generating authentic spans and metrics.

### Option B: Docker Compose Mode

When Docker and Docker Compose are available on the host machine:

1. **Launch Containers:**
   ```bash
   docker compose up -d
   ```
2. **Verify Container Health:**
   ```bash
   docker compose ps
   ```
3. **Verify Prometheus Scrape Targets:**
   Visit `http://localhost:9090/targets` to confirm `otel-collector:8889` is `UP`.
4. **Verify Jaeger UI:**
   Visit `http://localhost:16686` to inspect search filters.

---

## 4. Verification Commands

1. **Check Backend Connectivity:**
   ```powershell
   curl http://localhost:3000/api/telemetry/overview
   ```
2. **Retrieve Recent Traces:**
   ```powershell
   curl http://localhost:3000/api/telemetry/traces
   ```
3. **Trigger Incident Detection:**
   ```powershell
   curl -X POST http://localhost:3000/api/telemetry/detect
   ```
