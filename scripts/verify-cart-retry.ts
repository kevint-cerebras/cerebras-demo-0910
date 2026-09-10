import assert from 'node:assert/strict';
import { warmBrowser, closeBrowser } from '../server/browser';
import { GroceryTools } from '../server/grocery-tools';
const base = process.env.DASH_URL || 'http://127.0.0.1:3100';
try {
  await warmBrowser(base);
  const groceries = new GroceryTools(new AbortController().signal, async()=>{});
  const stores = await groceries.search(['chicken', 'tortillas']);
  const store = stores.find(s=>s.store==='goodmarket')!;
  const items = store.results.map(result=>({id:result.products.find(p=>p.stock)!.id,quantity:1}));
  await assert.rejects(groceries.cart('goodmarket',items,'unavailable-slot'), /available observed delivery slot/);
  const result = await groceries.cart('goodmarket',items,'tomorrow-eve');
  assert.equal(result.items.length,2);
  assert(result.items.every(item=>item.quantity===1));
  assert.equal(result.purchaseSubmitted,false);
  const start=performance.now();
  await assert.rejects(groceries.cart('basket',items,'tomorrow-eve'), /already verified/);
  assert(performance.now()-start<100,'Repeated cart construction should fail immediately, without a browser timeout.');
  console.log('Passed: checkout-screen retry, no duplicate quantities, repeated builds rejected immediately, no purchase.');
} finally { await closeBrowser(); }
