import http from "http";
import { initServiceTelemetry } from "../shared/telemetry";
import { SamplePostgresClient } from "../shared/database";
import { SpanStatusCode, context } from "@opentelemetry/api";

const PORT = Number(process.env.SAMPLE_INVENTORY_PORT) || 4003;
const SERVICE_NAME = "inventory-service";
const telemetry = initServiceTelemetry(SERVICE_NAME);
const db = SamplePostgresClient.getInstance();

let serviceDelayMs = 0;
let serviceFailureRate = 0;

export function setInventoryFault(delayMs: number, failureRate: number = 0) {
  serviceDelayMs = delayMs;
  serviceFailureRate = failureRate;
}

export function resetInventoryFault() {
  serviceDelayMs = 0;
  serviceFailureRate = 0;
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
        throw new Error("Inventory service artificial fault triggered");
      }

      // Handle routes
      if (req.method === "GET" && url.pathname.startsWith("/inventory/")) {
        const sku = url.pathname.split("/")[2] || "DEFAULT_SKU";

        // Execute database query with database span
        const dbResult = await db.query(
          "SELECT",
          "inventory_items",
          `SELECT stock_count FROM inventory_items WHERE sku = '${sku}' LIMIT 1`,
          { sku, stock: 450 }
        );

        telemetry.requestCounter.add(1, { service: SERVICE_NAME, status: "200" });
        telemetry.log("info", `Checked stock for SKU: ${sku}`, { sku, dbDuration: dbResult.durationMs });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "AVAILABLE", sku, inStock: true, stockCount: 450 }));
        telemetry.endSpan(span, SpanStatusCode.OK);
        return;
      }

      if (req.method === "POST" && url.pathname === "/inventory/reserve") {
        // Reserve stock in database
        const dbResult = await db.query(
          "UPDATE",
          "inventory_items",
          "UPDATE inventory_items SET reserved = reserved + 1 WHERE sku = 'ITEM-101'",
          { reservationId: "res_" + Date.now() }
        );

        telemetry.requestCounter.add(1, { service: SERVICE_NAME, status: "200" });
        telemetry.log("info", "Inventory stock reserved successfully", { dbDuration: dbResult.durationMs });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, reservationId: "res_" + Date.now(), sku: "ITEM-101" }));
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
      telemetry.log("error", `Inventory processing error: ${msg}`, { error: msg });
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
    console.log(`[Inventory Service] Listening on http://localhost:${PORT}`);
  });
}
