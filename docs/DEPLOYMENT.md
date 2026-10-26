# IncidentGraph AI — Production Deployment & Operations Guide

This guide details the production architecture, hosting integration, database persistence, AI configuration, and verification procedures for **IncidentGraph AI**.

---

## 1. Architecture Overview

IncidentGraph AI is built with Next.js 16 (App Router with Turbopack), React 19, TypeScript, and Prisma ORM.

| Component | Local / Development | Production Serverless (Vercel) |
| :--- | :--- | :--- |
| **Hosting Platform** | Node.js (`npm run dev` / `npm start`) | Vercel Edge & Serverless Lambda |
| **Database Engine** | SQLite (`file:./dev.db`) | Hosted PostgreSQL (e.g. Neon, Supabase) |
| **Prisma Schema** | `prisma/schema.prisma` | `prisma/schema.postgresql.prisma` |
| **Schema Selection** | Automatic via `prisma.config.ts` | Automatic via `DATABASE_URL` protocol inspection |
| **Telemetry Ingestion** | In-Memory / Local OTLP / Grafana Cloud | Grafana Cloud OTLP or In-Memory Simulation |
| **AI Investigator** | Live OpenAI or Offline Replay Demo | Live OpenAI or Offline Replay Demo |
| **Health Check** | `GET /api/health` | `GET /api/health` |

---

## 2. Database Persistence Architecture

### Why Serverless SQLite Fails
Serverless platforms (such as Vercel and AWS Lambda) run inside ephemeral containers with read-only filesystems. SQLite requires a writable local filesystem to create database locks, write-ahead logs (`-wal`), and rollback journals (`-journal`). Any file written to the deployment root throws `Error code 14: Unable to open the database file`.

### The Dual-Engine Solution
To preserve fast, zero-dependency local development while enabling enterprise-grade persistence in production, IncidentGraph AI uses a **dynamic Prisma configuration**:

1. **Local Development**: Default `DATABASE_URL="file:./dev.db"` maps automatically to `prisma/schema.prisma` with `provider = "sqlite"`.
2. **Production / Serverless**: Any `DATABASE_URL` beginning with `postgresql://` or `postgres://` automatically selects `prisma/schema.postgresql.prisma` with `provider = "postgresql"`.
3. **Safe Auto-Seeding**: When the application starts or receives a request via `/api/health`, `ensureBaselineSeeded()` checks whether services exist (`prisma.service.count() === 0`). If the database is blank, it seeds the 7 core ecommerce services and topology without resetting or deleting user incidents.

### Recommended Hosted PostgreSQL Providers (Free Tier Available)
1. **Neon Serverless PostgreSQL** (Recommended):
   - Generates a pooled connection string with `?sslmode=require`.
   - Native branching and zero-cost serverless cold starts.
2. **Supabase PostgreSQL**:
   - Connection pooler via port 6543 (transaction mode) or port 5432.
3. **AWS RDS / Aurora Serverless**:
   - Standard VPC or public subnet connection string.

### Applying Migrations to PostgreSQL
Run the initial migration against your hosted database:
```bash
# Push schema directly to your hosted PostgreSQL database
DATABASE_URL="postgresql://user:password@host/db?sslmode=require" npx prisma db push

# Or apply the provided DDL script
psql "$DATABASE_URL" -f prisma/migrations-postgres/0_init/migration.sql
```

---

## 3. Environment Variables Reference

Configure these environment variables in your hosting provider (e.g., Vercel Dashboard -> Settings -> Environment Variables):

| Variable | Description | Required in Production? |
| :--- | :--- | :--- |
| `DATABASE_URL` | Hosted PostgreSQL connection string (`postgres://...`) | **Yes** (for persistent storage) |
| `OPENAI_API_KEY` | OpenAI API key for live AI incident investigation | **Optional** (falls back to offline replay) |
| `OPENAI_MODEL` | Target OpenAI model (default: `gpt-4o-mini`) | Optional |
| `AI_PROVIDER` | `openai` (default) or `mock` | Optional |
| `GRAFANA_CLOUD_PROMETHEUS_URL` | Grafana Cloud Prometheus query endpoint | Optional (falls back to simulation) |
| `GRAFANA_CLOUD_PROMETHEUS_USER` | Grafana Cloud numeric user ID | Optional |
| `GRAFANA_CLOUD_PROMETHEUS_TOKEN` | Restricted read token (`metrics:read`) | Optional |
| `GRAFANA_CLOUD_TEMPO_URL` | Grafana Cloud Tempo traces endpoint | Optional |
| `GRAFANA_CLOUD_TEMPO_USER` | Grafana Cloud numeric user ID | Optional |
| `GRAFANA_CLOUD_TEMPO_TOKEN` | Restricted read token (`traces:read`) | Optional |

> **Security Rule**: Never check secrets, tokens, or live credentials into Git. All production secrets must be set strictly in hosting environment variables.

---

## 4. Health Check Endpoint (`/api/health`)

IncidentGraph AI includes a real-time, zero-side-effect health diagnostic endpoint at `/api/health`.

### Sample Healthy Response (Production with Hosted Postgres)
```json
{
  "status": "healthy",
  "timestamp": "2026-10-26T16:15:00.000Z",
  "latencyMs": 14,
  "version": "0.1.0",
  "environment": "production",
  "database": {
    "status": "connected",
    "provider": "postgresql",
    "servicesCount": 7
  },
  "telemetry": {
    "mode": "SIMULATION",
    "grafanaCloudConfigured": true
  },
  "aiProvider": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "isConfigured": true,
    "details": "Live OpenAI provider is active."
  }
}
```

### Health Check Status Rules
- Returns HTTP `200` with `status: "healthy"` when the database responds to `$queryRaw` ping.
- Returns HTTP `503` with `status: "unhealthy"` when database connection fails, detailing the exact provider and diagnostic error without exposing raw credentials.

---

## 5. Live Demo Operations

### Telemetry Provenance in the UI
The UI explicitly distinguishes between data sources to avoid confusing simulated demonstrations with live infrastructure:
- **`LIVE_GRAFANA`**: Real OpenTelemetry data ingested from Grafana Cloud Prometheus and Tempo.
- **`SIMULATION`**: Deterministic synthetic failure scenarios generated by the in-memory failure injector and verified by the 117-scenario DSA benchmark.

### AI Investigation Flow
- When `OPENAI_API_KEY` is provided: Click **"Run AI Investigation"** to generate an evidence-grounded hypothesis synthesized by `gpt-4o-mini`.
- When `OPENAI_API_KEY` is omitted: Click **"Run Simulation Replay Demo"** to observe an offline investigation replay without consuming API credits or failing with an error.

---

## 6. Verification and Smoke Testing

Before promoting any build to production, run the standard quality gates:

```bash
# 1. Typecheck and linting
npx tsc --noEmit
npm run lint

# 2. Automated test suite (75 tests)
npm test

# 3. Deterministic root-cause benchmark (117 scenarios, 100% accuracy required)
npm run benchmark

# 4. Production build check
npm run build

# 5. Live smoke test against deployed URL
curl -fsS https://<deployment-url>/api/health
```
