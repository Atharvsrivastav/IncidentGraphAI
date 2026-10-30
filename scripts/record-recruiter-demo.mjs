import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const BASE_URL = 'http://localhost:3000';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SCREENSHOT_DIR = path.resolve(process.cwd(), 'docs/screenshots');
const RECORDINGS_DIR = path.resolve(process.cwd(), 'docs/recordings');
const ARTIFACT_DIR = 'C:\\Users\\Atharv\\.gemini\\antigravity-ide\\brain\\963f9580-4405-48da-8240-8db965e8c903\\screenshots';

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

async function captureScreenshot(page, filename) {
  const localFile = path.join(SCREENSHOT_DIR, filename);
  const artifactFile = path.join(ARTIFACT_DIR, filename);
  await page.screenshot({ path: localFile, fullPage: false });
  fs.copyFileSync(localFile, artifactFile);
  console.log(`[Screenshot Captured]: ${filename} (1920x1080 16:9)`);
}

async function runRecruiterDemo() {
  console.log('========================================================================');
  console.log('   IncidentGraph AI: 3-Minute Recruiter Demo Recording & Capture Engine  ');
  console.log('========================================================================');

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: RECORDINGS_DIR,
      size: { width: 1920, height: 1080 }
    }
  });

  const page = await context.newPage();

  try {
    // -------------------------------------------------------------------------
    // SCENE 0: Initialize Clean Baseline (0:00 - 0:05)
    // -------------------------------------------------------------------------
    console.log('\n>>> Scene 0: Resetting Baseline on Isolated Local Environment...');
    await page.goto(`${BASE_URL}/simulator`, { waitUntil: 'networkidle' });
    const resetBaseline = await page.$('button:has-text("Reset Baseline")');
    if (resetBaseline && !(await resetBaseline.isDisabled())) {
      await resetBaseline.click();
      await page.waitForTimeout(1000);
    }

    // -------------------------------------------------------------------------
    // SCENE 1: The Real-World Problem — Overview Dashboard (0:00 - 0:25)
    // -------------------------------------------------------------------------
    console.log('\n>>> Scene 1: Overview Dashboard (0:00 - 0:25)...');
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=IncidentGraph AI', { timeout: 8000 });
    await page.waitForTimeout(3000);

    // Capture Screenshot 1: Hero Dashboard
    await captureScreenshot(page, '01_hero_dashboard.png');
    await page.waitForTimeout(5000);

    // -------------------------------------------------------------------------
    // SCENE 2: Inject a Failure — Simulator (0:25 - 0:55)
    // -------------------------------------------------------------------------
    console.log('\n>>> Scene 2: Injecting PostgreSQL Failure Scenario (0:25 - 0:55)...');
    await page.goto(`${BASE_URL}/simulator`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Select PostgreSQL scenario card
    const pgScenarioCard = await page.$('text=PostgreSQL Database Slowdown') ||
                           await page.$('text=PostgreSQL Connection Pool Exhaustion');
    if (pgScenarioCard) {
      await pgScenarioCard.click();
      await page.waitForTimeout(1000);
    }

    // Inject failure
    const injectBtn = await page.$('button:has-text("Inject Selected Scenario")');
    if (injectBtn) {
      await injectBtn.click();
      console.log('  Injected PostgreSQL Database Slowdown scenario.');
      await page.waitForTimeout(3000);
    }

    // Advance to Step 2 to cascade failure to dependent services
    const advanceBtn = await page.$('button:has-text("Advance Step")');
    if (advanceBtn && !(await advanceBtn.isDisabled())) {
      await advanceBtn.click();
      console.log('  Advanced simulation to Step 2 (Cascade propagating).');
      await page.waitForTimeout(3000);
    }

    // Capture Screenshot 3: Failure Simulation Injected
    await captureScreenshot(page, '03_failure_simulation.png');
    await page.waitForTimeout(4000);

    // -------------------------------------------------------------------------
    // SCENE 3: Visualize the Cascade — Service Dependency Map (0:55 - 1:25)
    // -------------------------------------------------------------------------
    console.log('\n>>> Scene 3: Visualizing Cascade on Service Map (0:55 - 1:25)...');
    await page.goto(`${BASE_URL}/service-map`, { waitUntil: 'networkidle' });
    await page.waitForSelector('svg', { timeout: 8000 });
    await page.waitForTimeout(2500);

    // Click on postgres-db node to highlight upstream blast radius
    const pgNode = await page.$('text=postgres-db') || await page.$('text=PostgreSQL');
    if (pgNode) {
      await pgNode.click({ force: true });
      await page.waitForTimeout(1500);
    }

    // Capture Screenshot 2: Service Dependency Map
    await captureScreenshot(page, '02_service_dependency_map.png');
    await page.waitForTimeout(5000);

    // -------------------------------------------------------------------------
    // SCENE 4: Explain the Diagnosis — Root Cause Analysis (1:25 - 2:00)
    // -------------------------------------------------------------------------
    console.log('\n>>> Scene 4: Incident Investigation & Ranked Diagnosis (1:25 - 2:00)...');
    await page.goto(`${BASE_URL}/incidents`, { waitUntil: 'networkidle' });
    await page.waitForSelector('table tbody tr', { timeout: 8000 });
    await page.waitForTimeout(2000);

    // Click Investigate on the active incident
    const investigateBtn = await page.$('a:has-text("Investigate")');
    if (investigateBtn) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }),
        investigateBtn.click({ force: true })
      ]);
      await page.waitForTimeout(2500);
    }

    // Switch to "Ranked Root Causes" tab
    const rootCausesTab = await page.$('button:has-text("Ranked Root Causes")');
    if (rootCausesTab) {
      await rootCausesTab.click({ force: true });
      await page.waitForTimeout(2000);
    }

    // Re-run the DSA Root Cause Engine to demonstrate deterministic calculation
    const reanalyzeBtn = await page.$('button:has-text("Re-Run DSA Root-Cause Engine")');
    if (reanalyzeBtn) {
      await reanalyzeBtn.click({ force: true });
      await page.waitForTimeout(2500);
    }

    // Capture Screenshot 4: Root Cause Diagnosis & Ranked Candidates
    await captureScreenshot(page, '04_root_cause_diagnosis.png');
    await page.waitForTimeout(4000);

    // View Evidence Timeline
    const evidenceTab = await page.$('button:has-text("Evidence Timeline")');
    if (evidenceTab) {
      await evidenceTab.click({ force: true });
      await page.waitForTimeout(3000);
    }

    // -------------------------------------------------------------------------
    // SCENE 5: AI Investigation — Deterministic Evidence Replay (2:00 - 2:35)
    // -------------------------------------------------------------------------
    console.log('\n>>> Scene 5: AI Investigation Replay (2:00 - 2:35)...');
    const aiTab = await page.$('button:has-text("AI Investigation")');
    if (aiTab) {
      await aiTab.click({ force: true });
      await page.waitForTimeout(2000);
    }

    // Trigger the deterministic simulation replay demo
    const replayDemoBtn = await page.$('button:has-text("Run Simulation Replay Demo")') ||
                          await page.$('button:has-text("Re-run Investigation")');
    if (replayDemoBtn) {
      await replayDemoBtn.click({ force: true });
      console.log('  Triggered deterministic evidence-grounded AI replay.');
      await page.waitForTimeout(4000);
    }

    // Expand hypothesis details if collapsed
    const hypothesisSection = await page.$('text=Ranked Hypotheses');
    if (hypothesisSection) {
      await page.waitForTimeout(2000);
    }

    // Capture Screenshot 5: AI Replay Investigation Report
    await captureScreenshot(page, '05_ai_replay_investigation.png');
    await page.waitForTimeout(5000);

    // -------------------------------------------------------------------------
    // SCENE 6: Engineering Architecture & Diagnostics (2:35 - 3:00)
    // -------------------------------------------------------------------------
    console.log('\n>>> Scene 6: Architecture & Live Health Diagnostics (2:35 - 3:00)...');
    await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    // Clean restore on simulator
    await page.goto(`${BASE_URL}/simulator`, { waitUntil: 'networkidle' });
    const restoreBtns = await page.$$('button:text-is("Restore")');
    for (const btn of restoreBtns) {
      if (!(await btn.isDisabled())) {
        await btn.click();
        await page.waitForTimeout(800);
      }
    }
    const finalReset = await page.$('button:has-text("Reset Baseline")');
    if (finalReset && !(await finalReset.isDisabled())) {
      await finalReset.click();
      await page.waitForTimeout(1000);
    }

    // Return to dashboard for clean conclusion
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    console.log('\n>>> All Demo Walkthrough Scenes Executed Successfully.');
  } catch (error) {
    console.error('\n[Demo Execution Error]:', error);
    throw error;
  } finally {
    // Save video
    const videoObj = page.video();
    await page.close();
    await context.close();
    await browser.close();

    if (videoObj) {
      const videoPath = await videoObj.path();
      console.log(`\n[Playwright Video Saved]: ${videoPath}`);

      const mp4Path = path.join(RECORDINGS_DIR, 'incident_graph_ai_recruiter_demo.mp4');
      try {
        console.log(`Converting ${videoPath} to MP4 (${mp4Path}) using ffmpeg...`);
        execSync(`ffmpeg -y -i "${videoPath}" -c:v libx264 -preset fast -crf 22 -c:a aac "${mp4Path}"`, {
          stdio: 'inherit'
        });
        console.log(`[Converted MP4 Ready]: ${mp4Path}`);
      } catch (e) {
        console.warn('FFmpeg MP4 conversion notice (WebM video remains intact):', e.message);
      }
    }
  }
}

runRecruiterDemo().catch((err) => {
  console.error('Demo script failure:', err);
  process.exit(1);
});
