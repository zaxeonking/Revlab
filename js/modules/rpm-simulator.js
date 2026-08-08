/**
 * REVLAB — rpm-simulator.js
 * -----------------------------------------------------------------------
 * A real, physics-based RPM simulation. This is the module a later "real"
 * engine simulator would either replace or feed into — it is the single
 * owner of the RPM signal. Everything else (gear, speed, temp, boost in
 * engine-state.js) is derived FROM this module's output, never the other
 * way around — EXCEPT gear, which now feeds back in one direction only:
 * engine-state.js tells this module which gear is currently engaged
 * (setGear) and when a shift just happened (triggerShiftDip), because
 * gear ratio and clutch engagement are properties of the DRIVETRAIN, not
 * the engine itself. RPM is still the only thing this module owns.
 *
 * Model (deterministic, no Math.random anywhere):
 *   - Throttle (0–100%) sets a TARGET rpm between idle and max.
 *   - Current RPM chases the target at a limited rate (RPM per second),
 *     not instantly — that rate limit IS the engine inertia (a flywheel
 *     can't change speed for free). Rising and falling use different
 *     rates, like a real engine: it revs up under power and falls back
 *     more slowly under engine braking when you lift off the throttle.
 *   - The rise rate is further scaled by which gear is engaged: low
 *     gears have more mechanical advantage (more torque multiplication)
 *     so RPM climbs noticeably harder/quicker off the line, while high
 *     gears climb more gradually — the classic "heavier" low-gear pull
 *     vs. the long, flatter pull of top gear.
 *   - When a gear shift happens (see triggerShiftDip), RPM briefly stops
 *     chasing the throttle target and instead dips toward a lower,
 *     gear-appropriate value over a short window — modeling the clutch
 *     momentarily disconnecting the engine from the drivetrain. This is
 *     what makes a shift feel like an actual event instead of the gear
 *     number silently changing underneath a perfectly smooth RPM curve.
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

  // Base rates before the per-gear multiplier below is applied. Lowered
  // from the previous version and pushed onto a per-gear curve instead —
  // a flat, high rate in every gear is what made the pull feel too easy/
  // light regardless of gear. Real engines don't rev the same in every
  // gear: low gears multiply torque and snap RPM up fast, top gear is a
  // long, comparatively lazy pull.
  const ACCEL_RATE_RPM_PER_S = 3600; // gear-1 baseline (see GEAR_ACCEL_MULT)
  const DECEL_RATE_RPM_PER_S = 3000; // how fast RPM can fall when throttle drops (engine braking)
  const SPINDOWN_RATE_RPM_PER_S = 2000; // how fast RPM falls to 0 with ignition off (coasting)

  // Per-gear acceleration multiplier applied on top of ACCEL_RATE_RPM_PER_S.
  // Index 0 = neutral/no gear engaged (kept brisk — revving in neutral
  // has no drivetrain load), index 1 = 1st gear (heaviest multiplier,
  // most torque advantage), climbing down to index 6 = 6th gear (flattest,
  // "long" pull). These are what actually make each gear feel distinct
  // rather than just a cosmetic label next to an identical RPM curve.
  const GEAR_ACCEL_MULT = [1.35, 1.55, 1.25, 1.05, 0.88, 0.74, 0.62];

  // ---- Shift-dip model ----
  // While a shift dip is active, RPM ignores the normal throttle-chases-
  // target logic and instead chases DIP_TARGET_RPM at DIP_RATE, then
  // (once the dip window elapses) resumes normal chasing from wherever
  // it ended up — exactly like a driver briefly lifting off / clutching
  // in, then getting back on the gas in the new gear.
  const SHIFT_DIP_MS = 220;            // how long the dip window lasts
  const SHIFT_DIP_RATE_RPM_PER_S = 9000; // dip itself is a quick, sharp drop
  const SHIFT_DIP_FRACTION = 0.32;     // dip target = currentRpm * (1 - this)

  const MAX_DT_S = 0.05; // clamp huge gaps (e.g. tab was backgrounded) so physics doesn't jump

  // ---- Simulation state (the only place RPM actually lives) ----
  let currentRpm = 0;
  let throttlePercent = 0;
  let engineOn = false;
  let revLimiting = false;
  let engagedGearIndex = 0; // 0 = neutral, mirrors EngineState's gear index

  let shiftDipUntil = 0;   // performance.now()-style timestamp, ms
  let shiftDipTargetRpm = 0;

  let lastTimestamp = null;
  let rafHandle = null;
  const listeners = new Set();

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function approach(current, target, ratePerSecond, dtSeconds) {
    const maxStep = ratePerSecond * dtSeconds;
    if (current < target) return Math.min(target, current + maxStep);
    if (current > target) return Math.max(target, current - maxStep);
    return current;
  }

  function gearAccelMultiplier() {
    return GEAR_ACCEL_MULT[engagedGearIndex] !== undefined
      ? GEAR_ACCEL_MULT[engagedGearIndex]
      : 1;
  }

  function isDipping() {
    return now() < shiftDipUntil;
  }

  function step(dtSeconds) {
    if (!engineOn) {
      // Ignition off: no target to chase, RPM just coasts down to 0.
      currentRpm = approach(currentRpm, 0, SPINDOWN_RATE_RPM_PER_S, dtSeconds);
      revLimiting = false;
      return;
    }

    if (isDipping()) {
      // Mid-shift: ignore the throttle target entirely and chase the
      // dip target instead — this is the "clutch disconnected" moment.
      // Deliberately does not honor the rev limiter here either; a dip
      // is already well below the limit by construction.
      currentRpm = approach(currentRpm, shiftDipTargetRpm, SHIFT_DIP_RATE_RPM_PER_S, dtSeconds);
      currentRpm = Math.min(Math.max(currentRpm, 0), MAX_RPM);
      return;
    }

    // Rev limiter hysteresis: engage at the limit, release well below it.
    if (currentRpm >= REV_LIMIT_RPM) revLimiting = true;
    if (revLimiting && currentRpm <= REV_LIMIT_RPM - REV_LIMIT_HYSTERESIS) revLimiting = false;

    const effectiveThrottle = revLimiting ? 0 : throttlePercent;
    const targetRpm = IDLE_RPM + (effectiveThrottle / 100) * (MAX_RPM - IDLE_RPM);

    const risingRate = ACCEL_RATE_RPM_PER_S * gearAccelMultiplier();
    const rate = targetRpm >= currentRpm ? risingRate : DECEL_RATE_RPM_PER_S;
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
      shifting: isDipping(),
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
    engagedGearIndex = 0;
    shiftDipUntil = 0;
  }

  function stop() {
    engineOn = false;
    throttlePercent = 0;
    shiftDipUntil = 0;
    // currentRpm is intentionally left as-is: it will coast down to 0
    // frame by frame via step(), not reset instantly.
  }

  function setThrottle(percent) {
    throttlePercent = Math.min(Math.max(Number(percent) || 0, 0), 100);
  }

  /** Tells the simulator which gear is currently engaged (0 = neutral),
   *  purely so it can scale acceleration rate per gear. Does not itself
   *  trigger a dip — that's triggerShiftDip()'s job, called separately
   *  by engine-state.js at the moment a shift actually completes. */
  function setGear(gearIndex) {
    engagedGearIndex = Math.max(0, Number(gearIndex) || 0);
  }

  /**
   * Call exactly when a gear shift completes (from engine-state.js's
   * stepGear/shiftUp/shiftDown) to make RPM visibly dip — the moment
   * that was previously missing, which is why shifts felt instant even
   * though the gear NUMBER was already being held/delayed correctly.
   * The dip target scales off whatever RPM the engine was AT when the
   * shift happened, so a shift at high RPM dips further (in absolute
   * rpm) than one at low RPM, same as a real clutch/synchro moment.
   */
  function triggerShiftDip() {
    if (!engineOn) return;
    shiftDipTargetRpm = Math.max(IDLE_RPM, currentRpm * (1 - SHIFT_DIP_FRACTION));
    shiftDipUntil = now() + SHIFT_DIP_MS;
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
    setGear,
    triggerShiftDip,
    IDLE_RPM,
    MAX_RPM,
    REDLINE_RPM,
    REV_LIMIT_RPM,
  };
})();
