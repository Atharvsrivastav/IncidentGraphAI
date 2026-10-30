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
  let res;
  try {
    res = await fetch(`${url}/api/health`);
  } catch (err) {
    throw new Error(`[Server Health Check Failed] Cannot connect to server at ${url}/api/health: ${err.message}`);
  }

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(
      `[Server Health Check Failed] /api/health returned HTTP ${res.status} ${res.statusText}. Body: ${errorBody.slice(0, 300)}`
    );
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`[Server Health Check Failed] /api/health did not return valid JSON: ${err.message}`);
  }

  if (data.status !== 'healthy') {
    throw new Error(`[Server Health Check Failed] Server reported non-healthy status: ${JSON.stringify(data)}`);
  }

  console.log(
    `  [Health Check Passed] Server is healthy: status=${data.status}, db=${data.database?.status}, services=${data.database?.servicesCount}`
  );
  return data;
}

async function runBrowserSuite() {
  console.log('================================================================');
  console.log('  IncidentGraph AI: Genuine Browser Automation Suite (Chrome)  ');
  console.log('================================================================');
  console.log(`Browser Executable: ${CHROME_PATH}`);
  console.log(`Target URL: ${BASE_URL}`);

  const serverHealth = await verifyServerAvailable(BASE_URL);

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // Centralized Error & Failure Tracking
  const consoleErrors = [];
  const pageErrors = [];
  const networkFailures = [];
  const httpErrors = [];
  const sectionResults = [];

  let assertionsPassed = 0;
  let assertionsFailed = 0;

  function assert(condition, message) {
    if (!condition) {
      assertionsFailed++;
      throw new Error(`Assertion Failed: ${message}`);
    }
    assertionsPassed++;
  }

  // Narrow, documented allowlist for genuinely expected failures
  const ALLOWLISTED_PATTERNS = [
    // Standard browser automatic probe for favicon when not explicitly declared
    (entry) => entry.url?.includes('favicon.ico') && entry.status === 404,
  ];

  function isAllowlisted(entry) {
    return ALLOWLISTED_PATTERNS.some((fn) => fn(entry));
  }

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!text.includes('favicon.ico')) {
        consoleErrors.push({ text, location: msg.location() });
      }
    }
  });

  page.on('pageerror', (err) => {
    pageErrors.push({ message: err.message, stack: err.stack });
  });

  page.on('requestfailed', (req) => {
    const entry = {
      method: req.method(),
      url: req.url(),
      errorText: req.failure()?.errorText || 'Unknown failure',
    };
    if (!entry.url.includes('favicon.ico')) {
      networkFailures.push(entry);
    }
  });

  page.on('response', (res) => {
    const status = res.status();
    if (status >= 400) {
      const entry = {
        method: res.request().method(),
        url: res.url(),
        status,
        statusText: res.statusText(),
      };
      if (!isAllowlisted(entry)) {
        httpErrors.push(entry);
      }
    }
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
      assert(pageTitle.includes('IncidentGraph'), `Expected page title to contain "IncidentGraph", got "${pageTitle}"`);

      // Check main branding header is visible
      await page.waitForSelector('text=IncidentGraph AI', { timeout: 8000 });
      assert(await page.locator('text=IncidentGraph AI').first().isVisible(), 'Branding header "IncidentGraph AI" must be visible');

      // Check top navigation links exist and are visible
      const navServiceMap = page.locator('header a[href="/service-map"], nav a[href="/service-map"]').first();
      await navServiceMap.waitFor({ state: 'visible', timeout: 5000 });
      assert(await navServiceMap.isVisible(), 'Header link to /service-map must be visible');

      const navSimulator = page.locator('header a[href="/simulator"], nav a[href="/simulator"]').first();
      await navSimulator.waitFor({ state: 'visible', timeout: 5000 });
      assert(await navSimulator.isVisible(), 'Header link to /simulator must be visible');

      const navIncidents = page.locator('header a[href="/incidents"], nav a[href="/incidents"]').first();
      await navIncidents.waitFor({ state: 'visible', timeout: 5000 });
      assert(await navIncidents.isVisible(), 'Header link to /incidents must be visible');

      await captureScreenshot(page, '01_dashboard_desktop.png');
      sectionResults.push({ name: '1. Overview Dashboard', status: 'passed' });
    } catch (err) {
      sectionResults.push({ name: '1. Overview Dashboard', status: 'failed', error: err.message });
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
      assert(await page.locator('svg').first().isVisible(), 'SVG topology canvas must be rendered');
      console.log('  SVG Topology Canvas loaded');

      // Test search filter input
      const searchBox = page.locator('input[placeholder*="Search"]');
      await searchBox.waitFor({ state: 'visible', timeout: 6000 });
      assert(await searchBox.isVisible(), 'Search input in service-map must be visible');
      await searchBox.fill('postgres');
      await page.waitForTimeout(400);
      console.log('  Search filter filled with "postgres"');
      await searchBox.fill('');
      await page.waitForTimeout(300);

      // Require PostgreSQL node to exist in deterministic test environment
      const postgresNode = page.locator('[data-testid="service-node-postgres-db"]').first();
      await postgresNode.waitFor({ state: 'visible', timeout: 8000 });
      assert(await postgresNode.isVisible(), 'Service node "postgres-db" must be visible in deterministic test environment');

      // Click node and assert detail drawer opens
      await postgresNode.click();
      console.log('  Clicked topology node "postgres-db"');

      const drawer = page.locator('[data-testid="service-detail-drawer"]');
      await drawer.waitFor({ state: 'visible', timeout: 6000 });
      assert(await drawer.isVisible(), 'Clicking service node must open service detail drawer');
      assert(await drawer.locator('h3:has-text("PostgreSQL")').isVisible(), 'Drawer must display PostgreSQL service name');
      assert(await drawer.locator('text=Observed Telemetry').first().isVisible(), 'Drawer must display Observed Telemetry section');

      // Close drawer and assert it closes
      const closeDrawerBtn = page.locator('[data-testid="close-service-detail-btn"]');
      await closeDrawerBtn.click();
      await page.waitForTimeout(400);
      assert(!(await drawer.isVisible()), 'Service detail drawer must close after clicking close button');
      console.log('  Service detail drawer opened and verified successfully');

      await captureScreenshot(page, '02_servicemap_desktop.png');
      sectionResults.push({ name: '2. Service Map & Topology', status: 'passed' });
    } catch (err) {
      sectionResults.push({ name: '2. Service Map & Topology', status: 'failed', error: err.message });
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
      assert(await scenarioCard.isVisible(), 'PostgreSQL scenario card must be visible');
      await scenarioCard.click();
      console.log('  Selected scenario card: "PostgreSQL Database Slowdown"');
      await page.waitForTimeout(400);

      // Click "Inject Selected Scenario" and deterministically capture POST /api/simulations/inject response
      const injectBtn = page.locator('button:has-text("Inject Selected Scenario")');
      await injectBtn.waitFor({ state: 'visible', timeout: 8000 });
      assert(await injectBtn.isVisible(), 'Inject button must be visible');
      assert(!(await injectBtn.isDisabled()), 'Inject button must be enabled');

      const [injectResponse] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes('/api/simulations/inject') && res.request().method() === 'POST',
          { timeout: 10000 }
        ),
        injectBtn.click(),
      ]);

      assert(injectResponse.ok(), `Simulation injection response must be OK (status ${injectResponse.status()})`);
      const injectData = await injectResponse.json();
      assert(
        typeof injectData.incidentId === 'string' && injectData.incidentId.length > 0,
        `Injection endpoint returned valid incidentId: ${JSON.stringify(injectData)}`
      );

      createdIncidentId = injectData.incidentId;
      console.log(`  Deterministic incident created successfully: ID=${createdIncidentId}`);

      // Verify Active Simulation Banner appears at Step 1
      await page.waitForSelector('text=Active Simulation: Step 1', { timeout: 8000 });
      assert(await page.locator('text=Active Simulation: Step 1').first().isVisible(), 'Active simulation Step 1 banner must be visible');
      console.log('  Verified Active Simulation status banner: Step 1');

      // Require Advance Step button to exist, be visible, and be enabled
      const advanceBtn = page.locator('button:has-text("Advance Step")');
      await advanceBtn.waitFor({ state: 'visible', timeout: 8000 });
      assert(await advanceBtn.isVisible(), 'Advance Step button must be visible after scenario injection');
      assert(!(await advanceBtn.isDisabled()), 'Advance Step button must be enabled after scenario injection');

      const [advanceResponse] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes('/api/simulations/advance') && res.request().method() === 'POST',
          { timeout: 10000 }
        ),
        advanceBtn.click(),
      ]);
      assert(advanceResponse.ok(), `Advance step response must be OK (status ${advanceResponse.status()})`);
      const advanceData = await advanceResponse.json();
      assert(advanceData.step === 2, `Advance step response must indicate step 2, got: ${advanceData.step}`);
      console.log('  Clicked "Advance Step" button and verified API step 2 response');

      await page.waitForSelector('text=Active Simulation: Step 2', { timeout: 8000 });
      assert(await page.locator('text=Active Simulation: Step 2').first().isVisible(), 'Active simulation Step 2 banner must be visible');
      console.log('  Verified Active Simulation status banner: Step 2');

      await captureScreenshot(page, '03_simulator_injected_desktop.png');
      sectionResults.push({ name: '3. Failure Simulator Injection', status: 'passed' });
    } catch (err) {
      sectionResults.push({ name: '3. Failure Simulator Injection', status: 'failed', error: err.message });
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
      const initialRowCount = await page.$$eval('table tbody tr', (rows) => rows.length);
      console.log(`  Initial incidents table row count: ${initialRowCount}`);
      assert(initialRowCount > 0, `Incidents table must have at least 1 row, found ${initialRowCount}`);

      // Verify the exact created incident link is present in the table
      assert(createdIncidentId !== null, 'createdIncidentId must exist before checking incidents table');
      const exactLinkSelector = `a[href="/incidents/${createdIncidentId}"]`;
      await page.waitForSelector(exactLinkSelector, { timeout: 8000 });
      assert(await page.locator(exactLinkSelector).first().isVisible(), `Link for exact incident /incidents/${createdIncidentId} must be visible`);
      console.log(`  Verified exact incident link in table: /incidents/${createdIncidentId}`);

      // Require status filter button IDENTIFIED to exist and be visible
      const identifiedBtn = page.locator('button:text-is("IDENTIFIED")');
      await identifiedBtn.waitFor({ state: 'visible', timeout: 5000 });
      assert(await identifiedBtn.isVisible(), 'Status filter button "IDENTIFIED" must be visible');
      await identifiedBtn.click();
      await page.waitForTimeout(400);

      // Verify the actual filtering result: every visible row must have status IDENTIFIED
      const filteredRowCount = await page.$$eval('table tbody tr', (rows) => rows.length);
      assert(filteredRowCount > 0, `Filtered table should contain at least 1 IDENTIFIED incident, found ${filteredRowCount}`);
      assert(filteredRowCount <= initialRowCount, `Filtered row count (${filteredRowCount}) must be <= initial count (${initialRowCount})`);

      const statuses = await page.$$eval('table tbody tr', (rows) =>
        rows.map((r) => r.querySelector('td:nth-child(3)')?.textContent?.trim() || '')
      );
      for (const st of statuses) {
        assert(st.includes('IDENTIFIED'), `Every visible filtered row must have status IDENTIFIED, got "${st}"`);
      }
      console.log(`  Verified IDENTIFIED filter applied correctly (${filteredRowCount} rows match)`);

      // Restore ALL filter and verify initial incident row count returns
      const allBtn = page.locator('button:text-is("ALL")').last();
      await allBtn.click();
      await page.waitForTimeout(300);

      const restoredRowCount = await page.$$eval('table tbody tr', (rows) => rows.length);
      assert(restoredRowCount === initialRowCount, `Restoring ALL should recover initial row count (${initialRowCount}), got ${restoredRowCount}`);
      assert(await page.locator(exactLinkSelector).first().isVisible(), 'Exact incident link confirmed after filter reset');
      console.log('  Reset filters via ALL pill; verified exact incident link present');

      await captureScreenshot(page, '04_incidents_list_desktop.png');
      sectionResults.push({ name: '4. Incidents List & Filtering', status: 'passed' });
    } catch (err) {
      sectionResults.push({ name: '4. Incidents List & Filtering', status: 'failed', error: err.message });
      throw err;
    }

    // ----------------------------------------------------
    // TEST 5: Incident Investigation Details & Deterministic Selection
    // ----------------------------------------------------
    console.log('\n--- 5. Testing Incident Investigation Details ---');
    try {
      assert(createdIncidentId !== null, 'Test 5 prerequisite missing: createdIncidentId is null.');

      // Locate the EXACT Investigate link for createdIncidentId
      const targetExactLink = page.locator(`a[href="/incidents/${createdIncidentId}"]`);
      await targetExactLink.waitFor({ state: 'visible', timeout: 8000 });
      assert(await targetExactLink.isVisible(), `Exact link a[href="/incidents/${createdIncidentId}"] must be visible`);
      console.log(`  Navigating to exact incident detail: /incidents/${createdIncidentId}`);

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        targetExactLink.click(),
      ]);

      // Verify the page URL corresponds to the same incident ID
      const pageUrl = page.url();
      assert(
        pageUrl.includes(`/incidents/${createdIncidentId}`),
        `Navigated URL "${pageUrl}" does not match created incident ID "${createdIncidentId}"`
      );

      // Check for incident not found error
      const notFoundElement = await page.$('text=Incident not found');
      assert(!notFoundElement, `Incident not found on detail page for ID "${createdIncidentId}"`);

      // Verify incident header displays ID
      await page.waitForSelector(`text=ID: ${createdIncidentId}`, { timeout: 8000 });
      assert(await page.locator(`text=ID: ${createdIncidentId}`).first().isVisible(), `Header must display ID: ${createdIncidentId}`);
      console.log(`  Confirmed incident detail header corresponds to ID: ${createdIncidentId}`);

      // Locate Ranked Root Causes tab button using reliable multi-fallback locator
      const rootCausesTabLocator = page.locator(
        'button:has-text("Ranked Root Causes"), button:has-text("DSA Graph Candidates"), [data-testid="ranked-root-causes-tab"]'
      );
      await rootCausesTabLocator.first().waitFor({ state: 'visible', timeout: 8000 });
      assert(await rootCausesTabLocator.first().isVisible(), 'Ranked Root Causes tab button must be visible');

      // Switch to the Ranked Root Causes / DSA Candidates tab
      await rootCausesTabLocator.first().click();
      await page.waitForTimeout(500);
      console.log('  Ranked Root Causes tab selected and active');

      // Verify root cause candidates or top suspect card is present
      const candidateCard = (await page.$('text=PostgreSQL')) || (await page.$('text=postgres-db')) || (await page.$('text=Heuristic Score'));
      assert(candidateCard !== null, 'Root cause candidate card must be rendered in investigation tab');
      console.log('  Verified Ranked Root Causes candidate card rendered');

      // Require Evidence Timeline tab and verify content appears after selection
      const evidenceTabBtn = page.locator('[data-testid="evidence-timeline-tab"]').first();
      await evidenceTabBtn.waitFor({ state: 'visible', timeout: 8000 });
      assert(await evidenceTabBtn.isVisible(), 'Evidence Timeline tab must exist');
      await evidenceTabBtn.click();
      await page.waitForTimeout(400);

      const evidencePanel = page.locator('[data-testid="evidence-timeline-panel"]').first();
      await evidencePanel.waitFor({ state: 'visible', timeout: 6000 });
      assert(await evidencePanel.isVisible(), 'Evidence Timeline content panel must appear after clicking Evidence Timeline tab');
      console.log('  Evidence Timeline tab selected and content panel verified');

      // Require Re-Run DSA Root-Cause Engine action
      const reanalyzeBtn = page.locator('[data-testid="reanalyze-button"]').first();
      await reanalyzeBtn.waitFor({ state: 'visible', timeout: 8000 });
      assert(await reanalyzeBtn.isVisible(), 'Re-Run DSA Root-Cause Engine button must be visible');

      const [reanalyzeResponse] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes(`/api/incidents/${createdIncidentId}/analyze`) && res.request().method() === 'POST',
          { timeout: 10000 }
        ),
        reanalyzeBtn.click(),
      ]);
      assert(reanalyzeResponse.ok(), `Re-Run DSA Root-Cause Engine POST returned status ${reanalyzeResponse.status()}`);
      const analyzeData = await reanalyzeResponse.json();

      // Validate rigorous response schema from analysis API
      assert(analyzeData && analyzeData.success === true, 'Analysis API response must have success: true');
      assert(typeof analyzeData.analysis === 'object' && analyzeData.analysis !== null, 'Analysis API response must include analysis object');
      assert(
        Array.isArray(analyzeData.analysis.allCandidates) && analyzeData.analysis.allCandidates.length > 0,
        'Analysis API response must include non-empty allCandidates array'
      );
      const topCand = analyzeData.analysis.allCandidates[0];
      assert(typeof topCand.serviceId === 'string', 'Analysis candidate must contain valid serviceId');
      assert(typeof topCand.score === 'number', 'Analysis candidate must contain numeric score');
      assert(typeof topCand.confidence === 'string', 'Analysis candidate must contain confidence rating');
      console.log(
        `  Re-Run DSA Root-Cause Engine response validated: candidate=${topCand.serviceId}, score=${topCand.score}, confidence=${topCand.confidence}`
      );

      // Verify the resulting investigation data reflects the re-analysis operation in the UI
      await rootCausesTabLocator.first().click();
      await page.waitForTimeout(500);
      assert(await page.locator(`text=ID: ${createdIncidentId}`).first().isVisible(), 'Incident header remains confirmed after re-analysis');
      assert(
        (await page.$('text=PostgreSQL')) !== null || (await page.$('text=postgres-db')) !== null,
        'Root cause candidates remain rendered following re-analysis'
      );

      await captureScreenshot(page, '05_incident_investigation_desktop.png');
      sectionResults.push({ name: '5. Incident Investigation Details', status: 'passed' });
    } catch (err) {
      sectionResults.push({ name: '5. Incident Investigation Details', status: 'failed', error: err.message });
      throw err;
    }

    // ----------------------------------------------------
    // TEST 6: Simulator Service Restoration & Reset
    // ----------------------------------------------------
    console.log('\n--- 6. Testing Simulator Service Restoration & Reset ---');
    try {
      await page.goto(`${BASE_URL}/simulator`, { waitUntil: 'domcontentloaded' });

      // Assert that the simulator page loaded
      await page.waitForSelector('h1:has-text("Failure Simulator")', { timeout: 8000 });
      assert(await page.locator('h1:has-text("Failure Simulator")').isVisible(), 'Failure Simulator page header must be visible');
      await page.waitForSelector('text=Live Fleet Telemetry', { timeout: 8000 });
      assert(await page.locator('text=Live Fleet Telemetry').first().isVisible(), 'Live Fleet Telemetry section must be visible');

      // Check for restore-eligible services (services with status DEGRADED or DOWN)
      await page.waitForTimeout(500);
      const restoreButtons = await page.$$('button:text-is("Restore")');
      let targetRestoreBtn = null;
      for (const btn of restoreButtons) {
        if (!(await btn.isDisabled())) {
          targetRestoreBtn = btn;
          break;
        }
      }

      if (targetRestoreBtn) {
        // Assert restore API response is successful
        const [restoreResponse] = await Promise.all([
          page.waitForResponse(
            (res) => res.url().includes('/api/services/') && res.url().endsWith('/restore') && res.request().method() === 'POST',
            { timeout: 10000 }
          ),
          targetRestoreBtn.click(),
        ]);
        assert(restoreResponse.ok(), `Service restore API returned non-OK status ${restoreResponse.status()}`);
        console.log('  Restored degraded service via API: 200 OK');
        await page.waitForTimeout(800);
        sectionResults.push({ name: '6. Simulator Service Restoration & Reset', status: 'passed' });
      } else {
        // If the environment intentionally has no restore-eligible service, explicitly classify this as SKIPPED rather than PASSED
        console.log('  No restore-eligible (DEGRADED/DOWN) services found in simulator; classifying as SKIPPED');
        sectionResults.push({
          name: '6. Simulator Service Restoration & Reset',
          status: 'skipped',
          skipReason: 'No restore-eligible service found in current simulator state',
        });
      }

      // Preserve safe behavior for protected database reset controls
      const finalResetBtn = page.locator('button:has-text("Reset Baseline")').first();
      if (await finalResetBtn.isVisible().catch(() => false)) {
        if (!(await finalResetBtn.isDisabled())) {
          await finalResetBtn.click();
          console.log('  Clicked "Reset Baseline" button');
          await page.waitForTimeout(1000);
        } else {
          console.log('  Reset Baseline button is disabled in current state (safe)');
        }
      }

      await captureScreenshot(page, '06_simulator_restored_desktop.png');
    } catch (err) {
      sectionResults.push({ name: '6. Simulator Service Restoration & Reset', status: 'failed', error: err.message });
      throw err;
    }

    // ----------------------------------------------------
    // TEST 7: DSA Lab Interactive Algorithms & Sandbox
    // ----------------------------------------------------
    console.log('\n--- 7. Testing DSA Lab Interactive Controls ---');
    try {
      await page.goto(`${BASE_URL}/dsa-lab`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('h1:has-text("Data Structures & Algorithms Lab")', { timeout: 8000 });
      assert(await page.locator('h1:has-text("Data Structures & Algorithms Lab")').isVisible(), 'DSA Lab page header must be visible');

      const expectedTabs = [
        {
          name: 'BFS',
          label: '1. BFS (Impact Propagation)',
          selector: 'button:has-text("1. BFS")',
          expectedContent: 'Traverses reverse-dependency edges',
        },
        {
          name: 'DFS',
          label: '2. DFS (Cycle Detection)',
          selector: 'button:has-text("2. DFS")',
          expectedContent: '3-Color Scheme',
        },
        {
          name: 'Priority Queue',
          label: '3. Priority Queue (Binary Heap)',
          selector: 'button:has-text("3. Priority Queue")',
          expectedContent: 'Binary Tree in array storage',
        },
        {
          name: 'Sliding Window',
          label: '4. Sliding Window Telemetry',
          selector: 'button:has-text("4. Sliding Window")',
          expectedContent: 'Sliding Window',
        },
        {
          name: 'Root-Cause Ranking Engine',
          label: '5. Root-Cause Ranking Engine',
          selector: 'button:has-text("5. Root-Cause Ranking Engine")',
          expectedContent: 'Heuristic Weights',
        },
      ];

      for (const tab of expectedTabs) {
        const tabBtn = page.locator(tab.selector);
        await tabBtn.waitFor({ state: 'visible', timeout: 6000 });
        assert(await tabBtn.isVisible(), `DSA Tab "${tab.label}" must exist and be visible`);

        await tabBtn.click();
        await page.waitForTimeout(400);

        // Verify active-tab state (class containing bg-blue-600)
        const btnClass = await tabBtn.getAttribute('class');
        assert(
          btnClass && btnClass.includes('bg-blue-600'),
          `Tab "${tab.label}" should have active styling (bg-blue-600), got: "${btnClass}"`
        );

        // Verify corresponding content is visible
        const contentLocator = page.locator(`text=${tab.expectedContent}`);
        await contentLocator.first().waitFor({ state: 'visible', timeout: 6000 });
        assert(
          await contentLocator.first().isVisible(),
          `Active tab "${tab.label}" should display content matching "${tab.expectedContent}"`
        );

        console.log(`  Verified tab "${tab.label}" active state and content`);

        // Extra DFS check: toggle synthetic cycle checkbox if present
        if (tab.name === 'DFS') {
          const cycleCheckbox = page.locator('input[type="checkbox"]');
          if (await cycleCheckbox.isVisible()) {
            await cycleCheckbox.click();
            await page.waitForTimeout(300);
            console.log('  Toggled synthetic test cycle checkbox in DFS tab');
          }
        }
      }

      await captureScreenshot(page, '07_dsalab_desktop.png');
      sectionResults.push({ name: '7. DSA Lab Interactive Controls', status: 'passed' });
    } catch (err) {
      sectionResults.push({ name: '7. DSA Lab Interactive Controls', status: 'failed', error: err.message });
      throw err;
    }

    // ----------------------------------------------------
    // TEST 8: Settings Page & Safe Destructive Controls
    // ----------------------------------------------------
    console.log('\n--- 8. Testing Settings Page ---');
    try {
      await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('h1:has-text("Settings & Diagnostics")', { timeout: 8000 });
      assert(await page.locator('h1:has-text("Settings & Diagnostics")').isVisible(), 'Settings page header must be visible');
      assert(await page.locator('text=System Administration').first().isVisible(), 'System Administration badge must be visible');

      // Verify diagnostics cards are rendered
      await page.waitForSelector('text=Database Layer', { timeout: 6000 });
      assert(await page.locator('text=Database Layer').isVisible(), 'Database Layer diagnostic card must be visible');

      // Verify safety protections on Reset Database control
      const resetDbBtn = page.locator('[data-testid="reset-database-button"]');
      await resetDbBtn.waitFor({ state: 'attached', timeout: 5000 });

      if (serverHealth.environment === 'production') {
        // In production, reset must be disabled and protected
        assert(await resetDbBtn.isDisabled(), 'Reset Database button must be disabled in production environment');
        const badge = page.locator('[data-testid="protected-in-production-badge"]');
        assert(await badge.isVisible(), 'Protected in Production badge must be visible in production environment');
        console.log('  Verified Reset Database control is safely protected and disabled in production');
      } else {
        console.log('  Reset Database control present in non-production environment');
      }

      await captureScreenshot(page, '08_settings_desktop.png');
      sectionResults.push({ name: '8. Settings & Diagnostics Page', status: 'passed' });
    } catch (err) {
      sectionResults.push({ name: '8. Settings & Diagnostics Page', status: 'failed', error: err.message });
      throw err;
    }

    // ----------------------------------------------------
    // TEST 9: Mobile Viewport (390x844 - iPhone 13) Verification
    // ----------------------------------------------------
    console.log('\n--- 9. Testing Mobile Viewport (390x844) Responsiveness ---');
    try {
      await page.setViewportSize({ width: 390, height: 844 });

      const mobilePages = [
        { name: 'Dashboard', path: '/', screenshot: '09_dashboard_mobile.png' },
        { name: 'Service Map', path: '/service-map', screenshot: '10_servicemap_mobile.png' },
        { name: 'Simulator', path: '/simulator', screenshot: '11_simulator_mobile.png' },
        { name: 'Incidents', path: '/incidents', screenshot: '12_incidents_mobile.png' },
      ];

      for (const p of mobilePages) {
        await page.goto(`${BASE_URL}${p.path}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(400);

        const dims = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          innerWidth: window.innerWidth,
        }));

        assert(
          dims.scrollWidth <= dims.clientWidth,
          `Mobile responsiveness overflow failure on ${p.name} (${p.path}): scrollWidth (${dims.scrollWidth}px) exceeds clientWidth (${dims.clientWidth}px, innerWidth: ${dims.innerWidth}px)`
        );

        console.log(`  ${p.name} Mobile - Clean (${dims.scrollWidth}px <= ${dims.clientWidth}px)`);
        await captureScreenshot(page, p.screenshot);
      }

      sectionResults.push({ name: '9. Mobile Viewport Responsiveness', status: 'passed' });
    } catch (err) {
      sectionResults.push({ name: '9. Mobile Viewport Responsiveness', status: 'failed', error: err.message });
      throw err;
    }

  } catch (err) {
    console.error('\n[FATAL ERROR IN BROWSER SUITE]:', err.message);
  } finally {
    await browser.close();
  }

  // ----------------------------------------------------
  // FINAL RESULT ACCOUNTING & CLASSIFICATION
  // ----------------------------------------------------
  const totalSections = 9;
  const executedSections = sectionResults.length;
  const passedSections = sectionResults.filter((r) => r.status === 'passed').length;
  const skippedSections = sectionResults.filter((r) => r.status === 'skipped').length;
  const failedSections = sectionResults.filter((r) => r.status === 'failed').length;

  const totalUnallowlistedErrors = consoleErrors.length + pageErrors.length + networkFailures.length + httpErrors.length;

  let finalClassification = 'FAILED';
  let exitCode = 1;

  if (failedSections === 0 && assertionsFailed === 0 && totalUnallowlistedErrors === 0 && executedSections === totalSections) {
    if (skippedSections === 0 && passedSections === totalSections) {
      finalClassification = 'PASS';
      exitCode = 0;
    } else if (skippedSections > 0) {
      finalClassification = 'PASS WITH SKIPS';
      exitCode = 0;
    }
  }

  console.log('\n================================================================');
  console.log('                   BROWSER TEST REPORT SUMMARY                  ');
  console.log('================================================================');
  console.log(`Final Classification:   ${finalClassification}`);
  console.log(`Sections Executed:      ${executedSections} / ${totalSections}`);
  console.log(`Sections Passed:        ${passedSections}`);
  console.log(`Sections Skipped:       ${skippedSections}`);
  console.log(`Sections Failed:        ${failedSections}`);
  console.log(`Assertions Passed:      ${assertionsPassed}`);
  console.log(`Assertions Failed:      ${assertionsFailed}`);
  console.log(`Browser Console Errors: ${consoleErrors.length}`);
  console.log(`Page Errors:            ${pageErrors.length}`);
  console.log(`Network Failures:       ${networkFailures.length}`);
  console.log(`HTTP Error Responses:   ${httpErrors.length}`);
  console.log(`Process Exit Code:      ${exitCode}`);

  console.log('\nSection Details:');
  sectionResults.forEach((r) => {
    const symbol = r.status === 'passed' ? '✓' : r.status === 'skipped' ? '⊘' : '✗';
    const detail = r.error ? ` (Error: ${r.error})` : r.skipReason ? ` (Skipped: ${r.skipReason})` : '';
    console.log(`  ${symbol} [${r.status.toUpperCase()}] ${r.name}${detail}`);
  });

  if (consoleErrors.length > 0) {
    console.log('\n[Console Errors]:');
    consoleErrors.forEach((e) => console.log(`  - ${e.text} (${e.location?.url}:${e.location?.lineNumber})`));
  }

  if (pageErrors.length > 0) {
    console.log('\n[Page Errors]:');
    pageErrors.forEach((e) => console.log(`  - ${e.message}`));
  }

  if (networkFailures.length > 0) {
    console.log('\n[Network Failures]:');
    networkFailures.forEach((n) => console.log(`  - ${n.method} ${n.url} (${n.errorText})`));
  }

  if (httpErrors.length > 0) {
    console.log('\n[HTTP Error Responses (>=400)]:');
    httpErrors.forEach((h) => console.log(`  - ${h.method} ${h.url} -> ${h.status} ${h.statusText}`));
  }

  if (exitCode === 0) {
    console.log(`\n>>> BROWSER SUITE OVERALL RESULT: ${finalClassification}`);
  } else {
    console.error(`\n>>> BROWSER SUITE OVERALL RESULT: ${finalClassification}`);
  }

  process.exit(exitCode);
}

runBrowserSuite().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
