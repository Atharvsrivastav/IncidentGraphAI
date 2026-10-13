import http from "http";
import { startOtlpReceiver, startPrometheusServer, startJaegerServer } from "./mock-observability";
import { server as gatewayServer } from "./gateway/server";
import { server as orderServer } from "./order/server";
import { server as paymentServer } from "./payment/server";
import { server as inventoryServer } from "./inventory/server";
import { SamplePostgresClient } from "./shared/database";

export interface RunnerOptions {
  startMockObservability?: boolean;
}

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = http.createServer();
    tester.once("error", (err: { code?: string }) => {
      if (err.code === "EADDRINUSE") resolve(true);
      else resolve(false);
    });
    tester.once("listening", () => {
      tester.close(() => resolve(false));
    });
    tester.listen(port);
  });
}

export async function startSampleEcosystem(options: RunnerOptions = {}) {
  console.log("=== Starting Sample Microservices & Observability Ecosystem ===");

  // 1. Probe database readiness
  const db = SamplePostgresClient.getInstance();
  const dbHealth = await db.checkReadiness();
  if (dbHealth.ready) {
    console.log("[Sample Runner] Connected to genuine PostgreSQL on port 5432 (Tables verified).");
  } else {
    console.log(`[Sample Runner] Notice: PostgreSQL is offline (${dbHealth.error || "connection refused"}).`);
    console.log("[Sample Runner] Services will use in-memory client fallback with explicit diagnostic reporting.");
  }

  // 2. Decide whether to launch dev mock observability server
  let otlp: http.Server | null = null;
  let prom: http.Server | null = null;
  let jaeger: http.Server | null = null;

  const port4318Busy = await isPortInUse(4318);
  const port9090Busy = await isPortInUse(9090);

  const hasCloudConfig = Boolean(
    process.env.GRAFANA_CLOUD_OTLP_ENDPOINT?.trim() &&
    process.env.GRAFANA_CLOUD_INGESTION_TOKEN?.trim()
  );

  const shouldStartMock = options.startMockObservability ?? (
    !hasCloudConfig && process.env.START_MOCK_OBSERVABILITY !== "false" && !port4318Busy && !port9090Busy
  );

  if (hasCloudConfig && !options.startMockObservability) {
    const safeEndpoint = process.env.GRAFANA_CLOUD_OTLP_ENDPOINT?.trim() || "";
    console.log(`[Sample Runner] ☁ Grafana Cloud configuration detected (${safeEndpoint}). Microservices export directly to Cloud OTLP Gateway.`);
  } else if (shouldStartMock) {
    console.log("[Sample Runner] No cloud or external OTel stack detected. Starting in-process Dev Mock Observability Server (MOCK_EMULATION)...");
    otlp = startOtlpReceiver(4318);
    prom = startPrometheusServer(9090);
    jaeger = startJaegerServer(16686);
  } else {
    console.log("[Sample Runner] Using existing/Docker observability stack on ports 4318, 9090, 16686. Skipping mock servers.");
  }

  // 3. Start microservices
  gatewayServer.listen(4000, () => console.log("[Sample Gateway] Listening on http://localhost:4000"));
  orderServer.listen(4001, () => console.log("[Sample Order Service] Listening on http://localhost:4001"));
  paymentServer.listen(4002, () => console.log("[Sample Payment Service] Listening on http://localhost:4002"));
  inventoryServer.listen(4003, () => console.log("[Sample Inventory Service] Listening on http://localhost:4003"));

  return {
    isMockRunning: Boolean(shouldStartMock),
    isPostgresConnected: dbHealth.ready,
    close: async () => {
      otlp?.close();
      prom?.close();
      jaeger?.close();
      gatewayServer.close();
      orderServer.close();
      paymentServer.close();
      inventoryServer.close();
      await db.close();
    },
  };
}

if (require.main === module) {
  void startSampleEcosystem();
}
