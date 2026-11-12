/* Make-a-mart flow: lines (each its own mart + budget, with its follow-up question and any
 * combine offer inline) -> references -> email -> confirmation.
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
 * Backend contracts (live on api.eura.style):
 *
 *   POST /marts/parse   JSON {lines:[label]}   (public: rate-limit per IP, cap line length)
 *     -> {lines:[{kind: "trip"|"work"|"gym"|"item"|"general"|...,
 *                 facts: {destination?, dates?, activity?, dress_code?, training?, ...},
 *                 question: {text, placeholder}|null}],          one per line, same order
 *         groups:[{lines:[int], confidence: 0-1}]}                 lines that look like one context
 *     One model call. Ask at most one question per line, and none when the line already
 *     says it; the placeholder is an example answer that fits that line. Groups at or above
 *     COMBINE_MIN_CONFIDENCE become a "Same trip? Combine?" offer (default: keep separate).
 *     Run on a pause in typing or on leaving a line, never on Next; the question shows
 *     under its line. Submit waits for a parse still in flight (bounded by the timeout).
 *     Failure or >PARSE_TIMEOUT -> no questions, no offer; never stalls.
 *     The result is saved with the submission as `parsed`: it's the structured brief
 *     the 48h review curates from, and later the input to automated sourcing.
 *
 *   POST /marts   multipart/form-data
 *     brief            string, the lines joined by newlines (raw, kept for review)
 *     pieces           JSON [{label, group, max_price_usd|null, question|null, answer|null}]
 *                      one mart per distinct group
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
  // "Connect Pinterest": an anonymous, read-only, 24h link held by the API (never a token
  // in the browser). The browser only keeps the link's `state`, in sessionStorage.
  // ?pinapi= works on localhost only (local end-to-end tests), never on the live site.
  const LOCAL_HOST = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const PIN_API_OVERRIDE = (() => {
    if (!LOCAL_HOST) return null;
    let v = new URLSearchParams(location.search).get('pinapi');
    try { if (v) sessionStorage.setItem('eura-make-pinapi', v); else v = sessionStorage.getItem('eura-make-pinapi'); } catch (_) {}
    return v;
  })();
  const API_ORIGIN = PIN_API_OVERRIDE ? new URL(PIN_API_OVERRIDE).origin : 'https://api.eura.style';
  const PINTEREST_API = `${API_ORIGIN}/marts/pinterest`;
  const PIN_KEY = 'eura-make-pinterest';
  const PIN_WAIT_MS = 10 * 60 * 1000;
  // OAuth inside these in-app browsers fails or strands people; send them to paste instead.
  const IN_APP = /Instagram|FBAN|FBAV|FB_IAB|FBIOS|TikTok|musical_ly|BytedanceWebview|Pinterest\//i.test(navigator.userAgent || '');
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
    italy: 'e.g. Clothes for my trip to Italy',
    '90s': 'e.g. everyday outfits inspired by the 90s',
    gym: 'e.g. Clothes for the gym'
  };
  const PLACEHOLDER = 'e.g. Clothes from my favorite brands, on sale';
  const NEXT_PLACEHOLDER = 'e.g. Clothes for my next trip';
  const STARTERS = ['Brands on sale', 'Clothes for a trip', 'Vintage finds', 'Everyday clothes'];
  // Detail chips fit what the line is about. A line can match several kinds
  // ("work trip" gets both); `skip` hides a chip when the line already says it
  // (unless the chip itself put it there, so it can still be tapped off).
  // `notForItem` drops whole-wardrobe chips on single-item lines ("running shoes").
  const SHOE_WORDS = /\b(shoes?|sneakers?|trainers|boots?|loafers?|sandals|heels|flats|slides|cleats)\b/i;
  const CLOTHING_WORDS = /\b(jacket|coat|parka|jeans|pants|trousers|chinos|shorts|shirt|tee|t-shirts?|polo|hoodie|sweater|cardigan|blazer|suit|bag|tote|backpack|belt|hat|cap|dress|skirt|watch|sunglasses)\b/i;
  const ITEM_WORDS = new RegExp(`${SHOE_WORDS.source}|${CLOTHING_WORDS.source}`, 'i');
  // `topic` drops a chip when the line's follow-up question already asks the same
  // thing ("What is the dress code?" replaces the dress-code chips).
  const KINDS = [
    { kind: 'event', test: /wedding|party|gala|graduation|funeral|reception|rehearsal|black tie|cocktail|prom\b|birthday|date night|concert|festival/i, details: [
      { t: 'Cocktail attire', skip: /cocktail|black tie|formal|casual|dress code|suit/i, topic: /dress|wear|formal|attire/i },
      { t: 'Outdoor venue', skip: /outdoor|indoor|garden|beach|barn/i, topic: /venue|outdoor|where/i },
      { t: 'Evening', skip: /evening|night|daytime|brunch/i, topic: /time|day|evening/i },
      { t: 'Shoes I can stand in', skip: /shoe|heel|comfort/i }] },
    { kind: 'sale', test: /\b(sales?|discounts?|discounted|markdowns?)\b|on sale|%\s*off/i, details: [
      { t: 'At least 30% off', skip: /\d+\s*%|percent|half[ -]price/i },
      { t: 'Secondhand too', skip: /second[ -]?hand|pre[ -]?(owned|loved)|resale|used only|new only/i },
      { t: 'No big logos', skip: /logo/i }] },
    { kind: 'trip', test: /trip|travel|vacation|holiday|honeymoon|getaway|italy|paris|europe|japan|mexico|beach/i, details: [
      { t: 'Carry-on only', skip: /carry[ -]?on|pack|luggage/i },
      { t: 'Walking all day', skip: /walk/i, topic: /doing|plan|activit/i },
      { t: 'Dinner out', skip: /dinner|dressy|formal/i, topic: /doing|plan|activit/i }] },
    { kind: 'work', test: /\bwork|office|job|interview|business|client|conference/i, details: [
      { t: 'Jeans allowed', skip: /jeans|formal|suit|black tie/i, topic: /dress|formal|casual|wear/i },
      { t: 'Machine washable', skip: /wash|dry[ -]clean/i },
      { t: 'Comfortable shoes', skip: /shoe|heel|comfort/i, notForItem: true }] },
    { kind: 'shoes', test: SHOE_WORDS, details: [
      { t: 'Cushioned', skip: /cushion|comfort|soft/i },
      { t: 'Wide fit', skip: /wide|narrow/i },
      { t: 'For everyday', skip: /everyday|daily|casual|race|racing/i },
      { t: 'For racing', skip: /race|racing|everyday|daily|casual/i, onlyIf: /run|race|marathon|track/i },
      { t: 'Secondhand too', skip: /second[ -]?hand|pre[ -]?(owned|loved)|resale|new only/i }] },
    { kind: 'item', test: CLOTHING_WORDS, details: [
      { t: 'Vintage', skip: /vintage|retro|second[ -]?hand|new only/i },
      { t: 'More color', skip: /colou?r|black|white|navy|grey|gray|brown|beige|cream|olive|dark|neutral/i, topic: /colou?r/i },
      { t: 'Oversized fits', skip: /oversized|loose|fitted|slim|tight|fit\b/i, onlyIf: /jacket|coat|parka|jeans|pants|trousers|chinos|shorts|shirt|tee|polo|hoodie|sweater|cardigan|blazer|dress|skirt/i }] },
    { kind: 'gym', test: /gym|train(?!ers)|workout|lift|\brun|yoga|sport|athlet/i, details: [
      { t: 'Darker colors', skip: /dark|black|colou?r/i },
      { t: 'Loose fit', skip: /loose|fitted|tight|fit\b/i, notForItem: true },
      { t: 'For lifting', skip: /lift|run/i, notForItem: true },
      { t: 'For running', skip: /run|lift/i, notForItem: true }] },
    { kind: 'general', test: /.*/, details: [
      { t: 'Vintage', skip: /vintage|retro|second[ -]?hand|new only/i, topic: /style|look|vibe/i },
      { t: 'More color', skip: /colou?r|black|white|navy|grey|gray|brown|beige|cream|olive|dark|neutral/i, topic: /colou?r/i },
      { t: 'Oversized fits', skip: /oversized|loose|fitted|slim|tight|fit\b/i }] }
  ];
  // The parser's kind for a line, when it has one, beats the regex (it knows
  // "wedding guest in october" is an event, not a trip).
  const PARSE_KIND = { everyday: 'general' };
  const MAX_CHIPS = 3;
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
  const kindsOf = (label, parsedKind = null) => {
    const hits = KINDS.filter(k => k.kind !== 'general' && k.test.test(label));
    const pk = parsedKind && KINDS.find(k => k.kind === (PARSE_KIND[parsedKind] || parsedKind));
    if (pk && pk.kind !== 'general') {
      // An event isn't a trip just because the regex saw a place in it.
      return [pk, ...hits.filter(k => k !== pk && !(pk.kind === 'event' && k.kind === 'trip'))];
    }
    return hits.length ? hits : [KINDS[KINDS.length - 1]];
  };
  // Interleave chips from every matching kind, drop ones the line already covers
  // and ones the line's follow-up question already asks about.
  function detailsFor(label, parsedKind = null, questionText = '') {
    const matched = kindsOf(label, parsedKind);
    // Keep mission-specific choices when a detail mentions an item (e.g. work shoes).
    const contextual = matched.filter(k => !['general', 'item', 'shoes'].includes(k.kind));
    const kinds = contextual.length ? contextual : matched;
    const isItem = ITEM_WORDS.test(label);
    const lists = kinds.map(k => k.details.filter(d => {
      if (hasPhrase(label, d.t)) return true;
      if (isItem && d.notForItem) return false;
      if (d.onlyIf && !d.onlyIf.test(label)) return false;
      if (questionText && d.topic && d.topic.test(questionText)) return false;
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
    } else if (kinds.includes('event') && !facts.dates) {
      question = { text: 'When is it, and how dressy?', placeholder: 'e.g. late October, cocktail' };
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
    // `group` is the id of the piece whose mart this line joins when combined;
    // `line` is this line's parse result (kind, facts), for the label it was parsed from.
    const newPiece = (label = '', price = null, manual = false) => {
      const p = { id: `p${nextId++}`, label, price, manual, question: null, answer: '', line: null, parsedLabel: null };
      p.group = p.id;
      return p;
    };
    const fromDraft = d => {
      const p = newPiece(String(d.label || '').slice(0, LABEL_MAX), Number.isFinite(d.price) ? d.price : null, Boolean(d.manual));
      const q = d.question;
      if (q && typeof q.text === 'string') p.question = { text: q.text.slice(0, 140), placeholder: String(q.placeholder || '').slice(0, 140) };
      p.answer = p.question ? String(d.answer || '').slice(0, 160) : '';
      if (p.question) p.parsedLabel = p.label;
      return p;
    };
    const draftPieces = Array.isArray(draft.pieces) ? draft.pieces.slice(0, MAX_PIECES) : [];
    const state = {
      step: 1,
      pieces: draftPieces.length ? draftPieces.map(fromDraft) : [newPiece()],
      activeId: null,
      parsedFor: null,     // key of the lines `parsed` was made from
      parsed: null,        // last parse result applied (saved with the submission)
      prefetch: null,      // {key, promise} for the parse in flight
      combine: false,      // combine lines the parser grouped into one mart
      // A reference points at a piece id (null = not sure). Drafts don't keep
      // that link: piece ids are new on every load.
      boards: Array.isArray(draft.boards) ? draft.boards.filter(b => b && b.url).slice(0, MAX_BOARDS).map(b => ({ url: b.url, piece: null })) : [],
      email: draft.email || '',
      photos: [],          // {blob, url, for}
      // Connect Pinterest: `state` is the link (sessionStorage only); picked boards are
      // {id, name, cover, piece}; `boards` is the account's list once loaded.
      pin: { state: null, username: null, boards: null, picked: [], waiting: false, done: null },
      sending: false
    };
    state.activeId = state.pieces[0].id;
    const TOTAL = 3;

    root.classList.add('mk');
    root.innerHTML = `
      <div class="mk-progress" data-progress>
        <span class="mk-mono" data-step-label>New mart · 01 / 0${TOTAL}</span>
        <div class="mk-bar" aria-hidden="true"><span class="is-on"></span>${'<span></span>'.repeat(TOTAL - 1)}</div>
      </div>

      <form class="mk-step" data-step="1" novalidate>
        <h2 class="mk-title" tabindex="-1">What are you shopping for?</h2>
        <p class="mk-sub">Tell us what you’re looking for. We’ll build your personal mart and email your first finds within 48 hours.</p>
        <div class="mk-rows" data-rows></div>
        <button type="button" class="mk-addrow" data-add-row>+ Add another mart</button>
        <p class="mk-error" data-rows-err role="alert"></p>
        <div data-combine></div>
        <p class="mk-undo" data-undo-bar hidden role="status">Cleared. <button type="button" class="mk-edit" data-undo>Undo</button></p>
        <div class="mk-actions"><button class="mk-back" type="button" data-reset hidden>Start over</button><button class="mk-button" type="submit" data-next1>Next</button></div>
      </form>

      <form class="mk-step" data-step="2" novalidate hidden>
        <h2 class="mk-title" tabindex="-1">Show us what you like</h2>
        <p class="mk-sub">Add photos or Pinterest boards.</p>
        <div class="mk-field">
          <div class="mk-label mk-mono"><span>Photos</span><span class="mk-opt">Up to ${MAX_PHOTOS}</span></div>
          <div class="mk-photos" data-photos></div>
          <p class="mk-error" data-photo-err role="alert"></p>
        </div>
        <div class="mk-field">
          <div class="mk-label mk-mono"><span>Pinterest boards</span><span class="mk-opt">Up to ${MAX_BOARDS}</span></div>
          <div class="mk-connect" data-pin-connect>
            <button type="button" class="mk-pin-btn" data-pin-btn><svg class="mk-pin-logo" aria-hidden="true" focusable="false" fill="currentColor" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z"/></svg><span data-pin-btn-label>Connect Pinterest</span></button>
          </div>
          <p class="mk-pin-msg" data-pin-msg role="status" hidden></p>
          <ul class="mk-list mk-picked" data-picked hidden></ul>
          <button type="button" class="mk-edit mk-pin-edit" data-pin-edit hidden>Edit boards</button>
          <ul class="mk-list" data-boards></ul>
          <details class="mk-paste" data-paste-board>
            <summary>Or paste a public board link</summary>
            <div class="mk-adder" data-board-adder>
              <input class="mk-input" id="${id}-pin" type="url" inputmode="url" autocomplete="off" placeholder="pinterest.com/yourname/board" aria-label="Public Pinterest board link" aria-describedby="${id}-pin-err">
              <button class="mk-add" type="button" data-add-board>Add</button>
            </div>
            <p class="mk-error" id="${id}-pin-err" role="alert"></p>
          </details>
        </div>
        <div class="mk-actions"><button class="mk-back" type="button" data-back>← Back</button><button class="mk-button" type="submit" data-next2>Skip for now</button></div>
      </form>

      <form class="mk-step" data-step="3" novalidate hidden>
        <h2 class="mk-title" tabindex="-1">Where should we send your mart?</h2>
        <p class="mk-sub">We’ll email your mart link within 48 hours.</p>
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
      </section>

      <div class="mk-sheet" data-pin-sheet hidden role="dialog" aria-modal="true" aria-labelledby="${id}-pin-title">
        <div class="mk-sheet-panel">
          <div class="mk-sheet-head"><h3 class="mk-sheet-title" id="${id}-pin-title" tabindex="-1">Your Pinterest boards</h3>
            <button type="button" class="mk-x" data-pin-close aria-label="Close">×</button></div>
          <p class="mk-note mk-sheet-count" data-pin-count></p>
          <div class="mk-board-grid" data-pin-grid></div>
          <div class="mk-sheet-foot"><button class="mk-button" type="button" data-pin-done>Done</button></div>
        </div>
      </div>`;

    const $ = sel => root.querySelector(sel);
    const steps = { 1: $('[data-step="1"]'), 2: $('[data-step="2"]'), 3: $('[data-step="3"]'), done: $('[data-step="done"]') };
    const STEP_NAMES = { 1: 'lines', 2: 'references', 3: 'email', done: 'done' };
    const rowsEl = $('[data-rows]');
    const rowsErr = $('[data-rows-err]');
    const addRowBtn = $('[data-add-row]');
    const combineEl = $('[data-combine]');
    const pin = $(`#${id}-pin`);
    const email = $(`#${id}-email`);
    const photosEl = $('[data-photos]');
    const photoErr = $('[data-photo-err]');
    const boardsEl = $('[data-boards]');
    const boardAdder = $('[data-board-adder]');
    const pasteBoard = $('[data-paste-board]');
    const next1 = $('[data-next1]');
    const next2 = $('[data-next2]');
    const submitBtn = $('[data-submit]');
    const progress = $('[data-progress]');

    email.value = state.email;

    const err = (input, msg) => {
      const el = root.querySelector(`#${input.getAttribute('aria-describedby')}`);
      el.textContent = msg || '';
      input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    };
    const snapshot = () => ({
      pieces: state.pieces.map(p => ({ label: p.label, price: p.price, manual: p.manual, answer: p.answer, question: p.question })),
      boards: state.boards, email: state.email
    });
    const resetBtn = $('[data-reset]');
    const undoBar = $('[data-undo-bar]');
    const hasContent = () => state.pieces.some(p => p.label.trim() || p.price != null) || state.boards.length || state.pin.picked.length || state.photos.length || state.email.trim();
    const save = () => { store.set(snapshot()); resetBtn.hidden = !hasContent(); };
    const filled = () => state.pieces.filter(p => p.label.trim());
    // Each line's mart, as the id of the piece that heads it.
    const finalGroups = () => state.pieces.map(p => (state.combine && state.pieces.some(x => x.id === p.group) ? p.group : p.id));
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
      if (step === 1) regrow();
      const scroller = root.closest('.mk-dialog');
      if (scroller) scroller.scrollTop = 0;
      else window.scrollTo(0, 0);
      track('make_step', { step: String(step), step_name: STEP_NAMES[step], placement });
    }

    // ---- Step 1: one line per thing; price and detail chips live inside each line.
    const pieceOf = el => state.pieces.find(p => p.id === el.closest('[data-piece]')?.dataset.piece);
    const rowEl = p => rowsEl.querySelector(`[data-piece="${p.id}"]`);
    // Measured while hidden (the popup before it opens) scrollHeight is 0; setting
    // that would collapse the box to a sliver, so leave it at its CSS height and
    // measure again once it's on screen (see regrow).
    const grow = ta => {
      ta.style.height = 'auto';
      if (ta.scrollHeight) ta.style.height = `${ta.scrollHeight}px`;
    };
    const regrow = () => rowsEl.querySelectorAll('[data-label]').forEach(grow);

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
      const fresh = p.line && p.parsedLabel === p.label.trim() ? p.line : null;
      const details = detailsFor(p.label, fresh && fresh.kind, p.question ? p.question.text : '');
      if (!details.length) return '';
      return `<div class="mk-label mk-mono"><span>Add details</span><span class="mk-opt">Tap again to remove</span></div>
        <div class="mk-chips">${details.map(d => {
          const on = hasPhrase(p.label, d);
          return `<button type="button" class="mk-chip" data-detail="${esc(d)}" aria-pressed="${on}"><span aria-hidden="true">${on ? '✓' : '+'}</span> ${esc(d)}</button>`;
        }).join('')}</div>`;
    }
    // The parser's one follow-up for a line, answered right under it.
    function questionHTML(p) {
      if (!p.question) return '';
      const qid = `${id}-${p.id}-a`;
      return `<label class="mk-q" for="${qid}"><span class="mk-q-text">${esc(p.question.text)}</span><span class="mk-opt mk-mono">Optional</span></label>
        <input class="mk-q-input" id="${qid}" data-answer type="text" maxlength="160" autocomplete="off" enterkeyhint="done" placeholder="${esc(p.question.placeholder)}" value="${esc(p.answer)}">`;
    }
    function syncQuestion(p) {
      const slot = rowEl(p)?.querySelector('[data-q-slot]');
      if (!slot) return;
      const sig = p.question ? p.question.text : '';
      if (slot.dataset.sig === sig) return;
      // Never swap the box out from under someone typing in it.
      if (slot.contains(document.activeElement)) return;
      slot.dataset.sig = sig;
      slot.innerHTML = questionHTML(p);
    }
    function syncRow(p) {
      const el = rowEl(p);
      if (!el) return;
      const isActive = p.id === state.activeId;
      el.classList.toggle('is-active', isActive);
      const opener = el.querySelector('[data-open-piece]');
      opener.hidden = isActive;
      opener.setAttribute('aria-expanded', String(isActive));
      el.querySelector('[data-collapsed-label]').textContent = p.label.trim() || 'Untitled mart';
      el.querySelector('[data-collapsed-price]').textContent = money(p.price);
      el.querySelector('[data-piece-editor]').hidden = !isActive;
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
          <button type="button" class="mk-row-summary" data-open-piece aria-expanded="false" aria-controls="${id}-${p.id}-editor">
            <span class="mk-summary-copy"><span class="mk-mono mk-summary-number">Mart ${i + 1}</span><span class="mk-summary-label" data-collapsed-label></span><span class="mk-summary-price" data-collapsed-price></span></span>
            <span class="mk-summary-arrow" aria-hidden="true">⌄</span>
          </button>
          <div id="${id}-${p.id}-editor" data-piece-editor>
          <div class="mk-row-top">
            ${many ? `<span class="mk-row-n mk-mono" aria-hidden="true">Mart ${i + 1}</span>` : ''}
            <textarea class="mk-row-input" data-label rows="1" maxlength="${LABEL_MAX}" aria-label="Mart ${i + 1}: what you're shopping for" placeholder="${esc(i === 0 ? (HOOKS[hook] || PLACEHOLDER) : NEXT_PLACEHOLDER)}">${esc(p.label)}</textarea>
            ${many ? `<button type="button" class="mk-x" data-remove-piece aria-label="Remove line ${i + 1}">×</button>` : ''}
          </div>
          <div class="mk-counter mk-mono" data-counter hidden></div>
          <div class="mk-row-q" data-q-slot>${questionHTML(p)}</div>
          <div class="mk-row-body">
            <div data-price-slot>${priceHTML(p, i)}</div>
            <div class="mk-row-chips" data-row-chips hidden></div>
          </div>
          </div>
        </div>`).join('');
      state.pieces.forEach(p => { rowEl(p).querySelector('[data-q-slot]').dataset.sig = p.question ? p.question.text : ''; syncRow(p); });
      regrow();
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
      grow(rowEl(p).querySelector('[data-label]'));
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
      if (e.target.matches('[data-answer]')) {
        pieceOf(e.target).answer = e.target.value;
        renderCombine();
        save();
        return;
      }
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
      if (!p.label.trim() && !p.answer.trim()) { p.question = null; syncQuestion(p); }
      priceFromText(p);
      // Chips live outside the text box, so redrawing them doesn't disturb typing.
      syncRow(p);
      save();
    });
    rowsEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches('[data-custom], [data-answer]')) { e.preventDefault(); e.target.blur(); return; }
      // Enter in a line = next line, like a list.
      if (e.key !== 'Enter' || !e.target.matches('[data-label]') || e.shiftKey) return;
      e.preventDefault();
      const p = pieceOf(e.target);
      if (!p.label.trim()) return;
      const after = state.pieces[state.pieces.indexOf(p) + 1];
      if (after) { setActive(after); rowEl(after).querySelector('[data-label]').focus(); }
      else addRow();
    });
    rowsEl.addEventListener('focusin', e => { if (!e.target.closest('[data-open-piece]')) setActive(pieceOf(e.target)); });
    rowsEl.addEventListener('click', e => {
      const p = pieceOf(e.target);
      if (!p) return;
      setActive(p);
      if (e.target.closest('[data-open-piece]')) {
        rowEl(p).querySelector('[data-label]').focus({ preventScroll: true });
        return;
      }
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
      state.pieces = d.pieces.length ? d.pieces.map(fromDraft) : [newPiece()];
      state.activeId = state.pieces[0].id;
      state.boards = d.boards.map(b => ({ ...b })); state.email = d.email;
      email.value = state.email; pin.value = '';
      state.parsedFor = null; state.parsed = null; state.prefetch = null; state.combine = false;
      if (!d.pieces.length) { state.pin.picked = []; }
      rowsErr.textContent = '';
      renderRows();
      renderRefs();
      save();
    }
    resetBtn.addEventListener('click', () => {
      undoData = { ...snapshot(), photos: state.photos };
      state.photos = [];
      applyDraft({ pieces: [], boards: [], email: '' });
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
    // Parse on a pause in typing or on leaving a line, never on Next: each line's
    // follow-up appears right under it, and the combine offer under the list.
    const labelsKey = labels => JSON.stringify(labels);
    const parseable = () => filled().filter(p => p.label.trim().length >= 3);
    function parseFor(labels) {
      const key = labelsKey(labels);
      if (!state.prefetch || state.prefetch.key !== key) state.prefetch = { key, promise: fetchParse(labels) };
      return state.prefetch.promise;
    }
    // Apply a result to the lines it was made from. A line that changed since
    // keeps what it had; a question someone already answered is never replaced.
    function applyParse(pieces, labels, result) {
      if (!result) return;
      pieces.forEach((p, i) => {
        if (!state.pieces.includes(p) || cap(p.label.trim()) !== labels[i]) return;
        const line = result.lines[i] || null;
        p.line = line;
        p.parsedLabel = p.label.trim();
        if (!p.answer.trim()) p.question = line ? line.question : null;
        p.group = p.id;
        syncQuestion(p);
        syncRow(p);
      });
      result.groups.forEach(g => {
        if ((g.confidence ?? 1) < COMBINE_MIN_CONFIDENCE) return;
        const members = g.lines.map(i => pieces[i]).filter(p => p && state.pieces.includes(p) && p.parsedLabel === p.label.trim());
        if (members.length > 1) members.forEach(p => { p.group = members[0].id; });
      });
      if (labelsKey(filled().map(p => cap(p.label.trim()))) === labelsKey(labels)) {
        state.parsed = result;
        state.parsedFor = labelsKey(labels);
      }
      renderCombine();
    }
    function runParse() {
      const pieces = parseable();
      const labels = pieces.map(p => cap(p.label.trim()));
      if (!labels.length) return Promise.resolve();
      return parseFor(labels).then(result => applyParse(pieces, labels, result));
    }
    let parseTimer = 0;
    function scheduleParse(delay) {
      clearTimeout(parseTimer);
      parseTimer = setTimeout(runParse, delay);
    }
    rowsEl.addEventListener('input', e => { if (e.target.matches('[data-label]')) scheduleParse(1200); });
    rowsEl.addEventListener('focusout', e => { if (e.target.matches('[data-label]')) scheduleParse(0); });

    // What a line says about where/when, from the parse facts or the person's answer.
    function factOf(p, key, re) {
      const fromFacts = p.line && p.parsedLabel === p.label.trim() && p.line.facts && p.line.facts[key];
      if (fromFacts) return String(fromFacts).toLowerCase();
      const m = p.answer.toLowerCase().match(re);
      return m ? m[0].toLowerCase() : null;
    }
    const conflicts = set => ['dates', 'destination'].some(key => {
      const vals = set.map(p => factOf(p, key, key === 'dates' ? MONTHS : PLACES)).filter(Boolean);
      return new Set(vals).size > 1;
    });
    // Lines the parser thinks are one thing, while nothing contradicts it: once two
    // trips turn out to have different dates or places, the offer goes away.
    function sharedSets() {
      const live = filled();
      const keys = [...new Set(live.map(p => p.group))];
      return keys.map(k => live.filter(p => p.group === k)).filter(set => set.length > 1 && !conflicts(set));
    }
    function renderCombine() {
      const shared = sharedSets();
      if (!shared.length) state.combine = false;
      // Ask, don't assert: the parser's grouping is a guess.
      const allTrips = shared.every(set => set.every(p => kindsOf(p.label, p.line && p.line.kind).some(k => k.kind === 'trip')));
      combineEl.innerHTML = !shared.length ? '' : `
        <div class="mk-split" role="radiogroup" aria-label="Combine lines">
          <p class="mk-split-q"><span class="mk-split-h">${allTrips ? 'Same trip?' : 'Same thing?'}</span>
            ${shared.map(set => set.map(p => `<strong>${esc(cap(p.label.trim()))}</strong>`).join(' and ')).join('; ')}.
            Combined, it’s one mart, and each line’s budget still applies to the pieces we find for that line.</p>
          <button type="button" class="mk-seg" role="radio" data-combine-choice="0" aria-checked="${!state.combine}">Keep separate</button>
          <button type="button" class="mk-seg" role="radio" data-combine-choice="1" aria-checked="${state.combine}">Combine into one mart</button>
        </div>`;
    }
    combineEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-combine-choice]');
      if (!btn) return;
      state.combine = btn.dataset.combineChoice === '1';
      combineEl.querySelectorAll('[data-combine-choice]').forEach(b => b.setAttribute('aria-checked', String(b === btn)));
      track('make_combine', { choice: state.combine ? 'combine' : 'separate' });
    });

    steps[1].addEventListener('submit', e => {
      e.preventDefault();
      const rows = filled();
      if (!rows.length) { rowsErr.textContent = 'Tell us at least one thing you’re shopping for.'; setActive(state.pieces[0]); rowEl(state.pieces[0]).querySelector('[data-label]').focus(); return; }
      const short = rows.find(p => p.label.trim().length < 3);
      if (short) { rowsErr.textContent = 'Add a few more words to that mart.'; setActive(short); rowEl(short).querySelector('[data-label]').focus(); return; }
      state.pieces = rows;
      state.pieces.forEach(p => {
        const trimmed = cap(p.label.trim());
        if (p.parsedLabel === p.label.trim()) p.parsedLabel = trimmed;
        p.label = trimmed;
      });
      if (!state.pieces.some(p => p.id === state.activeId)) state.activeId = state.pieces[0].id;
      // Don't wait on the parse here; submit catches up with it.
      clearTimeout(parseTimer);
      runParse();
      renderRows();
      renderCombine();
      rowsErr.textContent = '';
      save();
      renderRefs();
      show(2);
    });
    renderRows();
    renderCombine();
    resetBtn.hidden = !hasContent();

    // ---- Step 2: references, each tagged to a mart (by the id of the line heading it)
    const marts = () => martsOf();
    const martLabel = set => set.map(p => p.label).join(' + ');
    // With several marts, a reference defaults to "Not sure": it isn't counted
    // toward any mart, and gets matched to a line during review (later, by the
    // background job). "For all" used to leak a board into every mart.
    function forSelect(value, attr, label) {
      const ms = marts();
      if (ms.length < 2) return '';
      return `<select class="mk-for" ${attr} aria-label="${esc(label)}">
        <option value="">Not sure, match it for me</option>
        ${ms.map(set => `<option value="${set[0].id}" ${value === set[0].id ? 'selected' : ''}>For ${esc(clip(martLabel(set), 26))}</option>`).join('')}
      </select>`;
    }
    const pinValid = () => Boolean(normalizeBoard(pin.value));
    const boardsUsed = () => state.boards.length + state.pin.picked.length;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const syncNext2 = () => { next2.textContent = state.photos.length || boardsUsed() || pinValid() ? 'Next' : 'Skip for now'; };
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
      syncNext2();
    }
    function renderBoards() {
      boardsEl.innerHTML = state.boards.map((b, i) => `
        <li class="mk-list-row"><span class="mk-list-text">${esc(b.url.replace(/^https?:\/\/(www\.)?/, ''))}</span>
          ${forSelect(b.piece, `data-board-for="${i}"`, `Which mart is board ${i + 1} for?`)}
          <button type="button" class="mk-x" data-remove-board="${i}" aria-label="Remove board ${i + 1}">×</button></li>`).join('');
      boardsEl.hidden = !state.boards.length;
      boardAdder.hidden = boardsUsed() >= MAX_BOARDS;
      renderPicked();
      syncNext2();
    }
    function renderRefs() {
      // Drop tags that point at a mart that no longer exists.
      const valid = new Set(marts().map(set => set[0].id));
      state.photos.forEach(p => { if (!valid.has(p.for)) p.for = null; });
      state.boards.forEach(b => { if (!valid.has(b.piece)) b.piece = null; });
      state.pin.picked.forEach(b => { if (!valid.has(b.piece)) b.piece = null; });
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
      if (sel) { state.photos[+sel.dataset.photoFor].for = sel.value || null; return; }
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
      if (!url) { pasteBoard.open = true; err(pin, 'That doesn’t look like a Pinterest link. Paste the board’s address.'); pin.focus(); return false; }
      if (boardsUsed() >= MAX_BOARDS) { err(pin, `That’s the limit of ${MAX_BOARDS} boards.`); return false; }
      if (!state.boards.some(b => b.url === url)) state.boards.push({ url, piece: null });
      pin.value = '';
      err(pin, '');
      save();
      renderBoards();
      track('make_board', { count: String(state.boards.length) });
      track('board_url_pasted');
      return true;
    }
    $('[data-add-board]').addEventListener('click', () => { if (addBoardFromInput() && !boardAdder.hidden) pin.focus(); });
    pin.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (addBoardFromInput() && !boardAdder.hidden) pin.focus(); } });
    pin.addEventListener('input', () => { err(pin, ''); syncNext2(); });
    boardsEl.addEventListener('change', e => {
      const sel = e.target.closest('[data-board-for]');
      if (sel) { state.boards[+sel.dataset.boardFor].piece = sel.value || null; save(); }
    });
    boardsEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-remove-board]');
      if (!btn) return;
      state.boards.splice(+btn.dataset.removeBoard, 1);
      save();
      renderBoards();
      (pasteBoard.open ? pin : pasteBoard.querySelector('summary')).focus();
    });
    // ---- Connect Pinterest (step 2). Popup first: the form never leaves the page, so
    // photos and lines stay put. The popup's callback page records the outcome against
    // `state`; we poll for it (Pinterest's COOP can cut window.opener, so postMessage is
    // only a nudge to poll sooner). Blocked popup -> full redirect, draft restored on return.
    const pinBtn = $('[data-pin-btn]');
    const pinMsgEl = $('[data-pin-msg]');
    const pickedEl = $('[data-picked]');
    const pinEditBtn = $('[data-pin-edit]');
    const sheet = $('[data-pin-sheet]');
    const sheetGrid = $('[data-pin-grid]');
    const sheetCount = $('[data-pin-count]');
    const session = {
      get() { try { return JSON.parse(sessionStorage.getItem(PIN_KEY)) || null; } catch (_) { return null; } },
      set(v) { try { sessionStorage.setItem(PIN_KEY, JSON.stringify(v)); } catch (_) {} },
      clear() { try { sessionStorage.removeItem(PIN_KEY); } catch (_) {} }
    };
    const pinSave = (extra = {}) => session.set({
      state: state.pin.state, username: state.pin.username, placement,
      picked: state.pin.picked.map(b => ({ id: b.id, name: b.name, cover: b.cover })), ...extra
    });
    function pinMsg(text, retry = false) {
      pinMsgEl.hidden = !text;
      pinMsgEl.textContent = text || '';
      if (retry) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'mk-edit'; b.textContent = 'Try again';
        b.addEventListener('click', connectPinterest);
        pinMsgEl.append(' ', b);
      }
    }
    const httpsUrl = v => (typeof v === 'string' && /^https:\/\//.test(v) ? v : null);
    function renderPicked() {
      pickedEl.innerHTML = state.pin.picked.map((b, i) => `
        <li class="mk-list-row mk-picked-row">${httpsUrl(b.cover) ? `<img class="mk-picked-cover" src="${esc(b.cover)}" alt="" referrerpolicy="no-referrer">` : '<span class="mk-picked-cover" aria-hidden="true"></span>'}
          <span class="mk-list-text">${esc(b.name)}</span>
          ${forSelect(b.piece, `data-picked-for="${i}"`, `Which mart is the board ${b.name} for?`)}
          <button type="button" class="mk-x" data-remove-picked="${i}" aria-label="Remove board ${esc(b.name)}">×</button></li>`).join('');
      pickedEl.hidden = !state.pin.picked.length;
      pinEditBtn.hidden = !(state.pin.state && state.pin.done === 'connected');
      if (IN_APP) {
        $('[data-pin-connect]').hidden = true;
        if (!state.pin.picked.length) pinMsg('To connect Pinterest, open this page in Safari or Chrome. Or paste a board link below.');
      } else {
        $('[data-pin-connect]').hidden = state.pin.done === 'connected';
      }
    }
    pickedEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-remove-picked]');
      if (!btn) return;
      state.pin.picked.splice(+btn.dataset.removePicked, 1);
      pinSave();
      renderBoards();
    });
    pickedEl.addEventListener('change', e => {
      const sel = e.target.closest('[data-picked-for]');
      if (sel) state.pin.picked[+sel.dataset.pickedFor].piece = sel.value || null;
    });

    let pollTimer = 0;
    let pollUntil = 0;
    let pinPopup = null;
    let pinAuthUrl = null;
    let hintTimer = 0;
    function setWaiting(on) {
      state.pin.waiting = on;
      pinBtn.disabled = on;
      $('[data-pin-btn-label]').textContent = on ? 'Waiting for Pinterest…' : 'Connect Pinterest';
      if (!on) { clearTimeout(pollTimer); pollTimer = 0; clearTimeout(hintTimer); }
    }
    // Pinterest's login often drops the access request and lands people on their feed
    // (seen 2026-11-10). Once they're logged in, opening the same link again goes straight
    // to "Give access", so offer exactly that, plus a way out.
    function showWaitingHelp() {
      if (!state.pin.waiting || !pinAuthUrl) return;
      pinMsg('Logged in but ended up on your Pinterest feed? ');
      const again = document.createElement('button');
      again.type = 'button'; again.className = 'mk-edit'; again.textContent = 'Open Pinterest again';
      again.addEventListener('click', () => {
        // Synchronous, inside the tap: reuses the same named window (or opens one).
        pinPopup = window.open(pinAuthUrl, 'eura_pinterest', 'popup,width=520,height=760') || pinPopup;
        track('pinterest_reopen');
      });
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.className = 'mk-edit'; cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        setWaiting(false);
        try { pinPopup && !pinPopup.closed && pinPopup.close(); } catch (_) {}
        pinMsg('');
        track('pinterest_oauth_cancelled', { where: 'form' });
      });
      pinMsgEl.append(again, ' · ', cancel);
    }
    async function connectPinterest() {
      if (state.pin.waiting) return;
      track('pinterest_connect_clicked', { placement });
      if (IN_APP) { track('inapp_browser_blocked'); renderPicked(); return; }
      pinMsg('');
      // Open synchronously inside the tap, or iOS blocks it; point it at Pinterest after /start.
      pinPopup = STUB ? null : window.open('', 'eura_pinterest', 'popup,width=520,height=760');
      const mode = STUB || pinPopup ? 'popup' : 'redirect';
      if (pinPopup) { try { pinPopup.document.title = 'Connecting Pinterest…'; pinPopup.document.body.textContent = 'Opening Pinterest…'; } catch (_) {} }
      setWaiting(true);
      try {
        let data;
        if (STUB) {
          data = { state: `stub-${Date.now()}`, authorize_url: null };
        } else {
          const res = await fetch(`${PINTEREST_API}/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
            body: JSON.stringify({ mode, return_to: placement === 'popup' ? 'popup' : 'page' })
          });
          if (!res.ok) throw new Error(`status_${res.status}`);
          data = ((await res.json()) || {}).data || {};
          const okUrl = /^https:\/\/www\.pinterest\.com\//.test(data.authorize_url || '') || (PIN_API_OVERRIDE && (data.authorize_url || '').startsWith(API_ORIGIN));
          if (!data.state || !okUrl) throw new Error('shape');
        }
        state.pin = { ...state.pin, state: data.state, boards: null, done: null };
        if (mode === 'redirect') {
          // Popup blocked: the page itself goes to Pinterest. The draft (lines, budgets,
          // links, email) is in localStorage; photos can't survive, so remember the count.
          pinSave({ returning: true, photos: state.photos.length });
          save();
          location.assign(data.authorize_url);
          return;
        }
        pinSave();
        if (STUB) { setTimeout(() => onPinOutcome('connected'), 400); return; }
        pinPopup.location.href = data.authorize_url;
        pinAuthUrl = data.authorize_url;
        pinMsg('Finish in the Pinterest window. Your form stays here.');
        clearTimeout(hintTimer);
        hintTimer = setTimeout(showWaitingHelp, 8000);
        pollUntil = Date.now() + PIN_WAIT_MS;
        pollTimer = setTimeout(pollStatus, 2000);
      } catch (_) {
        try { pinPopup && pinPopup.close(); } catch (_) {}
        setWaiting(false);
        track('pinterest_oauth_failed', { reason: 'start' });
        pinMsg('We couldn’t reach Pinterest just now. Paste a board link below, or', true);
      }
    }
    async function pollStatus() {
      clearTimeout(pollTimer);
      if (!state.pin.waiting || !state.pin.state) return;
      try {
        const res = await fetch(`${PINTEREST_API}/status`, { headers: { 'X-Pinterest-State': state.pin.state }, cache: 'no-store' });
        if (res.status === 404) { onPinOutcome('failed'); return; }
        const st = (((await res.json()) || {}).data || {}).status;
        if (st && st !== 'pending') { onPinOutcome(st); return; }
      } catch (_) {}
      if (Date.now() < pollUntil) pollTimer = setTimeout(pollStatus, 2000);
      else { setWaiting(false); pinMsg('Pinterest didn’t finish connecting.', true); }
    }
    function onPinOutcome(outcome) {
      if (state.pin.done && state.pin.done === outcome) return;
      setWaiting(false);
      state.pin.done = outcome;
      try { pinPopup && !pinPopup.closed && pinPopup.close(); } catch (_) {}
      if (outcome === 'connected') {
        track('pinterest_oauth_completed', { placement });
        pinMsg('');
        pinSave();
        renderPicked();
        openPicker();
        return;
      }
      state.pin.state = null;
      session.clear();
      if (outcome === 'denied') {
        track('pinterest_oauth_cancelled');
        pinMsg('Pinterest wasn’t connected. That’s fine: paste a board link below, or', true);
      } else {
        track('pinterest_oauth_failed', { reason: outcome });
        pinMsg('We couldn’t connect Pinterest. Paste a board link below, or', true);
      }
      renderPicked();
    }
    window.addEventListener('message', e => {
      if (e.origin === API_ORIGIN && e.data && e.data.type === 'eura-pinterest' && state.pin.waiting) pollStatus();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.pin.waiting) pollStatus(); });
    pinBtn.addEventListener('click', connectPinterest);
    pinEditBtn.addEventListener('click', openPicker);

    // ---- The board picker
    let sheetOpener = null;
    const STUB_BOARDS = [
      { id: '9001', name: 'Fall fits', pin_count: 42, privacy: 'PUBLIC', cover: null },
      { id: '9002', name: 'Rings and chains', pin_count: 12, privacy: 'SECRET', cover: null },
      { id: '9003', name: 'Denim', pin_count: 88, privacy: 'PUBLIC', cover: null }
    ];
    async function loadBoards() {
      if (STUB) return { username: 'stub.user', boards: STUB_BOARDS };
      const res = await fetch(`${PINTEREST_API}/boards`, { headers: { 'X-Pinterest-State': state.pin.state }, cache: 'no-store' });
      if (res.status === 404) throw Object.assign(new Error('expired'), { expired: true });
      if (!res.ok) throw new Error(`status_${res.status}`);
      return ((await res.json()) || {}).data || {};
    }
    function sheetNote() {
      const left = MAX_BOARDS - boardsUsed();
      sheetCount.textContent = state.pin.picked.length
        ? `${plural(state.pin.picked.length, 'board')} chosen. ${left ? `You can add ${left} more.` : `That’s the limit of ${MAX_BOARDS}.`}`
        : `Choose up to ${MAX_BOARDS - state.boards.length}.`;
    }
    function renderSheet() {
      const boards = state.pin.boards || [];
      if (!boards.length) {
        sheetGrid.innerHTML = '<p class="mk-note">No boards on this Pinterest account yet. Add photos instead, or paste a board link.</p>';
        sheetCount.textContent = '';
        return;
      }
      sheetGrid.innerHTML = boards.map(b => {
        const on = state.pin.picked.some(x => x.id === b.id);
        const cover = httpsUrl(b.cover);
        return `<button type="button" class="mk-board" data-board-id="${esc(b.id)}" aria-pressed="${on}">
          <span class="mk-board-cover">${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<b aria-hidden="true">${esc((b.name || '·').charAt(0).toUpperCase())}</b>`}<span class="mk-board-check" aria-hidden="true">✓</span></span>
          <span class="mk-board-name">${esc(b.name)}</span>
          <span class="mk-board-meta mk-mono">${b.pin_count != null ? plural(b.pin_count, 'pin') : ''}${b.privacy === 'SECRET' ? ' · Secret' : ''}</span>
        </button>`;
      }).join('');
      sheetNote();
    }
    async function openPicker() {
      sheetOpener = document.activeElement;
      sheet.hidden = false;
      document.body.classList.add('mk-locked');
      $('.mk-sheet-title').focus({ preventScroll: true });
      if (state.pin.boards) { renderSheet(); return; }
      sheetGrid.innerHTML = '<p class="mk-note">Loading your boards…</p>';
      sheetCount.textContent = '';
      try {
        const data = await loadBoards();
        state.pin.username = data.username || null;
        state.pin.boards = Array.isArray(data.boards) ? data.boards : [];
        pinSave();
        renderSheet();
      } catch (e) {
        if (e.expired) {
          closePicker();
          state.pin = { ...state.pin, state: null, done: null, boards: null };
          session.clear();
          renderPicked();
          pinMsg('Your Pinterest connection expired. Connect again, or paste a board link below.', true);
          return;
        }
        sheetGrid.innerHTML = '';
        const p = document.createElement('p');
        p.className = 'mk-note';
        p.textContent = 'We couldn’t load your boards. ';
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'mk-edit'; b.textContent = 'Try again';
        b.addEventListener('click', openPicker);
        p.append(b, ' Or close this and paste a board link.');
        sheetGrid.append(p);
        track('pinterest_oauth_failed', { reason: 'boards' });
      }
    }
    function closePicker() {
      if (sheet.hidden) return;
      sheet.hidden = true;
      if (!root.closest('dialog[open]')) document.body.classList.remove('mk-locked');
      renderBoards();
      (sheetOpener && sheetOpener.isConnected ? sheetOpener : pinEditBtn).focus?.();
    }
    sheetGrid.addEventListener('click', e => {
      const btn = e.target.closest('[data-board-id]');
      if (!btn) return;
      const b = (state.pin.boards || []).find(x => x.id === btn.dataset.boardId);
      if (!b) return;
      const i = state.pin.picked.findIndex(x => x.id === b.id);
      if (i >= 0) state.pin.picked.splice(i, 1);
      else if (boardsUsed() >= MAX_BOARDS) { sheetCount.textContent = `That’s the limit of ${MAX_BOARDS} boards in total. Remove one to add another.`; return; }
      else state.pin.picked.push({ id: b.id, name: b.name, cover: httpsUrl(b.cover), piece: null });
      btn.setAttribute('aria-pressed', String(i < 0));
      pinSave();
      sheetNote();
    });
    $('[data-pin-done]').addEventListener('click', () => {
      track('boards_selected', { count: String(state.pin.picked.length) });
      closePicker();
    });
    $('[data-pin-close]').addEventListener('click', closePicker);
    sheet.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); } });
    sheet.addEventListener('click', e => { if (e.target === sheet) closePicker(); });

    steps[2].addEventListener('submit', e => {
      e.preventDefault();
      // A link typed but not added still counts; a bad one blocks with the error shown.
      if (!addBoardFromInput()) return;
      submitBtn.textContent = buildLabel();
      show(3);
    });
    renderRefs();

    (function restorePinterest() {
      const saved = session.get();
      const outcome = params.get('pinterest');
      if (!saved || saved.placement !== placement || !saved.state) {
        if (outcome) history.replaceState(null, '', location.pathname + (placement === 'popup' ? '#make' : ''));
        return;
      }
      state.pin.state = saved.state;
      state.pin.username = saved.username || null;
      state.pin.picked = (Array.isArray(saved.picked) ? saved.picked : []).slice(0, MAX_BOARDS)
        .filter(b => b && /^[0-9]{1,30}$/.test(String(b.id)))
        .map(b => ({ id: String(b.id), name: String(b.name || 'Pinterest board').slice(0, 200), cover: httpsUrl(b.cover), piece: null }));
      if (!outcome && !saved.returning) { state.pin.done = 'connected'; renderBoards(); return; }
      // Back from Pinterest via the redirect fallback.
      history.replaceState(null, '', location.pathname + (placement === 'popup' ? '#make' : ''));
      session.set({ ...saved, returning: false });
      if (filled().length) {
        renderRefs();
        show(2);
        if (saved.photos > 0) photoErr.textContent = `Your ${saved.photos === 1 ? 'photo' : `${saved.photos} photos`} didn’t come back from Pinterest. Please add ${saved.photos === 1 ? 'it' : 'them'} again.`;
      }
      onPinOutcome(['connected', 'denied', 'failed'].includes(outcome) ? outcome : 'failed');
    })();

    // ---- Step 3: email + submit
    const buildLabel = () => (marts().length > 1 ? `Build my ${marts().length} marts` : 'Build my mart');
    email.addEventListener('input', () => { state.email = email.value; err(email, ''); save(); });
    steps[3].addEventListener('submit', async e => {
      e.preventDefault();
      if (state.sending) return;
      const address = email.value.trim();
      email.value = address;
      if (!address || !email.checkValidity()) { err(email, 'Enter an email address so we can send you your mart.'); email.focus(); return; }
      state.sending = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
      err(email, '');

      // The parse normally finished long ago; if Next beat it, wait for it here
      // (fetchParse gives up after PARSE_TIMEOUT) so review gets the structured brief.
      const labels = state.pieces.map(p => p.label);
      if (state.parsedFor !== labelsKey(labels)) await runParse();
      const groups = finalGroups();
      const indexOf = pid => { const i = state.pieces.findIndex(p => p.id === pid); return i < 0 ? null : i; };
      const body = new FormData();
      body.append('brief', labels.join('\n'));
      body.append('pieces', JSON.stringify(state.pieces.map((p, i) => ({
        label: p.label, group: indexOf(groups[i]) ?? i, max_price_usd: p.price,
        question: p.question ? p.question.text : null,
        answer: p.answer.trim() || null
      }))));
      body.append('boards', JSON.stringify(state.boards.map(b => ({ url: b.url, piece: b.piece ? indexOf(b.piece) : null }))));
      if (state.pin.state && state.pin.picked.length) {
        // The API reads these boards' pins with the link, then deletes the link.
        body.append('pinterest', JSON.stringify({
          state: state.pin.state, username: state.pin.username,
          boards: state.pin.picked.map(b => ({ id: b.id, name: b.name, piece: b.piece ? indexOf(b.piece) : null }))
        }));
      }
      state.photos.forEach((p, i) => body.append('references', p.blob, `reference-${i + 1}.jpg`));
      body.append('references_for', JSON.stringify(state.photos.map(p => (p.for ? indexOf(p.for) : null))));
      // The structured brief (kinds, facts, groups) is what gets curated from in review.
      if (state.parsed && state.parsedFor === labelsKey(labels)) body.append('parsed', JSON.stringify(state.parsed));
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
          try { if (res.ok && typeof window.fbq === 'function') window.fbq('track', 'Lead'); } catch (_) {}
        }
        store.clear();
        session.clear();
        const ms = marts();
        track('make_submit', { placement, hook: hook || 'none', pieces: String(state.pieces.length), marts: String(ms.length), photos: String(state.photos.length), boards: String(state.boards.length), picked_boards: String(state.pin.picked.length) });
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
    // A textarea sized while hidden (before the popup opened, or on another step)
    // gets measured again whenever line 1 comes into view, and when the width changes.
    let lastWidth = 0;
    window.addEventListener('resize', () => {
      if (root.offsetWidth === lastWidth) return;
      lastWidth = root.offsetWidth;
      if (state.step === 1) regrow();
    });

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

    const api = {
      focus: () => {
        if (state.step === 1) regrow();
        steps[state.step].querySelector('.mk-title').focus({ preventScroll: true });
      }
    };
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
