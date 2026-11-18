// Prices on the customer mart page: every find shows a price in the currency its shop
// charges, including finds from non-US shops whose price was typed into the title.
// Run: node scripts/test-mart-prices.cjs
const vm = require('node:vm'), fs = require('node:fs'), assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../m/m.js'), 'utf8');
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.handlers = {}; this.classList = { add() {}, remove() {} }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  set className(v) { this.attrs.class = v; }
  get className() { return this.attrs.class || ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(k, fn) { this.handlers[k] = fn; }
  querySelector(q) { return new Element(q); }
}
const text = n => (n instanceof Element ? n.children.map(text).join('') : String(n));
const all = (n, cls, out = []) => {
  if (!(n instanceof Element)) return out;
  if (n.className === cls) out.push(n);
  n.children.forEach(c => all(c, cls, out));
  return out;
};

// [item fields, expected price text, expected title]
const cases = [
  [{ title: 'Glencoe Relaxed Linen Trousers — Beige (60% off; final sale)', price_usd: 78 }, '$78', 'Glencoe Relaxed Linen Trousers — Beige (60% off; final sale)'],
  [{ title: 'Type 02 Wide Double-Knee Denim — Washed Black (50% off; 32/34; final sale)', price_usd: 187.5 }, '$187.50', 'Type 02 Wide Double-Knee Denim — Washed Black (50% off; 32/34; final sale)'],
  [{ title: 'Ripstop Chore Jacket — Forest Camo (40% off; AUD $119; S/M/L/XL)', price_usd: null }, 'A$119', 'Ripstop Chore Jacket — Forest Camo (40% off; S/M/L/XL)'],
  [{ title: 'Ripstop Work Jacket — Washed Black (34% off; AUD $159; S–XXL)' }, 'A$159', 'Ripstop Work Jacket — Washed Black (34% off; S–XXL)'],
  [{ title: 'Double Knee Denim — Blue (35% off; €77; 29–33 / 32; ships from Spain)' }, '€77', 'Double Knee Denim — Blue (35% off; 29–33 / 32; ships from Spain)'],
  [{ title: 'Pacific Knit — Lagoon (50% off; £60; S–XXL; ships from UK)' }, '£60', 'Pacific Knit — Lagoon (50% off; S–XXL; ships from UK)'],
  [{ title: 'Painter Denim — Grey (€44.26; 40% off; 28/29/30/31/33)' }, '€44.26', 'Painter Denim — Grey (40% off; 28/29/30/31/33)'],
  [{ title: 'Garage Denim — Lowland Camo (50% off; AUD $89; size 30)' }, 'A$89', 'Garage Denim — Lowland Camo (50% off; size 30)'],
  // A structured price wins over price_usd and leaves the title alone.
  [{ title: 'Some Jacket (AUD $119)', price_amount: 119, price_currency: 'AUD', price_usd: 77 }, 'A$119', 'Some Jacket (AUD $119)'],
  [{ title: 'Some Knit', price_amount: '60.00', price_currency: 'GBP' }, '£60', 'Some Knit'],
  // price_usd wins over a currency in the title (the title isn't touched then).
  [{ title: 'Three People Coach Jacket — Black (61% off; final sale; CAD checkout)', price_usd: 61 }, '$61', 'Three People Coach Jacket — Black (61% off; final sale; CAD checkout)'],
  // Nothing to show: no price, title unchanged.
  [{ title: 'Mystery Shirt (M/L only)' }, '', 'Mystery Shirt (M/L only)'],
  [{ title: 'Size EU 42 boots' }, '', 'Size EU 42 boots']
];

(async () => {
  const main = new Element('main');
  const items = cases.map(([f], n) => ({ id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`, url: 'https://example.com/item', brand: 'Brand', ...f }));
  const context = {
    window: { matchMedia: () => ({ matches: true }), setInterval() {}, setTimeout, dataLayer: [] },
    Node: Element, URL, URLSearchParams, AbortController, Intl, setTimeout, clearTimeout,
    location: { hostname: 'localhost', origin: 'http://localhost', search: `?id=${id}`, hash: '#t=secret' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: () => main, createElement: t => new Element(t), head: new Element('head') },
    fetch: async url => (url.endsWith('/engagement') ? { ok: true } : { ok: true, json: async () => ({ data: { name: 'Test', items, lines: [] } }) })
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setTimeout(resolve, 10));

  const cards = all(main, 'card');
  assert.equal(cards.length, cases.length);
  cards.forEach((card, n) => {
    const [, price, title] = cases[n];
    assert.equal(all(card, 'card-price').map(text).join(''), price, `price for: ${cases[n][0].title}`);
    assert.equal(all(card, 'card-title').map(text).join(''), title, `title for: ${cases[n][0].title}`);
    assert.ok(card.attrs['aria-label'].includes(price), `aria-label carries the price for: ${cases[n][0].title}`);
  });
  console.log(`Mart price checks passed (${cases.length} finds)`);
})().catch(e => { console.error(e); process.exitCode = 1; });
