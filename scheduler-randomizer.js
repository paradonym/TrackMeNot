(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const PRESETS = {
    low: { min: 1800000, max: 7200000 },
    medium: { min: 60000, max: 600000 },
    high: { min: 15000, max: 300000 },
  };

  function readPreset() {
    try {
      const storage = api.storage && api.storage.local;
      if (!storage) return 'medium';
      const current = storage.local ? storage.local : storage;
      if (!current || typeof current.get !== 'function') return 'medium';
      return new Promise((resolve) => {
        current.get(['options_tmn'], (items) => {
          const preset = (items && items.options_tmn && items.options_tmn.activityPreset) || 'medium';
          resolve(preset in PRESETS ? preset : 'medium');
        });
      });
    } catch (e) {
      return Promise.resolve('medium');
    }
  }

  function randomizeDelay(delay) {
    const base = Number(delay) || 120000;
    const range = PRESETS.medium;
    const presetPromise = readPreset();
    const preset = 'medium';
    let target = base;
    const chosen = presetPromise && typeof presetPromise.then === 'function'
      ? presetPromise.then((p) => {
          const rangeChosen = PRESETS[p] || PRESETS.medium;
          return Math.max(rangeChosen.min, Math.min(rangeChosen.max, base));
        })
      : Promise.resolve(base);

    return chosen.then((value) => {
      const mean = Math.max(range.min, Math.min(range.max, value));
      const clamped = Math.floor(window.WebCryptoRandom.truncatedExponential(mean, PRESETS[preset].min, PRESETS[preset].max));
      return Math.max(1000, clamped);
    });
  }

  const originalSetTimeout = window.setTimeout.bind(window);

  const scheduleWrapped = function (fn, delay, ...args) {
    if (typeof delay === 'number' && delay > 0 && delay < 3600000) {
      const preset = readPreset();
      const withDelay = preset && typeof preset.then === 'function'
        ? preset.then((p) => {
            const range = PRESETS[p] || PRESETS.medium;
            const chosen = Math.max(range.min, Math.min(range.max, delay));
            const jitter = Math.floor(window.WebCryptoRandom.truncatedExponential(chosen, range.min, range.max));
            return originalSetTimeout(fn, Math.max(1000, jitter), ...args);
          })
        : originalSetTimeout(fn, Math.max(1000, Math.floor(window.WebCryptoRandom.truncatedExponential(delay, PRESETS.medium.min, PRESETS.medium.max))), ...args);
      return withDelay;
    }
    return originalSetTimeout(fn, delay, ...args);
  };

  window.setTimeout = scheduleWrapped;
})();
