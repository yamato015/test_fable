"use strict";

(() => {
  const screen = document.getElementById("start-screen");
  const photo = screen?.querySelector(".app-intro-visual");
  const button = document.getElementById("start-motion-toggle");
  if (!screen || !photo || !button) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let paused = false;
  let photoVisible = false;
  try { paused = localStorage.getItem("startMotionPaused") === "true"; } catch {}

  function update() {
    const enabled = !paused && !reduced.matches;
    screen.classList.toggle("start-motion-paused", !enabled);
    screen.classList.toggle("start-ambient-running", enabled && photoVisible &&
      !document.hidden && !screen.classList.contains("hidden") &&
      !document.body.classList.contains("sheet-open"));
    button.hidden = reduced.matches;
    button.textContent = t(enabled ? "startMotionPause" : "startMotionResume");
    button.setAttribute("aria-pressed", String(enabled));
  }

  button.addEventListener("click", () => {
    paused = !paused;
    try { localStorage.setItem("startMotionPaused", String(paused)); } catch {}
    update();
  });
  document.addEventListener("visibilitychange", update);
  reduced.addEventListener("change", update);
  new MutationObserver(update).observe(document.documentElement, { attributes:true, attributeFilter:["lang"] });
  // Observe only outside class changes; update() writes the screen classes too.
  new MutationObserver(records => {
    if (records.some(record => record.target === document.body ||
      (record.oldValue || "").split(/\s+/).includes("hidden") !== screen.classList.contains("hidden"))) update();
  }).observe(screen, { attributes:true, attributeFilter:["class"], attributeOldValue:true });
  new MutationObserver(update).observe(document.body, { attributes:true, attributeFilter:["class"] });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(entries => {
      photoVisible = entries[0].isIntersecting;
      update();
    }, { threshold:0 }).observe(photo);
  }
  update();
  screen.classList.add("start-motion-ready");
})();
