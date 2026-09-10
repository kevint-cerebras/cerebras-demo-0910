import type { Page } from 'playwright';
import { acquireBrowser } from './browser';
import type { BrowserLease } from './browser';
import type { Product, StoreId, Quote, StoreActivity } from '../shared/types';

export type GroceryProgress = (page: Page, label: string, duration: number, category: 'browser' | 'dom') => Promise<void>;
export class GroceryTools {
  private lease?: BrowserLease;
  approval?: { lease: BrowserLease; quote: Quote };
  private observed = new Map<string, Product>();
  constructor(private signal: AbortSignal, private progress: GroceryProgress, private activity: (event: StoreActivity)=>void = ()=>{}) {}
  async search(queries: string[]) {
    if (!queries.length || queries.length > 30 || queries.some(q => typeof q !== 'string' || q.length > 100)) throw new Error('Provide 1–30 short ingredient searches.');
    this.lease ??= await acquireBrowser();
    return Promise.all(Object.entries(this.lease.pages).map(async ([store, page]) => {
      const name = (await page.title()).split(' · ')[0];
      this.activity({store:store as StoreId,name,status:'searching'});
      try {
      if (await page.locator('#back-to-shop').isVisible()) await page.locator('#back-to-shop').click();
      const results = [];
      for (const query of queries) {
        this.signal.throwIfAborted();
        const start = performance.now();
        this.activity({store:store as StoreId,name,status:'searching',query});
        await page.locator('#search').fill(query);
        await page.locator('#search-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
        await this.progress(page, `Search ${store}: ${query}`, performance.now()-start, 'browser');
        const domStart = performance.now();
        const products = await page.locator('[data-product]').evaluateAll(nodes => nodes.map(node => {
          const {artwork, art, color, brand, ...product} = JSON.parse(node.getAttribute('data-json')!);
          return product;
        })) as Product[];
        for (const product of products) this.observed.set(product.id, product);
        results.push({query, products});
        await this.progress(page, `Read ${store}: ${query}`, performance.now()-domStart, 'dom');
      }
      await page.locator('#open-cart').click();
      const checkout = await page.evaluate(() => ({
        delivery: Number(document.querySelector('#delivery')?.getAttribute('data-cents')),
        slots: Array.from(document.querySelectorAll('[data-slot]')).map(el=>JSON.parse(el.getAttribute('data-json')!)),
      }));
      await page.locator('#back-to-shop').click();
      this.activity({store:store as StoreId,name,status:'checked',productCount:new Set(results.flatMap(r=>r.products.map(p=>p.id))).size});
      return {store, ...checkout, results};
      } catch(error) {
        this.activity({store:store as StoreId,name,status:'error'});
        throw error;
      }
    }));
  }
  async cart(store: StoreId, items: {id: string; quantity: number}[], slot: string) {
    if (this.approval) throw new Error('A cart is already verified. Finish and request approval instead of building another cart.');
    const page = this.lease?.pages[store];
    if (!page) throw new Error('Search groceries first, then choose an observed store.');
    if (!items.length || items.length > 30 || new Set(items.map(x=>x.id)).size !== items.length) throw new Error('Provide unique products for the cart.');
    for (const item of items) {
      const product = this.observed.get(item.id);
      if (!product || !product.id.startsWith(store+'-') || !product.stock || !Number.isInteger(item.quantity) || item.quantity<1 || item.quantity>12) throw new Error('Use available observed products and quantities from 1 to 12.');
    }
    const name = (await page.title()).split(' · ')[0];
    this.activity({store,name,status:'cart'});
    try {
    if (await page.locator('#back-to-shop').isVisible()) await page.locator('#back-to-shop').click();
    const existing = await page.locator('[data-cart-product]').evaluateAll(els=>els.map(el=>el.getAttribute('data-cart-product')));
    for (const item of items) {
      this.signal.throwIfAborted();
      const start = performance.now();
      const product = this.observed.get(item.id)!;
      await page.locator('#search').fill(product.key);
      await page.locator('#search-form').evaluate((form: HTMLFormElement)=>form.requestSubmit());
      if (!existing.includes(item.id)) await page.locator(`[data-add="${item.id}"]`).click();
      await this.progress(page, `Add ${product.name}`, performance.now()-start, 'browser');
    }
    await page.locator('#open-cart').click();
    for (const item of items) {
      const input=page.locator(`[data-quantity-input="${item.id}"]`);
      await input.fill(String(item.quantity));
      await input.dispatchEvent('change');
    }
    const slots = await page.locator('[data-slot]').evaluateAll(els=>els.map(el=>JSON.parse(el.getAttribute('data-json')!)));
    if (!slots.some(s=>s.id===slot && s.available)) throw new Error('Choose an available observed delivery slot.');
    await page.locator(`input[name="delivery"][value="${slot}"]`).check();
    const cart = await page.evaluate(()=>({
      items: Array.from(document.querySelectorAll('[data-cart-product]')).map(el=>({id:el.getAttribute('data-cart-product'),quantity:Number(el.getAttribute('data-quantity')),name:el.querySelector('h3')?.textContent})),
      subtotal: Number(document.querySelector('#subtotal')?.getAttribute('data-cents')),
      deliveryFee: Number(document.querySelector('#delivery')?.getAttribute('data-cents')),
      total: Number(document.querySelector('#total')?.getAttribute('data-cents')),
      delivery: document.querySelector('input[name="delivery"]:checked')?.closest('label')?.textContent,
      purchaseSubmitted: !!document.querySelector('[data-receipt]'),
    }));
    for(const item of items) if(!cart.items.some(row=>row.id===item.id && row.quantity===item.quantity)) throw new Error('Cart verification failed.');
    this.approval = {lease: this.lease!, quote: {
      store, subtotal: cart.subtotal, delivery: cart.deliveryFee, total: cart.total,
      complete: true, missing: [], slot: slots.find(s=>s.id===slot),
      items: items.map(item=>({product:this.observed.get(item.id)!, quantity:item.quantity, reason:"Selected by Cerebras from observed products", checked:true})),
    }};
    await this.progress(page, 'Cart verified · awaiting purchase approval', 0, 'dom');
    this.activity({store,name,status:'ready',total:cart.total});
    return { ...cart, url: page.url(), approvalRequired: true };
    } catch (error) {
      this.activity({store,name,status:'error'});
      throw error;
    }
  }
}
