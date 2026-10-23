(() => {
  'use strict';
  document.documentElement.classList.add('js');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const saveData = Boolean(navigator.connection && navigator.connection.saveData);
  const tv = document.querySelector('#demo-tv');
  const tvVideo = document.querySelector('#tv-video');
  const power = document.querySelector('#tv-power');
  const replay = document.querySelector('#tv-replay');
  const caption = document.querySelector('#tv-caption');
  const tabList = document.querySelector('.demo-tabs');
  const tabs = [...tabList.querySelectorAll('[role="tab"]')];
  const panels = [...document.querySelectorAll('.demo-panel')];
  const videos = [...document.querySelectorAll('video')];
  let activeStep = 0;
  let tvOn = true;
  let tvVisible = false;
  let stageVisible = false;
  const event = (name, data = {}) => {
    if (typeof window.gtag === 'function') window.gtag('event', name, data);
  };
  function play(video) {
    if (!video || document.hidden) return;
    video.muted = true;
    const result = video.play();
    if (result && result.catch) result.catch(() => {}); // Posters and native controls remain available.
  }
  function syncMedia(userInitiated = false) {
    const canAutoplay = userInitiated || (!reducedMotion.matches && !saveData);
    if (tvOn && tvVisible && canAutoplay && !document.hidden) play(tvVideo);
    else tvVideo.pause();
    panels.forEach((panel, index) => {
      const video = panel.querySelector('video');
      if (index === activeStep && stageVisible && canAutoplay && !document.hidden) play(video);
      else video.pause();
    });
  }
  function updatePowerLabel() {
    const playing = tvOn && !tvVideo.paused;
    power.setAttribute('aria-pressed', String(playing));
    power.setAttribute('aria-label', playing ? 'Pause demo' : 'Play demo');
    power.title = power.getAttribute('aria-label');
  }
  power.addEventListener('click', () => {
    if (tvVideo.paused || !tvOn) {
      tvOn = true;
      tv.classList.remove('is-off');
      play(tvVideo);
    } else {
      tvOn = false;
      tv.classList.add('is-off');
      tvVideo.pause();
    }
    updatePowerLabel();
  });
  tvVideo.addEventListener('play', updatePowerLabel);
  tvVideo.addEventListener('pause', updatePowerLabel);
  replay.addEventListener('click', () => {
    tvOn = true;
    tv.classList.remove('is-off');
    tvVideo.currentTime = 0;
    play(tvVideo);
    event('demo_replay');
  });
  const cutEnds = [2.16, 4.41, 7.01, 9.44, 11.615, 14.315];
  const cutLabels = ['01 / YOUR BRIEF', '02 / YOUR REFERENCES', '03 / YOUR FINDS', '04 / REFINE YOUR MART', '05 / SEE THE CHANGE', '06 / SET YOUR SCHEDULE', '07 / COME BACK FOR MORE'];
  tvVideo.addEventListener('timeupdate', () => {
    const index = cutEnds.findIndex(end => tvVideo.currentTime < end);
    const label = cutLabels[index < 0 ? 6 : index];
    if (caption.textContent !== label) caption.textContent = label;
  });
  function selectStep(index, focus = false) {
    activeStep = index;
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[i].hidden = !selected;
    });
    if (focus) tabs[index].focus();
    syncMedia(true);
    event('demo_step', { step: tabs[index].dataset.step });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectStep(index));
    tab.addEventListener('keydown', e => {
      let next;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = tabs.length - 1;
      if (next == null) return;
      e.preventDefault();
      selectStep(next, true);
    });
  });
  const mobile = matchMedia('(max-width: 600px)');
  const updateTabOrientation = () => tabList.setAttribute('aria-orientation', mobile.matches ? 'horizontal' : 'vertical');
  mobile.addEventListener('change', updateTabOrientation);
  updateTabOrientation();
  if ('IntersectionObserver' in window) {
    const mediaObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.target === tv) tvVisible = entry.isIntersecting;
        else stageVisible = entry.isIntersecting;
      });
      syncMedia();
    }, { threshold: .2 });
    mediaObserver.observe(tv);
    mediaObserver.observe(document.querySelector('.demo-stage'));
    const revealObserver = new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      revealObserver.unobserve(entry.target);
    }), { threshold: .12 });
    document.querySelectorAll('[data-reveal]').forEach(el => revealObserver.observe(el));
  } else {
    tvVisible = stageVisible = true;
    document.querySelectorAll('[data-reveal]').forEach(el => el.classList.add('is-visible'));
    syncMedia();
  }
  reducedMotion.addEventListener('change', () => syncMedia());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) videos.forEach(video => video.pause());
    else syncMedia();
  });
  document.querySelectorAll('[data-cta]').forEach(link => link.addEventListener('click', () => event('access_cta', { placement: link.dataset.cta })));
  const milestones = new Set();
  let scrollFrame = 0;
  function trackScroll() {
    scrollFrame = 0;
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
