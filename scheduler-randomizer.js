(function () {
  'use strict';

  // Simple shim to support both firefox/browser and chrome namespaces.
  const api = (typeof browser !== 'undefined') ? browser : chrome;

  // Preset delay ranges (ms)
  const PRESETS = {
    low: { min: 2 * 60 * 60 * 1000, max: 24 * 60 * 60 * 1000 },
    medium: { min: 30 * 60 * 1000, max: 6 * 60 * 60 * 1000 },
    high: { min: 15 * 1000, max: 5 * 60 * 1000 },
  };

  // Cached preset (kept synchronous for timer sampling)
  let cachedPreset = 'medium';

  // Try to initialize cachedPreset from storage (async read on startup).
  function initCachedPreset() {
    try {
      if (api && api.storage && api.storage.local && typeof api.storage.local.get === 'function') {
        api.storage.local.get(['options_tmn'], (items) => {
          try {
            const preset = items && items.options_tmn && items.options_tmn.activityPreset;
            if (preset && preset in PRESETS) {
              cachedPreset = preset;
              console.debug('scheduler-randomizer: cachedPreset loaded =', cachedPreset);
            }
          } catch (e) {
            console.debug('scheduler-randomizer: error reading preset', e);
          }
        });
        // update on changes
        if (api.storage.onChanged && typeof api.storage.onChanged.addListener === 'function') {
          api.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.options_tmn && changes.options_tmn.newValue) {
              const v = changes.options_tmn.newValue.activityPreset;
              if (v && v in PRESETS) {
                cachedPreset = v;
                console.debug('scheduler-randomizer: cachedPreset updated =', cachedPreset);
              }
            }
          });
        }
      }
    } catch (e) {
      console.debug('scheduler-randomizer: initCachedPreset failed', e);
    }
  }

  initCachedPreset();

  // Wrapped accessors to CSPRNG helper (WebCryptoRandom) with safe fallbacks.
  function secureRandomFloat() {
    if (window.WebCryptoRandom && typeof window.WebCryptoRandom.randomFloat === 'function') {
      return window.WebCryptoRandom.randomFloat();
    }
    return Math.random();
  }
  function secureRandInt(min, max) {
    if (window.WebCryptoRandom && typeof window.WebCryptoRandom.randInt === 'function') {
      return window.WebCryptoRandom.randInt(min, max);
    }
    // fallback inclusive
    return Math.floor(secureRandomFloat() * (max - min + 1)) + min;
  }
  function secureTruncatedExponential(mean, min, max) {
    if (window.WebCryptoRandom && typeof window.WebCryptoRandom.truncatedExponential === 'function') {
      return window.WebCryptoRandom.truncatedExponential(mean, min, max);
    }
    // crude fallback using exponential distribution via Math.random
    const u = secureRandomFloat();
    const v = -mean * Math.log(Math.max(1e-12, u));
    // clamp
    return Math.max(min, Math.min(max, v));
  }

  const originalSetTimeout = window.setTimeout.bind(window);

  // Replace window.setTimeout for calls inside the extension that pass a
  // numeric delay in a "reasonable" range. It MUST return a numeric id.
  function scheduleWrapped(fn, delay, ...args) {
    try {
      if (typeof delay === 'number' && delay > 0 && delay < 3600000) {
        // Use the cached preset synchronously.
        const preset = (cachedPreset in PRESETS) ? cachedPreset : 'medium';
        const range = PRESETS[preset];

        // Treat the provided delay as a suggestion (mean) if within range.
        const mean = (delay >= range.min && delay <= range.max) ? delay : Math.floor((range.min + range.max) / 2);

        // Sample from a truncated exponential distribution synchronously.
        const sampled = Math.floor(secureTruncatedExponential(mean, range.min, range.max));

        // Add a small ±10% jitter
        const jitter = Math.floor(sampled * (secureRandomFloat() * 0.2 - 0.1));
        const finalDelay = Math.max(1000, sampled + jitter);

        const id = originalSetTimeout(fn, finalDelay, ...args);
        console.debug('scheduler-randomizer: scheduled', finalDelay, 'ms (preset=' + preset + ')');
        return id;
      }
    } catch (e) {
      console.debug('scheduler-randomizer: error in scheduleWrapped', e);
    }
    // fallback to native behavior for other cases
    return originalSetTimeout(fn, delay, ...args);
  }

  // Install the override (synchronous, safe)
  window.setTimeout = scheduleWrapped;

  // Expose a small test helper on window for debugging in about:debugging console.
  window.TMNSchedulerRandomizer = {
    getPreset: () => cachedPreset,
    setPresetForTest: (p) => { if (p in PRESETS) { cachedPreset = p; } },
    PRESETS
  };

})();
