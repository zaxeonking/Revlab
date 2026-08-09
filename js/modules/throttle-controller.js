/**
 * REVLAB — throttle-controller.js
 * -----------------------------------------------------------------------
 * Owns every *input* source that can push the throttle: keyboard (W /
 * ArrowUp), the desktop throttle button, and the mobile virtual pedal.
 * The range slider in the control strip is a separate, direct input
 * (absolute position) and is intentionally left alone in ui-controller.js
 * — this module is specifically about press/hold/release-style controls,
 * which behave differently from a slider: they don't set an absolute
 * value, they ramp a value up while held and let it fall while not held.
 *
 * Design:
 *   - Each source (keyboard, button, pedal) is just a boolean "is this
 *     source currently being held" flag. Multiple sources can be held
 *     at once (e.g. touch pedal + keyboard on a hybrid device) without
 *     conflict — the controller simply asks "is ANY source active?"
 *     each frame. That single boolean question is what avoids
 *     keyboard/touch fights: neither source writes a throttle number
 *     directly, they only vote on "held" or "not held".
 *   - A dedicated requestAnimationFrame loop ramps an internal
 *     `rampPercent` value toward 100 (held) or 0 (released) at a
 *     capped rate per second — this is the "smooth response" layer,
 *     independent of and in addition to the engine-inertia smoothing
 *     that already happens inside rpm-simulator.js. Two layers of
 *     smoothing: pedal ramp (how fast your foot can move) feeds engine
 *     inertia (how fast the flywheel can follow).
 *   - Every ramped frame calls EngineState.setThrottle(rampPercent),
 *     same call the slider makes — so RPMSimulator doesn't need to know
 *     or care which control produced the number.
 *   - If the slider is moved directly while a press/hold source is also
 *     active, the press/hold ramp simply keeps running and will smoothly
 *     override the slider's value on the next frame — last-driver-wins
 *     per frame, no separate state to desync.
 * -----------------------------------------------------------------------
 */

const ThrottleController = (() => {
  // Now driven by VEHICLE SETUP's "Throttle Response" parameter (see
  // configure() below / EngineState.applyVehicleSetup()) — DEFAULT_*
  // matches the original hand-tuned rates so the stock profile behaves
  // identically to before this became configurable.
  const DEFAULT_RAMP_UP_RATE_PER_S = 260;   // %/s — how fast the "virtual pedal" can go from 0 to 100
  const DEFAULT_RAMP_DOWN_RATE_PER_S = 190; // %/s — slightly slower release, feels less twitchy than instant-0

  let RAMP_UP_RATE_PER_S = DEFAULT_RAMP_UP_RATE_PER_S;
  let RAMP_DOWN_RATE_PER_S = DEFAULT_RAMP_DOWN_RATE_PER_S;

  const MAX_DT_S = 0.05;

  // ---- Active-source bookkeeping ----
  // A Set of source ids currently "held". Throttle is only ramping up
  // while this set is non-empty; keyboard key-repeat, multi-touch, and
  // mouse+touch overlap all collapse into this one set safely because
  // adding the same id twice is a no-op.
  const activeSources = new Set();

  let rampPercent = 0;
  let lastTimestamp = null;
  let rafHandle = null;

  const indicatorListeners = new Set();

  function isHeld() {
    return activeSources.size > 0;
  }

  function notifyIndicator() {
    indicatorListeners.forEach((fn) => fn(rampPercent, isHeld()));
  }

  function loop(timestamp) {
    if (lastTimestamp === null) lastTimestamp = timestamp;
    const dtSeconds = Math.min((timestamp - lastTimestamp) / 1000, MAX_DT_S);
    lastTimestamp = timestamp;

    const target = isHeld() ? 100 : 0;
    const rate = target >= rampPercent ? RAMP_UP_RATE_PER_S : RAMP_DOWN_RATE_PER_S;
    const maxStep = rate * dtSeconds;

    if (rampPercent < target) {
      rampPercent = Math.min(target, rampPercent + maxStep);
    } else if (rampPercent > target) {
      rampPercent = Math.max(target, rampPercent - maxStep);
    }

    // Only push into the engine while the engine is actually on — this
    // mirrors the slider's disabled-while-off behavior, and stops a
    // held key from doing anything before START ENGINE is pressed.
    if (EngineState.getState().engineOn) {
      EngineState.setThrottle(rampPercent);
    }

    notifyIndicator();

    // Keep the loop running as long as there's active input OR the ramp
    // hasn't finished settling to 0 yet (so release still animates out).
    if (isHeld() || rampPercent > 0) {
      rafHandle = requestAnimationFrame(loop);
    } else {
      rafHandle = null;
      lastTimestamp = null;
    }
  }

  function ensureLoopRunning() {
    if (rafHandle !== null) return;
    lastTimestamp = null;
    rafHandle = requestAnimationFrame(loop);
  }

  /** Called by an input source on press/touchstart/keydown. */
  function press(sourceId) {
    const wasHeld = isHeld();
    activeSources.add(sourceId);
    if (!wasHeld) ensureLoopRunning();
  }

  /** Called by an input source on release/touchend/keyup/blur/cancel. */
  function release(sourceId) {
    activeSources.delete(sourceId);
    ensureLoopRunning(); // make sure the release ramp-to-0 still plays out
  }

  /** Hard reset, e.g. when the engine is stopped. */
  function releaseAll() {
    activeSources.clear();
    ensureLoopRunning();
  }

  function subscribe(fn) {
    indicatorListeners.add(fn);
    fn(rampPercent, isHeld());
    return () => indicatorListeners.delete(fn);
  }

  function getPercent() {
    return rampPercent;
  }

  /** Adopts new ramp rates from VEHICLE SETUP's Throttle Response
   *  parameter. Takes effect on the very next loop() tick — no restart
   *  needed, held inputs just start ramping at the new rate mid-press. */
  function configure({ rampUpRate, rampDownRate } = {}) {
    if (typeof rampUpRate === 'number' && rampUpRate > 0) RAMP_UP_RATE_PER_S = rampUpRate;
    if (typeof rampDownRate === 'number' && rampDownRate > 0) RAMP_DOWN_RATE_PER_S = rampDownRate;
  }

  // ------------------------------------------------------------------
  // Input source wiring
  // ------------------------------------------------------------------

  const KEY_SOURCE = {
    w: 'key-w',
    arrowup: 'key-arrowup',
  };

  function bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      // Ignore key-repeat auto-fire — press() is idempotent per source
      // anyway, but skipping repeats avoids needless work.
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      const sourceId = KEY_SOURCE[key];
      if (!sourceId) return;
      // Don't hijack typing in a focused form control (defensive; this
      // dashboard has no text inputs today, but keeps the control safe
      // if one is added later).
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      e.preventDefault();
      press(sourceId);
    });

    window.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase();
      const sourceId = KEY_SOURCE[key];
      if (!sourceId) return;
      release(sourceId);
    });

    // Safety net: if the tab/window loses focus while a key is held
    // down, the keyup event never fires — without this the throttle
    // would get stuck "on". Releasing both possible key sources here
    // is harmless even if only one was actually held.
    window.addEventListener('blur', () => {
      release(KEY_SOURCE.w);
      release(KEY_SOURCE.arrowup);
    });
  }

  /**
   * Binds a single element (desktop throttle button OR mobile virtual
   * pedal — same markup, same handler) to press/hold/release using
   * Pointer Events, which unify mouse, touch, and pen into one API so
   * keyboard and touch/mouse never need source-specific branches here.
   */
  function bindPressHoldElement(el, sourceId) {
    if (!el) return;

    const onPress = (e) => {
      e.preventDefault();
      if (el.setPointerCapture && e.pointerId !== undefined) {
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* no-op */ }
      }
      el.dataset.pressed = 'true';
      press(sourceId);
    };

    const onRelease = () => {
      el.dataset.pressed = 'false';
      release(sourceId);
    };

    el.addEventListener('pointerdown', onPress);
    el.addEventListener('pointerup', onRelease);
    el.addEventListener('pointercancel', onRelease);

    // Pointer capture (set on press above) means the button/pedal keeps
    // receiving pointerup/lostpointercapture even if the finger/cursor
    // drags outside its bounds — so we deliberately do NOT release on
    // pointerleave. That matches how a real pedal works: you can rock
    // your foot slightly without fully lifting off. Losing capture (e.g.
    // an OS gesture interrupting the touch) is the real safety net.
    el.addEventListener('lostpointercapture', onRelease);

    // Context menu (long-press on mobile) shouldn't hijack the pedal.
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function bindEngineStop() {
    // If the engine stops while throttle is held, don't leave the
    // ramp fighting to reach 100 against a stopped engine — release
    // every source so the pedal visually resets too.
    EngineState.subscribe((state) => {
      if (!state.engineOn && isHeld()) {
        releaseAll();
      }
    });
  }

  function init(els) {
    bindKeyboard();
    bindPressHoldElement(els.throttleButton, 'ui-button');
    bindPressHoldElement(els.throttlePedal, 'mobile-pedal');
    bindEngineStop();
  }

  return {
    init,
    subscribe,
    getPercent,
    isHeld,
    press,
    release,
    configure,
  };
})();
