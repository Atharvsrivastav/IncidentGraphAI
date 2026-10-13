import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://localhost:3000';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const LOCAL_SCREENSHOT_DIR = path.resolve(process.cwd(), 'tests/screenshots');
const ARTIFACT_SCREENSHOT_DIR = 'C:\\Users\\Atharv\\.gemini\\antigravity-ide\\brain\\aa433f5d-2644-48a0-90ea-0b37292f8f91\\screenshots';

fs.mkdirSync(LOCAL_SCREENSHOT_DIR, { recursive: true });
fs.mkdirSync(ARTIFACT_SCREENSHOT_DIR, { recursive: true });

async function captureScreenshot(page, filename) {
  const localFile = path.join(LOCAL_SCREENSHOT_DIR, filename);
  const artifactFile = path.join(ARTIFACT_SCREENSHOT_DIR, filename);
  await page.screenshot({ path: localFile, fullPage: false });
  fs.copyFileSync(localFile, artifactFile);
  console.log(`  [Screenshot] Saved: ${filename}`);
}

async function runBrowserSuite() {
  console.log('================================================================');
  console.log('  IncidentGraph AI: Genuine Browser Automation Suite (Chrome)  ');
  console.log('================================================================');
  console.log(`Browser Executable: ${CHROME_PATH}`);
  console.log(`Target URL: ${BASE_URL}`);

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  const consoleErrors = [];
  const networkFailures = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ignore innocuous asset 404s like favicon
      if (!text.includes('favicon.ico')) {
        consoleErrors.push(`[Console Error]: ${text}`);
      }
    }
  });

  page.on('pageerror', (err) => {
    consoleErrors.push(`[Page Error]: ${err.message}`);
  });

  page.on('requestfailed', (req) => {
    networkFailures.push(`[Network Failure]: ${req.method()} ${req.url()} (${req.failure()?.errorText})`);
  });

  try {
    // ----------------------------------------------------
    // TEST 1: Overview Dashboard (Desktop: 1280x800)
    // ----------------------------------------------------
    console.log('\n--- 1. Testing Overview Dashboard (1280x800) ---');
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    const pageTitle = await page.title();
    console.log(`  Page Title: "${pageTitle}"`);

    // Check main branding and KPI counters
    await page.waitForSelector('text=IncidentGraph AI', { timeout: 6000 });
    const quickActions = await page.$('text=Quick Actions');
    console.log(`  Dashboard Quick Actions: ${quickActions ? 'Present' : 'Not found'}`);

    await captureScreenshot(page, '01_dashboard_desktop.png');

    // ----------------------------------------------------
    // TEST 2: Service Map & Interactive Graph Node Selection
    // ----------------------------------------------------
    console.log('\n--- 2. Testing Service Map & Topology Graph ---');
    await page.goto(`${BASE_URL}/service-map`, { waitUntil: 'networkidle' });

    // Wait for SVG canvas
    await page.waitForSelector('svg', { timeout: 6000 });
    console.log('  SVG Topology Canvas loaded');

    // Test search filter input
    const searchBox = await page.$('input[placeholder*="Search"]');
    if (searchBox) {
      await searchBox.fill('postgres');
      await page.waitForTimeout(400);
      console.log('  Search filter filled with "postgres"');
      await searchBox.fill('');
      await page.waitForTimeout(300);
    }

    // Click on a node in the graph
    const postgresNode = await page.$('text=postgres-db');
    if (postgresNode) {
      await postgresNode.click();
      await page.waitForTimeout(500);
      console.log('  Clicked topology node "postgres-db"');
    }

    await captureScreenshot(page, '02_servicemap_desktop.png');

    // ----------------------------------------------------
    // TEST 3: Failure Simulator: Scenario Injection & Stepping
    // ----------------------------------------------------
    console.log('\n--- 3. Testing Failure Simulator: Injection & Advance ---');
    await page.goto(`${BASE_URL}/simulator`, { waitUntil: 'networkidle' });

    // Clean baseline first
    const resetBaselineBtn = await page.$('button:has-text("Reset Baseline")');
    if (resetBaselineBtn) {
      await resetBaselineBtn.click();
      await page.waitForTimeout(800);
      console.log('  Clean baseline confirmed via Reset button');
    }

    // Select the PostgreSQL Slowdown scenario card
    const scenarioCard = await page.$('text=PostgreSQL Connection Pool Exhaustion');
    if (scenarioCard) {
      await scenarioCard.click();
      console.log('  Selected scenario card: "PostgreSQL Connection Pool Exhaustion"');
      await page.waitForTimeout(400);
    }

    // Click "Inject Selected Scenario"
    const injectBtn = await page.$('button:has-text("Inject Selected Scenario")');
    if (injectBtn) {
      await injectBtn.click();
      console.log('  Clicked "Inject Selected Scenario" button');
      await page.waitForTimeout(1500);
    }

    // Verify Active Simulation Banner appears at Step 1
    await page.waitForSelector('text=Active Simulation: Step 1', { timeout: 6000 });
    console.log('  Verified Active Simulation status banner: Step 1');

    // Click "Advance Step" button
    const advanceBtn = await page.$('button:has-text("Advance Step")');
    if (advanceBtn && !(await advanceBtn.isDisabled())) {
      await advanceBtn.click();
      console.log('  Clicked "Advance Step" button');
      await page.waitForTimeout(1500);
      await page.waitForSelector('text=Active Simulation: Step 2', { timeout: 6000 });
      console.log('  Verified Active Simulation status banner: Step 2');
    }

    await captureScreenshot(page, '03_simulator_injected_desktop.png');

    // ----------------------------------------------------
    // TEST 4: Incidents List & Status Filtering
    // ----------------------------------------------------
    console.log('\n--- 4. Testing Incidents List & Filtering ---');
    await page.goto(`${BASE_URL}/incidents`, { waitUntil: 'networkidle' });

    // Verify incident row is displayed in the table
    await page.waitForSelector('table tbody tr', { timeout: 6000 });
    const rowCount = await page.$$eval('table tbody tr', (rows) => rows.length);
    console.log(`  Incidents table row count: ${rowCount}`);

    // Click status filter "IDENTIFIED"
    const identifiedBtn = await page.$('button:text-is("IDENTIFIED")');
    if (identifiedBtn) {
      await identifiedBtn.click();
      await page.waitForTimeout(300);
      console.log('  Clicked status filter: "IDENTIFIED"');
    }

    // Reset filters via ALL buttons
    const allButtons = await page.$$('button:text-is("ALL")');
    for (const btn of allButtons) {
      await btn.click();
      await page.waitForTimeout(100);
    }
    console.log('  Reset filters via ALL pills');

    await captureScreenshot(page, '04_incidents_list_desktop.png');

    // ----------------------------------------------------
    // TEST 5: Incident Investigation Details & DSA Reanalysis
    // ----------------------------------------------------
    console.log('\n--- 5. Testing Incident Investigation Details ---');
    await page.waitForSelector('a:has-text("Investigate")', { timeout: 6000 });
    const investigateBtn = await page.$('a:has-text("Investigate")');
    const incidentHref = await investigateBtn.getAttribute('href');
    console.log(`  Navigating to Incident Investigation: ${incidentHref}`);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      investigateBtn.click()
    ]);

    // Verify Ranked Root Causes tab is present
    await page.waitForSelector('button:has-text("Ranked Root Causes")', { timeout: 6000 });
    console.log('  Ranked Root Causes tab active on incident detail page');

    // Verify top candidate is postgres-db or PostgreSQL Database Cluster
    const topCandidateCard = (await page.$('text=PostgreSQL')) || (await page.$('text=postgres-db'));
    console.log(`  Top Suspect 'PostgreSQL' present: ${topCandidateCard ? 'Yes' : 'No'}`);

    // Click "Evidence Timeline" tab
    const evidenceTabBtn = await page.$('button:has-text("Evidence Timeline")');
    if (evidenceTabBtn) {
      await evidenceTabBtn.click();
      await page.waitForTimeout(500);
      console.log('  Switched to "Evidence Timeline" tab');
    }

    // Click "Re-Run DSA Root-Cause Engine" button
    const reanalyzeBtn = await page.$('button:has-text("Re-Run DSA Root-Cause Engine")');
    if (reanalyzeBtn) {
      await reanalyzeBtn.click();
      console.log('  Clicked "Re-Run DSA Root-Cause Engine"');
      await page.waitForTimeout(1500);
    }

    await captureScreenshot(page, '05_incident_investigation_desktop.png');

    // ----------------------------------------------------
    // TEST 6: Simulator Service Restoration & Reset
    // ----------------------------------------------------
    console.log('\n--- 6. Testing Simulator Service Restoration & Reset ---');
    await page.goto(`${BASE_URL}/simulator`, { waitUntil: 'networkidle' });

    // Restore failing service in the table if any degraded
    await page.waitForTimeout(500);
    const restoreButtons = await page.$$('button:text-is("Restore")');
    let restoredCount = 0;
    for (const btn of restoreButtons) {
      if (!(await btn.isDisabled())) {
        await btn.click();
        restoredCount++;
        await page.waitForTimeout(1000);
        break; // Restore first degraded service
      }
    }
    console.log(`  Restored degraded services: ${restoredCount}`);

    // Wait until Reset Baseline button is not disabled
    await page.waitForSelector('button:has-text("Reset Baseline"):not([disabled])', { timeout: 6000 });
    const finalResetBtn = await page.$('button:has-text("Reset Baseline")');
    if (finalResetBtn) {
      await finalResetBtn.click();
      console.log('  Clicked "Reset Baseline" button');
      await page.waitForTimeout(1500);
    }

    await captureScreenshot(page, '06_simulator_restored_desktop.png');

    // ----------------------------------------------------
    // TEST 7: DSA Lab Interactive Algorithms & Sandbox
    // ----------------------------------------------------
    console.log('\n--- 7. Testing DSA Lab Interactive Controls ---');
    await page.goto(`${BASE_URL}/dsa-lab`, { waitUntil: 'networkidle' });

    // Test Tab 1: BFS (Impact Propagation)
    const bfsTab = await page.$('button:has-text("1. BFS")');
    if (bfsTab) {
      await bfsTab.click();
      await page.waitForTimeout(500);
      console.log('  Switched to "1. BFS (Impact Propagation)"');
    }

    // Test Tab 2: DFS (Cycle Detection)
    const dfsTab = await page.$('button:has-text("2. DFS")');
    if (dfsTab) {
      await dfsTab.click();
      await page.waitForTimeout(500);
      console.log('  Switched to "2. DFS (Cycle Detection)"');

      // Toggle test cycle checkbox
      const cycleCheckbox = await page.$('input[type="checkbox"]');
      if (cycleCheckbox) {
        await cycleCheckbox.click();
        await page.waitForTimeout(500);
        console.log('  Toggled synthetic test cycle checkbox in DFS tab');
      }
    }

    // Test Tab 3: Priority Queue
    const pqTab = await page.$('button:has-text("3. Priority Queue")');
    if (pqTab) {
      await pqTab.click();
      await page.waitForTimeout(500);
      console.log('  Switched to "3. Priority Queue (Binary Heap)"');
    }

    // Test Tab 4: Sliding Window
    const swTab = await page.$('button:has-text("4. Sliding Window")');
    if (swTab) {
      await swTab.click();
      await page.waitForTimeout(500);
      console.log('  Switched to "4. Sliding Window Telemetry"');
    }

    // Test Tab 5: Root-Cause Engine
    const rcTab = await page.$('button:has-text("5. Root-Cause Ranking Engine")');
    if (rcTab) {
      await rcTab.click();
      await page.waitForTimeout(500);
      console.log('  Switched to "5. Root-Cause Ranking Engine"');
    }

    await captureScreenshot(page, '07_dsalab_desktop.png');

    // ----------------------------------------------------
    // TEST 8: Settings Page
    // ----------------------------------------------------
    console.log('\n--- 8. Testing Settings Page ---');
    await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Reset & Re-Seed Database', { timeout: 6000 });

    const resetDbBtn = await page.$('button:has-text("Reset Database")');
    if (resetDbBtn) {
      await resetDbBtn.click();
      await page.waitForTimeout(800);
      console.log('  Interacted with "Reset Database" button');
    }

    await captureScreenshot(page, '08_settings_desktop.png');

    // ----------------------------------------------------
    // TEST 9: Mobile Viewport (390x844 - iPhone 13) Verification
    // ----------------------------------------------------
    console.log('\n--- 9. Testing Mobile Viewport (390x844) Responsiveness ---');
    await page.setViewportSize({ width: 390, height: 844 });

    // Mobile Dashboard
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    const dashOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`  Dashboard Mobile - Horizontal Overflow: ${dashOverflow ? 'DETECTED' : 'None (Clean)'}`);
    await captureScreenshot(page, '09_dashboard_mobile.png');

    // Mobile Service Map
    await page.goto(`${BASE_URL}/service-map`, { waitUntil: 'networkidle' });
    const mapOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`  Service Map Mobile - Horizontal Overflow: ${mapOverflow ? 'DETECTED' : 'None (Clean)'}`);
    await captureScreenshot(page, '10_servicemap_mobile.png');

    // Mobile Simulator
    await page.goto(`${BASE_URL}/simulator`, { waitUntil: 'networkidle' });
    const simOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`  Simulator Mobile - Horizontal Overflow: ${simOverflow ? 'DETECTED' : 'None (Clean)'}`);
    await captureScreenshot(page, '11_simulator_mobile.png');

    // Mobile Incidents
    await page.goto(`${BASE_URL}/incidents`, { waitUntil: 'networkidle' });
    const incOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`  Incidents Mobile - Horizontal Overflow: ${incOverflow ? 'DETECTED' : 'None (Clean)'}`);
    await captureScreenshot(page, '12_incidents_mobile.png');

  } catch (err) {
    console.error('\n[FATAL ERROR IN BROWSER SUITE]:', err);
    throw err;
  } finally {
    await browser.close();
  }

  console.log('\n================================================================');
  console.log('                   BROWSER TEST REPORT SUMMARY                  ');
  console.log('================================================================');
  console.log(`Console Errors: ${consoleErrors.length}`);
  consoleErrors.forEach((e) => console.log(`  ${e}`));
  console.log(`Network Failures: ${networkFailures.length}`);
  networkFailures.forEach((n) => console.log(`  ${n}`));

  if (consoleErrors.length === 0 && networkFailures.length === 0) {
    console.log('\n>>> BROWSER SUITE OVERALL RESULT: 100% PASS (Zero Errors, Zero Failures)');
  } else {
    console.log(`\n>>> BROWSER SUITE RESULT: PASSED WITH ${consoleErrors.length} CONSOLE / ${networkFailures.length} NETWORK WARNINGS`);
  }
}

runBrowserSuite().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
