# IncidentGraph AI — Social Announcements & Portfolio Copy

## 1. LinkedIn Post (Engineering & Portfolio Story)

```text
🚀 Excited to showcase IncidentGraph AI: an autonomous, graph-driven root-cause analysis engine for distributed microservices.

Here is the real-world distributed systems problem I set out to solve:
When a core PostgreSQL database or cache experiences connection exhaustion at 2 AM, the failure doesn't stay local. Within seconds, upstream checkout queues back up, inventory checks stall, and the API gateway triggers an alert storm of HTTP 504 errors.

Traditional monitoring tools page on-call engineers with 20+ alerts simultaneously, treating symptoms at the edge with the same priority as the fire burning 3 tiers deep.

IncidentGraph AI takes a fundamentally different, mathematically grounded approach:
1️⃣ In-Memory Directed Dependency Graph: Models microservice dependencies as a directed graph with edge criticalities, communication protocols (SYNC_HTTP, ASYNC_QUEUE, DATABASE_CONN), and cycle detection.
2️⃣ Breadth-First Search (BFS) Blast-Radius Search: Real-time traversal computing graph reachability, blast radius, and topological impact scores across upstream dependents.
3️⃣ Algorithmic Root-Cause Engine: Uses a binary heap priority queue combining anomaly statistical z-scores, topological depth weighting, and temporal onset precedence to rank the true culprit with a deterministic heuristic score of 94/100.
4️⃣ Evidence-Grounded AI Investigation: Enforces strict Zod schema validation and post-generation evidence-ID cross-checking against database anomaly records (with deterministic simulation replay in public production where external LLM keys are unconfigured).
5️⃣ Enterprise Observability & Hardening: Instrumented with OpenTelemetry and verified against Grafana Cloud (Prometheus + Tempo) over HTTPS; hardened with production authentication guards blocking destructive resets.

Tech Stack: Next.js 16 (App Router), TypeScript, Prisma ORM, Neon Serverless PostgreSQL, OpenTelemetry JS SDK, Vitest (81/81 tests passing).

Check out the live production deployment and 3-minute demo:
🌐 Live App: https://incident-graph-ai.vercel.app
💻 GitHub Repo: https://github.com/Atharvsrivastav/IncidentGraphAI
📹 Recruiter Demo Kit: docs/RECRUITER_DEMO.md (95s silent video walkthrough + separate ~3-minute voiceover script)

Feedback and questions from SREs, platform engineers, and engineering managers are welcome!

#SoftwareEngineering #DistributedSystems #Observability #OpenTelemetry #SRE #TypeScript #Nextjs #SystemDesign #FullStack
```

---

## 2. GitHub Release / Feature Summary (Concise Markdown)

```markdown
### 🎯 What is IncidentGraph AI?
IncidentGraph AI is an autonomous, explainable root-cause investigation platform for microservice ecosystems. By fusing directed graph theory (BFS blast-radius search, DFS cycle detection, priority-queue ranking) with OpenTelemetry distributed tracing and grounded AI synthesis, it isolates originating service faults in <300ms during cascading outages.

### 🌟 Key Engineering Capabilities
- **Directed Graph Topology**: Real-time dependency graph with live latency percentiles, upstream blast radius, and cycle alerts.
- **Deterministic DSA Engine**: Multi-factor root-cause scoring (anomaly z-score, topological depth, temporal precedence) with 100% recall on 65 evaluable synthetic failure benchmarks across 5 topology families.
- **Dual Telemetry Modes**: Real cloud telemetry (Grafana Cloud Prometheus & Tempo probes) + zero-cost deterministic fault simulation (7 realistic failure scenarios).
- **Evidence-Grounded AI**: Strict Zod schema boundaries; verified evidence-ID provenance; deterministic replay in public production.
- **Production Hardened**: Destructive reset endpoints guarded with HTTP 403 Forbidden; transactional pruning preserves active incidents.
```
