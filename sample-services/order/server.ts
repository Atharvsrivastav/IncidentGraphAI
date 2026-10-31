import http from "http";
import crypto from "crypto";
import { initServiceTelemetry } from "../shared/telemetry";
import { SamplePostgresClient } from "../shared/database";
import { SpanStatusCode, context } from "@opentelemetry/api";

export function safeTokenEquals(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  const match = crypto.timingSafeEqual(hashA, hashB);
  return match && a.trim().length > 0 && b.trim().length > 0;
}

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

export function createOrderServer(activeTelemetry = telemetry): http.Server {
  return http.createServer(async (req, res) => {
    const start = performance.now();
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const carrier: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") carrier[key] = value;
    }

    const { span, ctx } = activeTelemetry.startSpan(`HTTP ${req.method} ${url.pathname}`, carrier);

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
        const isEnabled = process.env.ENABLE_TEST_METRIC_ENDPOINT === "true";
        const isProduction = process.env.NODE_ENV === "production" || process.env.DEPLOYMENT_ENVIRONMENT === "production";
        if (!isEnabled || isProduction) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: isProduction
              ? "Synthetic test metric endpoint is strictly disabled in production mode"
              : "Synthetic test metric endpoint is disabled by default. Set ENABLE_TEST_METRIC_ENDPOINT=true to enable.",
            disabled: true,
          }));
          telemetry.endSpan(span, SpanStatusCode.ERROR, "Endpoint disabled");
          return;
        }

        // Test authentication check - fail closed if token is absent or empty
        const configuredToken = process.env.TEST_METRIC_ENDPOINT_TOKEN?.trim();
        if (!configuredToken) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "Authentication not configured: TEST_METRIC_ENDPOINT_TOKEN environment variable must be set to a non-empty secret token",
            misconfigured: true,
          }));
          activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Authentication not configured");
          return;
        }

        const authHeader = req.headers["authorization"];
        const rawProvided = req.headers["x-test-token"] || (typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined);
        const providedToken = typeof rawProvided === "string" ? rawProvided.trim() : "";
        if (!providedToken || !safeTokenEquals(providedToken, configuredToken)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Missing or invalid test authentication token" }));
          activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Unauthorized test request");
          return;
        }

        // Payload size protection: max 1024 bytes
        const contentLength = Number(req.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > 1024) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload too large: Maximum 1024 bytes allowed" }));
          activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Payload too large");
          return;
        }

        let body = "";
        let bodyLength = 0;
        for await (const chunk of req) {
          bodyLength += chunk.length;
          if (bodyLength > 1024) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Payload too large: Maximum 1024 bytes allowed" }));
            activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Payload too large");
            return;
          }
          body += chunk;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON payload" }));
          activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Invalid JSON");
          return;
        }

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload must be a JSON object" }));
          activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Invalid JSON object");
          return;
        }

        // Verification ID validation: 8-64 alphanumeric, dash, or underscore
        const verificationId = parsed.verification_id;
        const VERIFICATION_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;
        if (typeof verificationId !== "string" || !VERIFICATION_ID_REGEX.test(verificationId.trim())) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "Invalid verification_id: must be 8-64 alphanumeric, underscore, or dash characters",
          }));
          activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Invalid verification ID");
          return;
        }

        // Count validation: finite positive bounded integer (1-1000)
        const count = parsed.count;
        if (
          typeof count !== "number" ||
          !Number.isFinite(count) ||
          Number.isNaN(count) ||
          count <= 0 ||
          !Number.isInteger(count) ||
          count > 1000
        ) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "Invalid count: must be a finite positive integer between 1 and 1000",
          }));
          activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Invalid count");
          return;
        }

        // Status validation: bounded allowlist to prevent unbounded metric cardinality
        const ALLOWED_STATUSES = new Set(["synthetic", "test_verified", "smoke_test"]);
        const rawStatus = parsed.status;
        if (rawStatus !== undefined && !ALLOWED_STATUSES.has(String(rawStatus))) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "Invalid status: must be one of ['synthetic', 'test_verified', 'smoke_test']",
          }));
          activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Invalid status");
          return;
        }
        const validatedStatus = (rawStatus as string) || "test_verified";

        try {
          activeTelemetry.recordSyntheticMetric(verificationId.trim(), count, validatedStatus);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("cardinality ceiling")) {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: errMsg,
              ceiling: 100,
            }));
            activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Cardinality ceiling reached");
            return;
          }
          throw err;
        }

        activeTelemetry.log("info", "Recorded synthetic test metric via authenticated HTTP endpoint", {
          verificationId: verificationId.trim(),
          count,
          status: validatedStatus,
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          service: SERVICE_NAME,
          verification_id: verificationId.trim(),
          count,
          status: validatedStatus,
        }));
        activeTelemetry.endSpan(span, SpanStatusCode.OK);
        return;
      }

      if ((req.method === "DELETE" && url.pathname === "/test/record-metric") ||
          ((req.method === "POST" || req.method === "DELETE") && url.pathname === "/test/cleanup-metric")) {
        const isEnabled = process.env.ENABLE_TEST_METRIC_ENDPOINT === "true";
        const isProduction = process.env.NODE_ENV === "production" || process.env.DEPLOYMENT_ENVIRONMENT === "production";
        if (!isEnabled || isProduction) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: isProduction
              ? "Synthetic test metric endpoint is strictly disabled in production mode"
              : "Synthetic test metric endpoint is disabled by default. Set ENABLE_TEST_METRIC_ENDPOINT=true to enable.",
            disabled: true,
          }));
          activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Endpoint disabled");
          return;
        }

        const configuredToken = process.env.TEST_METRIC_ENDPOINT_TOKEN?.trim();
        if (!configuredToken) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "Authentication not configured: TEST_METRIC_ENDPOINT_TOKEN environment variable must be set to a non-empty secret token",
            misconfigured: true,
          }));
          activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Authentication not configured");
          return;
        }

        const authHeader = req.headers["authorization"];
        const rawProvided = req.headers["x-test-token"] || (typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined);
        const providedToken = typeof rawProvided === "string" ? rawProvided.trim() : "";
        if (!providedToken || !safeTokenEquals(providedToken, configuredToken)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Missing or invalid test authentication token" }));
          activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Unauthorized test request");
          return;
        }

        // Payload size protection: max 1024 bytes
        const contentLength = Number(req.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > 1024) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload too large: Maximum 1024 bytes allowed" }));
          activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Payload too large");
          return;
        }

        let body = "";
        let bodyLength = 0;
        for await (const chunk of req) {
          bodyLength += chunk.length;
          if (bodyLength > 1024) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Payload too large: Maximum 1024 bytes allowed" }));
            activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Payload too large");
            return;
          }
          body += chunk;
        }

        let parsedBody: Record<string, unknown> = {};
        if (body.trim().length > 0) {
          try {
            parsedBody = JSON.parse(body);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON payload" }));
            activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Invalid JSON");
            return;
          }
          if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Payload must be a JSON object" }));
            activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Invalid JSON object");
            return;
          }
        }

        const VERIFICATION_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;
        const rawTargetId = url.searchParams.get("verification_id") ||
          (typeof parsedBody.verification_id === "string" ? parsedBody.verification_id.trim() : undefined);

        if (rawTargetId !== undefined) {
          const targetId = rawTargetId.trim();
          if (!VERIFICATION_ID_REGEX.test(targetId)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: "Invalid verification_id: must be 8-64 alphanumeric, underscore, or dash characters",
            }));
            activeTelemetry.endSpan(span, SpanStatusCode.ERROR, "Invalid verification ID");
            return;
          }
          const removed = activeTelemetry.clearSyntheticVerificationId(targetId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, removed, verification_id: targetId }));
        } else {
          // Clear only synthetic verification IDs (never touch standard metrics)
          activeTelemetry.clearSyntheticVerificationIds();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, clearedAll: true }));
        }
        activeTelemetry.endSpan(span, SpanStatusCode.OK);
        return;
      }

      if (url.pathname === "/metrics") {
        activeTelemetry.handleMetricsRequest(res);
        activeTelemetry.endSpan(span, SpanStatusCode.OK);
        return;
      }

      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "HEALTHY", service: SERVICE_NAME }));
        activeTelemetry.endSpan(span, SpanStatusCode.OK);
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Route not found" }));
      activeTelemetry.endSpan(span, SpanStatusCode.OK);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      activeTelemetry.errorCounter.add(1, { service: SERVICE_NAME, status: "500" });
      activeTelemetry.log("error", `Order creation failed: ${msg}`, { error: msg });
      activeTelemetry.endSpan(span, SpanStatusCode.ERROR, msg);

      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    } finally {
      const durationSec = (performance.now() - start) / 1000;
      activeTelemetry.durationHistogram.record(durationSec, { service: SERVICE_NAME });
    }
    });
  });
}

export const server = createOrderServer();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[Order Service] Listening on http://localhost:${PORT}`);
  });
}
