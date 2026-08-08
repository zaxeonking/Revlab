/**
 * REVLAB — audio-engine.js
 * -----------------------------------------------------------------------
 * STATUS: NOT YET IMPLEMENTED.
 *
 * This module defines the intended shape of the audio engine so the rest
 * of the app (UI controller, main.js) has a stable interface to program
 * against. Every method below is a stub: it records state and logs to
 * the console, but it does NOT create an AudioContext, load samples, or
 * produce any sound yet. Do not treat any of this as working audio.
 *
 * Planned implementation (future stage):
 *  - AudioContext + GainNode master bus
 *  - Layered oscillator/sample-based engine tone, pitched by RPM
 *  - Throttle input mapped to gain/filter envelopes
 *  - Cylinder-count / redline profile switching
 * -----------------------------------------------------------------------
 */

const AudioEngine = (() => {
  let isInitialized = false;
  let isRunning = false;

  /**
   * Placeholder for AudioContext creation. Intentionally does not touch
   * the Web Audio API yet — kept as a no-op so callers can wire up UI
   * without the feature silently pretending to work.
   */
  function init() {
    isInitialized = true;
    console.info('[AudioEngine] init() called — no AudioContext created yet (not implemented).');
    return { ok: false, reason: 'not_implemented' };
  }

  function start() {
    if (!isInitialized) {
      console.warn('[AudioEngine] start() called before init().');
      return { ok: false, reason: 'not_initialized' };
    }
    console.info('[AudioEngine] start() called — no audio will play (not implemented).');
    isRunning = false; // stays false on purpose: nothing actually starts
    return { ok: false, reason: 'not_implemented' };
  }

  function stop() {
    console.info('[AudioEngine] stop() called — no-op (not implemented).');
    isRunning = false;
    return { ok: false, reason: 'not_implemented' };
  }

  function setThrottle(percent0to100) {
    // No sound mapping yet. Kept as a documented no-op.
    return { ok: false, reason: 'not_implemented', received: percent0to100 };
  }

  function getState() {
    return {
      isInitialized,
      isRunning,
      implemented: false,
    };
  }

  return { init, start, stop, setThrottle, getState };
})();
