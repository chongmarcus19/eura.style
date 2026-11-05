/* Make-a-mart flow: lines (each its own mart + budget) -> details -> references -> review + email -> confirmation.
 *
 * Mounts into every [data-make-root] on the page (the standalone /make/ page),
 * and wires every [data-make-open] link to a popup <dialog> when one exists
 * (the main page). Links fall back to /make/ when the popup can't open.
 *
 * Query params (ads link here):
 *   ?hook=italy|90s|gym   pre-fills the first line's placeholder and picks the example mart
 *   utm_*                 forwarded with the submission
 *   ?stub=1 / ?stub=0     force stub mode on/off (see STUB below)
 *
 * Model: people separate what they're shopping for themselves, one line per thing.
 * Each line becomes its own mart with its own max price per piece. The text is the
 * source of truth: detail chips write into it (and toggle back out), and a price
 * written in the text ("under 40 bucks") sets the line's price unless the person
 * picked one by hand.
 *
 * Backend contracts (proposed; neither endpoint exists yet):
 *
 *   POST /marts/parse   JSON {lines:[label]}   (public: rate-limit per IP, cap line length)
 *     -> {lines:[{kind: "trip"|"work"|"gym"|"item"|"general"|...,
 *                 facts: {destination?, dates?, activity?, dress_code?, training?, ...},
 *                 question: {text, placeholder}|null}],          one per line, same order
 *         groups:[{lines:[int], confidence: 0-1}]}                 lines that look like one context
 *     One model call. Ask at most one question per line, and none when the line already
 *     says it; the placeholder is an example answer that fits that line. Groups at or above
 *     COMBINE_MIN_CONFIDENCE become a "Same trip? Combine?" offer (default: keep separate).
 *     Started early (pause in typing / leaving a line) so Next rarely waits.
 *     Failure or >PARSE_TIMEOUT -> no questions, no offer; never stalls.
 *     The result is saved with the submission as `parsed`: it's the structured brief
 *     the 48h review curates from, and later the input to automated sourcing.
 *
 *   POST /marts   multipart/form-data
 *     brief            string, the lines joined by newlines (raw, kept for review)
 *     pieces           JSON [{label, group, max_price_usd|null, question|null, answer|null}]
 *                      one mart per distinct group
 *     sizes            string, optional
 *     boards           JSON [{url, piece: index|null}]  (null = not sure; match it in review), 0-5
 *     references       0-6 image files (JPEG, longest edge <= 1600px)
 *     references_for   JSON [index|null], aligned with the files (null = not sure)
 *     parsed           JSON, the /marts/parse result for these lines (absent if it failed)
 *     email            string, required
 *     hook, placement ("page"|"popup"), utm (JSON of utm_* params)
 *   2xx or 409 = accepted. Anything else = show a retry message.
 */
(() => {
  'use strict';

  const ENDPOINT = 'https://api.eura.style/marts';
  const PARSE_ENDPOINT = 'https://api.eura.style/marts/parse';
  // Live: both endpoints exist on api.eura.style (Mira #771/#772). Add ?stub=1 to
  // click through without sending anything (local preview, demos). Note the API only
  // accepts browser calls from https://eura.style, so a localhost preview without
  // ?stub=1 will show "couldn't send" — that's CORS, not a bug.
  const STUB_DEFAULT = false;
  const PARSE_TIMEOUT = 6000;
  const MAX_PHOTOS = 6;
  const MAX_BOARDS = 5;
  const MAX_PIECES = 6;
  const MAX_EDGE = 1600;
  const LABEL_MAX = 300;
  const COUNT_FROM = 90;
  const DRAFT_KEY = 'eura-make-draft';
  const DRAFT_TTL = 7 * 24 * 3600 * 1000;
  const ASSET = '/assets/marts/products/';
  const PRESETS = [null, 50, 100, 200];

  const params = new URLSearchParams(location.search);
  const STUB = params.has('stub') ? params.get('stub') !== '0' : STUB_DEFAULT;

  const HOOKS = {
    italy: 'e.g. Italy in June, linen, nothing that wrinkles',
    '90s': 'e.g. everyday outfits inspired by the 90s',
    gym: 'e.g. gym clothes in darker colors'
  };
  const PLACEHOLDER = 'e.g. Italy in June, linen, nothing that wrinkles';
  const NEXT_PLACEHOLDER = 'e.g. white sneakers';
  const STARTERS = ['Everyday outfits', 'A trip', 'Gym clothes', 'Something for work'];
  // Detail chips fit what the line is about. A line can match several kinds
  // ("work trip" gets both); `skip` hides a chip when the line already says it
  // (unless the chip itself put it there, so it can still be tapped off).
  // `notForItem` drops whole-wardrobe chips on single-item lines ("running shoes").
  const SHOE_WORDS = /\b(shoes?|sneakers?|trainers|boots?|loafers?|sandals|heels|flats|slides|cleats)\b/i;
  const CLOTHING_WORDS = /\b(jacket|coat|parka|jeans|pants|trousers|chinos|shorts|shirt|tee|t-shirts?|polo|hoodie|sweater|cardigan|blazer|suit|bag|tote|backpack|belt|hat|cap|dress|skirt|watch|sunglasses)\b/i;
  const ITEM_WORDS = new RegExp(`${SHOE_WORDS.source}|${CLOTHING_WORDS.source}`, 'i');
  const KINDS = [
    { kind: 'trip', test: /trip|travel|vacation|holiday|honeymoon|getaway|wedding|italy|paris|europe|japan|mexico|beach/i, details: [
      { t: 'Warm weather', skip: /warm|hot|summer|cold|winter|weather/i },
      { t: 'Dressy dinners', skip: /dinner|dressy|formal/i },
      { t: 'Lots of walking', skip: /walk/i },
      { t: 'Packs light', skip: /pack|carry-on|light/i }] },
    { kind: 'work', test: /\bwork|office|job|interview|business|client|conference/i, details: [
      { t: 'Smart casual', skip: /casual|suit|formal|dressy/i },
      { t: 'Business casual', skip: /casual|suit|formal|dressy/i },
      { t: 'Suits', skip: /casual|suit|formal/i },
      { t: 'Nothing too stiff', skip: /stiff|relaxed/i }] },
    { kind: 'shoes', test: SHOE_WORDS, details: [
      { t: 'Cushioned', skip: /cushion|comfort|soft/i },
      { t: 'Wide fit', skip: /wide|narrow/i },
      { t: 'For everyday', skip: /everyday|daily|casual|race|racing/i },
      { t: 'For racing', skip: /race|racing|everyday|daily|casual/i, onlyIf: /run|race|marathon|track/i },
      { t: 'Neutral colors', skip: /colou?r|black|white|navy|grey|gray|brown|beige|cream|olive/i }] },
    { kind: 'item', test: CLOTHING_WORDS, details: [
      { t: 'Neutral colors', skip: /colou?r|black|white|navy|grey|gray|brown|beige|cream|olive/i },
      { t: 'Minimal logos', skip: /logo/i },
      { t: 'Classic, not trendy', skip: /classic|trendy|timeless/i },
      { t: 'Built to last', skip: /last|durable|quality/i }] },
    { kind: 'gym', test: /gym|train(?!ers)|workout|lift|\brun|yoga|sport|athlet/i, details: [
      { t: 'Darker colors', skip: /dark|black|colou?r/i },
      { t: 'Loose fit', skip: /loose|fitted|tight|fit\b/i, notForItem: true },
      { t: 'For lifting', skip: /lift|run/i, notForItem: true },
      { t: 'For running', skip: /run|lift/i, notForItem: true }] },
    { kind: 'general', test: /.*/, details: [
      { t: 'Inspired by the 90s', skip: /\b(90s|80s|70s|y2k|vintage|retro)\b/i },
      { t: 'Darker colors', skip: /dark|black|colou?r/i },
      { t: 'Nothing too loud', skip: /loud|quiet|minimal|logo/i },
      { t: 'Good basics', skip: /basic|essential/i }] }
  ];
  const MAX_CHIPS = 6;
  const EXAMPLES = {
    italy: { name: 'Italy in June', items: [['italy-shirt', 'Short-sleeve linen shirt'], ['italy-pants', 'Pleated cotton trousers']] },
    '90s': { name: 'Everyday 90s', items: [['90s-jacket', 'Vintage windbreaker'], ['90s-jeans', 'Straight-leg jeans']] },
    gym: { name: 'Gym', items: [['gym-tee', 'Training tee'], ['gym-tote', 'Canvas gym tote']] }
  };

  const hookParam = (params.get('hook') || '').toLowerCase();
  const hook = HOOKS[hookParam] ? hookParam : '';
  const utm = {};
  params.forEach((value, key) => { if (key.startsWith('utm_')) utm[key] = value.slice(0, 200); });

  const track = (name, data = {}) => {
    try { if (typeof window.gtag === 'function') window.gtag('event', name, data); } catch (_) {}
    // Meta pixel isn't installed yet; this is a no-op until it is.
    try { if (name === 'make_submit' && typeof window.fbq === 'function') window.fbq('track', 'Lead'); } catch (_) {}
  };

  // localStorage (not session) so a draft survives iOS discarding the tab while
  // someone is off in Pinterest or Photos. Photos can't be kept; they're files.
  const store = {
    get() {
      try {
        const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
        return d && Date.now() - (d.savedAt || 0) < DRAFT_TTL ? d : {};
      } catch (_) { return {}; }
    },
    set(v) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...v, savedAt: Date.now() })); } catch (_) {} },
    clear() { try { localStorage.removeItem(DRAFT_KEY); } catch (_) {} }
  };

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const kindsOf = label => {
    const hits = KINDS.filter(k => k.kind !== 'general' && k.test.test(label));
    return hits.length ? hits : [KINDS[KINDS.length - 1]];
  };
  const kindOf = label => kindsOf(label)[0];
  // Interleave chips from every matching kind, drop ones the line already covers.
  function detailsFor(label) {
    const kinds = kindsOf(label);
    const isItem = ITEM_WORDS.test(label);
    const lists = kinds.map(k => k.details.filter(d => {
      if (hasPhrase(label, d.t)) return true;
      if (isItem && d.notForItem) return false;
      if (d.onlyIf && !d.onlyIf.test(label)) return false;
      return !d.skip.test(label);
    }));
    const out = [];
    for (let i = 0; out.length < MAX_CHIPS && lists.some(l => l[i]); i++) {
      lists.forEach(l => { if (l[i] && out.length < MAX_CHIPS && !out.some(o => o.t === l[i].t)) out.push(l[i]); });
    }
    return out.map(d => d.t);
  }
  const money = v => (v == null ? 'Any price' : `Up to $${v} a piece`);
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

  // "under 40 bucks", "$150", "nothing over 80", "max $60" -> number
  function priceInText(text) {
    const m = text.match(/\$\s?(\d{1,4})\b|\b(\d{1,4})\s?(?:bucks|dollars|usd)\b|\b(?:under|below|less than|max|up to|nothing over|no more than|not over)\s+\$?(\d{1,4})\b/i);
    if (!m) return null;
    const n = +(m[1] || m[2] || m[3]);
    return n >= 1 && n <= 10000 ? n : null;
  }
  const hasPhrase = (label, frag) => new RegExp(`(^|[\\s,])${escRe(frag)}($|[\\s,.])`, 'i').test(label);
  function addPhrase(label, frag) {
    const current = label.replace(/\s+$/, '');
    if (!current) return frag;
    if (/[.!?]$/.test(current)) return `${current} ${frag}`;
    return `${current.replace(/,$/, '')}, ${frag.charAt(0).toLowerCase()}${frag.slice(1)}`;
  }
  function removePhrase(label, frag) {
    const re = new RegExp(`(\\s*,\\s*)?${escRe(frag)}(\\s*,\\s*)?`, 'i');
    const out = label.replace(re, (_, a, b) => (a && b ? ', ' : ''))
      .replace(/^\s*,\s*|\s*,\s*$/g, '').replace(/\s{2,}/g, ' ').trim();
    return out ? cap(out) : '';
  }

  function pickExample(text) {
    if (hook) return EXAMPLES[hook];
    const b = text.toLowerCase();
    if (/ital|europe|trip|travel|vacation|summer|linen/.test(b)) return EXAMPLES.italy;
    if (/gym|train|run|workout|lift|athlet/.test(b)) return EXAMPLES.gym;
    return EXAMPLES['90s'];
  }

  // ---- Stub parse: stands in for POST /marts/parse with the same output shape.
  // Pulls out the facts a line already states and asks only for what's missing.
  const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\b(spring|summer|fall|autumn|winter|christmas|thanksgiving|new year)\b|\b(next|this)\s+(week|weekend|month|year)\b|\btomorrow\b/i;
  const PLACES = /\b(italy|rome|milan|florence|venice|amalfi|paris|france|london|uk|spain|barcelona|madrid|lisbon|porto|portugal|greece|athens|japan|tokyo|kyoto|mexico|tulum|cancun|cdmx|new york|nyc|miami|vegas|hawaii|europe|asia|bali|thailand|iceland|germany|berlin|amsterdam|copenhagen)\b/;
  const DOING = /walk|hik|dinner|beach|swim|wedding|meeting|client|conference|party|club|ski|sightsee|museum|business|\bwork/i;
  const DRESS = /casual|formal|suit|jeans|dressy|business|smart|relaxed|stiff/i;
  const TRAINING = /lift|run|yoga|pilates|crossfit|cycl|box|climb|hiit|swim/i;
  function stubLine(label) {
    const kinds = kindsOf(label).map(k => k.kind);
    const lower = label.toLowerCase();
    const facts = {};
    const place = lower.match(PLACES) || label.match(/\b(?:to|in)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
    if (place) facts.destination = place[1] || place[0];
    const when = label.match(MONTHS);
    if (when) facts.dates = when[0];
    const doing = label.match(DOING);
    if (doing) facts.activity = doing[0];
    const dress = label.match(DRESS);
    if (dress) facts.dress_code = dress[0];
    const training = label.match(TRAINING);
    if (training) facts.training = training[0];
    const isWork = kinds.includes('work');
    let question = null;
    if (kinds.includes('trip')) {
      const where = !facts.destination;
      const whenMissing = !facts.dates;
      if (where && whenMissing) question = { text: 'Where and when?', placeholder: 'e.g. Lisbon, mid-June' };
      else if (where) question = { text: 'Where are you going?', placeholder: `e.g. Lisbon and Porto` };
      else if (whenMissing) question = { text: 'When is it?', placeholder: 'e.g. mid-June, about a week' };
      else if (!facts.activity) question = { text: 'What will you be doing there?', placeholder: isWork ? 'e.g. client meetings, one dinner out' : 'e.g. lots of walking, two nice dinners' };
    } else if (isWork && !facts.dress_code) {
      question = { text: 'How dressed up is your work?', placeholder: 'e.g. jeans are fine, client days are not' };
    } else if (kinds.includes('gym') && !facts.training && !kinds.includes('item')) {
      question = { text: 'What kind of training?', placeholder: 'e.g. lifting, running' };
    }
    return { kind: kinds[0], facts, question };
  }
  function stubParse(labels) {
    const lines = labels.map(stubLine);
    // Suggest combining trips only, and only when nothing they state conflicts
    // ("Italy in June" vs "Milan" name different places, so no offer).
    const trips = lines.map((l, i) => (l.kind === 'trip' ? i : -1)).filter(i => i >= 0);
    const clash = (a, b, key) => a.facts[key] && b.facts[key] && a.facts[key].toLowerCase() !== b.facts[key].toLowerCase();
    const groups = [];
    trips.forEach(i => {
      const g = groups.find(gr => gr.lines.every(j => !clash(lines[i], lines[j], 'destination') && !clash(lines[i], lines[j], 'dates')));
      if (g) g.lines.push(i); else groups.push({ lines: [i], confidence: 0.6 });
    });
    return { lines, groups: groups.filter(g => g.lines.length > 1) };
  }
  const COMBINE_MIN_CONFIDENCE = 0.5;
  async function fetchParse(labels) {
    if (STUB) return stubParse(labels);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PARSE_TIMEOUT);
    try {
      const res = await fetch(PARSE_ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: labels }), signal: controller.signal
      });
      if (!res.ok) throw new Error(`status_${res.status}`);
      // API envelope: {success, data: {lines, groups}, error}
      const data = ((await res.json()) || {}).data || {};
      return {
        lines: labels.map((_, i) => {
          const l = (data.lines && data.lines[i]) || {};
          const q = l.question;
          return {
            kind: typeof l.kind === 'string' ? l.kind : null,
            facts: l.facts && typeof l.facts === 'object' ? l.facts : {},
            question: q && q.text ? { text: String(q.text), placeholder: String(q.placeholder || '') } : null
          };
        }),
        groups: Array.isArray(data.groups) ? data.groups.filter(g => g && Array.isArray(g.lines) && g.lines.length > 1) : []
      };
    } catch (_) {
      track('make_parse_fallback');
      return null; // no questions, no combine offer; the flow carries on
    } finally {
      clearTimeout(timeout);
    }
  }

  // Downscale to MAX_EDGE and re-encode as JPEG so uploads stay small on phones.
  function compress(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('encode')), 'image/jpeg', 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  function normalizeBoard(raw) {
    let url = raw.trim();
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    let parsed;
    try { parsed = new URL(url); } catch (_) { return null; }
    return /(^|\.)pinterest\.[a-z.]+$|^pin\.it$/i.test(parsed.hostname) ? parsed.href : null;
  }

  let uid = 0;

  function mount(root, { placement = 'page', onClose = null } = {}) {
    if (root.dataset.mounted) return root._mk;
    root.dataset.mounted = '1';
    const id = `mk${++uid}`;
    const draft = store.get();
    let nextId = 0;
    const newPiece = (label = '', price = null, manual = false) =>
      ({ id: `p${nextId++}`, label, price, manual, question: null, answer: '', group: 0 });
    const draftPieces = Array.isArray(draft.pieces) ? draft.pieces.slice(0, MAX_PIECES) : [];
    const state = {
      step: 1,
      pieces: draftPieces.length
        ? draftPieces.map(p => newPiece(String(p.label || '').slice(0, LABEL_MAX), Number.isFinite(p.price) ? p.price : null, Boolean(p.manual)))
        : [newPiece()],
      activeId: null,
      parsedFor: null,
      parsed: null,        // last parse result applied (saved with the submission)
      prefetch: null,      // {key, promise} for the parse started ahead of Next
      combine: false,      // combine lines the parser grouped into one mart
      sizes: draft.sizes || '',
      boards: Array.isArray(draft.boards) ? draft.boards.filter(b => b && b.url).slice(0, MAX_BOARDS) : [],
      email: draft.email || '',
      photos: [],          // {blob, url, for}
      sending: false
    };
    state.activeId = state.pieces[0].id;
    const TOTAL = 4;

    root.classList.add('mk');
    root.innerHTML = `
      <div class="mk-progress" data-progress>
        <span class="mk-mono" data-step-label>New mart · 01 / 0${TOTAL}</span>
        <div class="mk-bar" aria-hidden="true"><span class="is-on"></span>${'<span></span>'.repeat(TOTAL - 1)}</div>
      </div>

      <form class="mk-step" data-step="1" novalidate>
        <h2 class="mk-title" tabindex="-1">What are you shopping for?</h2>
        <p class="mk-sub">One line per thing. Each line becomes its own mart, with its own budget.</p>
        <div class="mk-rows" data-rows></div>
        <button type="button" class="mk-addrow" data-add-row>+ Add another thing</button>
        <p class="mk-error" data-rows-err role="alert"></p>
        <p class="mk-note">Short is fine. “dark gym fits, cheap” works.</p>
        <p class="mk-undo" data-undo-bar hidden role="status">Cleared. <button type="button" class="mk-edit" data-undo>Undo</button></p>
        <div class="mk-actions"><button class="mk-back" type="button" data-reset hidden>Start over</button><button class="mk-button" type="submit" data-next1>Next</button></div>
      </form>

      <form class="mk-step" data-step="2" novalidate hidden>
        <h2 class="mk-title" tabindex="-1">A few details.</h2>
        <p class="mk-sub">Answer what you like and skip the rest. It helps us get it right the first time.</p>
        <div data-questions></div>
        <div data-combine></div>
        <div class="mk-field">
          <label class="mk-label mk-q-label" for="${id}-sizes"><span class="mk-q-text">Your sizes</span></label>
          <input class="mk-input" id="${id}-sizes" type="text" maxlength="120" autocomplete="off" placeholder="e.g. M tops, 32x30 jeans, 10 shoes">
        </div>
        <div class="mk-actions"><button class="mk-back" type="button" data-back>← Back</button><button class="mk-button" type="submit">Next</button></div>
      </form>

      <form class="mk-step" data-step="3" novalidate hidden>
        <h2 class="mk-title" tabindex="-1">Show us what you mean.</h2>
        <p class="mk-sub">Photos, screenshots, outfits you’ve saved, or public Pinterest boards. This is the fastest way to show us what you like.</p>
        <div class="mk-field">
          <div class="mk-label mk-mono"><span>Photos</span><span class="mk-opt">Up to ${MAX_PHOTOS}</span></div>
          <div class="mk-photos" data-photos></div>
          <p class="mk-error" data-photo-err role="alert"></p>
        </div>
        <div class="mk-field">
          <label class="mk-label mk-mono" for="${id}-pin"><span>Pinterest boards</span><span class="mk-opt">Up to ${MAX_BOARDS}</span></label>
          <ul class="mk-list" data-boards></ul>
          <div class="mk-adder" data-board-adder>
            <input class="mk-input" id="${id}-pin" type="url" inputmode="url" autocomplete="off" placeholder="pinterest.com/yourname/board" aria-describedby="${id}-pin-err">
            <button class="mk-add" type="button" data-add-board>Add</button>
          </div>
          <p class="mk-error" id="${id}-pin-err" role="alert"></p>
        </div>
        <div class="mk-actions"><button class="mk-back" type="button" data-back>← Back</button><button class="mk-button" type="submit" data-next3>Skip for now</button></div>
      </form>

      <form class="mk-step" data-step="4" novalidate hidden>
        <h2 class="mk-title" tabindex="-1">Where should we send it?</h2>
        <p class="mk-sub">We’ll email your first finds within 48 hours, with a link to see them. No password.</p>
        <div class="mk-recap" data-recap></div>
        <div class="mk-field">
          <label class="mk-label mk-mono" for="${id}-email"><span>Email</span></label>
          <input class="mk-input" id="${id}-email" name="email" type="email" required autocomplete="email" inputmode="email" maxlength="254" placeholder="you@example.com" aria-describedby="${id}-email-err">
          <p class="mk-error" id="${id}-email-err" role="alert"></p>
          <p class="mk-note">By continuing you agree to our <a href="/terms.html" target="_blank" rel="noopener">Terms</a> and <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</p>
        </div>
        <div class="mk-actions"><button class="mk-back" type="button" data-back>← Back</button><button class="mk-button" type="submit" data-submit>Build my mart</button></div>
      </form>

      <section class="mk-step" data-step="done" hidden aria-live="polite">
        <p class="mk-done-mark mk-mono">Received</p>
        <h2 class="mk-title" tabindex="-1" data-done-title>Your mart is being built.</h2>
        <p class="mk-sub" data-done-sub></p>
        <ul class="mk-done-list" data-done-list></ul>
        <div class="mk-example" data-example></div>
        <div class="mk-actions" data-done-actions></div>
      </section>`;

    const $ = sel => root.querySelector(sel);
    const steps = { 1: $('[data-step="1"]'), 2: $('[data-step="2"]'), 3: $('[data-step="3"]'), 4: $('[data-step="4"]'), done: $('[data-step="done"]') };
    const rowsEl = $('[data-rows]');
    const rowsErr = $('[data-rows-err]');
    const addRowBtn = $('[data-add-row]');
    const combineEl = $('[data-combine]');
    const questionsEl = $('[data-questions]');
    const sizes = $(`#${id}-sizes`);
    const pin = $(`#${id}-pin`);
    const email = $(`#${id}-email`);
    const photosEl = $('[data-photos]');
    const photoErr = $('[data-photo-err]');
    const boardsEl = $('[data-boards]');
    const boardAdder = $('[data-board-adder]');
    const next1 = $('[data-next1]');
    const next3 = $('[data-next3]');
    const submitBtn = $('[data-submit]');
    const progress = $('[data-progress]');

    sizes.value = state.sizes;
    email.value = state.email;

    const err = (input, msg) => {
      const el = root.querySelector(`#${input.getAttribute('aria-describedby')}`);
      el.textContent = msg || '';
      input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    };
    const snapshot = () => ({
      pieces: state.pieces.map(p => ({ label: p.label, price: p.price, manual: p.manual })),
      sizes: state.sizes, boards: state.boards, email: state.email
    });
    const resetBtn = $('[data-reset]');
    const undoBar = $('[data-undo-bar]');
    const hasContent = () => state.pieces.some(p => p.label.trim() || p.price != null) || state.boards.length || state.photos.length || state.sizes.trim() || state.email.trim();
    const save = () => { store.set(snapshot()); resetBtn.hidden = !hasContent(); };
    const filled = () => state.pieces.filter(p => p.label.trim());
    const finalGroups = () => state.pieces.map((p, i) => (state.combine ? p.group : i));
    const martsOf = () => {
      const g = finalGroups();
      return [...new Set(g)].map(k => state.pieces.filter((_, i) => g[i] === k));
    };

    function show(step) {
      state.step = step;
      Object.entries(steps).forEach(([k, el]) => { el.hidden = String(k) !== String(step); });
      progress.hidden = step === 'done';
      if (step !== 'done') {
        $('[data-step-label]').textContent = `New mart · 0${step} / 0${TOTAL}`;
        root.querySelectorAll('.mk-bar span').forEach((s, i) => s.classList.toggle('is-on', i < step));
      }
      steps[step].querySelector('.mk-title').focus({ preventScroll: true });
      const scroller = root.closest('.mk-dialog');
      if (scroller) scroller.scrollTop = 0;
      else window.scrollTo(0, 0);
      track('make_step', { step: String(step), placement });
    }

    // ---- Step 1: one line per thing; price and detail chips live inside each line.
    const pieceOf = el => state.pieces.find(p => p.id === el.closest('[data-piece]')?.dataset.piece);
    const rowEl = p => rowsEl.querySelector(`[data-piece="${p.id}"]`);
    const grow = ta => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };

    function priceHTML(p, i) {
      const custom = p.price != null && !PRESETS.includes(p.price);
      return `
        <div class="mk-label mk-mono mk-price-label"><span>Max per piece</span></div>
        <div class="mk-prices" role="radiogroup" aria-label="Max price per piece for line ${i + 1}">
          ${PRESETS.map(v => `<button type="button" class="mk-seg" role="radio" data-price="${v ?? ''}" aria-checked="${!custom && p.price === v}">${v ? `$${v}` : 'Any'}</button>`).join('')}
          <label class="mk-seg mk-seg-custom" aria-checked="${custom}"><span aria-hidden="true">$</span><input type="text" inputmode="numeric" maxlength="5" data-custom placeholder="Other" aria-label="Other max price for line ${i + 1}" value="${custom ? p.price : ''}"></label>
        </div>`;
    }
    function chipsHTML(p) {
      if (!p.label.trim()) {
        return `<div class="mk-label mk-mono"><span>Or start with</span></div>
          <div class="mk-chips">${STARTERS.map(s => `<button type="button" class="mk-chip" data-starter>${esc(s)}</button>`).join('')}</div>`;
      }
      const details = detailsFor(p.label);
      if (!details.length) return '';
      return `<div class="mk-label mk-mono"><span>Add details</span><span class="mk-opt">Tap again to remove</span></div>
        <div class="mk-chips">${details.map(d => {
          const on = hasPhrase(p.label, d);
          return `<button type="button" class="mk-chip" data-detail="${esc(d)}" aria-pressed="${on}"><span aria-hidden="true">${on ? '✓' : '+'}</span> ${esc(d)}</button>`;
        }).join('')}</div>`;
    }
    function syncRow(p) {
      const el = rowEl(p);
      if (!el) return;
      const isActive = p.id === state.activeId;
      el.classList.toggle('is-active', isActive);
      const n = p.label.length;
      const counter = el.querySelector('[data-counter]');
      counter.hidden = n < COUNT_FROM;
      counter.textContent = `${n} / ${LABEL_MAX}`;
      counter.classList.toggle('is-near', n > LABEL_MAX - 20);
      const chips = el.querySelector('[data-row-chips]');
      const html = isActive ? chipsHTML(p) : '';
      chips.innerHTML = html;
      chips.hidden = !html;
    }
    function renderRows(focusId) {
      const many = state.pieces.length > 1;
      rowsEl.innerHTML = state.pieces.map((p, i) => `
        <div class="mk-row" data-piece="${p.id}">
          <div class="mk-row-top">
            ${many ? `<span class="mk-row-n mk-mono" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>` : ''}
            <textarea class="mk-row-input" data-label rows="1" maxlength="${LABEL_MAX}" aria-label="Line ${i + 1}: what you're shopping for" placeholder="${esc(i === 0 ? (HOOKS[hook] || PLACEHOLDER) : NEXT_PLACEHOLDER)}">${esc(p.label)}</textarea>
            ${many ? `<button type="button" class="mk-x" data-remove-piece aria-label="Remove line ${i + 1}">×</button>` : ''}
          </div>
          <div class="mk-counter mk-mono" data-counter hidden></div>
          <div class="mk-row-body">
            <div data-price-slot>${priceHTML(p, i)}</div>
            <div class="mk-row-chips" data-row-chips hidden></div>
          </div>
        </div>`).join('');
      state.pieces.forEach(syncRow);
      rowsEl.querySelectorAll('[data-label]').forEach(grow);
      addRowBtn.hidden = state.pieces.length >= MAX_PIECES;
      if (focusId) {
        const ta = rowsEl.querySelector(`[data-piece="${focusId}"] [data-label]`);
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      }
    }
    function setActive(p) {
      if (!p || p.id === state.activeId) return;
      const prev = state.pieces.find(x => x.id === state.activeId);
      state.activeId = p.id;
      if (prev) syncRow(prev);
      syncRow(p);
    }
    // Text is the source of truth for price too, unless the person picked one by hand.
    function priceFromText(p) {
      if (p.manual) return;
      const n = priceInText(p.label);
      if (n !== p.price) { p.price = n; rowEl(p).querySelector('[data-price-slot]').innerHTML = priceHTML(p, state.pieces.indexOf(p)); }
    }
    function setLabel(p, label) {
      p.label = label.slice(0, LABEL_MAX);
      const ta = rowEl(p).querySelector('[data-label]');
      ta.value = p.label;
      grow(ta);
      priceFromText(p);
      syncRow(p);
      save();
    }
    function addRow(label = '', focus = true) {
      if (state.pieces.length >= MAX_PIECES) { rowsErr.textContent = `That’s the limit of ${MAX_PIECES} for one go.`; return null; }
      const p = newPiece(label);
      state.pieces.push(p);
      state.activeId = p.id;
      renderRows(focus ? p.id : null);
      save();
      return p;
    }
    rowsEl.addEventListener('input', e => {
      if (e.target.matches('[data-custom]')) {
        const p = pieceOf(e.target);
        e.target.value = e.target.value.replace(/[^\d]/g, '');
        const v = e.target.value ? Math.min(+e.target.value, 10000) : null;
        p.price = v || null;
        p.manual = Boolean(v);
        const group = e.target.closest('[role="radiogroup"]');
        group.querySelectorAll('[data-price]').forEach(b => b.setAttribute('aria-checked', String(!v && b.dataset.price === '')));
        e.target.closest('.mk-seg-custom').setAttribute('aria-checked', String(Boolean(v)));
        save();
        return;
      }
      if (!e.target.matches('[data-label]')) return;
      const p = pieceOf(e.target);
      // Pasting a multi-line list splits it into lines.
      if (e.target.value.includes('\n')) {
        const [first, ...rest] = e.target.value.split(/\n+/).map(s => s.trim()).filter(Boolean);
        p.label = (first || '').slice(0, LABEL_MAX);
        priceFromText(p);
        let lastId = p.id;
        let at = state.pieces.indexOf(p) + 1;
        rest.forEach(label => {
          if (state.pieces.length >= MAX_PIECES) return;
          const n = newPiece(label.slice(0, LABEL_MAX));
          n.price = priceInText(n.label);
          state.pieces.splice(at++, 0, n);
          lastId = n.id;
        });
        state.activeId = lastId;
        renderRows(lastId);
        save();
        return;
      }
      p.label = e.target.value;
      grow(e.target);
      rowsErr.textContent = '';
      priceFromText(p);
      // Chips live outside the text box, so redrawing them doesn't disturb typing.
      syncRow(p);
      save();
    });
    rowsEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches('[data-custom]')) { e.preventDefault(); e.target.blur(); return; }
      // Enter in a line = next line, like a list.
      if (e.key !== 'Enter' || !e.target.matches('[data-label]') || e.shiftKey) return;
      e.preventDefault();
      const p = pieceOf(e.target);
      if (!p.label.trim()) return;
      const after = state.pieces[state.pieces.indexOf(p) + 1];
      if (after) { setActive(after); rowEl(after).querySelector('[data-label]').focus(); }
      else addRow();
    });
    rowsEl.addEventListener('focusin', e => setActive(pieceOf(e.target)));
    rowsEl.addEventListener('click', e => {
      const p = pieceOf(e.target);
      if (!p) return;
      setActive(p);
      const priceBtn = e.target.closest('[data-price]');
      if (priceBtn) {
        p.price = priceBtn.dataset.price ? +priceBtn.dataset.price : null;
        p.manual = true;
        rowEl(p).querySelector('[data-price-slot]').innerHTML = priceHTML(p, state.pieces.indexOf(p));
        save();
        return;
      }
      // Chips never focus the text box, so the keyboard stays down on phones.
      const starter = e.target.closest('[data-starter]');
      if (starter) {
        setLabel(p, starter.textContent);
        track('make_chip', { chip: starter.textContent, kind: 'starter' });
        return;
      }
      const detail = e.target.closest('[data-detail]');
      if (detail) {
        const frag = detail.dataset.detail;
        const on = hasPhrase(p.label, frag);
        const next = on ? removePhrase(p.label, frag) : addPhrase(p.label, frag);
        if (next.length > LABEL_MAX) { rowsErr.textContent = 'That line is full. Start another one for the rest.'; return; }
        setLabel(p, next);
        track('make_chip', { chip: frag, kind: on ? 'detail_remove' : 'detail_add' });
        return;
      }
      if (e.target.closest('[data-remove-piece]')) {
        const i = state.pieces.indexOf(p);
        state.pieces.splice(i, 1);
        const focus = state.pieces[Math.max(0, i - 1)];
        state.activeId = focus.id;
        rowsErr.textContent = '';
        renderRows();
        save();
        track('make_piece_remove');
      }
    });
    addRowBtn.addEventListener('click', () => { addRow(); track('make_piece_add'); });

    // Start over: drafts are saved for a week, so returning visitors (or the next
    // person on a shared device) need a way out. Undo covers a mis-tap.
    let undoData = null;
    let undoTimer = 0;
    function applyDraft(d) {
      state.pieces = d.pieces.length ? d.pieces.map(p => newPiece(p.label, p.price, p.manual)) : [newPiece()];
      state.activeId = state.pieces[0].id;
      state.sizes = d.sizes; state.boards = d.boards.map(b => ({ ...b })); state.email = d.email;
      sizes.value = state.sizes; email.value = state.email; pin.value = '';
      state.parsedFor = null; state.parsed = null; state.prefetch = null; state.combine = false;
      rowsErr.textContent = '';
      renderRows();
      renderRefs();
      save();
    }
    resetBtn.addEventListener('click', () => {
      undoData = { ...snapshot(), photos: state.photos };
      state.photos = [];
      applyDraft({ pieces: [], sizes: '', boards: [], email: '' });
      store.clear();
      resetBtn.hidden = true;
      undoBar.hidden = false;
      clearTimeout(undoTimer);
      undoTimer = setTimeout(() => {
        undoBar.hidden = true;
        (undoData?.photos || []).forEach(p => URL.revokeObjectURL(p.url));
        undoData = null;
      }, 8000);
      rowEl(state.pieces[0]).querySelector('[data-label]').focus();
      track('make_reset');
    });
    $('[data-undo]').addEventListener('click', () => {
      if (!undoData) return;
      clearTimeout(undoTimer);
      state.photos = undoData.photos;
      applyDraft(undoData);
      undoData = null;
      undoBar.hidden = true;
    });
    // Start the parse before Next is tapped (on a pause in typing or leaving a line),
    // so the details screen usually opens without a wait.
    const labelsKey = labels => JSON.stringify(labels);
    function parseFor(labels) {
      const key = labelsKey(labels);
      if (!state.prefetch || state.prefetch.key !== key) state.prefetch = { key, promise: fetchParse(labels) };
      return state.prefetch.promise;
    }
    let prefetchTimer = 0;
    function schedulePrefetch(delay) {
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(() => {
        const labels = filled().map(p => cap(p.label.trim())).filter(l => l.length >= 3);
        if (labels.length) parseFor(labels);
      }, delay);
    }
    rowsEl.addEventListener('input', e => { if (e.target.matches('[data-label]')) schedulePrefetch(1200); });
    rowsEl.addEventListener('focusout', e => { if (e.target.matches('[data-label]')) schedulePrefetch(0); });

    steps[1].addEventListener('submit', async e => {
      e.preventDefault();
      const rows = filled();
      if (!rows.length) { rowsErr.textContent = 'Tell us at least one thing you’re shopping for.'; rowEl(state.pieces[0]).querySelector('[data-label]').focus(); return; }
      const short = rows.find(p => p.label.trim().length < 3);
      if (short) { rowsErr.textContent = 'Add a few more words to that line.'; rowEl(short).querySelector('[data-label]').focus(); return; }
      state.pieces = rows;
      state.pieces.forEach(p => { p.label = cap(p.label.trim()); });
      if (!state.pieces.some(p => p.id === state.activeId)) state.activeId = state.pieces[0].id;
      renderRows();
      rowsErr.textContent = '';
      const labels = state.pieces.map(p => p.label);
      const key = labelsKey(labels);
      // Only re-apply when the lines changed, so Back -> Next keeps answers.
      if (state.parsedFor !== key) {
        next1.disabled = true;
        next1.textContent = 'Reading…';
        const result = await parseFor(labels);
        next1.disabled = false;
        next1.textContent = 'Next';
        // Keep answers for lines whose text didn't change.
        const oldAnswers = new Map(state.pieces.map(p => [p.label, p.answer]));
        state.pieces.forEach((p, i) => {
          const line = result && result.lines[i];
          p.question = line ? line.question : null;
          p.answer = (p.question && oldAnswers.get(p.label)) || '';
          p.group = i;
        });
        // A suggested group becomes a combine offer; each line still defaults to its own mart.
        (result ? result.groups : []).forEach(g => {
          if ((g.confidence ?? 1) < COMBINE_MIN_CONFIDENCE) return;
          const members = g.lines.filter(i => state.pieces[i]);
          members.forEach(i => { state.pieces[i].group = members[0]; });
        });
        state.parsed = result;
        state.combine = false;
        state.parsedFor = key;
        renderDetails();
      }
      save();
      show(2);
    });
    renderRows();
    resetBtn.hidden = !hasContent();

    // ---- Step 2: follow-ups, a combine offer when lines look like the same thing, sizes
    // What a line says about where/when, from the parse facts or the person's answer.
    function factOf(p, key, re) {
      const line = state.parsed && state.parsed.lines[state.pieces.indexOf(p)];
      const fromFacts = line && line.facts && line.facts[key];
      if (fromFacts) return String(fromFacts).toLowerCase();
      const m = p.answer.toLowerCase().match(re);
      return m ? m[0].toLowerCase() : null;
    }
    const conflicts = set => ['dates', 'destination'].some(key => {
      const vals = set.map(p => factOf(p, key, key === 'dates' ? MONTHS : PLACES)).filter(Boolean);
      return new Set(vals).size > 1;
    });
    function renderDetails() { renderQuestions(); renderCombine(); }
    // Shown after the questions, and only while the answers don't contradict it:
    // once two trips turn out to have different dates or places, the offer goes away.
    function renderCombine() {
      const g = state.pieces.map(p => p.group);
      const shared = [...new Set(g)].map(k => state.pieces.filter(p => p.group === k)).filter(set => set.length > 1 && !conflicts(set));
      if (!shared.length && state.combine) { state.combine = false; }
      // Ask, don't assert: the parser's grouping is a guess.
      const allTrips = shared.every(set => set.every(p => kindsOf(p.label).some(k => k.kind === 'trip')));
      combineEl.innerHTML = !shared.length ? '' : `
        <div class="mk-split" role="radiogroup" aria-label="Combine lines">
          <p class="mk-split-q"><span class="mk-split-h">${allTrips ? 'Same trip?' : 'Same thing?'}</span>
            ${shared.map(set => set.map(p => `<strong>${esc(p.label)}</strong>`).join(' and ')).join('; ')}.
            Combined, it’s one mart, and each line’s budget still applies to the pieces we find for that line.</p>
          <button type="button" class="mk-seg" role="radio" data-combine-choice="0" aria-checked="${!state.combine}">Keep separate</button>
          <button type="button" class="mk-seg" role="radio" data-combine-choice="1" aria-checked="${state.combine}">Combine into one mart</button>
        </div>`;
    }
    function renderQuestions() {
      questionsEl.innerHTML = state.pieces.filter(p => p.question).map(p => `
        <div class="mk-field">
          <label class="mk-label mk-q-label" for="${id}-${p.id}-a"><span class="mk-q-for mk-mono">${esc(p.label)}</span><span class="mk-q-text">${esc(p.question.text)}</span></label>
          <input class="mk-input" id="${id}-${p.id}-a" data-piece="${p.id}" data-answer type="text" maxlength="160" autocomplete="off" placeholder="${esc(p.question.placeholder)}" value="${esc(p.answer)}">
        </div>`).join('');
    }
    questionsEl.addEventListener('input', e => {
      if (!e.target.matches('[data-answer]')) return;
      pieceOf(e.target).answer = e.target.value;
      renderCombine();
    });
    questionsEl.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-answer]')) e.preventDefault(); });
    combineEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-combine-choice]');
      if (!btn) return;
      state.combine = btn.dataset.combineChoice === '1';
      combineEl.querySelectorAll('[data-combine-choice]').forEach(b => b.setAttribute('aria-checked', String(b === btn)));
      renderRefs();
    });
    sizes.addEventListener('input', () => { state.sizes = sizes.value; save(); });
    steps[2].addEventListener('submit', e => { e.preventDefault(); renderRefs(); show(3); });

    // ---- Step 3: references, each tagged to a mart when there's more than one
    const marts = () => martsOf();
    const martLabel = set => set.map(p => p.label).join(' + ');
    // With several marts, a reference defaults to "Not sure": it isn't counted
    // toward any mart, and gets matched to a line during review (later, by the
    // background job). "For all" used to leak a board into every mart.
    function forSelect(value, attr, label) {
      const ms = marts();
      if (ms.length < 2) return '';
      return `<select class="mk-for" ${attr} aria-label="${esc(label)}">
        <option value="">Match it for me</option>
        ${ms.map(set => { const i = state.pieces.indexOf(set[0]); return `<option value="${i}" ${value === i ? 'selected' : ''}>For ${esc(clip(martLabel(set), 26))}</option>`; }).join('')}
      </select>`;
    }
    const pinValid = () => Boolean(normalizeBoard(pin.value));
    const syncNext3 = () => { next3.textContent = state.photos.length || state.boards.length || pinValid() ? 'Next' : 'Skip for now'; };
    function renderPhotos() {
      const tiles = state.photos.map((p, i) => `
        <div class="mk-photo">
          <div class="mk-tile is-filled"><img src="${p.url}" alt="Reference photo ${i + 1}">
            <button type="button" class="mk-remove" data-remove="${i}" aria-label="Remove photo ${i + 1}">×</button></div>
          ${forSelect(p.for, `data-photo-for="${i}"`, `Which mart is photo ${i + 1} for?`)}
        </div>`);
      if (state.photos.length < MAX_PHOTOS) {
        tiles.push(`<div class="mk-photo"><label class="mk-tile"><input type="file" accept="image/*" ${MAX_PHOTOS - state.photos.length > 1 ? 'multiple' : ''} data-file aria-label="Add photos">
          <span class="mk-tile-add"><b aria-hidden="true">+</b><span class="mk-mono">Add photo</span></span></label></div>`);
      }
      photosEl.innerHTML = tiles.join('');
      syncNext3();
    }
    function renderBoards() {
      boardsEl.innerHTML = state.boards.map((b, i) => `
        <li class="mk-list-row"><span class="mk-list-text">${esc(b.url.replace(/^https?:\/\/(www\.)?/, ''))}</span>
          ${forSelect(b.piece, `data-board-for="${i}"`, `Which mart is board ${i + 1} for?`)}
          <button type="button" class="mk-x" data-remove-board="${i}" aria-label="Remove board ${i + 1}">×</button></li>`).join('');
      boardsEl.hidden = !state.boards.length;
      boardAdder.hidden = state.boards.length >= MAX_BOARDS;
      syncNext3();
    }
    function renderRefs() {
      // Drop tags that point at a mart that no longer exists.
      const valid = new Set(marts().map(set => state.pieces.indexOf(set[0])));
      state.photos.forEach(p => { if (!valid.has(p.for)) p.for = null; });
      state.boards.forEach(b => { if (!valid.has(b.piece)) b.piece = null; });
      renderPhotos();
      renderBoards();
    }
    photosEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-remove]');
      if (!btn) return;
      const [removed] = state.photos.splice(+btn.dataset.remove, 1);
      URL.revokeObjectURL(removed.url);
      photoErr.textContent = '';
      renderPhotos();
      photosEl.querySelector('[data-file]')?.focus();
    });
    photosEl.addEventListener('change', async e => {
      const sel = e.target.closest('[data-photo-for]');
      if (sel) { state.photos[+sel.dataset.photoFor].for = sel.value === '' ? null : +sel.value; return; }
      const input = e.target.closest('[data-file]');
      if (!input) return;
      const files = [...input.files].filter(f => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
      const room = MAX_PHOTOS - state.photos.length;
      photoErr.textContent = input.files.length > room ? `Only the first ${room} ${room === 1 ? 'photo was' : 'photos were'} added.` : '';
      let failed = 0;
      for (const file of files.slice(0, room)) {
        try {
          const blob = await compress(file);
          state.photos.push({ blob, url: URL.createObjectURL(blob), for: null });
        } catch (_) { failed++; }
      }
      if (failed) photoErr.textContent = 'We couldn’t read one of those images. Try a JPEG or PNG, or a screenshot of it.';
      renderPhotos();
      if (files.length) track('make_photo', { count: String(state.photos.length) });
    });
    function addBoardFromInput() {
      if (!pin.value.trim()) return true;
      const url = normalizeBoard(pin.value);
      if (!url) { err(pin, 'That doesn’t look like a Pinterest link. Paste the board’s address.'); pin.focus(); return false; }
      if (!state.boards.some(b => b.url === url)) state.boards.push({ url, piece: null });
      pin.value = '';
      err(pin, '');
      save();
      renderBoards();
      track('make_board', { count: String(state.boards.length) });
      return true;
    }
    $('[data-add-board]').addEventListener('click', () => { if (addBoardFromInput() && !boardAdder.hidden) pin.focus(); });
    pin.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (addBoardFromInput() && !boardAdder.hidden) pin.focus(); } });
    pin.addEventListener('input', () => { err(pin, ''); syncNext3(); });
    boardsEl.addEventListener('change', e => {
      const sel = e.target.closest('[data-board-for]');
      if (sel) { state.boards[+sel.dataset.boardFor].piece = sel.value === '' ? null : +sel.value; save(); }
    });
    boardsEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-remove-board]');
      if (!btn) return;
      state.boards.splice(+btn.dataset.removeBoard, 1);
      save();
      renderBoards();
      pin.focus();
    });
    steps[3].addEventListener('submit', e => {
      e.preventDefault();
      // A link typed but not added still counts; a bad one blocks with the error shown.
      if (!addBoardFromInput()) return;
      renderRecap();
      show(4);
    });
    renderRefs();

    // ---- Step 4: recap + email + submit
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    function renderRecap() {
      const ms = marts();
      const single = ms.length < 2;
      const refCount = set => {
        if (single) return state.photos.length + state.boards.length;
        const i = state.pieces.indexOf(set[0]);
        return state.photos.filter(p => p.for === i).length + state.boards.filter(b => b.piece === i).length;
      };
      const unassigned = single ? 0 : state.photos.filter(p => p.for === null).length + state.boards.filter(b => b.piece === null).length;
      $('[data-recap]').innerHTML = `
        <div class="mk-label mk-mono"><span>${single ? 'Your mart' : `${ms.length} marts`}</span><button type="button" class="mk-edit" data-edit>Edit</button></div>
        <ul class="mk-recap-list">${ms.map(set => {
          const meta = [set.map(p => money(p.price)).join(' · ')];
          if (refCount(set)) meta.push(plural(refCount(set), 'reference'));
          const answers = set.filter(p => p.answer.trim()).map(p => `“${p.answer.trim()}”`);
          return `<li><span class="mk-recap-name">${esc(martLabel(set))}</span>
            <span class="mk-recap-meta">${esc(meta.join(' · '))}</span>
            ${answers.length ? `<span class="mk-recap-meta">${esc(answers.join(' · '))}</span>` : ''}</li>`;
        }).join('')}
        </ul>
        ${unassigned ? `<p class="mk-recap-extra">${plural(unassigned, 'reference')} we’ll match to the right mart</p>` : ''}
        ${state.sizes.trim() ? `<p class="mk-recap-extra">Sizes: ${esc(state.sizes.trim())}</p>` : ''}`;
      $('[data-edit]').addEventListener('click', () => show(1));
      submitBtn.textContent = buildLabel();
    }
    const buildLabel = () => (marts().length > 1 ? `Build my ${marts().length} marts` : 'Build my mart');
    email.addEventListener('input', () => { state.email = email.value; err(email, ''); save(); });
    steps[4].addEventListener('submit', async e => {
      e.preventDefault();
      if (state.sending) return;
      const address = email.value.trim();
      email.value = address;
      if (!address || !email.checkValidity()) { err(email, 'Enter an email address so we can send you your mart.'); email.focus(); return; }
      state.sending = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
      err(email, '');

      const groups = finalGroups();
      const body = new FormData();
      body.append('brief', state.pieces.map(p => p.label).join('\n'));
      body.append('pieces', JSON.stringify(state.pieces.map((p, i) => ({
        label: p.label, group: groups[i], max_price_usd: p.price,
        question: p.question ? p.question.text : null, answer: p.answer.trim() || null
      }))));
      if (state.sizes.trim()) body.append('sizes', state.sizes.trim());
      body.append('boards', JSON.stringify(state.boards));
      state.photos.forEach((p, i) => body.append('references', p.blob, `reference-${i + 1}.jpg`));
      body.append('references_for', JSON.stringify(state.photos.map(p => p.for)));
      // The structured brief (kinds, facts, groups) is what gets curated from in review.
      if (state.parsed) body.append('parsed', JSON.stringify(state.parsed));
      body.append('email', address);
      if (hook) body.append('hook', hook);
      body.append('placement', placement);
      body.append('utm', JSON.stringify(utm));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        if (STUB) {
          const shown = {};
          for (const [k, v] of body.entries()) {
            const val = v instanceof Blob ? `${v.type} ${Math.round(v.size / 1024)}KB` : v;
            shown[k] = k in shown ? [].concat(shown[k], val) : val;
          }
          console.info('[make] stub submission (not sent):', JSON.stringify(shown, null, 1));
          await new Promise(r => setTimeout(r, 500));
        } else {
          const res = await fetch(ENDPOINT, { method: 'POST', body, signal: controller.signal });
          if (!res.ok && res.status !== 409) throw new Error(`status_${res.status}`);
        }
        store.clear();
        const ms = marts();
        track('make_submit', { placement, hook: hook || 'none', pieces: String(state.pieces.length), marts: String(ms.length), photos: String(state.photos.length), boards: String(state.boards.length) });
        renderDone(address, ms);
        show('done');
      } catch (error) {
        err(email, error.name === 'AbortError' ? 'That took too long. Please try again.' : 'We couldn’t send that just now. Please try again.');
      } finally {
        clearTimeout(timeout);
        state.sending = false;
        submitBtn.disabled = false;
        submitBtn.textContent = buildLabel();
      }
    });

    root.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => show(state.step - 1)));

    function renderDone(address, ms) {
      $('[data-done-title]').textContent = ms.length > 1 ? `Your ${ms.length} marts are being built.` : 'Your mart is being built.';
      $('[data-done-sub]').innerHTML = `First finds within 48 hours. We’ll send them to <strong>${esc(address)}</strong>.`;
      $('[data-done-list]').innerHTML = ms.map(set => `<li>${esc(martLabel(set))}</li>`).join('');
      const ex = pickExample(state.pieces.map(p => p.label).join(' '));
      $('[data-example]').innerHTML = `
        <div class="mk-example-head"><span class="mk-example-name">${esc(ex.name)}</span><span class="mk-tag mk-mono">Example</span></div>
        <p class="mk-note">This is an example of a finished mart, not yours. Yours is built from what you told us.</p>
        <div class="mk-items">${ex.items.map(([img, label]) => `
          <figure class="mk-item" style="margin:0"><picture><source srcset="${ASSET}${img}.webp" type="image/webp"><img src="${ASSET}${img}.${img.startsWith('gym') ? 'png' : 'jpg'}" alt="" loading="lazy"></picture><p>${esc(label)}</p></figure>`).join('')}
        </div>`;
      $('[data-done-actions]').innerHTML = onClose
        ? '<button class="mk-button" type="button" data-done-close>Done</button>'
        : '<a class="mk-button" href="/">Back to Eura</a>';
      $('[data-done-close]')?.addEventListener('click', onClose);
    }

    const api = { focus: () => steps[state.step].querySelector('.mk-title').focus({ preventScroll: true }) };
    root._mk = api;
    return api;
  }

  // Standalone page
  document.querySelectorAll('[data-make-root]').forEach(root => mount(root, { placement: 'page' }));

  // Popup on the main page
  const dialog = document.querySelector('[data-make-dialog]');
  if (dialog && typeof dialog.showModal === 'function') {
    const root = dialog.querySelector('[data-make-popup-root]');
    let opener = null;
    const close = () => dialog.close();
    dialog.addEventListener('close', () => {
      document.body.classList.remove('mk-locked');
      if (location.hash === '#make') history.replaceState(null, '', location.pathname + location.search);
      opener?.focus();
    });
    dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
    dialog.querySelector('[data-make-close]')?.addEventListener('click', close);
    const open = trigger => {
      opener = trigger || null;
      const api = mount(root, { placement: 'popup', onClose: close });
      document.body.classList.add('mk-locked');
      dialog.showModal();
      dialog.scrollTop = 0;
      api.focus();
      track('make_open', { placement: trigger?.dataset.makeOpen || 'hash' });
    };
    document.querySelectorAll('[data-make-open]').forEach(link => link.addEventListener('click', e => {
      e.preventDefault();
      open(link);
    }));
    if (location.hash === '#make') open(null);
  }
})();
