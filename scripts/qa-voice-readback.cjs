'use strict';
// Exercise feedback regression. Injects recognised transcripts, not microphone audio.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.QGH_QA_URL || 'http://127.0.0.1:4214/';
const out = path.resolve('artifacts/voice-readback');

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let flows = 0;
  try {
    for (const [width, height] of [[1366, 768], [360, 800], [412, 915]]) {
      for (const tactical of [false, true]) for (const us of [false, true]) {
        const name = `${tactical ? 'tactical' : 'single'}-${us ? 'us' : 'normal'}-${width}`;
        const page = await browser.newPage({ viewport: { width, height }, serviceWorkers: 'block' });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(new URL(tactical ? 'tactical.html' : 'single.html', base).href);
        if (us) await page.locator(tactical ? '#tProcedureUs' : '#us').click();
        await page.locator(tactical ? '#tStart' : '#startExercise').click();
        if (!tactical && width < 600) {
          await page.locator('#mobileControlsToggle').click();
          assert.equal(await page.locator('#controls').isVisible(), false, `${name}: controls collapsed`);
        }
        const ackId = tactical ? 'tVoiceCommandAck' : 'voiceCommandAck';
        const prefix = tactical ? 'falcon ' : '';
        const expectedPrefix = tactical ? 'FALCON 11 · ' : '';
        const clockId = tactical ? 'tHomingClock' : 'homingClock';
        const clock = page.locator(`#${clockId}`);
        async function call(text, ok = true, addressed = true) {
          const result = await page.evaluate(phrase => QGHVoiceWorkspace.dispatchTranscript(phrase), (addressed ? prefix : '') + text);
          assert.equal(result.ok, ok, `${name}: ${text}`);
          await page.waitForFunction(id => /^(APPLIED|REJECTED) ·/.test(document.getElementById(id).textContent), ackId);
          return page.locator(`#${ackId}`).textContent();
        }
        assert.equal(await clock.isVisible(), false, `${name}: stopwatch waits for Start`);
        await call('start clock', true, false);
        assert.equal(await clock.isVisible(), true);
        if (us) {
          const stopId = tactical ? 'tUsStop' : 'turnStop';
          // End the randomly assigned initial turn through its real manual control.
          await page.evaluate(id => { const button = document.getElementById(id); if (!button.disabled) button.click(); }, stopId);
          assert.equal(await call('turn right now'), `APPLIED · ${expectedPrefix}TURNING RIGHT`);
          assert.equal(await call('stop turn now'), `APPLIED · ${expectedPrefix}TURN STOPPED`);
          assert.doesNotMatch(await call('report heading', false), /\d{3}°/);
        } else {
          for (const phrase of ['turn left one four zero', 'turn left heading one four zero']) {
            assert.equal(await call(phrase), `APPLIED · ${expectedPrefix}TURNING LEFT 140°M`);
            assert.equal(await page.locator(tactical ? '#tHeadingInput' : '#headingInput').inputValue(), '140');
          }
          assert.equal(await call('turn right two three zero'), `APPLIED · ${expectedPrefix}TURNING RIGHT 230°M`);
          assert.equal(await page.locator(tactical ? '#tHeadingInput' : '#headingInput').inputValue(), '230');
          assert.match(await page.locator(tactical ? '#tTurnRight' : '#turnHeadingRight').getAttribute('class'), /voice-command-effect/);
          const heading = await call('report heading');
          const reported = await page.locator(tactical ? '#tHeadingReply' : '#headingReply').textContent();
          assert.equal(heading, `APPLIED · ${expectedPrefix}${reported}`);
          const beforeTick = await clock.textContent();
          await page.waitForFunction(({ id, previous }) => document.getElementById(id).textContent !== previous, { id: clockId, previous: beforeTick });
          assert.equal(await page.locator(`#${ackId}`).textContent(), heading, `${name}: timer tick does not overwrite the readback`);
          assert.equal(await clock.textContent(), await page.locator(tactical ? '#tClock' : '#clock').textContent());
          const receiptBox = await page.locator(`#${ackId}`).boundingBox();
          const timerBox = await clock.boundingBox();
          assert.ok(receiptBox.x + receiptBox.width <= timerBox.x && timerBox.x + timerBox.width <= width, `${name}: separate right-corner timer`);
          const geometry = await page.locator(`#${ackId}`).evaluate(element => {
            const box = element.getBoundingClientRect();
            const display = element.closest('.voice-ack-slot').nextElementSibling.getBoundingClientRect();
            return { above: box.bottom <= display.top + 1, color: getComputedStyle(element).color,
              fits: box.left >= 0 && box.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1 };
          });
          assert.equal(geometry.above, true, `${name}: above homing indication`);
          assert.equal(geometry.fits, true, `${name}: readable without horizontal clipping`);
          assert.equal(geometry.color, 'rgb(163, 44, 39)', `${name}: red readback`);
          await page.screenshot({ path: path.join(out, `${name}.png`) });
          const range = await call('report distance');
          assert.equal(range, `APPLIED · ${expectedPrefix}${await page.locator(tactical ? '#tDistanceReply' : '#distanceReply').textContent()}`);
        }
        await call('transmit for df');
        await call('stop clock', true, false);
        const stopped = await clock.textContent();
        await page.waitForTimeout(1100);
        assert.equal(await clock.textContent(), stopped, `${name}: stopwatch freezes on Stop`);
        assert.equal(await clock.isVisible(), true);
        await call('start clock', true, false);
        await page.evaluate(id => document.getElementById(id).click(), tactical ? 'tClockReset' : 'clockReset');
        assert.equal(await clock.isVisible(), false, `${name}: manual Reset clears the voice-started stopwatch`);
        assert.equal(await clock.textContent(), '00:00');
        // Manual controls still execute after voice feedback, even when collapsed.
        await page.evaluate(id => document.getElementById(id).click(), tactical ? 'tAdvance' : 'advanceFlight');
        assert.deepEqual(errors, [], `${name}: runtime errors`);
        await page.close();
        flows += 1;
      }
    }
    console.log(`${flows} browser readback flows passed (single/tactical, Normal/U/S, desktop/two phone sizes).`);
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
