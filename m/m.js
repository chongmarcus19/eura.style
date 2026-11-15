/* Customer mart page: /m/?id=<mart id>#t=<token>, the link in the delivery email.
 *
 * The token rides in the URL fragment, which browsers never send to a server; this
 * page reads it and sends it to GET /marts/{id} in the X-Mart-Token header. It's also
 * remembered on this device (localStorage) so /m/?id=… keeps working if the fragment
 * gets dropped.
 *
 * Everything shown comes from founders' review and from shop pages, so it's built as
 * text nodes only (never parsed as HTML), and links/images must be http(s).
 *
 * Analytics: GA gets page_location "/m/" — never the id or the token.
 */
(() => {
  'use strict';

  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const params = new URLSearchParams(location.search);
  // ?api= only on a local preview: anywhere else it could send a remembered token elsewhere.
  const API = (LOCAL && params.get('api')) || 'https://api.eura.style';
  const GA_ID = 'G-BVDCWB00GN';
  const TIMEOUT = 15000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const main = document.getElementById('main');

  // ---- analytics (no inline script: the page's CSP forbids it)
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  if (!LOCAL) {
    window.gtag('js', new Date());
    window.gtag('config', GA_ID, { page_location: `${location.origin}/m/`, page_title: 'Mart' });
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
    document.head.appendChild(s);
  }
  const track = (name, data = {}) => { try { window.gtag('event', name, data); } catch (_) {} };

  // ---- helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    });
    kids.flat().forEach(k => { if (k != null && k !== false) el.append(k instanceof Node ? k : String(k)); });
    return el;
  }
  const httpUrl = v => {
    try { const u = new URL(String(v)); return /^https?:$/.test(u.protocol) ? u.href : null; } catch (_) { return null; }
  };
  // $1,990 / $39.90
  const money = n => `$${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
  const budget = max => (max == null ? 'Any price' : `Up to ${money(+max)} a piece`);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const shopHost = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };

  const store = {
    key: id => `eura-mart-${id}`,
    get(id) { try { return localStorage.getItem(this.key(id)); } catch (_) { return null; } },
    set(id, t) { try { localStorage.setItem(this.key(id), t); } catch (_) {} }
  };

  function showState(kind, title, text, retry) {
    main.replaceChildren(h('div', { class: `state${kind === 'error' ? ' is-error' : ''}` },
      h('p', { class: 'eyebrow' }, title),
      h('p', { class: 'state-text' }, text),
      retry ? h('button', { class: 'retry', type: 'button' }, 'Try again') : null));
    if (retry) main.querySelector('.retry').addEventListener('click', retry);
  }
  const broken = () => showState('error', 'Link not working',
    'This link doesn’t open a mart. Use the newest email we sent you, or reply to it and we’ll sort it out.');

  // ---- read the link
  const id = (params.get('id') || '').trim();
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('t') || (UUID.test(id) ? store.get(id) : null);
  if (!UUID.test(id) || !token) { broken(); track('mart_view_error', { reason: 'bad_link' }); return; }

  // ---- render
  function card(item) {
    const url = httpUrl(item.url);
    const img = httpUrl(item.image_url);
    const imgBox = h('div', { class: 'card-img' });
    const blank = () => imgBox.replaceChildren(h('span', { class: 'blank', 'aria-hidden': 'true' }, (item.brand || item.title || '·').trim().charAt(0).toUpperCase()));
    if (img) {
      const el = h('img', { src: img, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
      el.addEventListener('error', blank, { once: true });
      imgBox.append(el);
    } else blank();
    const price = item.price_usd != null ? h('span', { class: 'card-price' }, money(+item.price_usd)) : h('span');
    const inner = [
      imgBox,
      h('div', { class: 'card-body' },
        item.brand ? h('span', { class: 'card-brand' }, item.brand) : null,
        h('span', { class: 'card-title' }, item.title)),
      h('div', { class: 'card-foot' }, price, url ? h('span', { class: 'card-shop' }, `Shop${shopHost(url) ? ` · ${shopHost(url)}` : ''} ↗`) : null)
    ];
    const label = [item.brand, item.title, item.price_usd != null ? money(+item.price_usd) : null].filter(Boolean).join(', ');
    const el = url
      ? h('a', { class: 'card', href: url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${label} (opens the shop in a new tab)` }, inner)
      : h('div', { class: 'card' }, inner);
    if (url) el.addEventListener('click', () => track('mart_click', { shop: shopHost(url) }));
    return h('li', null, el);
  }

  function render(mart) {
    document.title = `${mart.name} | Eura`;
    const items = Array.isArray(mart.items) ? mart.items : [];
    const lines = Array.isArray(mart.lines) ? mart.lines : [];


    const body = [
      h('div', { class: 'mart-intro' },
        h('h1', { class: 'title' }, mart.name))
    ];

    // One section per line when the mart holds several (each keeps its own budget).
    if (lines.length > 1) {
      const byLine = lines.map(() => []);
      const rest = [];
      items.forEach(i => (Number.isInteger(i.line_index) && byLine[i.line_index] ? byLine[i.line_index] : rest).push(i));
      lines.forEach((line, n) => {
        if (!byLine[n].length) return;
        body.push(h('section', { class: 'section', 'aria-label': line.label || `Line ${n + 1}` },
          h('div', { class: 'section-head' }, h('h2', { class: 'section-name' }, line.label || ''), h('span', { class: 'section-budget' }, budget(line.max_price_usd))),
          h('ul', { class: 'grid' }, byLine[n].map(card))));
      });
      if (rest.length) {
        body.push(h('section', { class: 'section', 'aria-label': 'More finds' },
          h('div', { class: 'section-head' }, h('h2', { class: 'section-name' }, 'More finds')),
          h('ul', { class: 'grid' }, rest.map(card))));
      }
    } else {
      body.push(h('section', { class: 'section', 'aria-label': 'Finds' },
        items.length ? h('ul', { class: 'grid' }, items.map(card)) : h('p', { class: 'empty' }, 'No finds here right now.')));
    }

    {
      body.push(h('section', { class: 'mart-actions', 'aria-label': 'Feedback and updates' },
        h('form', { class: 'action-panel', id: 'feedback-form' },
          h('h2', { class: 'action-title' }, 'Any feedback?'),
          h('p', { class: 'action-copy' }, 'Tell us what you like or want to change in your mart.'),
          h('label', { class: 'sr-only', for: 'feedback' }, 'Any feedback?'),
          h('textarea', { id: 'feedback', class: 'feedback-input', rows: '3', maxlength: '1000', placeholder: 'e.g. More like the second pair, less sporty' }),
          h('button', { class: 'action-button', type: 'submit' }, 'Send feedback'),
          h('p', { class: 'action-status', id: 'feedback-status', role: 'status' })),
        h('div', { class: 'action-panel updates-panel' },
          h('h2', { class: 'action-title' }, 'Keep this mart updated'),
          h('p', { class: 'action-copy' }, 'We’ll keep looking for new finds for this mart and email you as it updates.'),
          h('button', { class: 'action-button action-button-outline', id: 'updates-toggle', type: 'button', 'aria-pressed': String(Boolean(mart.updates_enabled)) }, mart.updates_enabled ? '✓ Updates on' : 'Keep me updated'),
          h('p', { class: 'action-status', id: 'updates-status', role: 'status' }))));
    }

    main.replaceChildren(...body);
    {
      const feedback = main.querySelector('#feedback');
      const examples = [
        'More like the second pair, less sporty',
        'I love the first pair. Show me more like those',
        'Show me darker colors and fewer logos',
        'Keep everything under $100'
      ];
      let exampleIndex = 0;
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        window.setInterval(() => {
          if (!feedback.isConnected || feedback.value || document.hidden) return;
          feedback.classList.add('is-changing-example');
          window.setTimeout(() => {
            if (feedback.isConnected && !feedback.value && !document.hidden) {
              exampleIndex = (exampleIndex + 1) % examples.length;
              feedback.placeholder = `e.g. ${examples[exampleIndex]}`;
            }
            feedback.classList.remove('is-changing-example');
          }, 350);
        }, 4000);
      }
      main.querySelector('#feedback-form').addEventListener('submit', async event => {
        event.preventDefault();
        const message = feedback.value.trim();
        const status = main.querySelector('#feedback-status');
        if (!message) { status.textContent = 'Add a note first.'; return; }
        const button = event.currentTarget.querySelector('button');
        button.disabled = true;
        try {
          const res = await fetch(`${API}/marts/${encodeURIComponent(id)}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mart-Token': token }, body: JSON.stringify({ message }) });
          if (!res.ok) throw new Error('feedback');
          feedback.value = '';
          status.textContent = 'Thanks. Your feedback was sent.';
        } catch (_) { status.textContent = 'Could not send feedback. Please try again.'; }
        finally { button.disabled = false; }
      });
      const toggle = main.querySelector('#updates-toggle');
      toggle.addEventListener('click', async () => {
        const active = toggle.getAttribute('aria-pressed') !== 'true';
        toggle.disabled = true;
        const status = main.querySelector('#updates-status');
        try {
          const res = await fetch(`${API}/marts/${encodeURIComponent(id)}/updates`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Mart-Token': token }, body: JSON.stringify({ enabled: active }) });
          if (!res.ok) throw new Error('updates');
          toggle.setAttribute('aria-pressed', String(active));
          toggle.textContent = active ? '✓ Updates on' : 'Keep me updated';
          status.textContent = active ? 'Updates are on.' : 'Updates are off.';
        } catch (_) { status.textContent = 'Could not save your choice. Please try again.'; }
        finally { toggle.disabled = false; }
      });
    }
    main.querySelector('.title').setAttribute('tabindex', '-1');
    track('mart_view', { finds: String(items.length) });
  }

  async function load() {
    showState('loading', 'Your mart', 'Opening your mart…');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await fetch(`${API}/marts/${encodeURIComponent(id)}`, {
        headers: { 'X-Mart-Token': token }, signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
      });
      if (res.status === 404 || res.status === 422) { broken(); track('mart_view_error', { reason: 'not_found' }); return; }
      if (!res.ok) throw new Error(`status_${res.status}`);
      const mart = ((await res.json()) || {}).data;
      if (!mart || typeof mart.name !== 'string') throw new Error('shape');
      store.set(id, token);
      render(mart);
    } catch (error) {
      showState('error', 'Couldn’t load', error.name === 'AbortError'
        ? 'That took too long. Check your connection and try again.'
        : 'We couldn’t load your mart just now. Try again in a moment.', load);
      track('mart_view_error', { reason: error.name === 'AbortError' ? 'timeout' : 'network' });
    } finally {
      clearTimeout(timer);
    }
  }
  load();
})();
