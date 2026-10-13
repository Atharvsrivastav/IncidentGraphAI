export interface SeedService {
  id: string;
  name: string;
  serviceType: string;
  description: string;
  status: "HEALTHY" | "DEGRADED" | "DOWN";
  baselineLatency: number;
  currentLatency: number;
  baselineErrorRate: number;
  currentErrorRate: number;
  requestRate: number;
  tier: number;
}

export interface SeedDependency {
  sourceServiceId: string;
  targetServiceId: string;
  dependencyType: "SYNC_HTTP" | "ASYNC_QUEUE" | "DATABASE_CONN";
  timeoutThreshold: number;
  criticality: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
}

export const INITIAL_SERVICES: SeedService[] = [
  {
    id: "api-gateway",
    name: "API Gateway",
    serviceType: "GATEWAY",
    description: "Edge ingress proxy handling SSL termination, rate limiting, and request routing.",
    status: "HEALTHY",
    baselineLatency: 22,
    currentLatency: 22,
    baselineErrorRate: 0.1,
    currentErrorRate: 0.1,
    requestRate: 1450,
    tier: 1,
  },
  {
    id: "auth-service",
    name: "Authentication Service",
    serviceType: "AUTH",
    description: "OAuth2 and JWT token validation service verifying user credentials and sessions.",
    status: "HEALTHY",
    baselineLatency: 16,
    currentLatency: 16,
    baselineErrorRate: 0.05,
    currentErrorRate: 0.05,
    requestRate: 1200,
    tier: 2,
  },
  {
    id: "order-service",
    name: "Order Service",
    serviceType: "ORDER",
    description: "Core transactional order processing and checkout orchestration engine.",
    status: "HEALTHY",
    baselineLatency: 42,
    currentLatency: 42,
    baselineErrorRate: 0.15,
    currentErrorRate: 0.15,
    requestRate: 520,
    tier: 2,
  },
  {
    id: "payment-service",
    name: "Payment Gateway Service",
    serviceType: "PAYMENT",
    description: "Processes payment intents, card authorisations, and ledger accounting.",
    status: "HEALTHY",
    baselineLatency: 65,
    currentLatency: 65,
    baselineErrorRate: 0.08,
    currentErrorRate: 0.08,
    requestRate: 240,
    tier: 2,
  },
  {
    id: "inventory-service",
    name: "Inventory Service",
    serviceType: "INVENTORY",
    description: "Maintains real-time stock availability, reservation locks, and warehouse SKUs.",
    status: "HEALTHY",
    baselineLatency: 32,
    currentLatency: 32,
    baselineErrorRate: 0.12,
    currentErrorRate: 0.12,
    requestRate: 360,
    tier: 2,
  },
  {
    id: "postgres-db",
    name: "PostgreSQL Database Cluster",
    serviceType: "DATABASE",
    description: "Primary relational storage cluster backing order, payment, and inventory records.",
    status: "HEALTHY",
    baselineLatency: 11,
    currentLatency: 11,
    baselineErrorRate: 0.02,
    currentErrorRate: 0.02,
    requestRate: 1550,
    tier: 3,
  },
  {
    id: "notification-service",
    name: "Notification Service",
    serviceType: "NOTIFICATION",
    description: "Dispatches transactional emails, webhooks, and SMS notifications.",
    status: "HEALTHY",
    baselineLatency: 38,
    currentLatency: 38,
    baselineErrorRate: 0.25,
    currentErrorRate: 0.25,
    requestRate: 190,
    tier: 2,
  },
];

// Convention: source calls target (source depends on target)
export const INITIAL_DEPENDENCIES: SeedDependency[] = [
  {
    sourceServiceId: "api-gateway",
    targetServiceId: "auth-service",
    dependencyType: "SYNC_HTTP",
    timeoutThreshold: 800,
    criticality: "CRITICAL",
  },
  {
    sourceServiceId: "api-gateway",
    targetServiceId: "order-service",
    dependencyType: "SYNC_HTTP",
    timeoutThreshold: 2000,
    criticality: "CRITICAL",
  },
  {
    sourceServiceId: "order-service",
    targetServiceId: "payment-service",
    dependencyType: "SYNC_HTTP",
    timeoutThreshold: 2500,
    criticality: "CRITICAL",
  },
  {
    sourceServiceId: "order-service",
    targetServiceId: "inventory-service",
    dependencyType: "SYNC_HTTP",
    timeoutThreshold: 1500,
    criticality: "HIGH",
  },
  {
    sourceServiceId: "order-service",
    targetServiceId: "postgres-db",
    dependencyType: "DATABASE_CONN",
    timeoutThreshold: 1000,
    criticality: "CRITICAL",
  },
  {
    sourceServiceId: "payment-service",
    targetServiceId: "postgres-db",
    dependencyType: "DATABASE_CONN",
    timeoutThreshold: 1000,
    criticality: "CRITICAL",
  },
  {
    sourceServiceId: "inventory-service",
    targetServiceId: "postgres-db",
    dependencyType: "DATABASE_CONN",
    timeoutThreshold: 1000,
    criticality: "CRITICAL",
  },
  {
    sourceServiceId: "order-service",
    targetServiceId: "notification-service",
    dependencyType: "ASYNC_QUEUE",
    timeoutThreshold: 3000,
    criticality: "LOW",
  },
];
