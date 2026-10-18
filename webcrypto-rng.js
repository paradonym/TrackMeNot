// name=webcrypto-rng.js
// WebCrypto-backed randomness helpers. Exposes WebCryptoRandom and replaces Math.random
(function () {
  'use strict';
  const MAX_UINT32 = 0xFFFFFFFF;

  function getUint32() {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0];
  }

  function randomFloat() {
    return (getUint32() + 1) / (MAX_UINT32 + 2);
  }

  function randInt(min, max) {
    const u = randomFloat();
    return Math.floor(u * (max - min + 1)) + min;
  }

  function exponential(mean) {
    const u = randomFloat();
    return -mean * Math.log(u);
  }

  function truncatedExponential(mean, min, max) {
    if (min >= max) return min;
    for (let i = 0; i < 32; i++) {
      const v = exponential(mean);
      if (v >= min && v <= max) return v;
    }
    const fallback = Math.max(min, Math.min(max, exponential(mean)));
    return fallback;
  }

  function standardNormal() {
    const u1 = randomFloat();
    const u2 = randomFloat();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    return r * Math.cos(theta);
  }

  function logNormal(mu = 0, sigma = 1) {
    const z = standardNormal();
    return Math.exp(mu + sigma * z);
  }

  const WebCryptoRandom = {
    getUint32,
    randomFloat,
    randInt,
    exponential,
    truncatedExponential,
    logNormal,
  };

  // Expose globally
  window.WebCryptoRandom = WebCryptoRandom;

  // Replace Math.random with a crypto-backed implementation. This keeps
  // the rest of the code untouched while providing CSPRNG-quality values.
  try {
    Object.defineProperty(Math, 'random', {
      value: function () { return WebCryptoRandom.randomFloat(); },
      writable: false,
      configurable: false,
    });
  } catch (e) {
    // Fallback: best-effort assignment if defineProperty is not allowed.
    try { Math.random = function () { return WebCryptoRandom.randomFloat(); }; } catch (e2) { /* ignore */ }
  }
})();
