'use strict';
// Real prior worker + its cached radio/voice scripts, then current navigation.
// Run after build-web.mjs. The referenced release commit must exist locally.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'apps/web/dist');
const prior = '410ff989aeb9b927a92c11ac54bd5a9b5798fb66';
const oldSource = file => execFileSync('git', ['show', `${prior}:${file}`], {cwd:root,maxBuffer:16*1024*1024});
const old = new Map([
  ['/service-worker.js', Buffer.from(oldSource('apps/web/static/service-worker.js').toString().replaceAll('__QGH_VERSION__', '4.4.0'))],
  ['/radio-workspace.js', oldSource('packages/qgh-engine/radio-workspace.js')],
  ['/voice-workspace.js', oldSource('packages/qgh-engine/voice-workspace.js')],
]);
const types = {'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.ttf':'font/ttf','.wav':'audio/wav'};
let upgraded = false;
const server = http.createServer((request,response) => {
  const pathname = new URL(request.url,'http://localhost').pathname;
  if (pathname === '/setup.html') {
    response.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
    response.end('<!doctype html><title>Upgrade test setup</title><body>Upgrade test</body>');
    return;
  }
  const file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(dist + path.sep)) {response.writeHead(404);response.end();return;}
  try {
    const data = !upgraded && old.has(pathname) ? old.get(pathname) : fs.readFileSync(file);
    response.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
    response.end(data);
  } catch {response.writeHead(404);response.end();}
});

(async () => {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({channel:'msedge',headless:true});
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.goto(`${base}setup.html`);
    await page.evaluate(async () => {
      localStorage.setItem('qgh-pilot-headphones-v1','on');
      await navigator.serviceWorker.register('service-worker.js');
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    const before=await page.evaluate(async()=>{
      const response=await fetch('radio-workspace.js?v=4.4.1');
      return (await response.text()).includes("getItem(AUDIO_KEY) === 'on'");
    });
    assert.equal(before,true,'actual old worker serves the old opt-in-restoring script');
    upgraded=true;
    for (const document of ['single.html','tactical.html']) {
      await page.goto(`${base}${document}`);
      await page.waitForFunction(()=>!!window.QGHHeadphones && !!window.QGHPilotVoiceEngine);
      assert.equal(await page.evaluate(()=>QGHRadioWorkspace.status().audioEnabled),false);
      assert.equal(await page.evaluate(()=>QGHHeadphones.confirmed()),false);
      await page.evaluate(()=>QGHRadioWorkspace.setAudioEnabled(true));
      assert.equal(await page.evaluate(()=>QGHRadioWorkspace.status().audioEnabled),false,'fresh confirmation is enforced');
      await page.locator('.voice-settings-toggle').click();
      await page.locator('#pilotAudio').click();
      await page.locator('.headphone-dialog').waitFor({state:'visible'});
      assert.equal(await page.locator('.headphone-enable').isDisabled(),true);
      await page.getByRole('button',{name:'KEEP MUTED',exact:true}).click();
      // Do not press UPDATE: prove safe behavior while the old worker still owns
      // the page, not merely after installing a clean new worker.
      const oldStillActive=await page.evaluate(async()=>
        (await (await fetch('radio-workspace.js?v=4.4.1')).text()).includes("getItem(AUDIO_KEY) === 'on'"));
      assert.equal(oldStillActive,true);
    }
    assert.deepEqual(errors,[]);
    const report={prior,returningPreference:'on',pages:2,oldWorkerRemainedActive:true,freshConsentRequired:true,errors};
    const output=path.join(root,'artifacts/headphone-4.4.1');
    fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'pwa-upgrade.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
