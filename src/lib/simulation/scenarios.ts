export interface ScenarioDefinition {
  id: string;
  name: string;
  targetServiceId: string;
  defaultSeverity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  failureType: "LATENCY_SPIKE" | "SERVICE_OUTAGE" | "DEPENDENCY_TIMEOUT" | "AUTH_FAILURE" | "HIGH_ERROR_RATE" | "NETWORK_PARTITION";
  description: string;
  steps: {
    step: number;
    description: string;
    affectedServices: {
      serviceId: string;
      status: "HEALTHY" | "DEGRADED" | "DOWN";
      latencyMultiplier: number; // multiplied with baseline
      addedLatencyMs: number;
      errorRate: number; // percentage
      reason: string;
    }[];
  }[];
}

export const SIMULATION_SCENARIOS: Record<string, ScenarioDefinition> = {
  "database-slowdown": {
    id: "database-slowdown",
    name: "PostgreSQL Database Slowdown",
    targetServiceId: "postgres-db",
    defaultSeverity: "HIGH",
    failureType: "LATENCY_SPIKE",
    description: "Database connection contention and unindexed slow queries cause query latency to surge, cascading into dependent transactional services.",
    steps: [
      {
        step: 1,
        description: "PostgreSQL query execution latency surges due to disk I/O wait and lock contention.",
        affectedServices: [
          {
            serviceId: "postgres-db",
            status: "DEGRADED",
            latencyMultiplier: 45.0, // 11ms -> ~500ms
            addedLatencyMs: 480,
            errorRate: 4.5,
            reason: "High disk I/O wait and locks on orders/inventory tables",
          },
        ],
      },
      {
        step: 2,
        description: "Direct database dependents (Order, Payment, Inventory) observe query latency elevation.",
        affectedServices: [
          {
            serviceId: "postgres-db",
            status: "DEGRADED",
            latencyMultiplier: 75.0, // ~825ms
            addedLatencyMs: 800,
            errorRate: 8.0,
            reason: "Connection pool exhaustion warning threshold reached",
          },
          {
            serviceId: "order-service",
            status: "DEGRADED",
            latencyMultiplier: 12.0, // 42ms -> ~500ms
            addedLatencyMs: 460,
            errorRate: 14.0,
            reason: "Synchronous SQL transactions waiting on PostgreSQL connection pool",
          },
          {
            serviceId: "payment-service",
            status: "DEGRADED",
            latencyMultiplier: 8.0, // 65ms -> ~520ms
            addedLatencyMs: 450,
            errorRate: 9.0,
            reason: "Ledger commit queries delayed waiting on database locks",
          },
          {
            serviceId: "inventory-service",
            status: "DEGRADED",
            latencyMultiplier: 10.0, // 32ms -> ~320ms
            addedLatencyMs: 290,
            errorRate: 11.0,
            reason: "Stock SKU update queries experiencing thread pool queueing",
          },
        ],
      },
      {
        step: 3,
        description: "Order Service exceeds downstream client timeout thresholds; API Gateway reports 504 Gateway Timeouts.",
        affectedServices: [
          {
            serviceId: "postgres-db",
            status: "DEGRADED",
            latencyMultiplier: 90.0,
            addedLatencyMs: 950,
            errorRate: 12.5,
            reason: "Severe query backlog and buffer pool saturation",
          },
          {
            serviceId: "order-service",
            status: "DOWN",
            latencyMultiplier: 25.0, // >1000ms
            addedLatencyMs: 1400,
            errorRate: 48.0,
            reason: "Database connection pool exhausted; queries timing out after 1000ms",
          },
          {
            serviceId: "payment-service",
            status: "DEGRADED",
            latencyMultiplier: 12.0,
            addedLatencyMs: 700,
            errorRate: 22.0,
            reason: "Transaction rollbacks increasing due to database timeout errors",
          },
          {
            serviceId: "api-gateway",
            status: "DEGRADED",
            latencyMultiplier: 18.0,
            addedLatencyMs: 850,
            errorRate: 36.0,
            reason: "504 Gateway Timeout responses on /api/orders routes",
          },
        ],
      },
    ],
  },

  "database-outage": {
    id: "database-outage",
    name: "PostgreSQL Database Outage",
    targetServiceId: "postgres-db",
    defaultSeverity: "CRITICAL",
    failureType: "SERVICE_OUTAGE",
    description: "PostgreSQL database primary node crashes and is completely unreachable, immediately disrupting all stateful services.",
    steps: [
      {
        step: 1,
        description: "PostgreSQL cluster crashes; TCP connections refused.",
        affectedServices: [
          {
            serviceId: "postgres-db",
            status: "DOWN",
            latencyMultiplier: 1.0,
            addedLatencyMs: 0,
            errorRate: 100.0,
            reason: "PostgreSQL connection refused (ECONNREFUSED): daemon terminated",
          },
        ],
      },
      {
        step: 2,
        description: "Dependent services encounter instant connection drop exceptions.",
        affectedServices: [
          {
            serviceId: "postgres-db",
            status: "DOWN",
            latencyMultiplier: 1.0,
            addedLatencyMs: 0,
            errorRate: 100.0,
            reason: "Cluster offline",
          },
          {
            serviceId: "order-service",
            status: "DOWN",
            latencyMultiplier: 2.0,
            addedLatencyMs: 100,
            errorRate: 92.0,
            reason: "Cannot acquire database connection for order state storage",
          },
          {
            serviceId: "payment-service",
            status: "DOWN",
            latencyMultiplier: 2.0,
            addedLatencyMs: 80,
            errorRate: 88.0,
            reason: "Payment transaction ledger persistence unavailable",
          },
          {
            serviceId: "inventory-service",
            status: "DOWN",
            latencyMultiplier: 2.0,
            addedLatencyMs: 70,
            errorRate: 85.0,
            reason: "Inventory catalog store connection dropped",
          },
        ],
      },
      {
        step: 3,
        description: "API Gateway returns 502 Bad Gateway across all business routes.",
        affectedServices: [
          {
            serviceId: "api-gateway",
            status: "DOWN",
            latencyMultiplier: 5.0,
            addedLatencyMs: 150,
            errorRate: 78.0,
            reason: "Upstream cluster failures on order, payment, and inventory backends",
          },
        ],
      },
    ],
  },

  "payment-failure": {
    id: "payment-failure",
    name: "Payment Gateway Service Failure",
    targetServiceId: "payment-service",
    defaultSeverity: "HIGH",
    failureType: "HIGH_ERROR_RATE",
    description: "Third-party payment settlement connector throws 500 errors. Affects Order Service checkout while database and auth remain healthy.",
    steps: [
      {
        step: 1,
        description: "Payment Service external acquirer integration starts failing card charges.",
        affectedServices: [
          {
            serviceId: "payment-service",
            status: "DOWN",
            latencyMultiplier: 3.0,
            addedLatencyMs: 250,
            errorRate: 85.0,
            reason: "Payment intent processing failures: TLS handshake timeouts to acquirer",
          },
        ],
      },
      {
        step: 2,
        description: "Order Service checkout calls fail on payment capture.",
        affectedServices: [
          {
            serviceId: "payment-service",
            status: "DOWN",
            latencyMultiplier: 3.5,
            addedLatencyMs: 300,
            errorRate: 90.0,
            reason: "Downstream acquirer outage",
          },
          {
            serviceId: "order-service",
            status: "DEGRADED",
            latencyMultiplier: 4.0,
            addedLatencyMs: 180,
            errorRate: 42.0,
            reason: "Checkout payment authorization requests failing with 502",
          },
        ],
      },
      {
        step: 3,
        description: "API Gateway observes elevated checkout errors; Auth, Inventory, DB unaffected.",
        affectedServices: [
          {
            serviceId: "api-gateway",
            status: "DEGRADED",
            latencyMultiplier: 2.5,
            addedLatencyMs: 90,
            errorRate: 24.0,
            reason: "Partial ingress failure on /checkout routes",
          },
        ],
      },
    ],
  },

  "inventory-timeout": {
    id: "inventory-timeout",
    name: "Inventory Service Timeout",
    targetServiceId: "inventory-service",
    defaultSeverity: "MEDIUM",
    failureType: "DEPENDENCY_TIMEOUT",
    description: "Lock contention on inventory stock reservations causes responses to exceed 1500ms timeout threshold.",
    steps: [
      {
        step: 1,
        description: "Inventory Service stock lock acquisition stalls.",
        affectedServices: [
          {
            serviceId: "inventory-service",
            status: "DEGRADED",
            latencyMultiplier: 50.0, // 32ms -> ~1600ms
            addedLatencyMs: 1600,
            errorRate: 15.0,
            reason: "Row-level lock queue on high-demand SKU catalog",
          },
        ],
      },
      {
        step: 2,
        description: "Order Service stock checks time out after 1500ms threshold.",
        affectedServices: [
          {
            serviceId: "inventory-service",
            status: "DOWN",
            latencyMultiplier: 65.0,
            addedLatencyMs: 2100,
            errorRate: 35.0,
            reason: "Request queue overflow: response latency >2000ms",
          },
          {
            serviceId: "order-service",
            status: "DEGRADED",
            latencyMultiplier: 15.0,
            addedLatencyMs: 800,
            errorRate: 30.0,
            reason: "Inventory stock reservation client timed out after 1500ms",
          },
        ],
      },
    ],
  },

  "auth-failure": {
    id: "auth-failure",
    name: "Authentication Service Outage",
    targetServiceId: "auth-service",
    defaultSeverity: "CRITICAL",
    failureType: "AUTH_FAILURE",
    description: "JWT token validation key rotation misconfiguration causes Auth Service to reject all ingress tokens.",
    steps: [
      {
        step: 1,
        description: "Auth Service signature validation keys fail to load.",
        affectedServices: [
          {
            serviceId: "auth-service",
            status: "DOWN",
            latencyMultiplier: 2.0,
            addedLatencyMs: 50,
            errorRate: 98.0,
            reason: "JWKS keystore verification failed: invalid certificate thumbprint",
          },
        ],
      },
      {
        step: 2,
        description: "API Gateway blocks incoming traffic due to failed auth checks.",
        affectedServices: [
          {
            serviceId: "auth-service",
            status: "DOWN",
            latencyMultiplier: 2.0,
            addedLatencyMs: 50,
            errorRate: 99.0,
            reason: "Token validation service offline",
          },
          {
            serviceId: "api-gateway",
            status: "DOWN",
            latencyMultiplier: 3.0,
            addedLatencyMs: 60,
            errorRate: 85.0,
            reason: "401/500 Auth validation failure on ingress requests",
          },
        ],
      },
    ],
  },

  "gateway-errors": {
    id: "gateway-errors",
    name: "API Gateway Elevated Error Rate",
    targetServiceId: "api-gateway",
    defaultSeverity: "HIGH",
    failureType: "HIGH_ERROR_RATE",
    description: "Edge proxy rate limiter misconfiguration drops legitimate user traffic. All backend microservices remain completely healthy.",
    steps: [
      {
        step: 1,
        description: "API Gateway token bucket rate limiter aggressively throttles clients.",
        affectedServices: [
          {
            serviceId: "api-gateway",
            status: "DEGRADED",
            latencyMultiplier: 1.5,
            addedLatencyMs: 20,
            errorRate: 55.0,
            reason: "Ingress proxy 429 Too Many Requests / 502 misconfiguration",
          },
        ],
      },
    ],
  },

  "network-latency": {
    id: "network-latency",
    name: "Cross-Tier Network Latency Surge",
    targetServiceId: "order-service",
    defaultSeverity: "MEDIUM",
    failureType: "LATENCY_SPIKE",
    description: "VPC virtual switch packet drop and jitter injects +600ms latency into Order Service calls.",
    steps: [
      {
        step: 1,
        description: "Network interface packet loss on Order Service subnet.",
        affectedServices: [
          {
            serviceId: "order-service",
            status: "DEGRADED",
            latencyMultiplier: 1.0,
            addedLatencyMs: 650,
            errorRate: 18.0,
            reason: "TCP retransmission queueing and VPC network jitter",
          },
        ],
      },
      {
        step: 2,
        description: "Ingress Gateway experiences elevated response time.",
        affectedServices: [
          {
            serviceId: "order-service",
            status: "DEGRADED",
            latencyMultiplier: 1.0,
            addedLatencyMs: 750,
            errorRate: 22.0,
            reason: "Packet delay",
          },
          {
            serviceId: "api-gateway",
            status: "DEGRADED",
            latencyMultiplier: 1.0,
            addedLatencyMs: 700,
            errorRate: 15.0,
            reason: "Downstream latency propagation on /orders endpoint",
          },
        ],
      },
    ],
  },
};
