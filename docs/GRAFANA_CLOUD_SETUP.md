# Grafana Cloud & Zero-Admin Setup Guide

This guide describes how to run **IncidentGraph AI** with genuine **OpenTelemetry** observability on a restricted workstation (such as a locked-down Windows office laptop) without needing Docker Desktop, WSL, PostgreSQL system services, or local administrator privileges.

---

## Architecture Overview

```
Restricted Windows Laptop (Zero-Admin, Zero-Docker)
┌──────────────────────────────────────────────────────────────────┐
│  IncidentGraph AI Dashboard (Next.js 16 + React 19 + SQLite)     │
│  Port 3000                                                       │
│                                                                  │
│  Sample Microservices Mesh (Node.js)                             │
│  ├── API Gateway        (:4000)                                  │
│  ├── Order Service      (:4001)                                  │
│  ├── Payment Service    (:4002)                                  │
│  ├── Inventory Service  (:4003)                                  │
│  └── Storage: Zero-Admin File Store (data/sample_store.json)     │
└─────────────────────────────────┬────────────────────────────────┘
                                  │
                                  │ HTTPS (Port 443) - Direct OTLP Exporters
                                  │ W3C TraceContext Propagation
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  Grafana Cloud (ap-south-1 Hosted Observability Stack)           │
│                                                                  │
│  ├── OTLP Gateway     https://otlp-gateway-prod-ap-south-1.../   │
│  ├── Hosted Metrics   (Prometheus Mimir PromQL)                  │
│  └── Hosted Traces    (Tempo Distributed Tracing)                │
└──────────────────────────────────────────────────────────────────┘
```

---

## 1. Configured Connection Details

Your active Grafana Cloud stack uses:
- **OTLP Gateway Endpoint**: `https://otlp-gateway-prod-ap-south-1.grafana.net/otlp`
- **Instance / Tenant ID**: `1871065`

All query credentials remain strictly server-side in the local `.env` file (which is excluded from Git via `.gitignore`). Never commit tokens or share them in chat.

---

## 2. Least-Privilege Token Architecture

Grafana Cloud uses **Access Policies** to issue scoped tokens. For security and least-privilege compliance, tokens are separated by purpose:

### A. Telemetry Ingestion Token (`GRAFANA_CLOUD_INGESTION_TOKEN`)
Used exclusively by the Node.js sample microservices to push telemetry over HTTPS.
- **Required Scopes**:
  - `metrics:write` — pushes HTTP duration histograms and request counters to Prometheus Mimir.
  - `traces:write` — pushes distributed trace spans to Tempo.
- **Where to create in Grafana Cloud**:
  1. Open the [Grafana Cloud Portal](https://grafana.com) -> **Security** -> **Access Policies**.
  2. Click **Create access policy**. Name it `incidentgraph-ingest`.
  3. Under **Scopes**, select:
     - `metrics:write`
     - `traces:write`
  4. Click **Create**, then click **Add token**. Name it `ingest-token`.
  5. Copy the generated token (`glc_...`) into `.env` as `GRAFANA_CLOUD_INGESTION_TOKEN`.

> [!NOTE]
> An ingestion token has **no read permissions**. It cannot query Prometheus or Tempo.

---

### B. Telemetry Query Read Token (`GRAFANA_CLOUD_PROMETHEUS_TOKEN` & `GRAFANA_CLOUD_TEMPO_TOKEN`)
Used exclusively by the IncidentGraph AI Next.js server to query metrics and traces for the Service Map and Root-Cause Engine.
- **Required Scopes**:
  - `metrics:read` — executes PromQL queries (`rate(http_requests_total...)`).
  - `traces:read` — searches Tempo traces and retrieves span waterfalls.
- **Where to create in Grafana Cloud**:
  1. In **Security** -> **Access Policies**, click **Create access policy**. Name it `incidentgraph-query`.
  2. Under **Scopes**, select:
     - `metrics:read`
     - `traces:read`
  3. Click **Create**, then click **Add token**. Name it `query-read-token`.
  4. Copy the generated token (`glc_...`) into `.env`:
     - You can set `GRAFANA_CLOUD_READ_TOKEN="glc_..."` (shared for both Prom and Tempo), OR
     - Set `GRAFANA_CLOUD_PROMETHEUS_TOKEN="glc_..."` and `GRAFANA_CLOUD_TEMPO_TOKEN="glc_..."` individually.

---

## 3. Finding Query URLs in Grafana Cloud Portal

In the [Grafana Cloud Portal](https://grafana.com) (My Account):

### 1. Prometheus Query URL
1. On your stack card, locate the **Prometheus** service tile.
2. Click **Details**:
   - **URL**: Copy the full URL (e.g. `https://prometheus-prod-XX-prod-ap-south-1.grafana.net/api/prom`).
   - **User / Instance ID**: Confirm it matches `1871065`.
3. Set in `.env`:
   ```env
   GRAFANA_CLOUD_PROMETHEUS_URL="https://prometheus-prod-XX-prod-ap-south-1.grafana.net/api/prom"
   GRAFANA_CLOUD_PROMETHEUS_USER="1871065"
   GRAFANA_CLOUD_PROMETHEUS_TOKEN="glc_your_read_token_here"
   ```

### 2. Tempo Query URL
1. Locate the **Tempo** service tile.
2. Click **Details**:
   - **URL**: Copy the URL (e.g. `https://tempo-prod-XX-prod-ap-south-1.grafana.net`).
   - **User / Instance ID**: Confirm it matches `1871065`.
3. Set in `.env`:
   ```env
   GRAFANA_CLOUD_TEMPO_URL="https://tempo-prod-XX-prod-ap-south-1.grafana.net"
   GRAFANA_CLOUD_TEMPO_USER="1871065"
   GRAFANA_CLOUD_TEMPO_TOKEN="glc_your_read_token_here"
   ```

---

## 4. Local `.env` Reference

Your `.env` should look like this:

```env
DATABASE_URL="file:./dev.db"

# Hosted Observability (Grafana Cloud / Cloud OTLP)
GRAFANA_CLOUD_OTLP_ENDPOINT="https://otlp-gateway-prod-ap-south-1.grafana.net/otlp"
GRAFANA_CLOUD_INSTANCE_ID="1871065"

# Least-Privilege Ingest Token (metrics:write, traces:write)
GRAFANA_CLOUD_INGESTION_TOKEN="glc_eyJvIjoi..."

# Hosted Prometheus Metrics (metrics:read)
GRAFANA_CLOUD_PROMETHEUS_URL="https://prometheus-prod-XX-prod-ap-south-1.grafana.net/api/prom"
GRAFANA_CLOUD_PROMETHEUS_USER="1871065"
GRAFANA_CLOUD_PROMETHEUS_TOKEN="glc_eyJvIjoi..."

# Hosted Tempo Traces (traces:read)
GRAFANA_CLOUD_TEMPO_URL="https://tempo-prod-XX-prod-ap-south-1.grafana.net"
GRAFANA_CLOUD_TEMPO_USER="1871065"
GRAFANA_CLOUD_TEMPO_TOKEN="glc_eyJvIjoi..."

# Environment Tags
ENVIRONMENT="production-hosted"
DEPLOYMENT_ENVIRONMENT="production-hosted"
```

---

## 5. Checking Configuration Readiness

Before running live traffic, verify your configuration safely:

```bash
npm run config:check
```

This diagnostic command:
- Checks whether required variables are populated.
- Validates HTTPS URL formats and instance IDs.
- **Masks all tokens** (zero secrets printed).
- Checks port readiness for sample microservices.
- Points directly to the Grafana Cloud screen for any missing parameters.

---

## 6. Running Without Docker or Admin Access

You do not need Docker Desktop, WSL, or background services.

### Terminal 1: Start the Sample Microservices
```bash
npm run sample:start
```
- Listens on `http://localhost:4000` (Gateway), `4001` (Order), `4002` (Payment), `4003` (Inventory).
- Connects directly to `https://otlp-gateway-prod-ap-south-1.grafana.net/otlp` via HTTPS.
- Stores order and inventory data locally in `sample-services/data/sample_store.json`.

### Terminal 2: Start IncidentGraph AI Dashboard
```bash
npm run dev
```
- Opens on `http://localhost:3000`.
- In the top bar, switch to **Real Cloud Telemetry Mode**.
- The Service Map will display the `☁ Grafana Cloud (Hosted)` badge.

---

## 7. Generating Live Synthetic Traffic

To generate authentic multi-service traces and metrics:

```bash
npm run sample:traffic
```

This sends synthetic orders through the API Gateway:
`Client -> Gateway (:4000) -> Order (:4001) -> Inventory (:4003) -> Payment (:4002) -> Local Storage`

W3C `traceparent` headers are injected and propagated across every service hop and exported to Grafana Cloud.

---

## 8. Verifying Real Cloud Telemetry

Run the automated verification suite:

```bash
npm run test:cloud
```

This script performs:
1. **Sanitized Configuration Audit**: Confirms all cloud variables without exposing secrets.
2. **Zero-Admin Storage Check**: Verifies file-backed transactional store.
3. **W3C Context Propagation**: Validates parent-child span trace continuity.
4. **Live Traffic Generation**: Transmits synthetic orders through the microservices.
5. **Grafana Cloud Query Check**: Actively queries Prometheus PromQL and Tempo APIs.
6. **Controlled Fault Injection & RCA**: Injects a 700ms storage latency anomaly, verifies anomaly detection, and confirms root-cause ranking based on observed evidence.

---

## 9. Troubleshooting

### 1. HTTP 401 Unauthorized
- **Cause**: The API token is invalid, expired, or the username is wrong.
- **Fix**: Verify `GRAFANA_CLOUD_INSTANCE_ID="1871065"`. Ensure the token was copied completely with the `glc_` prefix.

### 2. HTTP 403 Forbidden
- **Cause**: The token lacks required scopes.
  - Ingesting metrics/spans requires `metrics:write` and `traces:write`.
  - Querying Prometheus requires `metrics:read`.
  - Querying Tempo requires `traces:read`.
- **Fix**: Check the token's Access Policy in Grafana Cloud -> Security -> Access Policies.

### 3. Corporate Proxy / SSL Interception
- **Cause**: Office network intercepting SSL connections (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`).
- **Fix**: Point Node to your corporate CA certificate:
  ```powershell
  $env:NODE_EXTRA_CA_CERTS="C:\path\to\corporate-ca.crt"
  ```

### 4. Running Offline
- If you are disconnected from the internet, run `npm test` for the local test suite, or `npm run sample:mock` for isolated local emulation. Real Cloud Telemetry Mode will display `N/A (Backends Offline)` rather than faking data.
