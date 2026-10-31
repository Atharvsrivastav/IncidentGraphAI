import http from "http";
import { initServiceTelemetry } from "../shared/telemetry";
import { SamplePostgresClient } from "../shared/database";
import { SpanStatusCode, context } from "@opentelemetry/api";

const PORT = Number(process.env.SAMPLE_ORDER_PORT) || 4001;
const INVENTORY_URL = process.env.SAMPLE_INVENTORY_URL || `http://localhost:${process.env.SAMPLE_INVENTORY_PORT || 4003}`;
const PAYMENT_URL = process.env.SAMPLE_PAYMENT_URL || `http://localhost:${process.env.SAMPLE_PAYMENT_PORT || 4002}`;

export const SERVICE_NAME = "order-service";
export const telemetry = initServiceTelemetry(SERVICE_NAME);
export const db = SamplePostgresClient.getInstance();

let serviceDelayMs = 0;
let serviceFailureRate = 0;

export function setOrderFault(delayMs: number, failureRate: number = 0) {
  serviceDelayMs = delayMs;
  serviceFailureRate = failureRate;
  if (failureRate > 0.2 || delayMs > 2000) {
    telemetry.setHealthStatus(0);
  } else if (failureRate > 0 || delayMs > 500) {
    telemetry.setHealthStatus("DEGRADED");
  }
}

export function resetOrderFault() {
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
        throw new Error("Order Service internal execution error");
      }

      if (req.method === "POST" && url.pathname === "/orders") {
        // Step 1: Call Inventory Service with W3C trace context propagation
        const outgoingHeaders: Record<string, string> = {
          "Content-Type": "application/json",
        };
        telemetry.injectTraceContext(outgoingHeaders);

        const invSpan = telemetry.tracer.startSpan("call.inventory.reserve", undefined, context.active());
        const invRes = await fetch(`${INVENTORY_URL}/inventory/reserve`, {
          method: "POST",
          headers: outgoingHeaders,
          body: JSON.stringify({ sku: "ITEM-101", quantity: 1 }),
        });
        invSpan.setAttribute("http.status_code", invRes.status);
        if (!invRes.ok) {
          invSpan.setStatus({ code: SpanStatusCode.ERROR, message: `Inventory returned HTTP ${invRes.status}` });
          invSpan.end();
          throw new Error(`Inventory reservation failed with status ${invRes.status}`);
        }
        invSpan.setStatus({ code: SpanStatusCode.OK });
        invSpan.end();

        // Step 2: Call Payment Service with W3C trace context propagation
        const paymentHeaders: Record<string, string> = {
          "Content-Type": "application/json",
        };
        telemetry.injectTraceContext(paymentHeaders);

        const paySpan = telemetry.tracer.startSpan("call.payment.authorize", undefined, context.active());
        const payRes = await fetch(`${PAYMENT_URL}/payments/authorize`, {
          method: "POST",
          headers: paymentHeaders,
          body: JSON.stringify({ amount: 99.00, currency: "USD" }),
        });
        paySpan.setAttribute("http.status_code", payRes.status);
        if (!payRes.ok) {
          paySpan.setStatus({ code: SpanStatusCode.ERROR, message: `Payment returned HTTP ${payRes.status}` });
          paySpan.end();
          throw new Error(`Payment authorization failed with status ${payRes.status}`);
        }
        paySpan.setStatus({ code: SpanStatusCode.OK });
        paySpan.end();

        // Step 3: Insert Order Record into Database
        const dbResult = await db.query(
          "INSERT",
          "orders",
          "INSERT INTO orders (id, amount, status) VALUES ('order_test', 99.00, 'CONFIRMED')",
          { orderId: "ord_" + Date.now() }
        );

        telemetry.requestCounter.add(1, { service: SERVICE_NAME, status: "201" });
        telemetry.log("info", "Order created and confirmed successfully", { dbDuration: dbResult.durationMs });

        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          orderId: "ord_" + Date.now(),
          status: "CONFIRMED",
          amount: 99.00,
        }));
        telemetry.endSpan(span, SpanStatusCode.OK);
        return;
      }

      if (req.method === "POST" && url.pathname === "/test/record-metric") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }
        let parsed: { verification_id?: string; count?: number; status?: string } = {};
        try {
          if (body) parsed = JSON.parse(body);
        } catch {
          // ignore
        }
        const verificationId = parsed.verification_id || "verify_manual_" + Date.now();
        const count = typeof parsed.count === "number" ? parsed.count : 1;
        const status = parsed.status || "synthetic";

        telemetry.recordSyntheticMetric(verificationId, count, status);
        telemetry.log("info", "Recorded synthetic test metric via HTTP endpoint", { verificationId, count, status });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          service: SERVICE_NAME,
          verification_id: verificationId,
          count,
          status,
        }));
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
      telemetry.log("error", `Order creation failed: ${msg}`, { error: msg });
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
    console.log(`[Order Service] Listening on http://localhost:${PORT}`);
  });
}
