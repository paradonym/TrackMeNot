// name=webcrypto-rng.js
// WebCrypto-backed random helper used by the scheduler to avoid Math.random() patterns.
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
    return Math.max(min, Math.min(max, exponential(mean)));
  }

  function standardNormal() {
    const u1 = randomFloat();
    const u2 = randomFloat();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    return r * Math.cos(theta);
  }

  function logNormal(mu = 0, sigma = 1) {
    return Math.exp(mu + sigma * standardNormal());
  }

  const WebCryptoRandom = {
    getUint32,
    randomFloat,
    randInt,
    exponential,
    truncatedExponential,
    logNormal,
  };

  window.WebCryptoRandom = WebCryptoRandom;
})();
