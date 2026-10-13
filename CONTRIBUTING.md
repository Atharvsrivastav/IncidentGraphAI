# Contributing to IncidentGraph AI

Thank you for your interest in contributing to **IncidentGraph AI**! Whether you are fixing a bug, adding new DSA graph algorithms, expanding OpenTelemetry instrumentation, or improving documentation, your contributions are welcome.

Please review this guide before submitting code or opening pull requests.

---

## 1. Code of Conduct & Core Engineering Standards

Every contribution to IncidentGraph AI must uphold the following engineering standards:

1. **Strict Type Safety**: Use strict TypeScript without `any`. Validate external and user inputs using Zod.
2. **Immutability First**: Avoid direct mutation of state, graph nodes, or function arguments. Use object/array spreads or functional transforms.
3. **Deterministic & Explainable Algorithms**: The root-cause ranking engine must remain explainable and heuristic-based. **Never introduce ground-truth leakage** (the RCA engine must never read hidden simulator scenario state; it must only analyze observable telemetry, timestamps, and graph topology).
4. **Zero Secrets**: Never commit tokens, passwords, private endpoints, or `.env` files. Ensure diagnostic outputs and error logs always sanitize sensitive credentials.
5. **Clean Verification**: All pull requests must pass the automated verification loop:
   - `npm test` (Unit and integration tests)
   - `npm run lint` (ESLint Next.js rules)
   - `npx tsc --noEmit` (TypeScript typecheck)
   - `npm run build` (Next.js production build)

---

## 2. Local Development Setup

IncidentGraph AI is built to run on standard developer workstations, including zero-admin or corporate-restricted laptops, without requiring Docker or WSL.

### Prerequisites
- **Node.js**: v18+ (v20+ LTS recommended)
- **npm**: v9+
- **Git**: v2+

### Step-by-Step Instructions

1. **Fork and Clone the Repository**:
   ```bash
   git clone https://github.com/Atharvsrivastav/IncidentGraphAI.git
   cd IncidentGraphAI
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   ```bash
   cp .env.example .env
   ```
   *Note: For basic local mode and running tests, no external tokens or cloud endpoints are needed. The default `DATABASE_URL="file:./dev.db"` runs directly against SQLite.*

4. **Initialize Local Database & Topology Seed**:
   ```bash
   npx prisma generate
   npx prisma db push
   npm run db:seed
   ```

5. **Start Development Server**:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) to view the console.

---

## 3. Available Development Scripts

| Command | Description |
|---|---|
| `npm run dev` | Starts the Next.js development server on port 3000 |
| `npm test` | Runs the full Vitest automated test suite |
| `npm run test:watch` | Runs Vitest in interactive watch mode |
| `npm run lint` | Runs ESLint validation across all source files |
| `npx tsc --noEmit` | Validates TypeScript types across the entire project |
| `npm run build` | Compiles optimized Next.js production build |
| `npm run config:check` | Runs sanitized, masked configuration audit |
| `npm run sample:start` | Boots the 4 sample microservices mesh on ports 4000–4003 |
| `npm run sample:traffic` | Generates synthetic HTTP traffic across the sample mesh |
| `npm run test:cloud` | Runs 6-stage end-to-end verification against Grafana Cloud (requires configured credentials) |

---

## 4. Architectural Boundaries

- **`src/lib/algorithms/`**: Pure, deterministic algorithms (`DirectedGraph`, `PriorityQueue`, `SlidingWindow`, `RootCauseEngine`). These files should have zero direct database or network dependencies, making them 100% unit-testable.
- **`src/lib/telemetry/`**: OpenTelemetry clients, Prometheus PromQL queries, Tempo/Jaeger trace parsers, and the dual-mode `TelemetryManager`.
- **`sample-services/`**: Standalone Express/HTTP microservices representing a distributed e-commerce workflow with W3C trace context propagation.
- **`src/app/api/`**: Next.js App Router route handlers with structured error handling and Zod request validation.

---

## 5. Pull Request Workflow

1. **Create a Feature Branch**:
   ```bash
   git checkout -b feat/your-feature-name
   # or
   git checkout -b fix/your-bugfix-name
   ```

2. **Write Tests First (TDD)**:
   - For algorithm changes, add test cases in `tests/algorithms.test.ts`.
   - For telemetry changes, add test cases in `tests/telemetry.test.ts`.
   - For API route changes, add test cases in `tests/api.test.ts`.

3. **Verify Locally**:
   Run the full verification gate before opening a pull request:
   ```bash
   npm test
   npm run lint
   npx tsc --noEmit
   npm run build
   ```

4. **Commit with Clear Messages**:
   Follow conventional commits format:
   - `feat: add Tarjan strongly connected components detector`
   - `fix: prevent divide-by-zero when baseline latency is zero`
   - `docs: update Grafana Cloud setup instructions`

5. **Submit Pull Request**:
   - Provide a clear summary of what changed and why.
   - Include test output or screenshots demonstrating the change.
   - Ensure the automated GitHub Actions CI workflow turns green.

Thank you for helping make distributed system incident investigation smarter and more accessible!
