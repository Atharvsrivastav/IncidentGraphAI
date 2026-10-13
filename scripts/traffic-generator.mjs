/**
 * Real Traffic Generator for IncidentGraph AI Sample Microservices
 *
 * Sends genuine HTTP requests through the API Gateway (:4000), triggering
 * distributed request propagation across Order Service (:4001), Inventory (:4003),
 * Payment (:4002), and PostgreSQL database.
 */

const GATEWAY_URL = process.env.SAMPLE_GATEWAY_URL || 'http://localhost:4000';
const isContinuous = process.argv.includes('--continuous');
const requestCount = Number(process.env.REQUEST_COUNT) || 15;

async function sendOrderRequest(index) {
  const start = performance.now();
  try {
    const res = await fetch(`${GATEWAY_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: `user_${index}`,
        items: [{ sku: 'ITEM-101', quantity: 1 }],
      }),
    });
    const duration = Math.round(performance.now() - start);
    const data = await res.json();
    console.log(`[Order #${index}] Status: ${res.status} (${duration}ms) - Response:`, data);
    return res.ok;
  } catch (err) {
    const duration = Math.round(performance.now() - start);
    console.error(`[Order #${index}] FAILED (${duration}ms):`, err.message);
    return false;
  }
}

async function sendInventoryCheck(index) {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/inventory/ITEM-101`);
    console.log(`[Inventory #${index}] Status: ${res.status}`);
  } catch (err) {
    console.error(`[Inventory #${index}] FAILED:`, err.message);
  }
}

async function runTraffic() {
  console.log(`=== Starting Traffic Generation against ${GATEWAY_URL} ===`);
  console.log(`Mode: ${isContinuous ? 'Continuous Loop' : `Batch (${requestCount} requests)`}`);

  let i = 1;
  while (isContinuous || i <= requestCount) {
    await sendOrderRequest(i);
    if (i % 3 === 0) {
      await sendInventoryCheck(i);
    }
    i++;
    await new Promise((r) => setTimeout(r, 600));
  }

  console.log('=== Traffic Generation Completed ===');
}

runTraffic().catch(console.error);
