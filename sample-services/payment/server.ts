import http from "http";
import { initServiceTelemetry } from "../shared/telemetry";
import { SamplePostgresClient } from "../shared/database";
import { SpanStatusCode, context } from "@opentelemetry/api";

const PORT = Number(process.env.SAMPLE_PAYMENT_PORT) || 4002;
const SERVICE_NAME = "payment-service";
const telemetry = initServiceTelemetry(SERVICE_NAME);
const db = SamplePostgresClient.getInstance();

let serviceDelayMs = 0;
let serviceFailureRate = 0;

export function setPaymentFault(delayMs: number, failureRate: number = 0) {
  serviceDelayMs = delayMs;
  serviceFailureRate = failureRate;
  if (failureRate > 0.2 || delayMs > 2000) {
    telemetry.setHealthStatus(0);
  } else if (failureRate > 0 || delayMs > 500) {
    telemetry.setHealthStatus("DEGRADED");
  }
}

export function resetPaymentFault() {
  serviceDelayMs = 0;
  serviceFailureRate = 0;
  telemetry.setHealthStatus(1);
}

export const server = http.createServer(async (req, res) => {
  const start = performance.now();
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const carrier: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") carrier[key] = value;
  }

  const { span, ctx } = telemetry.startSpan(`HTTP ${req.method} ${url.pathname}`, carrier);

  await context.with(ctx, async () => {
    try {
      span.setAttribute("http.method", req.method || "GET");
      span.setAttribute("http.url", url.pathname);
      span.setAttribute("service.name", SERVICE_NAME);

      if (serviceDelayMs > 0) {
        await new Promise((r) => setTimeout(r, serviceDelayMs));
      }

      if (serviceFailureRate > 0 && Math.random() < serviceFailureRate) {
        throw new Error("Payment gateway connection timeout");
      }

      if (req.method === "POST" && url.pathname === "/payments/authorize") {
        // Record payment ledger transaction in Database
        const dbResult = await db.query(
          "INSERT",
          "payment_transactions",
          "INSERT INTO payment_transactions (tx_id, amount, status) VALUES ('tx_test', 99.00, 'AUTHORIZED')",
          { txId: "tx_" + Date.now(), status: "AUTHORIZED" }
        );

        telemetry.requestCounter.add(1, { service: SERVICE_NAME, status: "200" });
        telemetry.log("info", "Payment authorized successfully", { dbDuration: dbResult.durationMs });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, transactionId: "tx_" + Date.now(), status: "AUTHORIZED" }));
        telemetry.endSpan(span, SpanStatusCode.OK);
        return;
      }

      if (url.pathname === "/metrics") {
        telemetry.handleMetricsRequest(res);
        telemetry.endSpan(span, SpanStatusCode.OK);
        return;
      }

      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "HEALTHY", service: SERVICE_NAME }));
        telemetry.endSpan(span, SpanStatusCode.OK);
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Route not found" }));
      telemetry.endSpan(span, SpanStatusCode.OK);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.errorCounter.add(1, { service: SERVICE_NAME, status: "500" });
      telemetry.log("error", `Payment processing error: ${msg}`, { error: msg });
      telemetry.endSpan(span, SpanStatusCode.ERROR, msg);

      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    } finally {
      const durationSec = (performance.now() - start) / 1000;
      telemetry.durationHistogram.record(durationSec, { service: SERVICE_NAME });
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[Payment Service] Listening on http://localhost:${PORT}`);
  });
}
