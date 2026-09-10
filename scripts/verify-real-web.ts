import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const base=process.env.DASH_URL || 'http://127.0.0.1:3100';
const prompt='Find me a restaurant that serves a gluten free dish without onions or tomatoes that is in Palo Alto.';
const initial=await(await fetch(base+'/api/browser/reset',{method:'POST'})).json();
assert.equal(initial.page.tabs.length,1);
assert.equal(new URL(initial.page.url).hostname,'www.google.com');
const browser=await chromium.launch();
try {
  const page=await browser.newPage({viewport:{width:1600,height:900}});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).endsWith('/api/run'))void response.clone().text().then(text=>(window as any).recordedTrace=text);return response;}});
  await page.goto(`${base}/?prompt=${encodeURIComponent(prompt)}`,{waitUntil:'domcontentloaded'});
  assert.equal(await page.getByRole('button',{name:'Preload pages',exact:true}).count(),0);
  await page.getByRole('button',{name:'Run',exact:true}).click();
  await page.waitForFunction(()=>Boolean((window as any).recordedTrace),{},{timeout:50000});
  const trace=await page.evaluate(()=>(window as any).recordedTrace as string);
  const events=trace.trim().split('\n').map(line=>JSON.parse(line));
  const result=events.find(event=>event.type==='result')?.result;
  assert.equal(result?.status,'done');
  assert(events.some(event=>event.type==='browser-page' && event.url?.includes('google.com/maps/')));
  assert(events.some(event=>event.type==='browser-action' && event.label==='parallel_browse'));
  assert(/confirm/i.test(result.summary));
  assert.equal(errors.length,0);
  mkdirSync('artifacts',{recursive:true});
  writeFileSync('artifacts/real-web-trace.ndjson',trace);
  console.log(JSON.stringify({status:result.status,taskMs:result.metrics.total,calls:result.metrics.modelCalls,summary:result.summary}));
} finally {await browser.close();}
