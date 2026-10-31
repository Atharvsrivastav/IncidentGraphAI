import http from "http";
import { initServiceTelemetry } from "../shared/telemetry";
import { SpanStatusCode, context } from "@opentelemetry/api";
import { SamplePostgresClient } from "../shared/database";
import { setOrderFault, resetOrderFault } from "../order/server";
import { setPaymentFault, resetPaymentFault } from "../payment/server";
import { setInventoryFault, resetInventoryFault } from "../inventory/server";

const PORT = Number(process.env.SAMPLE_GATEWAY_PORT) || 4000;
const ORDER_URL = process.env.SAMPLE_ORDER_URL || `http://localhost:${process.env.SAMPLE_ORDER_PORT || 4001}`;
const INVENTORY_URL = process.env.SAMPLE_INVENTORY_URL || `http://localhost:${process.env.SAMPLE_INVENTORY_PORT || 4003}`;

const SERVICE_NAME = "api-gateway";
const telemetry = initServiceTelemetry(SERVICE_NAME);
const db = SamplePostgresClient.getInstance();

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

      // Fault control experiment endpoints for safe demonstration
      if (req.method === "POST" && url.pathname === "/debug/inject-fault") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body || "{}");

        if (parsed.type === "db-slowdown") {
          db.setFault({ latencyMs: parsed.latencyMs || 1500 });
        } else if (parsed.type === "order-timeout" || parsed.type === "service-timeout") {
          setOrderFault(parsed.delayMs || 3000, parsed.failureRate || 0);
        } else if (parsed.type === "payment-failure") {
          setPaymentFault(parsed.delayMs || 100, parsed.failureRate || 0.8);
        } else if (parsed.type === "inventory-slowdown") {
          setInventoryFault(parsed.delayMs || 1200, 0);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "FAULT_INJECTED", details: parsed }));
        telemetry.endSpan(span, SpanStatusCode.OK);
        return;
      }

      if (req.method === "POST" && url.pathname === "/debug/restore") {
        db.resetFault();
        resetOrderFault();
        resetPaymentFault();
        resetInventoryFault();
        telemetry.setHealthStatus(1);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "BASELINE_RESTORED" }));
        telemetry.endSpan(span, SpanStatusCode.OK);
        return;
      }

      // Proxy /api/orders -> Order Service
      if (req.method === "POST" && url.pathname === "/api/orders") {
        const outgoingHeaders: Record<string, string> = {
          "Content-Type": "application/json",
        };
        telemetry.injectTraceContext(outgoingHeaders);

        const callSpan = telemetry.tracer.startSpan("proxy.order-service", undefined, context.active());
        const orderRes = await fetch(`${ORDER_URL}/orders`, {
          method: "POST",
          headers: outgoingHeaders,
          body: JSON.stringify({ customer: "guest_user", items: [{ sku: "ITEM-101", qty: 1 }] }),
        });
        const orderData = await orderRes.json();
        callSpan.setAttribute("http.status_code", orderRes.status);

        if (!orderRes.ok) {
          callSpan.setStatus({ code: SpanStatusCode.ERROR, message: `Order Service failed: ${orderRes.status}` });
          callSpan.end();
          throw new Error(`Downstream Order Service returned ${orderRes.status}: ${JSON.stringify(orderData)}`);
        }
        callSpan.setStatus({ code: SpanStatusCode.OK });
        callSpan.end();

        telemetry.requestCounter.add(1, { service: SERVICE_NAME, status: "201" });
        telemetry.log("info", "Order request successfully routed and fulfilled");

        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(orderData));
        telemetry.endSpan(span, SpanStatusCode.OK);
        return;
      }

      // Proxy /api/inventory/:sku -> Inventory Service
      if (req.method === "GET" && url.pathname.startsWith("/api/inventory/")) {
        const sku = url.pathname.replace("/api/inventory/", "");
        const outgoingHeaders: Record<string, string> = {};
        telemetry.injectTraceContext(outgoingHeaders);

        const invRes = await fetch(`${INVENTORY_URL}/inventory/${sku}`, {
          method: "GET",
          headers: outgoingHeaders,
        });
        const invData = await invRes.json();

        telemetry.requestCounter.add(1, { service: SERVICE_NAME, status: String(invRes.status) });
        res.writeHead(invRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(invData));
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
      res.end(JSON.stringify({ error: "Gateway route not found" }));
      telemetry.endSpan(span, SpanStatusCode.OK);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.errorCounter.add(1, { service: SERVICE_NAME, status: "502" });
      telemetry.log("error", `API Gateway upstream failure: ${msg}`, { error: msg });
      telemetry.endSpan(span, SpanStatusCode.ERROR, msg);

      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    } finally {
      const durationSec = (performance.now() - start) / 1000;
      telemetry.durationHistogram.record(durationSec, { service: SERVICE_NAME });
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[API Gateway] Listening on http://localhost:${PORT}`);
  });
}
