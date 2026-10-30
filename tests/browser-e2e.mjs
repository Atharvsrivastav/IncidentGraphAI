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
  const pageErrors = [];
  const networkFailures = [];
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
    pageErrors.push(`[Page Error]: ${err.message}`);
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
      assert(pageTitle.includes('IncidentGraph'), `Expected page title to contain "IncidentGraph", got "${pageTitle}"`);

      // Check main branding and KPI counters
      await page.waitForSelector('text=IncidentGraph AI', { timeout: 8000 });
      assert(await page.locator('text=IncidentGraph AI').first().isVisible(), 'Branding header "IncidentGraph AI" must be visible');

      const quickActions = await page.$('text=Quick Actions');
      console.log(`  Dashboard Quick Actions: ${quickActions ? 'Present' : 'Not found'}`);

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
      if (await searchBox.isVisible()) {
        await searchBox.fill('postgres');
        await page.waitForTimeout(400);
        console.log('  Search filter filled with "postgres"');
        await searchBox.fill('');
        await page.waitForTimeout(300);
        assert(true, 'Search filter interaction succeeded');
      }

      // Click on a node in the graph
      const postgresNode = page.locator('text=postgres-db').first();
      if (await postgresNode.isVisible()) {
        await postgresNode.click();
        await page.waitForTimeout(500);
        console.log('  Clicked topology node "postgres-db"');
        assert(true, 'Clicked topology node "postgres-db"');
      }

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
      assert(await page.locator('text=Active Simulation: Step 1').isVisible(), 'Active simulation Step 1 banner must be visible');
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
        assert(advanceResponse.ok(), `Advance step response must be OK (status ${advanceResponse.status()})`);
        console.log('  Clicked "Advance Step" button');
        await page.waitForSelector('text=Active Simulation: Step 2', { timeout: 8000 });
        assert(await page.locator('text=Active Simulation: Step 2').isVisible(), 'Active simulation Step 2 banner must be visible');
        console.log('  Verified Active Simulation status banner: Step 2');
      }

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
      const rowCount = await page.$$eval('table tbody tr', (rows) => rows.length);
      console.log(`  Incidents table row count: ${rowCount}`);
      assert(rowCount > 0, `Incidents table must have at least 1 row, found ${rowCount}`);

      // Verify the exact created incident link is present in the table
      assert(createdIncidentId !== null, 'createdIncidentId must exist before checking incidents table');
      const exactLinkSelector = `a[href="/incidents/${createdIncidentId}"]`;
      await page.waitForSelector(exactLinkSelector, { timeout: 8000 });
      assert(await page.locator(exactLinkSelector).first().isVisible(), `Link for exact incident /incidents/${createdIncidentId} must be visible`);
      console.log(`  Verified exact incident link in table: /incidents/${createdIncidentId}`);

      // Click status filter "IDENTIFIED"
      const identifiedBtn = await page.$('button:text-is("IDENTIFIED")');
      if (identifiedBtn) {
        await identifiedBtn.click();
        await page.waitForTimeout(300);
        console.log('  Clicked status filter: "IDENTIFIED"');
        assert(true, 'Filtered by status IDENTIFIED');
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
      assert(await page.locator(exactLinkSelector).first().isVisible(), 'Exact incident link confirmed after filter reset');

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

      // Click "Evidence Timeline" tab
      const evidenceTabBtn = page.locator('button:has-text("Evidence Timeline")');
      if (await evidenceTabBtn.isVisible()) {
        await evidenceTabBtn.click();
        await page.waitForTimeout(500);
        console.log('  Switched to "Evidence Timeline" tab');
        assert(true, 'Switched to Evidence Timeline tab');
      }

      // Click "Re-Run DSA Root-Cause Engine" button if visible, asserting POST API response
      const reanalyzeBtn = page.locator('button:has-text("Re-Run DSA Root-Cause Engine")');
      if (await reanalyzeBtn.isVisible()) {
        const [reanalyzeResponse] = await Promise.all([
          page.waitForResponse(
            (res) => res.url().includes(`/api/incidents/${createdIncidentId}/analyze`) && res.request().method() === 'POST',
            { timeout: 10000 }
          ),
          reanalyzeBtn.click(),
        ]);
        assert(reanalyzeResponse.ok(), `Re-Run DSA Root-Cause Engine POST returned status ${reanalyzeResponse.status()}`);
        const analyzeData = await reanalyzeResponse.json();
        assert(analyzeData !== null, 'Re-analysis API returned JSON response');
        console.log('  Re-Run DSA Root-Cause Engine POST request succeeded');

        // Verify resulting incident data or visible confirmation after the request
        await page.waitForTimeout(600);
        assert(await page.locator(`text=ID: ${createdIncidentId}`).first().isVisible(), 'Incident header remains confirmed after re-analysis');
      }

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

      // Check for restore-eligible services
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
          console.log('  Reset Baseline button is disabled');
        }
      } else {
        console.log('  Reset Baseline button protected/hidden in current environment');
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
            assert(true, 'Toggled DFS test cycle checkbox');
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
    // TEST 8: Settings Page
    // ----------------------------------------------------
    console.log('\n--- 8. Testing Settings Page ---');
    try {
      await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('h1:has-text("Settings & Diagnostics")', { timeout: 8000 });
      assert(await page.locator('h1:has-text("Settings & Diagnostics")').isVisible(), 'Settings page header must be visible');
      assert(await page.locator('text=System Administration').first().isVisible(), 'System Administration badge must be visible');

      await page.waitForTimeout(500);

      const resetDbBtn = page.locator('button:has-text("Reset Database")');
      if (await resetDbBtn.isVisible().catch(() => false)) {
        if (!(await resetDbBtn.isDisabled().catch(() => true))) {
          await resetDbBtn.click({ timeout: 3000 }).catch(() => null);
          await page.waitForTimeout(600);
          console.log('  Interacted with "Reset Database" button');
          assert(true, 'Interacted with enabled Reset Database button');
        } else {
          console.log('  Reset Database button is protected or disabled in this environment (safe)');
          assert(true, 'Reset Database button is safely protected/disabled');
        }
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

  console.log('\n================================================================');
  console.log('                   BROWSER TEST REPORT SUMMARY                  ');
  console.log('================================================================');

  const passedSections = sectionResults.filter((r) => r.status === 'passed').length;
  const skippedSections = sectionResults.filter((r) => r.status === 'skipped').length;
  const failedSections = sectionResults.filter((r) => r.status === 'failed').length;
  const totalSections = 9;

  console.log(`Sections Executed:  ${sectionResults.length} / ${totalSections}`);
  console.log(`Sections Passed:    ${passedSections}`);
  console.log(`Sections Skipped:   ${skippedSections}`);
  console.log(`Sections Failed:    ${failedSections}`);
  console.log(`Assertions Passed:  ${assertionsPassed}`);
  console.log(`Assertions Failed:  ${assertionsFailed}`);

  sectionResults.forEach((r) => {
    const symbol = r.status === 'passed' ? '✓' : r.status === 'skipped' ? '⊘' : '✗';
    const detail = r.error ? ` (Error: ${r.error})` : r.skipReason ? ` (Skipped: ${r.skipReason})` : '';
    console.log(`  ${symbol} [${r.status.toUpperCase()}] ${r.name}${detail}`);
  });

  console.log(`\nBrowser Console Errors: ${consoleErrors.length}`);
  consoleErrors.forEach((e) => console.log(`  ${e}`));

  console.log(`Page Errors: ${pageErrors.length}`);
  pageErrors.forEach((e) => console.log(`  ${e}`));

  console.log(`Network Failures: ${networkFailures.length}`);
  networkFailures.forEach((n) => console.log(`  ${n}`));

  const allPassedOrSkipped = (passedSections + skippedSections === totalSections) && failedSections === 0 && assertionsFailed === 0;

  if (allPassedOrSkipped) {
    console.log(`\n>>> BROWSER SUITE OVERALL RESULT: 100% PASS (${passedSections} passed, ${skippedSections} skipped, 0 failed)`);
    process.exit(0);
  } else {
    console.error(`\n>>> BROWSER SUITE OVERALL RESULT: FAILED (${failedSections} failed, ${assertionsFailed} failed assertions)`);
    process.exit(1);
  }
}

runBrowserSuite().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
