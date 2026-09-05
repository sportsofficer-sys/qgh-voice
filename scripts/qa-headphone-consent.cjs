'use strict';
// Browser integration proof. Audio is stubbed here; actual offline clip playback is
// verified separately. These checks never claim a physical headphone route.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.QGH_QA_URL || 'http://127.0.0.1:4220/';
const output = path.resolve('artifacts/headphone-4.4.1');
const engineStub = `(() => {
  let ready=false; let timer;
  window.QGHPilotVoiceEngine={ capability:()=>ready?'ready':'unprepared',
    prepare:async()=>{ready=true;}, profile:()=>({id:'am_michael',name:'Michael'}),
    speak:r=>{ clearTimeout(timer); r.onstart?.(); timer=setTimeout(()=>r.onend?.(),60); },
    cancel:()=>clearTimeout(timer) };
})();`;

(async () => {
  fs.mkdirSync(output, {recursive:true});
  const browser = await chromium.launch({channel:'msedge',headless:true});
  let flows=0;
  try {
    for (const [width,height] of [[1366,900],[360,800],[412,915]]) {
      for (const tactical of [false,true]) for (const us of [false,true]) {
        const page=await browser.newPage({viewport:{width,height},serviceWorkers:'block'});
        const errors=[]; page.on('pageerror',e=>errors.push(e.message));
        await page.route('**/pilot-voice-engine.js*',route=>route.fulfill({contentType:'text/javascript',body:engineStub}));
        await page.addInitScript(()=>localStorage.setItem('qgh-pilot-headphones-v1','on'));
        await page.goto(new URL(tactical?'tactical.html':'single.html',base).href);
        await page.waitForFunction(()=>!!window.QGHHeadphones);
        assert.equal(await page.evaluate(()=>QGHRadioWorkspace.status().audioEnabled),false);
        await page.locator('.voice-settings-toggle').click();
        await page.locator('#pilotAudio').click();
        const dialog=page.locator('.headphone-dialog');
        await dialog.waitFor({state:'visible'});
        assert.equal(await page.evaluate(()=>QGHHeadphones.blocksMicrophone()),true);
        assert.equal(await page.locator('.headphone-enable').isDisabled(),true);
        const bounds=await dialog.boundingBox();
        assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width+1 && bounds.y>=0 && bounds.y+bounds.height<=height+1);
        await page.getByRole('button',{name:'TEST HEADPHONE AUDIO',exact:true}).click();
        await page.locator('#headphoneConfirmed').check();
        await page.screenshot({path:path.join(output,`${tactical?'tactical':'single'}-${width}.png`)});
        await page.getByRole('button',{name:'ENABLE PILOT REPLIES',exact:true}).click();
        assert.equal(await page.evaluate(()=>QGHRadioWorkspace.status().audioEnabled),true);
        assert.equal(await page.evaluate(()=>QGHHeadphones.blocksMicrophone()),false);
        if(us) await page.locator(tactical?'#tProcedureUs':'#us').click();
        await page.locator(tactical?'#tStart':'#startExercise').click();
        // Random U/S exercises can begin in a turn. Preserve the existing
        // stop-before-next-turn control rule rather than assuming wings level.
        if(us && await page.locator(tactical?'#tUsStop':'#turnStop').isEnabled()) {
          const initialStop=await page.evaluate(text=>QGHVoiceWorkspace.dispatchTranscript(text),`${tactical?'falcon ':''}stop turn now`);
          assert.equal(initialStop.ok,true);
        }
        const accepted=await page.evaluate(text=>QGHVoiceWorkspace.dispatchTranscript(text),`${tactical?'falcon ':''}turn right ${us?'now':'two three zero'}`);
        assert.equal(accepted.ok,true,JSON.stringify({width,tactical,us,accepted}));
        if(!us) assert.equal(await page.locator(tactical?'#tHeadingInput':'#headingInput').inputValue(),'230');
        else {
          const stopped=await page.evaluate(text=>QGHVoiceWorkspace.dispatchTranscript(text),`${tactical?'falcon ':''}stop turn now`);
          assert.equal(stopped.ok,true);
          const noHeading=await page.evaluate(text=>QGHVoiceWorkspace.dispatchTranscript(text),`${tactical?'falcon ':''}report heading`);
          assert.equal(noHeading.ok,false);
        }
        await page.evaluate(()=>navigator.mediaDevices.dispatchEvent(new Event('devicechange')));
        assert.equal(await page.evaluate(()=>QGHRadioWorkspace.status().audioEnabled),false);
        assert.equal(await page.evaluate(()=>QGHHeadphones.confirmed()),false);
        const transmit=await page.evaluate(text=>QGHVoiceWorkspace.dispatchTranscript(text),`${tactical?'falcon ':''}transmit for df`);
        assert.equal(transmit.ok,true);
        const clockStart=await page.evaluate(()=>QGHVoiceWorkspace.dispatchTranscript('start clock'));
        assert.equal(clockStart.ok,true);
        await page.locator(tactical?'#tHomingClock':'#homingClock').waitFor({state:'visible'});
        // A device change does not disable manual flight instructions.
        await page.evaluate(tactical=>document.getElementById(tactical?'tAdvance':'advanceFlight').click(),tactical);
        await page.locator('.voice-settings-toggle').click();
        await page.locator('#pilotAudio').click();
        assert.equal(await page.locator('.headphone-enable').isDisabled(),true);
        await page.getByRole('button',{name:'KEEP MUTED',exact:true}).click();
        assert.equal(await page.evaluate(()=>QGHHeadphones.blocksMicrophone()),false);
        assert.deepEqual(errors,[]);
        await page.close(); flows++;
      }
    }
    console.log(`${flows} headphone-dialog browser flows passed; actual speech tested separately.`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
