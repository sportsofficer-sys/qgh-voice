'use strict';
// Real service-worker, audio worker and Web Audio proof. No speech/audio mocks.
// This does not attest physical headphone routing or microphone accuracy.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.QGH_QA_URL || 'http://127.0.0.1:4221/';

(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const remoteRequests = [];
  context.on('request', request => {
    if(new URL(request.url()).origin !== new URL(base).origin) remoteRequests.push(request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base);
    await page.getByText('Pilot voices are saved for offline use.',{exact:true}).waitFor({timeout:90000});
    const cached = await page.evaluate(async () => {
      const manifest = await (await fetch('pilot-voices/manifest.json')).json();
      const names = await caches.keys();
      const name = names.find(value => value.endsWith(manifest.version));
      const cache = await caches.open(name);
      const entries = await Promise.all(manifest.assets.map(async asset => {
        const response = await cache.match(new URL(asset.path,location.href));
        return !!response && response.headers.get('x-qgh-pilot-sha256') === asset.sha256;
      }));
      return {count:entries.length,valid:entries.every(Boolean),bytes:manifest.assets.reduce((sum,a)=>sum+a.bytes,0)};
    });
    assert.equal(cached.count,9);
    assert.equal(cached.valid,true);
    await context.setOffline(true);
    await page.goto(new URL('single.html',base).href);
    await page.waitForFunction(()=>!!window.QGHHeadphones);
    assert.equal(await page.evaluate(()=>QGHRadioWorkspace.status().audioEnabled),false);
    await page.locator('.voice-settings-toggle').click();
    await page.locator('#pilotAudio').click();
    await page.getByRole('button',{name:'TEST HEADPHONE AUDIO',exact:true}).click();
    await page.waitForFunction(()=>!document.getElementById('headphoneConfirmed').disabled,{},{timeout:30000});
    await page.locator('#headphoneConfirmed').check();
    await page.getByRole('button',{name:'ENABLE PILOT REPLIES',exact:true}).click();
    assert.equal(await page.evaluate(()=>QGHPilotVoiceEngine.capability()),'ready');
    const voices=[];
    for (const source of ['A','B','C','D']) {
      const playback=await page.evaluate(source=>new Promise((resolve,reject)=>{
        let started;
        const requested=performance.now();
        const timeout=setTimeout(()=>{QGHPilotVoiceEngine.cancel();reject(new Error('Offline voice timeout'));},15000);
        QGHPilotVoiceEngine.speak({source,text:'Roger, turning right two three zero, Falcon one one.',
          onstart:audio=>{started={voice:QGHPilotVoiceEngine.profile(source).id,duration:audio.durationSeconds,latencyMs:performance.now()-requested};},
          onend:()=>{clearTimeout(timeout);resolve(started);},
          onerror:error=>{clearTimeout(timeout);reject(error);}});
      }),source);
      assert.ok(playback.duration>0 && playback.duration<10);
      voices.push(playback);
    }
    assert.equal(new Set(voices.map(voice=>voice.voice)).size,4);
    await page.locator('#startExercise').click();
    const turn=await page.evaluate(()=>QGHVoiceWorkspace.dispatchTranscript('turn right two three zero'));
    assert.equal(turn.ok,true);
    assert.equal(await page.locator('#headingInput').inputValue(),'230');
    await page.waitForFunction(()=>QGHRadioAdapter.observation().phase==='live');
    const replacement=await page.evaluate(()=>QGHVoiceWorkspace.dispatchTranscript('turn left zero one zero'));
    assert.equal(replacement.ok,true);
    assert.equal(await page.locator('#headingInput').inputValue(),'10');
    await page.evaluate(()=>QGHHeadphones.mute());
    assert.equal(await page.evaluate(()=>QGHRadioWorkspace.status().audioEnabled),false);
    await page.locator('#advanceFlight').click();
    await page.reload();
    await page.waitForFunction(()=>!!window.QGHHeadphones);
    assert.equal(await page.evaluate(()=>QGHRadioWorkspace.status().audioEnabled),false);
    assert.deepEqual(errors,[]);
    assert.deepEqual(remoteRequests,[]);
    const report={cached,offlineReload:true,actualAudioTest:true,voices,turnReplacement:true,mutedReload:true,remoteRequests,errors};
    const output=path.resolve('artifacts/headphone-4.4.1');
    fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'offline-integration.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
