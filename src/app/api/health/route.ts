import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";
import { TelemetryManager } from "@/lib/telemetry/telemetryManager";
import { getAIProviderStatus } from "@/lib/ai/providers/factory";
import { ensureDatabaseSeeded } from "@/lib/db/ensure-seeded";
import { validateDatabaseIsolation } from "@/lib/db/isolation-validator";

export async function GET() {
  const startTime = Date.now();
  let dbStatus: "connected" | "disconnected" = "disconnected";
  let servicesCount = 0;
  let dbError: string | null = null;

  try {
    // 1. Verify Database Connectivity & Auto-Seed if empty
    await prisma.$queryRaw`SELECT 1`;
    const seedResult = await ensureDatabaseSeeded();
    servicesCount = seedResult.servicesCount;
    dbStatus = "connected";
  } catch (err: unknown) {
    dbStatus = "disconnected";
    dbError = err instanceof Error ? err.message : "Database ping failed";
  }

  // 2. Telemetry Manager & Backend Diagnostics
  const telemetryMgr = TelemetryManager.getInstance();
  const telemetryMode = telemetryMgr.getMode();
  let backendHealth;
  try {
    backendHealth = await telemetryMgr.getBackendHealth();
  } catch (err) {
    backendHealth = {
      prometheusAvailable: false,
      jaegerAvailable: false,
      isMockBackend: false,
      isCloudBackend: false,
      cloudConfigured: Boolean(
        process.env.GRAFANA_CLOUD_OTLP_ENDPOINT &&
        process.env.GRAFANA_CLOUD_PROMETHEUS_URL
      ),
      backendType: "UNAVAILABLE" as const,
      details: err instanceof Error ? err.message : "Failed to query telemetry backend health",
    };
  }

  // 3. AI Provider Status
  const aiStatus = getAIProviderStatus();

  // 4. Overall Health Condition
  const isHealthy = dbStatus === "connected";
  const statusCode = isHealthy ? 200 : 503;

  const dbUrl = process.env.DATABASE_URL || "file:./dev.db";
  const dbProvider = dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://")
    ? "postgresql"
    : "sqlite";
  const isolationResult = validateDatabaseIsolation(dbUrl, process.env.E2E_ISOLATED);
  const isIsolated = isolationResult.isIsolated;

  return NextResponse.json(
    {
      status: isHealthy ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - startTime,
      version: "0.1.0",
      environment: process.env.NODE_ENV || "development",
      database: {
        status: dbStatus,
        provider: dbProvider,
        servicesCount,
        error: dbError,
        isIsolated,
      },
      telemetry: {
        mode: telemetryMode,
        grafanaCloudConfigured: backendHealth.cloudConfigured,
        backendType: backendHealth.backendType,
        prometheusAvailable: backendHealth.prometheusAvailable,
        tempoAvailable: backendHealth.jaegerAvailable,
        details: backendHealth.details,
      },
      aiProvider: {
        provider: aiStatus.providerName,
        model: aiStatus.modelName,
        isConfigured: aiStatus.isConfigured,
        details: aiStatus.details,
      },
    },
    { status: statusCode }
  );
}
