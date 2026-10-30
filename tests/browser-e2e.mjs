import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function resolveChromePath() {
  if (process.env.CHROME_PATH) {
    if (fs.existsSync(process.env.CHROME_PATH)) {
      return process.env.CHROME_PATH;
    }
    throw new Error(`Configured CHROME_PATH does not exist: ${process.env.CHROME_PATH}`);
  }

  const defaultWinPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const defaultWinPathX86 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
  const defaultMacPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const defaultLinuxPath = '/usr/bin/google-chrome';

  const candidates = [
    defaultWinPath,
    defaultWinPathX86,
    defaultMacPath,
    defaultLinuxPath,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Could not find Google Chrome executable. Please set CHROME_PATH environment variable to your Chrome/Chromium binary path.'
  );
}

const CHROME_PATH = resolveChromePath();
const LOCAL_SCREENSHOT_DIR = process.env.LOCAL_SCREENSHOT_DIR || path.resolve(process.cwd(), 'tests/screenshots');
const ARTIFACT_SCREENSHOT_DIR = process.env.ARTIFACT_SCREENSHOT_DIR || (
  fs.existsSync('C:\\Users\\Atharv\\.gemini\\antigravity-ide\\brain\\963f9580-4405-48da-8240-8db965e8c903\\screenshots')
    ? 'C:\\Users\\Atharv\\.gemini\\antigravity-ide\\brain\\963f9580-4405-48da-8240-8db965e8c903\\screenshots'
    : null
);

fs.mkdirSync(LOCAL_SCREENSHOT_DIR, { recursive: true });
if (ARTIFACT_SCREENSHOT_DIR) {
  try {
    fs.mkdirSync(ARTIFACT_SCREENSHOT_DIR, { recursive: true });
  } catch {
    // Non-fatal if artifact path is not writable
  }
}

async function captureScreenshot(page, filename) {
  const localFile = path.join(LOCAL_SCREENSHOT_DIR, filename);
  await page.screenshot({ path: localFile, fullPage: false });
  if (ARTIFACT_SCREENSHOT_DIR && fs.existsSync(ARTIFACT_SCREENSHOT_DIR)) {
    try {
      const artifactFile = path.join(ARTIFACT_SCREENSHOT_DIR, filename);
      fs.copyFileSync(localFile, artifactFile);
    } catch {
      // Ignored if artifact copy fails
    }
  }
  console.log(`  [Screenshot] Saved: ${filename}`);
}

async function verifyServerAvailable(url) {
  try {
    const res = await fetch(`${url}/api/health`);
    if (!res.ok) {
      console.warn(`  [Warning] Health endpoint returned status ${res.status}`);
    }
    return true;
  } catch (err) {
    throw new Error(
      `Cannot connect to Next.js server at ${url}. Ensure the server is running (e.g. 'npm run dev' or 'npm run build && npm start') before running browser tests. Error: ${err.message}`
    );
  }
}

async function runBrowserSuite() {
  console.log('================================================================');
  console.log('  IncidentGraph AI: Genuine Browser Automation Suite (Chrome)  ');
  console.log('================================================================');
  console.log(`Browser Executable: ${CHROME_PATH}`);
  console.log(`Target URL: ${BASE_URL}`);

  await verifyServerAvailable(BASE_URL);

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
  const sectionResults = [];

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

  let createdIncidentId = null;

  try {
    // ----------------------------------------------------
    // TEST 1: Overview Dashboard (Desktop: 1280x800)
    // ----------------------------------------------------
    console.log('\n--- 1. Testing Overview Dashboard (1280x800) ---');
    try {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      const pageTitle = await page.title();
      console.log(`  Page Title: "${pageTitle}"`);

      // Check main branding and KPI counters
      await page.waitForSelector('text=IncidentGraph AI', { timeout: 8000 });
      const quickActions = await page.$('text=Quick Actions');
      console.log(`  Dashboard Quick Actions: ${quickActions ? 'Present' : 'Not found'}`);

      await captureScreenshot(page, '01_dashboard_desktop.png');
      sectionResults.push({ name: '1. Overview Dashboard', passed: true });
    } catch (err) {
      sectionResults.push({ name: '1. Overview Dashboard', passed: false, error: err.message });
      throw err;
    }

    // ----------------------------------------------------
    // TEST 2: Service Map & Interactive Graph Node Selection
    // ----------------------------------------------------
    console.log('\n--- 2. Testing Service Map & Topology Graph ---');
    try {
      await page.goto(`${BASE_URL}/service-map`, { waitUntil: 'domcontentloaded' });

      // Wait for SVG canvas
      await page.waitForSelector('svg', { timeout: 8000 });
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
      sectionResults.push({ name: '2. Service Map & Topology', passed: true });
    } catch (err) {
      sectionResults.push({ name: '2. Service Map & Topology', passed: false, error: err.message });
      throw err;
    }

    // ----------------------------------------------------
    // TEST 3: Failure Simulator: Scenario Injection & Stepping
    // ----------------------------------------------------
    console.log('\n--- 3. Testing Failure Simulator: Injection & Advance ---');
    try {
      await page.goto(`${BASE_URL}/simulator`, { waitUntil: 'domcontentloaded' });

      // Clean baseline first if reset button is available in main content
      const resetBaselineBtn = page.locator('main button:has-text("Reset Baseline")');
      if (await resetBaselineBtn.isVisible().catch(() => false)) {
        if (!(await resetBaselineBtn.isDisabled())) {
          await Promise.all([
            page.waitForResponse(
              (res) => res.url().includes('/api/simulations/reset') && res.request().method() === 'POST',
              { timeout: 8000 }
            ).catch(() => null),
            resetBaselineBtn.click(),
          ]);
          console.log('  Clean baseline confirmed via main Reset Baseline button');
          await page.waitForTimeout(600);
        }
      }

      // Select the PostgreSQL scenario card
      const scenarioCard = page.locator('h4:has-text("PostgreSQL")').first();
      await scenarioCard.waitFor({ state: 'visible', timeout: 8000 });
      await scenarioCard.click();
      console.log('  Selected scenario card: "PostgreSQL Database Slowdown"');
      await page.waitForTimeout(400);

      // Click "Inject Selected Scenario" and deterministically capture POST /api/simulations/inject response
      const injectBtn = page.locator('button:has-text("Inject Selected Scenario")');
      await injectBtn.waitFor({ state: 'visible', timeout: 8000 });

      const [injectResponse] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes('/api/simulations/inject') && res.request().method() === 'POST',
          { timeout: 10000 }
        ),
        injectBtn.click(),
      ]);

      if (!injectResponse.ok()) {
        const errorText = await injectResponse.text();
        throw new Error(`Simulation injection failed with status ${injectResponse.status()}: ${errorText}`);
      }

      const injectData = await injectResponse.json();
      if (!injectData.incidentId || typeof injectData.incidentId !== 'string') {
        throw new Error(`Injection endpoint returned invalid incident ID: ${JSON.stringify(injectData)}`);
      }

      createdIncidentId = injectData.incidentId;
      console.log(`  Deterministic incident created successfully: ID=${createdIncidentId}`);

      // Verify Active Simulation Banner appears at Step 1
      await page.waitForSelector('text=Active Simulation: Step 1', { timeout: 8000 });
      console.log('  Verified Active Simulation status banner: Step 1');

      // Click "Advance Step" button
      const advanceBtn = page.locator('button:has-text("Advance Step")');
      if (await advanceBtn.isVisible() && !(await advanceBtn.isDisabled())) {
        const [advanceResponse] = await Promise.all([
          page.waitForResponse(
            (res) => res.url().includes('/api/simulations/advance') && res.request().method() === 'POST',
            { timeout: 10000 }
          ),
          advanceBtn.click(),
        ]);
        if (!advanceResponse.ok()) {
          console.warn(`  Advance step returned non-OK status: ${advanceResponse.status()}`);
        }
        console.log('  Clicked "Advance Step" button');
        await page.waitForSelector('text=Active Simulation: Step 2', { timeout: 8000 });
        console.log('  Verified Active Simulation status banner: Step 2');
      }

      await captureScreenshot(page, '03_simulator_injected_desktop.png');
      sectionResults.push({ name: '3. Failure Simulator Injection', passed: true });
    } catch (err) {
      sectionResults.push({ name: '3. Failure Simulator Injection', passed: false, error: err.message });
      throw err;
    }

    // ----------------------------------------------------
    // TEST 4: Incidents List & Status Filtering
    // ----------------------------------------------------
    console.log('\n--- 4. Testing Incidents List & Filtering ---');
    try {
      await page.goto(`${BASE_URL}/incidents`, { waitUntil: 'domcontentloaded' });

      // Verify incident rows are displayed in the table
      await page.waitForSelector('table tbody tr', { timeout: 8000 });
      const rowCount = await page.$$eval('table tbody tr', (rows) => rows.length);
      console.log(`  Incidents table row count: ${rowCount}`);

      // Verify the exact created incident link is present in the table
      const exactLinkSelector = `a[href="/incidents/${createdIncidentId}"]`;
      await page.waitForSelector(exactLinkSelector, { timeout: 8000 });
      console.log(`  Verified exact incident link in table: /incidents/${createdIncidentId}`);

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

      // Re-confirm exact incident link after filter reset
      await page.waitForSelector(exactLinkSelector, { timeout: 6000 });

      await captureScreenshot(page, '04_incidents_list_desktop.png');
      sectionResults.push({ name: '4. Incidents List & Filtering', passed: true });
    } catch (err) {
      sectionResults.push({ name: '4. Incidents List & Filtering', passed: false, error: err.message });
      throw err;
    }

    // ----------------------------------------------------
    // TEST 5: Incident Investigation Details & Deterministic Selection
    // ----------------------------------------------------
    console.log('\n--- 5. Testing Incident Investigation Details ---');
    try {
      if (!createdIncidentId) {
        throw new Error('Test 5 prerequisite missing: createdIncidentId is null.');
      }

      // Locate the EXACT Investigate link for createdIncidentId
      const targetExactLink = page.locator(`a[href="/incidents/${createdIncidentId}"]`);
      await targetExactLink.waitFor({ state: 'visible', timeout: 8000 });
      console.log(`  Navigating to exact incident detail: /incidents/${createdIncidentId}`);

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        targetExactLink.click(),
      ]);

      // Verify the page URL corresponds to the same incident ID
      const pageUrl = page.url();
      if (!pageUrl.includes(`/incidents/${createdIncidentId}`)) {
        throw new Error(`Navigated URL "${pageUrl}" does not match created incident ID "${createdIncidentId}"`);
      }

      // Check for incident not found error
      const notFoundElement = await page.$('text=Incident not found');
      if (notFoundElement) {
        const bodyText = await page.innerText('body');
        throw new Error(`Incident not found on detail page for ID "${createdIncidentId}". Body: ${bodyText.slice(0, 300)}`);
      }

      // Verify incident header displays ID
      await page.waitForSelector(`text=ID: ${createdIncidentId}`, { timeout: 8000 });
      console.log(`  Confirmed incident detail header corresponds to ID: ${createdIncidentId}`);

      // Locate Ranked Root Causes tab button using reliable multi-fallback locator
      const rootCausesTabLocator = page.locator(
        'button:has-text("Ranked Root Causes"), button:has-text("DSA Graph Candidates"), [data-testid="ranked-root-causes-tab"]'
      );
      try {
        await rootCausesTabLocator.first().waitFor({ state: 'visible', timeout: 8000 });
      } catch {
        const pageContent = await page.innerText('body');
        throw new Error(`Failed to locate Ranked Root Causes tab button. Page text sample: ${pageContent.slice(0, 350)}`);
      }

      // Switch to the Ranked Root Causes / DSA Candidates tab
      await rootCausesTabLocator.first().click();
      await page.waitForTimeout(500);
      console.log('  Ranked Root Causes tab selected and active');

      // Verify root cause candidates or top suspect card is present
      const candidateCard = (await page.$('text=PostgreSQL')) || (await page.$('text=postgres-db')) || (await page.$('text=Heuristic Score'));
      if (!candidateCard) {
        const pageText = await page.innerText('body');
        throw new Error(`Root cause candidates not rendered in investigation tab. Page text: ${pageText.slice(0, 350)}`);
      }
      console.log('  Verified Ranked Root Causes candidate card rendered');

      // Click "Evidence Timeline" tab
      const evidenceTabBtn = page.locator('button:has-text("Evidence Timeline")');
      if (await evidenceTabBtn.isVisible()) {
        await evidenceTabBtn.click();
        await page.waitForTimeout(500);
        console.log('  Switched to "Evidence Timeline" tab');
      }

      // Click "Re-Run DSA Root-Cause Engine" button
      const reanalyzeBtn = page.locator('button:has-text("Re-Run DSA Root-Cause Engine")');
      if (await reanalyzeBtn.isVisible()) {
        const [reanalyzeResponse] = await Promise.all([
          page.waitForResponse(
            (res) => res.url().includes(`/api/incidents/${createdIncidentId}/analyze`) && res.request().method() === 'POST',
            { timeout: 10000 }
          ).catch(() => null),
          reanalyzeBtn.click(),
        ]);
        if (reanalyzeResponse?.ok()) {
          console.log('  Re-Run DSA Root-Cause Engine completed successfully');
        }
        await page.waitForTimeout(1000);
      }

      await captureScreenshot(page, '05_incident_investigation_desktop.png');
      sectionResults.push({ name: '5. Incident Investigation Details', passed: true });
    } catch (err) {
      sectionResults.push({ name: '5. Incident Investigation Details', passed: false, error: err.message });
      throw err;
    }

    // ----------------------------------------------------
    // TEST 6: Simulator Service Restoration & Reset
    // ----------------------------------------------------
    console.log('\n--- 6. Testing Simulator Service Restoration & Reset ---');
    try {
      await page.goto(`${BASE_URL}/simulator`, { waitUntil: 'domcontentloaded' });

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

      // Reset Baseline if button is visible and enabled
      const finalResetBtn = page.locator('button:has-text("Reset Baseline")').first();
      if (await finalResetBtn.isVisible().catch(() => false)) {
        if (!(await finalResetBtn.isDisabled())) {
          await finalResetBtn.click();
          console.log('  Clicked "Reset Baseline" button');
          await page.waitForTimeout(1500);
        } else {
          console.log('  Reset Baseline button is disabled');
        }
      } else {
        console.log('  Reset Baseline button protected/hidden in current environment');
      }

      await captureScreenshot(page, '06_simulator_restored_desktop.png');
      sectionResults.push({ name: '6. Simulator Service Restoration & Reset', passed: true });
    } catch (err) {
      sectionResults.push({ name: '6. Simulator Service Restoration & Reset', passed: false, error: err.message });
      throw err;
    }

    // ----------------------------------------------------
    // TEST 7: DSA Lab Interactive Algorithms & Sandbox
    // ----------------------------------------------------
    console.log('\n--- 7. Testing DSA Lab Interactive Controls ---');
    try {
      await page.goto(`${BASE_URL}/dsa-lab`, { waitUntil: 'domcontentloaded' });

      // Test Tab 1: BFS (Impact Propagation)
      const bfsTab = page.locator('button:has-text("1. BFS")');
      if (await bfsTab.isVisible()) {
        await bfsTab.click();
        await page.waitForTimeout(400);
        console.log('  Switched to "1. BFS (Impact Propagation)"');
      }

      // Test Tab 2: DFS (Cycle Detection)
      const dfsTab = page.locator('button:has-text("2. DFS")');
      if (await dfsTab.isVisible()) {
        await dfsTab.click();
        await page.waitForTimeout(400);
        console.log('  Switched to "2. DFS (Cycle Detection)"');

        // Toggle test cycle checkbox
        const cycleCheckbox = await page.$('input[type="checkbox"]');
        if (cycleCheckbox) {
          await cycleCheckbox.click();
          await page.waitForTimeout(400);
          console.log('  Toggled synthetic test cycle checkbox in DFS tab');
        }
      }

      // Test Tab 3: Priority Queue
      const pqTab = page.locator('button:has-text("3. Priority Queue")');
      if (await pqTab.isVisible()) {
        await pqTab.click();
        await page.waitForTimeout(400);
        console.log('  Switched to "3. Priority Queue (Binary Heap)"');
      }

      // Test Tab 4: Sliding Window
      const swTab = page.locator('button:has-text("4. Sliding Window")');
      if (await swTab.isVisible()) {
        await swTab.click();
        await page.waitForTimeout(400);
        console.log('  Switched to "4. Sliding Window Telemetry"');
      }

      // Test Tab 5: Root-Cause Engine
      const rcTab = page.locator('button:has-text("5. Root-Cause Ranking Engine")');
      if (await rcTab.isVisible()) {
        await rcTab.click();
        await page.waitForTimeout(400);
        console.log('  Switched to "5. Root-Cause Ranking Engine"');
      }

      await captureScreenshot(page, '07_dsalab_desktop.png');
      sectionResults.push({ name: '7. DSA Lab Interactive Controls', passed: true });
    } catch (err) {
      sectionResults.push({ name: '7. DSA Lab Interactive Controls', passed: false, error: err.message });
      throw err;
    }

    // ----------------------------------------------------
    // TEST 8: Settings Page
    // ----------------------------------------------------
    console.log('\n--- 8. Testing Settings Page ---');
    try {
      await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('text=System Administration', { timeout: 8000 });

      // Wait for health state to settle
      await page.waitForTimeout(500);

      const resetDbBtn = page.locator('button:has-text("Reset Database")');
      if (await resetDbBtn.isVisible().catch(() => false) && !(await resetDbBtn.isDisabled().catch(() => true))) {
        await resetDbBtn.click({ timeout: 3000 }).catch(() => null);
        await page.waitForTimeout(600);
        console.log('  Interacted with "Reset Database" button');
      } else {
        console.log('  Reset Database button is protected or disabled in this environment');
      }

      await captureScreenshot(page, '08_settings_desktop.png');
      sectionResults.push({ name: '8. Settings & Diagnostics Page', passed: true });
    } catch (err) {
      sectionResults.push({ name: '8. Settings & Diagnostics Page', passed: false, error: err.message });
      throw err;
    }

    // ----------------------------------------------------
    // TEST 9: Mobile Viewport (390x844 - iPhone 13) Verification
    // ----------------------------------------------------
    console.log('\n--- 9. Testing Mobile Viewport (390x844) Responsiveness ---');
    try {
      await page.setViewportSize({ width: 390, height: 844 });

      // Mobile Dashboard
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      const dashOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      console.log(`  Dashboard Mobile - Horizontal Overflow: ${dashOverflow ? 'DETECTED' : 'None (Clean)'}`);
      await captureScreenshot(page, '09_dashboard_mobile.png');

      // Mobile Service Map
      await page.goto(`${BASE_URL}/service-map`, { waitUntil: 'domcontentloaded' });
      const mapOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      console.log(`  Service Map Mobile - Horizontal Overflow: ${mapOverflow ? 'DETECTED' : 'None (Clean)'}`);
      await captureScreenshot(page, '10_servicemap_mobile.png');

      // Mobile Simulator
      await page.goto(`${BASE_URL}/simulator`, { waitUntil: 'domcontentloaded' });
      const simOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      console.log(`  Simulator Mobile - Horizontal Overflow: ${simOverflow ? 'DETECTED' : 'None (Clean)'}`);
      await captureScreenshot(page, '11_simulator_mobile.png');

      // Mobile Incidents
      await page.goto(`${BASE_URL}/incidents`, { waitUntil: 'domcontentloaded' });
      const incOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      console.log(`  Incidents Mobile - Horizontal Overflow: ${incOverflow ? 'DETECTED' : 'None (Clean)'}`);
      await captureScreenshot(page, '12_incidents_mobile.png');

      sectionResults.push({ name: '9. Mobile Viewport Responsiveness', passed: true });
    } catch (err) {
      sectionResults.push({ name: '9. Mobile Viewport Responsiveness', passed: false, error: err.message });
      throw err;
    }

  } catch (err) {
    console.error('\n[FATAL ERROR IN BROWSER SUITE]:', err.message);
  } finally {
    await browser.close();
  }

  console.log('\n================================================================');
  console.log('                   BROWSER TEST REPORT SUMMARY                  ');
  console.log('================================================================');

  const passedCount = sectionResults.filter((r) => r.passed).length;
  const totalSections = 9;
  console.log(`Sections Executed: ${sectionResults.length} / ${totalSections}`);
  console.log(`Sections Passed:   ${passedCount} / ${totalSections}`);

  sectionResults.forEach((r) => {
    console.log(`  ${r.passed ? '✓' : '✗'} ${r.name}${r.error ? ` (Error: ${r.error})` : ''}`);
  });

  console.log(`\nBrowser Console Errors: ${consoleErrors.length}`);
  consoleErrors.forEach((e) => console.log(`  ${e}`));

  console.log(`Network Failures: ${networkFailures.length}`);
  networkFailures.forEach((n) => console.log(`  ${n}`));

  if (passedCount === totalSections) {
    console.log('\n>>> BROWSER SUITE OVERALL RESULT: 100% PASS (All 9 sections passed)');
    process.exit(0);
  } else {
    console.error(`\n>>> BROWSER SUITE OVERALL RESULT: FAILED (${passedCount}/${totalSections} sections passed)`);
    process.exit(1);
  }
}

runBrowserSuite().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
