/**
 * ui.smoke.test.mjs - boots the real server, builds the real DOM and drives the
 * real client modules (router, views, markdown renderer, fetch wrapper).
 *
 * jsdom cannot execute `<script type="module">`, so the test wires the client
 * modules up itself against a jsdom document. Skipped when jsdom is absent,
 * because the app itself ships with zero dependencies:
 *
 *   npm install --no-save jsdom && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test('the UI renders, navigates and trades in paper mode without an uncaught error', { skip: JSDOM ? false : 'jsdom is not installed (npm install --no-save jsdom)' }, async (t) => {
  const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-ui-')), 'desk.json');
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), DESK_DATA: dataFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  child.stdout.on('data', (d) => serverLog.push(String(d)));
  child.stderr.on('data', (d) => serverLog.push(String(d)));
  t.after(() => child.kill('SIGKILL'));
  assert.ok(await waitForServer(), `server did not start: ${serverLog.join('')}`);

  const html = await (await fetch(`${BASE}/`)).text();
  assert.match(html, /PAPER MODE|paper mode/i);

  const dom = new JSDOM(html, { url: `${BASE}/`, pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error?.stack || e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${e.reason?.message || e.reason}`));
  window.Chart = undefined; // charts are optional; jsdom has no canvas

  /* publish the DOM to the module scope the client expects */
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.location = window.location;
  // Node 22 exposes `navigator` as a getter-only global; redefine it instead
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  globalThis.HashChangeEvent = window.HashChangeEvent;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  const nodeFetch = globalThis.fetch; // captured first, so the wrapper cannot call itself
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, BASE);
    const res = await nodeFetch(url, init);
    calls.push(`${url.pathname} -> ${res.status}`);
    return res;
  };
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...rest) => {
    const timer = realSetInterval(fn, ms, ...rest);
    timer.unref?.();
    return timer;
  };
  t.after(() => window.close());

  register('./ui.loader.mjs', import.meta.url);

  const waitFor = async (fn, what, timeoutMs = 9000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        if (fn()) return true;
      } catch {
        /* keep waiting */
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    const toasts = [...window.document.querySelectorAll('.toast')].map((x) => x.textContent).join(' || ');
    throw new Error(
      `timed out waiting for ${what}; page errors: ${errors.join(' | ') || 'none'}; toasts: ${toasts || 'none'}; api calls: ${calls.slice(-12).join(', ')}; view: ${(view().textContent || '').replace(/\s+/g, " ").slice(0, 1600)}`,
    );
  };
  const view = () => window.document.querySelector('#view');

  await import('../public/client/app.mjs');

  /* 1. boot: nav, paper-mode status bar, onboarding checklist on an empty ledger */
  await waitFor(() => window.document.querySelectorAll('.navlink').length >= 5, 'the navigation to render');
  const navText = window.document.querySelector('#nav').textContent;
  for (const label of ['Polymarket', 'Positions & results', 'Crypto tools', 'Crypto review', 'Checks & settings', 'Setup guide']) {
    assert.match(navText, new RegExp(label), `nav is missing "${label}"`);
  }
  await waitFor(() => view().textContent.includes('Your Polymarket workflow'), 'the Polymarket home page');
  const status = () => window.document.querySelector('#statusbar').textContent;
  assert.match(status(), /PAPER MODE/);
  assert.match(status(), /\$1,000/);
  assert.match(view().textContent, /No wallet, no real orders/);

  const go = async (hash, expectText) => {
    window.location.hash = hash;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(() => view().textContent.includes(expectText), `${hash} to render "${expectText}"`);
  };

  /* 2. every route renders */
  await go('#/desk', 'Step 1 - market data in');
  assert.match(view().textContent, /No wallet/);
  await go('#/log', 'Paper trades');
  [...view().querySelectorAll('button')].find(b => b.textContent === 'Paper trades').click();
  await waitFor(() => view().textContent.includes('Paper trades') && view().querySelector('.tab-active')?.textContent === 'Paper trades', 'crypto trades tab');
  await go('#/review', 'The headline numbers');
  await go('#/research', 'Prediction-Market');
  await go('#/start', 'Onboarding checklist');

  /* 3. the guide renders from docs/SETUP_GUIDE.md and the prompts are on the page */
  await go('#/guide', 'Before You Start');
  await waitFor(() => window.document.querySelectorAll('.doc h2, .doc h3').length > 3, 'the rendered guide headings');
  const guideText = window.document.querySelector('.doc').textContent;
  assert.match(guideText, /6 AI Bot Trading Team/);
  assert.match(guideText, /Important Disclaimer/);

  /* 4. the self-test proves the rules fire (it runs against a throwaway ledger) */
  await go('#/start', 'Final checklist');
  const selftestBtn = [...view().querySelectorAll('button')].find((b) => b.textContent.includes('self-test'));
  assert.ok(selftestBtn, 'the self-test button exists');
  selftestBtn.click();
  await waitFor(() => view().textContent.includes('rules fired correctly'), 'the four-scenario self-test', 20000);
  assert.match(view().textContent, /4\/4 scenarios behaved exactly as designed/);

  /* 4b. the agents tab shows the copy-paste prompts */
  [...view().querySelectorAll('.tab')].find((b) => b.textContent.includes('The six agents')).click();
  await waitFor(() => view().textContent.includes('Agent 5 - Anti-FOMO'), 'the agent cards');
  assert.match(view().textContent, /You are the Anti-FOMO Risk Agent/, 'the copy-paste prompt is shown');
  assert.match(view().textContent, /Agent 1 - Scanner/);

  /* 5. demo data through the desk, then the full guided pipeline */
  await go('#/desk', 'Step 1 - market data in');
  [...view().querySelectorAll('button')].find((b) => b.textContent.includes('Use demo data')).click();
  await waitFor(() => view().textContent.includes('scenario: base'), 'the base demo snapshot to render');
  assert.match(view().textContent, /DEMO DATA - not real market data/);

  [...view().querySelectorAll('button')].find((b) => b.textContent.includes('Derive plan from structure')).click();
  await waitFor(() => view().textContent.includes('Base / coil'), 'the derived plan');

  [...view().querySelectorAll('button')].find((b) => b.textContent.includes('Run the 6-agent pipeline')).click();
  for (const stage of ['Scanner', 'Anti-FOMO', 'Sizer']) {
    await waitFor(() => view().textContent.includes(`Waiting for your decision - ${stage}`), `the ${stage} gate`);
    const approveBtn = [...view().querySelectorAll('button')].find((b) => b.textContent.includes(`I approve ${stage}`));
    assert.ok(approveBtn, `the approve button for ${stage} is missing`);
    approveBtn.click();
  }
  await waitFor(() => view().textContent.includes('Paper ticket'), 'the paper ticket', 15000);
  assert.match(view().textContent, /STATUS: OPEN/);

  /* 6. the ledger holds the ticket and the status bar reflects the open position */
  await go('#/log', 'Paper trades');
  const ticketId = /PT-\d{8}-\d{3}/.exec(view().textContent)[0];
  assert.ok(ticketId, 'the ledger shows the ticket id');
  assert.match(view().textContent, /OPEN/, 'the ticket is open');
  assert.match(status(), /0\/3 paper bets open/, 'crypto trades must not count as Polymarket positions');
  assert.match(status(), /Read-only/, 'the status bar identifies read-only access');

  /* 7. close it at a loss, from the UI, and confirm the loss is kept */
  await go('#/desk', 'Step 1 - market data in');
  const closeBtn = [...view().querySelectorAll('button')].find((b) => b.textContent.includes('Close this paper position'));
  assert.ok(closeBtn, 'the close button exists');
  closeBtn.click();
  await waitFor(() => window.document.querySelector('.overlay .modal'), 'the close dialog');
  const modalDialog = window.document.querySelector('.overlay .modal');
  const exitInput = modalDialog.querySelector('input[type=number]');
  assert.ok(Number(exitInput.value) > 0, 'the dialog pre-fills the last observed price');
  const stopText = [...view().querySelectorAll('.metric')].find((m) => m.querySelector('.metric-k')?.textContent === 'stop')?.querySelector('.metric-v')?.textContent;
  const stopPrice = Number(String(stopText).replace(/[^\d.]/g, ''));
  assert.ok(stopPrice > 0, `the open position panel shows the stop (got "${stopText}")`);
  exitInput.value = String(stopPrice); // a clean stop-out
  [...modalDialog.querySelectorAll('button')].find((b) => b.textContent === 'Stop was hit').click();
  [...modalDialog.querySelectorAll('button')].find((b) => b.textContent.includes('Record the close')).click();
  await waitFor(() => !window.document.querySelector('.overlay'), 'the dialog to close', 12000);
  await waitFor(() => view().textContent.includes('0/1 position open'), 'the position to be closed', 12000);
  await go('#/log', 'Paper trades');
  await waitFor(() => view().textContent.includes('LOSS'), 'the losing trade in the ledger');
  assert.match(view().textContent, /LOSS/, 'the loss is recorded, not hidden');
  assert.match(view().textContent, /1 closed, 0 open/i);
  const pnlText = [...view().querySelectorAll('td')].find((td) => /^-?\$/.test(td.textContent) && td.className.includes('down'))?.textContent || '';
  const loss = Math.abs(Number(String(pnlText).replace(/[^\d.]/g, '')));
  assert.ok(loss > 0 && loss < 10.5, `the stop-out lost ${loss}, which must stay inside the 1% (\$10) rule`);

  /* 8. the Anti-FOMO block path, end to end through the UI */
  await go('#/desk', 'Step 1 - market data in');
  const demoSelect = [...view().querySelectorAll('select')].find((sel) => [...sel.options].some((o) => o.value === 'pump'));
  assert.ok(demoSelect, 'the demo scenario picker exists');
  demoSelect.value = 'pump';
  [...view().querySelectorAll('button')].find((b) => b.textContent.includes('Use demo data')).click();
  await waitFor(() => view().textContent.includes('scenario: pump'), 'the pump snapshot to render (not the previous one)');
  assert.match(view().textContent, /\+10\.\d+%/, 'the pump move is visible');
  view().querySelector('input[name=mode][value=auto]').click();
  [...view().querySelectorAll('button')].find((b) => b.textContent.includes('plan from structure')).click();
  await waitFor(() => view().textContent.includes('Momentum continuation'), 'the momentum plan');
  [...view().querySelectorAll('button')].find((b) => b.textContent.includes('Run the 6-agent pipeline')).click();
  await waitFor(() => view().textContent.includes('Trade blocked at the antiFomo stage'), 'the Anti-FOMO block', 15000);
  assert.match(view().textContent, /no ticket/i);

  await go('#/log', 'Paper trades');
  [...view().querySelectorAll('.tab')].find((b) => b.textContent.includes('Blocked setups')).click();
  await waitFor(() => view().textContent.includes('Chased an extended move (Anti-FOMO)'), 'the blocked setup in the ledger');
  assert.match(view().textContent, /BLK-\d{8}-\d{3}/);
  const outcomeSelect = view().querySelector('select.input-mini');
  assert.ok(outcomeSelect, 'a blocked setup can be reviewed later');
  outcomeSelect.value = 'would have lost';
  outcomeSelect.dispatchEvent(new window.Event('change'));
  await waitFor(() => calls.some((c) => c.startsWith('/api/blocked-review -> 200')), 'the review outcome to be sent');
  await waitFor(() => view().querySelector('select.input-mini') !== outcomeSelect && view().querySelector('select.input-mini').value === 'would have lost', 'the reviewed row to re-render with the saved outcome');

  /* 9. the review page reports it honestly */
  await go('#/review', 'The headline numbers');
  assert.match(view().textContent, /blocks reviewed/);
  assert.match(view().textContent, /blocks that avoided a loss/);

  assert.deepEqual(errors, [], `the page logged errors: ${errors.join(' | ')}`);
});
