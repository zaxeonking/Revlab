/**
 * REVLAB — brake-controller.js
 * -----------------------------------------------------------------------
 * Owns every *input* source that can push the brake: keyboard (S /
 * ArrowDown), the desktop brake button, and the mobile virtual pedal —
 * the exact same press/hold/release model ThrottleController uses for
 * the gas pedal (see throttle-controller.js for the full design
 * rationale), just driving EngineState.setBrake() instead of
 * .setThrottle(). Deliberately its own module rather than folded into
 * ThrottleController: gas and brake are independent controls with
 * independent ramp state (you can be easing off the gas at the same
 * moment you're easing onto the brake — they shouldn't share one
 * internal "pedal" variable), and EngineState.setBrake() itself already
 * cuts throttle to 0 the instant the brake is pressed at all, so the two
 * controllers never need to coordinate directly.
 * -----------------------------------------------------------------------
 */

const BrakeController = (() => {
  const RAMP_UP_RATE_PER_S = 320;   // %/s — a stab on the brake reaches full force fast
  const RAMP_DOWN_RATE_PER_S = 260; // %/s — release is quick too, but not instant

  const MAX_DT_S = 0.05;

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

    // Brakes are mechanical, not ignition-gated — unlike the throttle
    // ramp, this keeps pushing EngineState.setBrake() even if the
    // engine is off, so coasting to a stop with the key off still works.
    EngineState.setBrake(rampPercent);

    notifyIndicator();

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

  function subscribe(fn) {
    indicatorListeners.add(fn);
    fn(rampPercent, isHeld());
    return () => indicatorListeners.delete(fn);
  }

  function getPercent() {
    return rampPercent;
  }

  // ------------------------------------------------------------------
  // Input source wiring
  // ------------------------------------------------------------------

  const KEY_SOURCE = {
    s: 'key-s',
    arrowdown: 'key-arrowdown',
  };

  function bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      const sourceId = KEY_SOURCE[key];
      if (!sourceId) return;
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

    // Safety net: tab/window loses focus mid-press → the key never
    // fires keyup, so without this the brake could get stuck "on".
    window.addEventListener('blur', () => {
      release(KEY_SOURCE.s);
      release(KEY_SOURCE.arrowdown);
    });
  }

  /**
   * Binds a single element (desktop brake button OR mobile virtual
   * pedal) to press/hold/release using Pointer Events — identical
   * pattern to ThrottleController.bindPressHoldElement().
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
    el.addEventListener('lostpointercapture', onRelease);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function init(els) {
    bindKeyboard();
    bindPressHoldElement(els.brakeButton, 'ui-button');
    bindPressHoldElement(els.brakePedal, 'mobile-pedal');
  }

  return {
    init,
    subscribe,
    getPercent,
    isHeld,
    press,
    release,
  };
})();
