// Seedable random source for the Random kernel, so headless runs and tests
// replay the same slot spins and card deals. mulberry32: 32-bit state,
// uniform [0, 1).

const GOLDEN_GAMMA = 0x6d2b79f5;
const TWO_POW_32 = 2 ** 32;

/** @param {number} seed @returns {() => number} */
export function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + GOLDEN_GAMMA) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / TWO_POW_32;
  };
}
