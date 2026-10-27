(() => {
  'use strict';
  document.documentElement.classList.add('js');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const desktopExpansion = matchMedia('(min-width: 901px) and (prefers-reduced-motion: no-preference)');
  let expansionReady = !desktopExpansion.matches;
  const saveData = Boolean(navigator.connection && navigator.connection.saveData);
  const event = (name, data = {}) => {
    if (typeof window.gtag === 'function') window.gtag('event', name, data);
  };
  const chapters = [...document.querySelectorAll('[data-playback]')].map(tv => {
    const video = tv.querySelector('video');
    const power = tv.querySelector('[data-power]');
    const replay = tv.querySelector('[data-replay]');
    const name = tv.dataset.chapter;
    const chapter = { tv, video, power, visible: false, on: true, viewed: false, started: false };
    const play = () => {
      if (document.hidden) return;
      video.muted = true;
      const result = video.play();
      if (result && result.catch) result.catch(() => {});
    };
    chapter.sync = () => {
      if (chapter.on && chapter.visible && !document.hidden && !reducedMotion.matches && !saveData && (name !== 'product' || chapter.started || expansionReady)) play();
      else video.pause();
    };
    if (name === 'product') {
      if (matchMedia('(max-width: 600px)').matches) video.poster = './assets/marts/demo-mobile-poster.jpg?v=mobile1';
      video.controls = false;
      video.tabIndex = 0;
      video.setAttribute('role', 'button');
      const label = () => video.setAttribute('aria-label', `${video.paused ? 'Play' : 'Pause'} product demo`);
      const toggle = () => {
        chapter.on = video.paused;
        if (chapter.on) play();
        else video.pause();
        label();
      };
      video.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        toggle();
      });
      video.addEventListener('play', () => { chapter.started = true; label(); });
      video.addEventListener('pause', label);
      label();
    }
    const updatePowerLabel = () => {
      if (!power) return;
      const playing = chapter.on && !video.paused;
      power.setAttribute('aria-pressed', String(playing));
      power.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${name} clip`);
      power.title = power.getAttribute('aria-label');
    };
    let powerTimers = [];
    power?.addEventListener('click', () => {
      powerTimers.forEach(clearTimeout);
      powerTimers = [];
      tv.classList.remove('is-closing', 'is-opening');
      if (!chapter.on) {
        chapter.on = true;
        tv.classList.remove('is-off');
        if (!reducedMotion.matches) {
          tv.classList.add('is-opening');
          powerTimers.push(setTimeout(() => tv.classList.remove('is-opening'), 190));
        }
        play();
      } else {
        chapter.on = false;
        video.pause();
        if (reducedMotion.matches) tv.classList.add('is-off');
        else {
          tv.classList.add('is-closing');
          powerTimers.push(setTimeout(() => tv.classList.add('is-off'), 150));
          powerTimers.push(setTimeout(() => tv.classList.remove('is-closing'), 310));
        }
      }
      updatePowerLabel();
    });
    video.addEventListener('play', updatePowerLabel);
    video.addEventListener('pause', updatePowerLabel);
    replay?.addEventListener('click', () => {
      chapter.on = true;
      tv.classList.remove('is-off');
      video.currentTime = 0;
      play();
      event('demo_replay', { chapter: name });
    });
    return chapter;
  });
  const productBeat = document.querySelector('.product-beat');
  function updateExpansion() {
    const top = productBeat.getBoundingClientRect().top;
    const progress = desktopExpansion.matches ? Math.max(0, Math.min(1, (innerHeight * .95 - top) / (innerHeight * .6))) : 1;
    const scale = .9 + .1 * (1 - Math.pow(1 - progress, 3));
    productBeat.style.setProperty('--demo-scale', String(scale));
    const ready = progress >= 1;
    if (ready !== expansionReady) {
      expansionReady = ready;
      chapters.find(chapter => chapter.tv.dataset.chapter === 'product')?.sync();
    }
  }
  updateExpansion();
  addEventListener('resize', updateExpansion, { passive: true });
  desktopExpansion.addEventListener('change', updateExpansion);
  if ('IntersectionObserver' in window) {
    const mediaObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const chapter = chapters.find(item => item.tv === entry.target);
        if (!chapter) return;
        const visible = entry.isIntersecting && entry.intersectionRatio >= .2;
        if (visible && !chapter.viewed && chapter.tv.dataset.chapter === 'product') {
          chapter.video.currentTime = 0;
        }
        chapter.visible = visible;
        chapter.sync();
        if (chapter.visible && !chapter.viewed) {
          chapter.viewed = true;
          event('frame_view', { chapter: chapter.tv.dataset.chapter });
        }
      });
    }, { threshold: .2 });
    chapters.forEach(chapter => mediaObserver.observe(chapter.tv));
    const revealObserver = new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      revealObserver.unobserve(entry.target);
    }), { threshold: .12 });
    document.querySelectorAll('[data-reveal]').forEach(el => revealObserver.observe(el));
  } else {
    chapters.forEach(chapter => { chapter.visible = true; chapter.sync(); });
    document.querySelectorAll('[data-reveal]').forEach(el => el.classList.add('is-visible'));
  }
  const screen = document.querySelector('.opening-screen');
  const pointerFx = screen.querySelector('.crt-pointer-field');
  const pointerEnabled = matchMedia('(hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference)');
  let previousPoint = null;
  let pointerFade;
  const clearPointer = () => {
    clearTimeout(pointerFade);
    previousPoint = null;
    pointerFx.style.opacity = '0';
  };
  const movePointer = e => {
    if (!pointerEnabled.matches || screen.closest('.is-off')) return clearPointer();
    const r = screen.getBoundingClientRect();
    const x = Math.max(0, Math.min(screen.clientWidth, (e.clientX - r.left) / (r.width / screen.offsetWidth) - screen.clientLeft));
    const y = Math.max(0, Math.min(screen.clientHeight, (e.clientY - r.top) / (r.height / screen.offsetHeight) - screen.clientTop));
    const now = performance.now();
    const speed = previousPoint ? Math.hypot(x - previousPoint.x, y - previousPoint.y) / Math.max(16, now - previousPoint.t) : 0;
    pointerFx.style.setProperty('--crt-x', `${x}px`);
    pointerFx.style.setProperty('--crt-y', `${y}px`);
    pointerFx.style.opacity = String(Math.min(.62, .3 + speed * .18));
    previousPoint = { x, y, t: now };
    clearTimeout(pointerFade);
    pointerFade = setTimeout(() => { pointerFx.style.opacity = '.3'; }, 90);
  };
  screen.addEventListener('pointerenter', movePointer);
  screen.addEventListener('pointermove', movePointer);
  screen.addEventListener('pointerleave', clearPointer);
  screen.addEventListener('pointercancel', clearPointer);
  pointerEnabled.addEventListener('change', clearPointer);
  document.addEventListener('visibilitychange', clearPointer);
  reducedMotion.addEventListener('change', () => chapters.forEach(chapter => chapter.sync()));
  document.addEventListener('visibilitychange', () => chapters.forEach(chapter => chapter.sync()));
  document.querySelectorAll('[data-cta]').forEach(link => link.addEventListener('click', () => event('access_cta', { placement: link.dataset.cta })));
  const milestones = new Set();
  let scrollFrame = 0;
  function trackScroll() {
    scrollFrame = 0;
    updateExpansion();
    const length = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const depth = Math.round(scrollY / length * 100);
    [25, 50, 75, 100].forEach(mark => {
      if (depth < mark || milestones.has(mark)) return;
      milestones.add(mark);
      event('scroll_depth', { depth_percent: mark });
    });
  }
  addEventListener('scroll', () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(trackScroll); }, { passive: true });
  const form = document.querySelector('#access-form');
  const status = document.querySelector('#access-status');
  const input = form.querySelector('input');
  const submit = form.querySelector('button');
  let sending = false;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (sending || !form.reportValidity()) return;
    sending = true;
    submit.disabled = true;
    submit.textContent = 'Joining…';
    status.classList.remove('is-error');
    status.textContent = 'Adding you to the list…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch('https://api.eura.style/waitlist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: input.value.trim() }), signal: controller.signal
      });
      if (response.ok) {
        status.textContent = 'You’re on the list. We’ll email you when there’s a chance to try Eura.';
        input.value = '';
        event('waitlist_signup');
      } else if (response.status === 409) {
        status.textContent = 'You’re already on the list. We’ll be in touch.';
      } else {
        throw new Error('signup_failed');
      }
    } catch (error) {
      status.classList.add('is-error');
      status.textContent = error.name === 'AbortError' ? 'That took too long. Please try again.' : 'We couldn’t add you just now. Please try again.';
    } finally {
      clearTimeout(timeout);
      sending = false;
      submit.disabled = false;
      submit.textContent = 'Get early access';
    }
  });
})();
