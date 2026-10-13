# Root-Cause Ranking Engine Specification

IncidentGraph AI utilizes an explainable, deterministic heuristic algorithm to infer which microservice originated a system incident.

---

## 1. Core Principle: Zero Ground-Truth Leakage

> [!IMPORTANT]
> **Correctness Invariant:** The root-cause engine **never reads** the simulator's internal `injectedServiceId`. The simulation state keeps the injected target solely to apply reproducible physical degradation steps. The root-cause ranking engine receives only:
> 1. Service topology (Directed graph)
> 2. Observed telemetry samples and timestamps
> 3. Current health signals (HTTP 5xx, timeouts, connection drops)
> 4. Active alert thresholds

This ensures the algorithm performs honest, observable inference identical to a real production observability platform.

---

## 2. Evidence Model & Scoring Weights

Each candidate service is scored on a normalized scale from **0 to 100 points**.

### Scoring Components (Max 100 Points)

| Evidence Category | Max Score | Evaluation Rule |
|---|---|---|
| **1. Service Status Signal** | **25 pts** | • `DOWN`: +25 pts<br>• `DEGRADED`: +15 pts<br>• `HEALTHY`: 0 pts |
| **2. Telemetry Spike Threshold** | **25 pts** | • Latency ratio $\ge 3.0\times$ baseline: up to +20 pts<br>• Latency ratio $\ge 1.8\times$ baseline: +10 pts<br>• Error rate delta $\ge 10\%$: +15 pts |
| **3. Temporal Precedence** | **25 pts** | • Anomaly onset at $t = \min(t_{\text{onset}})$: +25 pts<br>• Anomaly onset at $t = \min(t_{\text{onset}}) + 1$: +12 pts<br>• Onset strictly after downstream callers: -15 pts penalty |
| **4. Cascading Reachability Coverage** | **25 pts** | Evaluates what fraction of downstream symptomatic services are reachable from this node via reverse BFS:<br>$\text{Score} = 25 \times \frac{\text{Symptomatic Callers Explained}}{\text{Total Symptomatic Callers}}$ |

### Contradictory Evidence Penalties
- If a service exhibits completely normal telemetry and status within baseline SLA: **-40 pts penalty**.
- If anomaly onset occurred *after* downstream services: **-15 pts penalty**.

---

## 3. Confidence Classification

The final score is clamped between 0 and 100. Rather than claiming fabricated probabilistic certainty (e.g. "97.4% probability"), the engine assigns calibrated heuristic confidence labels:

| Heuristic Score | Confidence Label | Interpretation |
|---|---|---|
| **$75 - 100$** | `HIGH` | Strong direct signals, earliest temporal onset, and explains downstream cascade. |
| **$50 - 74$** | `MEDIUM` | Noticeable anomaly and graph alignment, but possible partial evidence overlap. |
| **$30 - 49$** | `LOW` | Weak signals or conflicting timing. |
| **$< 30$** | `INCONCLUSIVE` | Insufficient abnormal signals; default when system is healthy. |

---

## 4. Remediation Recommender

For every evaluated candidate, the engine generates actionable SRE runbook steps tailored to the service's architectural tier and failure mode:
- **Database:** Inspect connection pool saturation, slow query logs, lock contention, and disk IOPS.
- **Authentication Service:** Verify JWT signing certificates, JWKS rotation, and OAuth provider response times.
- **Edge Gateway:** Check ingress rate-limiting rules, route table configurations, and backend socket pool exhaustion.
- **Core Microservice:** Review pod replica health, thread dump traces, memory leaks, or rollback recent deployments.

---

## 5. How to Reproduce an Analysis

1. Open **Failure Simulator** (`/simulator`).
2. Select **PostgreSQL Database Slowdown** and click **Inject Selected Scenario**.
3. Advance the simulation by 1 or 2 steps using **Advance Step**.
4. Open the active incident in **Incidents** (`/incidents`) or click **Investigate**.
5. Observe the ranked candidates table: `postgres-db` will be ranked #1 with HIGH confidence, backed by timing precedence and cascading reachability proofs.
