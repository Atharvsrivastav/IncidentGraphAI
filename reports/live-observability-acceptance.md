# 🔬 IncidentGraphAI — Live Telemetry Acceptance & Verification Report

- **Execution Timestamp**: `2026-10-31T15:47:09.736Z`
- **Overall Verdict**: ⚠️ **UNVERIFIED / INCOMPLETE**

## Telemetry Pipelines Acceptance Summary

| Pipeline | Target Provider | Status | Verification ID / Marker | Export Latency | Query Latency | Evidence & Details |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Path A: Direct OTLP Metrics** | Grafana Cloud Prometheus | ⚠️ `NOT_VERIFIED` | `verify_otlp_7198452ee1d4748c7ad91b08101ec8c3` | 574ms | 0ms | Export to OTLP gateway succeeded; ingestion read-back timed out or query indexing remained pending. |
| **Path B: Scrape & Remote-Write** | Containerized Prometheus → Grafana Cloud | ⚠️ `NOT_VERIFIED` | `verify_rw_mvwkrt43_c0f30f778aab` | N/A | 0ms | Docker engine unavailable on this runner host. Isolated containerized Prometheus scraping and remote-write verification preserved as NOT_VERIFIED. |
| **Path C: Distributed Traces** | Grafana Cloud Tempo | ✅ `PASSED` | `verify_trace_mvwkrt46_f8fd346effa67b137124c11b0a90218b` | 578ms | 50ms | Trace retrieved directly via Tempo Trace ID API (matched trace ID 17175dada72c7aa58fa4e07f0a910444, 2 verified real span(s)). |

## Configuration Audit

- **OTLP Ingestion Configured**: Yes
- **Prometheus Query Configured**: Yes
- **Tempo Query Configured**: Yes
- **Remote-Write Dedicated Token Configured**: No
