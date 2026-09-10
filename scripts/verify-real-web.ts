import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const base = process.env.DASH_URL || 'http://127.0.0.1:3100';
const urls = [
  'https://www.truefoodkitchen.com/locations/palo-alto/',
  'https://www.wildseedsf.com/palo-alto-menus/',
  'https://www.asianbox.com/menus/',
  'https://www.asianbox.com/location/palo-alto/',
];
const prompt = 'Find me a restaurant that serves a gluten free dish without onions or tomatoes that is in Palo Alto.';
const browser = await chromium.launch();
mkdirSync('artifacts', {recursive:true});
try {
  const page = await browser.newPage({viewport:{width:1600,height:900}});
  const errors: string[] = [];
  page.on('pageerror', error=>errors.push(error.message));
  await page.goto(`${base}/?prompt=${encodeURIComponent(prompt)}`,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Preload pages',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Preload real pages'});
  await dialog.getByLabel('Page URLs').fill(urls.join('\n'));
  const preparationResponse=page.waitForResponse(r=>r.url().endsWith('/api/browser/prepare'));
  await dialog.getByRole('button',{name:'Preload pages',exact:true}).click();
  const preparation=await (await preparationResponse).json();
  assert.equal(preparation.preparation.count,4);
  await dialog.waitFor({state:'hidden'});
  assert.equal(await page.getByRole('tab').count(),1,'Prepared sites stay hidden');
  assert((await page.locator('.general-address').innerText()).includes('google.com'));
  await page.getByRole('button',{name:'New browser task'}).click();
  await page.waitForFunction(()=>document.querySelector('.general-address')?.textContent?.includes('google.com'));
  const afterReset=await (await fetch(base+'/api/browser/preload')).json();
  assert.equal(afterReset.page.tabs.length,1);
  assert.equal(afterReset.page.preparation.at,preparation.preparation.at,'Plus must preserve the original preload');
  await page.evaluate(()=>{
    (window as any).maxReading=0;
    new MutationObserver(()=>{(window as any).maxReading=Math.max((window as any).maxReading,document.querySelectorAll('.browser-tab.working').length)}).observe(document.body,{subtree:true,attributes:true,childList:true});
  });
  const response=page.waitForResponse(r=>r.url().endsWith('/api/run'));
  await page.getByRole('button',{name:'Run',exact:true}).click();
  const trace=await (await response).text();
  const events=trace.trim().split('\n').map(line=>JSON.parse(line));
  const result=events.find(e=>e.type==='result')?.result;
  assert.equal(result.status,'done');
  assert(events.some(e=>e.label==='parallel_browse'));
  assert(events.filter(e=>e.type==='browser-action' && e.label?.startsWith('Reading preloaded page:')).length>=3,'The submitted task must reuse cached pages');
  assert(await page.evaluate(()=>(window as any).maxReading>=3));
  await page.locator('.answer-text').waitFor();
  assert(await page.locator('.answer-text a').count()>=2,'Answer should link menu and location evidence');
  assert(/confirm/i.test(result.summary),'Unverified ingredient details must remain explicit');
  assert.equal(errors.length,0);
  assert(await page.locator('.preload-note').isVisible());
  assert(await page.evaluate(()=>document.documentElement.scrollHeight===innerHeight));
  await page.screenshot({path:'artifacts/real-web-result.png'});
  writeFileSync('artifacts/real-web-trace.ndjson',trace);
  writeFileSync('artifacts/real-web-verification.json',JSON.stringify({urls,prompt,preparation:preparation.preparation,result,maxConcurrentIndicators:await page.evaluate(()=>(window as any).maxReading),errors},null,2));
  console.log(JSON.stringify({preparation:preparation.preparation,taskMs:result.metrics.total,calls:result.metrics.modelCalls,summary:result.summary}));
} finally {await browser.close();}
