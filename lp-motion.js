/* A reversible LP motion preview. No dependencies, storage or external calls. */
(() => {
  'use strict';
  const root = document.documentElement;
  const toggle = document.getElementById('motion-toggle');
  const replay = document.getElementById('motion-replay');
  const hero = document.querySelector('.hero');
  const phone = document.querySelector('.hero-phone');
  const label = document.querySelector('.demo-mode-label');
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  if (!toggle || !replay || !hero || !phone || !label) return;

  const items = [...document.querySelectorAll(
    '.hero-foot>div,.experience-top,.mode-panel figure,.experience-copy,' +
    '.guide-copy,.guide-stage,.features .section-heading,.feature-group,' +
    '.feature-note,.start-grid>.section-heading,.steps li,.faq,.final-row')];
  let enabled = false;
  let heroVisible = true;
  let timer;
  let revealObserver;
  let replayFrame;
  let replayGeneration = 0;

  function showScreen(onboard) {
    phone.classList.toggle('is-demo-onboard', onboard);
    label.textContent = onboard ? '車内モード' : '通常表示';
  }

  function scheduleDemo() {
    clearTimeout(timer);
    if (!enabled || !heroVisible || document.hidden) return;
    timer = setTimeout(() => {
      showScreen(!phone.classList.contains('is-demo-onboard'));
      scheduleDemo();
    }, 4500);
  }

  function observeReveals(reset = false) {
    if (!('IntersectionObserver' in window)) return;
    revealObserver?.disconnect();
    revealObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      });
    }, {threshold: .08, rootMargin: '0px 0px -20px 0px'});
    items.forEach((item, index) => {
      item.classList.add('motion-pending');
      item.style.setProperty('--reveal-delay', `${index % 3 * .07}s`);
      if (reset) item.classList.remove('is-visible');
      if (!item.classList.contains('is-visible')) revealObserver.observe(item);
    });
  }

  function setMotion(value) {
    enabled = value && !preference.matches;
    replayGeneration++;
    cancelAnimationFrame(replayFrame);
    root.classList.toggle('motion-active', enabled);
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.textContent = enabled ? '動き ON' : '動き OFF';
    toggle.disabled = preference.matches;
    toggle.title = preference.matches ? '端末の「動きを減らす」設定に合わせています' : '';
    replay.disabled = !enabled;
    if (!enabled) showScreen(false);
    scheduleDemo();
  }

  toggle.addEventListener('click', () => setMotion(!enabled));
  replay.addEventListener('click', () => {
    if (!enabled) return;
    const generation = ++replayGeneration;
    root.classList.remove('motion-active');
    window.scrollTo({top: 0, behavior: 'instant'});
    showScreen(false);
    observeReveals(true);
    replayFrame = requestAnimationFrame(() => {
      replayFrame = requestAnimationFrame(() => {
        if (!enabled || generation !== replayGeneration) return;
        root.classList.add('motion-active');
        scheduleDemo();
      });
    });
  });
  document.addEventListener('visibilitychange', scheduleDemo);
  preference.addEventListener('change', () => setMotion(!preference.matches));
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      heroVisible = entries[0].isIntersecting;
      hero.classList.toggle('motion-in-view', heroVisible);
      scheduleDemo();
    }, {threshold: 0}).observe(hero);
  }
  observeReveals();
  hero.classList.add('motion-in-view');
  setMotion(!preference.matches);
})();
