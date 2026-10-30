# IncidentGraph AI — Professional 3-Minute Demo Voiceover Script

> **Tone**: Confident, articulate, senior engineer / staff SRE.  
> **Pacing**: Steady, deliberate (~130–140 words per minute).  
> **Total Duration**: ~3 minutes (180 seconds).  
> **Accompanying Video**: `docs/recordings/incident_graph_ai_recruiter_demo.mp4` *(Silent 1080p Screen Recording Walkthrough, 95s, no audio track. This script serves as the companion narration transcript for live presentation or voiceover recording).*

---

### [0:00 – 0:25] Scene 1: The Real-World Problem — Alert Storms

**(Visual: Clean Overview Dashboard `/` at 1920x1080. Guided Demo ribbon visible, health stats green, live telemetry feed ticking.)**

> *"When a microservice incident strikes at 2 AM, the biggest bottleneck isn't fixing the bug—it's finding it.*
>
> *In distributed architectures, microservices are deeply coupled. When a core database suffers connection pool exhaustion, the latency immediately cascades upstream: payment gateways time out, order queues back up, and the API gateway triggers a flood of HTTP 504 errors.*
>
> *On-call engineers are inundated by dozens of simultaneous Slack and PagerDuty alerts. Most monitoring tools treat every alert equally, forcing teams to triage symptoms at the edge while the real fire burns three tiers deep.*
>
> *IncidentGraph AI is built to solve this exact problem."*

---

### [0:25 – 0:55] Scene 2: Inject a Failure — Deterministic Simulation

**(Visual: Navigate to `/simulator`. Select 'PostgreSQL Database Slowdown'. Click 'Inject Selected Scenario', then 'Advance Step'.)**

> *"To demonstrate this in action, we head to our Failure Simulator.*
>
> *We select a common high-severity scenario: PostgreSQL Database Slowdown. With one click, we inject an 800-millisecond query latency surge into our storage cluster.*
>
> *As we advance the simulation step, watch how our deterministic fault engine mirrors a genuine production incident: database connection pools saturate, which stalls synchronous transactions in the Inventory Service and Order Service.*
>
> *Within seconds, our telemetry pipeline detects abnormal latency deviations across multiple services and automatically opens an active incident."*

---

### [0:55 – 1:25] Scene 3: Visualize the Cascade — Service Dependency Graph

**(Visual: Navigate to `/service-map`. Interactive SVG topology graph renders. postgres-db highlighted in warning/degraded color. Click node to highlight blast radius.)**

> *"Next, we open the Service Dependency Map.*
>
> *Instead of sifting through fragmented dashboards or log dumps, engineers can visualize their entire microservice topology as a directed dependency graph.*
>
> *Here, services are organized cleanly into tiers—Edge Ingress, Core Business Logic, and Infrastructure Storage.*
>
> *Notice how the edges light up in amber and red: our breadth-first search traversal tracks the blast radius in real time, showing exactly how degradation in postgres-db is propagating upstream through order-service to the edge gateway."*

---

### [1:25 – 2:00] Scene 4: Explain the Diagnosis — Graph-Based Root-Cause Engine

**(Visual: Navigate to `/incidents`, click 'Investigate', select 'Ranked Root Causes' tab, click 'Re-Run DSA Root-Cause Engine', then toggle 'Evidence Timeline'.)**

> *"Now let's examine the diagnosis on the Incident Triage page.*
>
> *Rather than relying on black-box heuristics or LLM hallucinations, IncidentGraph AI uses a deterministic data structures and algorithms engine.*
>
> *Our engine evaluates three distinct mathematical signals:*
> 1. *First, anomaly severity using statistical z-scores.*
> 2. *Second, topological depth—favoring root dependencies over ingress proxies.*
> 3. *Third, temporal precedence—pinpointing which service degraded first.*
>
> *Using a binary heap priority queue, the engine assigns postgres-db as Candidate Number 1 with a 94 percent deterministic ranking score, while correctly discounting the API Gateway as merely a downstream victim.*
>
> *Switching to the Evidence Timeline, we see the chronological proof clearly laid out."*

---

### [2:00 – 2:35] Scene 5: AI Investigation — Evidence-Grounded Replay

**(Visual: Click 'AI Investigation' tab. Banner displays 'AI Provider Standby'. Click 'Run Simulation Replay Demo'. Generated report expands with verified impact and checks.)**

> *"For deeper triage, IncidentGraph AI includes an evidence-grounded AI investigator.*
>
> *Production reliability demands absolute truthfulness. In public production, where no external LLM key is configured, the system transparently indicates standby mode and activates our deterministic simulation replay engine.*
>
> *Notice how every single claim in this report is strictly grounded in telemetry evidence IDs validated by Zod schemas and database cross-checking.*
>
> *The report delivers concise, actionable intelligence: verified latency impact, the blast radius, specific read-only diagnostic queries like checking active database locks, and safe remediation options with clear prerequisites."*

---

### [2:35 – 3:00] Scene 6: Engineering Architecture & Production Hardening

**(Visual: Navigate to `/settings` & `/api/health`. Show Grafana Cloud, OpenTelemetry, Neon PostgreSQL, and production safety guards. Return to dashboard.)**

> *"Under the hood, IncidentGraph AI is built with modern enterprise standards: Next.js 16 App Router, TypeScript, Neon Serverless PostgreSQL with Prisma ORM, and full OpenTelemetry instrumentation with Grafana Cloud connectivity probes verified over HTTPS.*
>
> *Furthermore, the application is hardened for public production: destructive resets are blocked with HTTP 403 Forbidden, and active incidents are transactionally shielded from automated pruning.*
>
> *IncidentGraph AI delivers deterministic precision, real-time observability, and AI safety to drastically cut MTTR in complex microservice environments.*
>
> *Thank you for watching."*
