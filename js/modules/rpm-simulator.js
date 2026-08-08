/**
 * REVLAB — rpm-simulator.js
 * -----------------------------------------------------------------------
 * A real, physics-based RPM simulation. This is the module a later "real"
 * engine simulator would either replace or feed into — it is the single
 * owner of the RPM signal. Everything else (gear, speed, temp, boost in
 * engine-state.js) is derived FROM this module's output, never the other
 * way around.
 *
 * Model (deterministic, no Math.random anywhere):
 *   - Throttle (0–100%) sets a TARGET rpm between idle and max.
 *   - Current RPM chases the target at a limited rate (RPM per second),
 *     not instantly — that rate limit IS the engine inertia (a flywheel
 *     can't change speed for free). Rising and falling use different
 *     rates, like a real engine: it revs up under power and falls back
 *     more slowly under engine braking when you lift off the throttle.
 *   - When RPM reaches the rev limiter threshold, fuel is "cut"
 *     (effective throttle forced to 0 for that instant) until RPM drops
 *     back below a hysteresis band, then power resumes. Held at full
 *     throttle, this naturally produces the classic rev-limiter bounce
 *     — entirely from the physics loop, not from any random number.
 *   - The loop runs on requestAnimationFrame and is frame-rate
 *     independent (uses real elapsed time each frame).
 * -----------------------------------------------------------------------
 */

const RPMSimulator = (() => {
  // ---- Engine profile (placeholder values, later replaceable) ----
  const IDLE_RPM = 800;
  const MAX_RPM = 9000;          // absolute ceiling — matches gauge face (9 x 1000)
  const REDLINE_RPM = 7500;      // visual redline zone start — matches gauge.js REDLINE_START_K
  const REV_LIMIT_RPM = 8800;    // fuel-cut engages at/above this
  const REV_LIMIT_HYSTERESIS = 450; // fuel-cut releases once RPM falls this far below the limit

  const ACCEL_RATE_RPM_PER_S = 5200; // how fast RPM can rise at full throttle (inertia limit)
  const DECEL_RATE_RPM_PER_S = 3200; // how fast RPM can fall when throttle drops (engine braking)
  const SPINDOWN_RATE_RPM_PER_S = 2000; // how fast RPM falls to 0 with ignition off (coasting)

  const MAX_DT_S = 0.05; // clamp huge gaps (e.g. tab was backgrounded) so physics doesn't jump

  // ---- Simulation state (the only place RPM actually lives) ----
  let currentRpm = 0;
  let throttlePercent = 0;
  let engineOn = false;
  let revLimiting = false;

  let lastTimestamp = null;
  let rafHandle = null;
  const listeners = new Set();

  function approach(current, target, ratePerSecond, dtSeconds) {
    const maxStep = ratePerSecond * dtSeconds;
    if (current < target) return Math.min(target, current + maxStep);
    if (current > target) return Math.max(target, current - maxStep);
    return current;
  }

  function step(dtSeconds) {
    if (!engineOn) {
      // Ignition off: no target to chase, RPM just coasts down to 0.
      currentRpm = approach(currentRpm, 0, SPINDOWN_RATE_RPM_PER_S, dtSeconds);
      revLimiting = false;
      return;
    }

    // Rev limiter hysteresis: engage at the limit, release well below it.
    if (currentRpm >= REV_LIMIT_RPM) revLimiting = true;
    if (revLimiting && currentRpm <= REV_LIMIT_RPM - REV_LIMIT_HYSTERESIS) revLimiting = false;

    const effectiveThrottle = revLimiting ? 0 : throttlePercent;
    const targetRpm = IDLE_RPM + (effectiveThrottle / 100) * (MAX_RPM - IDLE_RPM);

    const rate = targetRpm >= currentRpm ? ACCEL_RATE_RPM_PER_S : DECEL_RATE_RPM_PER_S;
    currentRpm = approach(currentRpm, targetRpm, rate, dtSeconds);
    currentRpm = Math.min(Math.max(currentRpm, 0), MAX_RPM);
  }

  function notify() {
    const snapshot = getState();
    listeners.forEach((fn) => fn(snapshot));
  }

  function loop(timestamp) {
    if (lastTimestamp === null) lastTimestamp = timestamp;
    const dtSeconds = Math.min((timestamp - lastTimestamp) / 1000, MAX_DT_S);
    lastTimestamp = timestamp;

    step(dtSeconds);
    notify();

    rafHandle = requestAnimationFrame(loop);
  }

  function ensureLoopRunning() {
    if (rafHandle !== null) return;
    lastTimestamp = null;
    rafHandle = requestAnimationFrame(loop);
  }

  function getState() {
    return {
      rpm: Math.round(currentRpm),
      rpmK: currentRpm / 1000,
      throttlePercent,
      engineOn,
      revLimiting,
      idleRpm: IDLE_RPM,
      maxRpm: MAX_RPM,
      redlineRpm: REDLINE_RPM,
      revLimitRpm: REV_LIMIT_RPM,
    };
  }

  function subscribe(fn) {
    listeners.add(fn);
    fn(getState());
    return () => listeners.delete(fn);
  }

  function start() {
    engineOn = true;
    // Engine catches at idle immediately (ignition), then simulation
    // takes over from there — it does not jump straight to a target.
    if (currentRpm < IDLE_RPM * 0.5) currentRpm = IDLE_RPM * 0.5;
    throttlePercent = 0;
  }

  function stop() {
    engineOn = false;
    throttlePercent = 0;
    // currentRpm is intentionally left as-is: it will coast down to 0
    // frame by frame via step(), not reset instantly.
  }

  function setThrottle(percent) {
    throttlePercent = Math.min(Math.max(Number(percent) || 0, 0), 100);
  }

  function init() {
    ensureLoopRunning();
    return getState();
  }

  return {
    init,
    subscribe,
    getState,
    start,
    stop,
    setThrottle,
    IDLE_RPM,
    MAX_RPM,
    REDLINE_RPM,
    REV_LIMIT_RPM,
  };
})();
