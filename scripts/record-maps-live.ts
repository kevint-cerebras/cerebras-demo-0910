import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import type { RunResult } from '../shared/types';
const recordingName = process.env.RECORDING_NAME || 'maps-live-v2';
const base = process.env.DASH_URL || 'http://127.0.0.1:3100';
const prompt = 'Find me a restaurant that serves a gluten free dish without onions or tomatoes that is in Palo Alto.';
const initial = await (await fetch(base+'/api/browser/reset',{method:'POST'})).json();
assert(!initial.page.preparation?.count,'Restart the server without preloading any pages before recording.');
assert.equal(initial.page.tabs.length,1);
assert.equal(new URL(initial.page.url).hostname,'www.google.com');
mkdirSync('artifacts/recordings',{recursive:true});
const browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1600,height:900},recordVideo:{dir:'artifacts/recordings',size:{width:1600,height:900}}});
const page=await context.newPage();const video=page.video()!;
const hold=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
let trace='';let result:RunResult|undefined;
await page.addInitScript(()=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).endsWith('/api/run'))void response.clone().text().then(text=>(window as any).recordedTrace=text);return response;}});
try {
  await page.goto(`${base}/?prompt=${encodeURIComponent(prompt)}`,{waitUntil:'domcontentloaded'});
  await page.getByRole('tab',{name:/Google/}).waitFor();
  await page.evaluate(()=>document.fonts.ready);await hold(1900);
  await page.getByRole('button',{name:'Run',exact:true}).click();
  await page.waitForFunction(()=>Boolean((window as any).recordedTrace),{},{timeout:55000});
  trace=await page.evaluate(()=>(window as any).recordedTrace);
  result=trace.trim().split('\n').map(line=>JSON.parse(line)).find(e=>e.type==='result')?.result;
  if(result?.summary){await page.locator('.answer-text').waitFor();await page.locator('.answer-text').scrollIntoViewIfNeeded();}
  await hold(3000);
  await page.screenshot({path:`artifacts/recordings/${recordingName}-final.png`});
} finally {await context.close();await video.saveAs(`artifacts/recordings/${recordingName}.webm`);await browser.close();}
writeFileSync(`artifacts/recordings/${recordingName}.ndjson`,trace);
writeFileSync(`artifacts/recordings/${recordingName}.json`,JSON.stringify({source:'Live Google Maps search, no preloaded results or restaurant pages; browser processes warm',preparation:initial.page.preparation,prompt,result,speed:1,audio:false},null,2));
console.log(JSON.stringify({status:result?.status,ms:result?.metrics.total,calls:result?.metrics.modelCalls,summary:result?.summary,warnings:result?.warnings}));
