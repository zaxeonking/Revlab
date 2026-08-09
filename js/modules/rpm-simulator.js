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
  // Resting/idle baseline is 0, not a nonzero idle rpm — this simulator
  // reads "not on the gas" as 0 on the dial (0 also correctly means
  // "not moving" for the neutral/speed logic in engine-state.js), so
  // there's one consistent zero baseline instead of RPM settling at a
  // nonzero idle number while everything else reads 0.
  const IDLE_RPM = 0;
  const MAX_RPM = 9000;          // absolute ceiling — matches gauge face (9 x 1000)
  const REDLINE_RPM = 7500;      // visual redline zone start — matches gauge.js REDLINE_START_K
  const REV_LIMIT_RPM = 8800;    // engine's absolute fuel-cut ceiling (top gear / neutral use this)
  const REV_LIMIT_HYSTERESIS = 450; // fuel-cut releases once RPM falls this far below whichever limit is active

  // Idle used to sit perfectly flat at exactly IDLE_RPM forever. This
  // used to add a small deterministic sine-wave lope (a few rpm) so it
  // wouldn't read as dead/frozen — but in practice, sitting in Neutral,
  // that constant micro up-down motion reads as an unstable/broken idle
  // rather than a subtle "breathing" effect, so it's disabled: idle now
  // holds dead flat at IDLE_RPM until the driver actually does something
  // (gas, shift). Kept as 0 (not deleted) so it's a one-line change to
  // bring back later, tuned smaller, if a subtle idle lope is wanted.
  const IDLE_WOBBLE_RPM = 0;
  const IDLE_WOBBLE_HZ = 1.3;
  const IDLE_WOBBLE_THROTTLE_THRESHOLD = 2; // % — wobble only applies this close to closed throttle

  // Base rates before the per-gear multiplier below is applied. Dialed
  // BACK DOWN from the previous tune (was 4400) — that made RPM climb
  // fast enough in every gear to feel light/revvy instead of like it's
  // pulling real mass against it. Lower baseline = more "tarikan berat":
  // the flywheel visibly resists spinning up rather than snapping to
  // target, especially noticeable in the higher gears once
  // GEAR_ACCEL_MULT below has less multiplier left to compensate with.
  // Bumped back up from 3100: that tune leaned too far into a
  // floaty/underpowered feel ("kurang berat tarikannya") instead of
  // heavy-against-real-mass. This keeps the flywheel resisting the
  // instant snap-to-target, but with enough base punch that low gears
  // read as torquey rather than gutless.
  const ACCEL_RATE_RPM_PER_S = 3450; // gear-1 baseline (see GEAR_ACCEL_MULT)
  // Lowered a lot from the previous tune: releasing the throttle used to
  // snap RPM back down at 3000 rpm/s, which read as an abrupt cut rather
  // than an engine coasting down under its own compression/engine-braking.
  // This is what makes the needle drift down "pelan-pelan" after you let
  // off the gas, most noticeably right after a shift when the dip hands
  // off into this same decel chase.
  const DECEL_RATE_RPM_PER_S = 1500;
  const SPINDOWN_RATE_RPM_PER_S = 2000; // how fast RPM falls to 0 with ignition off (coasting)

  // Per-gear acceleration multiplier applied on top of ACCEL_RATE_RPM_PER_S.
  // Index 0 = neutral/no gear engaged (kept brisk — revving in neutral
  // has no drivetrain load), index 1 = 1st gear (heaviest multiplier,
  // most torque advantage), climbing down to index 6 = 6th gear (flattest,
  // "long" pull). Spread widened further on both ends this pass — low
  // gears keep (roughly) their punch even with the lower baseline above,
  // while top gears get noticeably flatter/heavier so the "long pull" of
  // a high gear actually feels like it's working against something.
  const GEAR_ACCEL_MULT = [1.35, 2.30, 1.65, 1.20, 0.85, 0.60, 0.46];

  // ---- Shift-dip model ----
  // While a shift dip is active, RPM ignores the normal throttle-chases-
  // target logic and instead chases dipTargetRpm at SHIFT_DIP_RATE_RPM_PER_S,
  // ending the INSTANT it reaches that target (see dipActive/step() above)
  // — then resumes normal throttle-chasing from wherever it ended up.
  // Exactly like a driver briefly lifting off / clutching in, then
  // getting back on the gas in the new gear, with no dead pause at the
  // bottom of the dip in between.
  // Rate cut hard from the original 6200 → 2200 → this. The dip's
  // HARSHNESS was never really about how far it dropped (the fractions
  // below are already shallow for low gears) — it's about how fast it
  // got there. A dip that reaches even a shallow target almost
  // instantly still reads as a jolt/hentakan because the RATE OF CHANGE
  // (jerk) is what the eye picks up, not just the endpoint.
  const SHIFT_DIP_RATE_RPM_PER_S = 2200;
  // Per-gear dip depth (dip target = currentRpm * (1 - fraction)),
  // indexed by the gear being ENTERED — same indexing as
  // GEAR_ACCEL_MULT (0 = neutral, 1..6 = gears). Shallowed further for
  // 1st–4th on top of the rate cut above — still enough that a shift
  // reads as a real event, not so much it feels like a stumble.
  const GEAR_DIP_FRACTION = [0, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25];

  // A dip models the clutch briefly interrupting POWER — that only makes
  // sense for a shift that happens while the driver is actually on the
  // gas. A downshift that happens because the driver let off the throttle
  // (coasting to a red light, engine braking) already has RPM falling on
  // its own smooth DECEL_RATE curve; layering a fast 6200rpm/s dip on top
  // of that reads as a harsh second drop, not a smooth hand-off — this is
  // the "pas gas turun ganti gigi kasar" case. Below this throttle level
  // a shift is treated as coasting and skips the dip entirely, letting
  // RPM continue whatever curve it was already on straight through the
  // gear change.
  const SHIFT_DIP_THROTTLE_THRESHOLD = 8; // %

  // ---- Start-up rev flare ----
  // Ignition used to just set currentRpm straight to a low starting point
  // and let the normal idle-chase logic carry it up to IDLE_RPM — which
  // at ACCEL_RATE_RPM_PER_S is fast enough (a few hundred ms) that it
  // reads as the needle simply snapping to 800 and sticking there, no
  // "catching" feel. A real engine on start-up flares — RPM overshoots
  // idle for a moment as it catches, then settles back down — so this
  // adds that as a short two-phase move right after start(): rise fast
  // to a peak above idle, then fall back to idle at a gentler rate.
  // Purely time/rate based, no randomness. If the driver gets on the gas
  // before the flare finishes, the flare is cancelled immediately so it
  // never fights a real throttle input.
  const START_FLARE_PEAK_RPM = 1650;
  const START_FLARE_RISE_MS = 220;
  const START_FLARE_RISE_RATE_RPM_PER_S = 7200;
  const START_FLARE_FALL_MS = 650;
  const START_FLARE_FALL_RATE_RPM_PER_S = 1900;
  const START_FLARE_CANCEL_THROTTLE = 5; // % — real gas input cancels the flare

  // Safety ceiling only — see dipActive below for why the dip no longer
  // runs on a fixed timer.
  const SHIFT_DIP_MAX_MS = 450;

  const MAX_DT_S = 0.05; // clamp huge gaps (e.g. tab was backgrounded) so physics doesn't jump

  // ---- Simulation state (the only place RPM actually lives) ----
  let currentRpm = 0;
  let throttlePercent = 0;
  let engineOn = false;
  let revLimiting = false;
  let engagedGearIndex = 0; // 0 = neutral, mirrors EngineState's gear index

  // Dip used to run on a fixed SHIFT_DIP_MS timer regardless of how far
  // it actually had to travel. That was fine back when the dip was deep
  // (0.32) and fast (6200rpm/s) — it genuinely took most of the window
  // to get there. But once the dip got shallower and slower to fix the
  // harsh kick, RPM often reached its dip target in well under 450ms and
  // then just sat FROZEN at the bottom for the rest of the window before
  // the throttle-chase logic resumed at full accel rate — a flat hold
  // followed by a sudden snap, which reads as a glitch/blink, not a
  // smooth dip. Fix: the dip now ends the INSTANT it reaches its target
  // (dipActive flips off in step() below), so it's always one continuous
  // downward move with no dead pause. dipDeadlineMs is only a safety
  // ceiling in case something odd leaves the target unreachable.
  let dipActive = false;
  let dipTargetRpm = 0;
  let dipStartedAt = 0;

  let startFlarePhase = null; // null | 'rise' | 'fall'
  let startFlarePhaseUntil = 0;

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

  // Per-gear rev limiter ceiling — the piece that was missing before.
  // The old rev limiter was a single global REV_LIMIT_RPM regardless of
  // which gear was engaged, so "limiter per gear" wasn't actually a
  // thing yet; every gear just revved all the way to the same 8800 rpm
  // engine ceiling. This gives each gear its OWN fuel-cut ceiling with
  // some headroom past that gear's normal auto-upshift point (see
  // GEARS.upAt in engine-state.js) — mainly felt in MANUAL mode, since
  // AUTO shifts you out of a gear before you'd ever reach its ceiling.
  // 5th now gets its own distinct ceiling too (was silently falling
  // back to the flat engine limit, same number as 6th — so AUTO and
  // MANUAL didn't actually agree on what "5th gear's limiter" meant).
  // It uses less headroom than 1st–4th (500 vs 1300) simply because
  // there isn't 1300rpm of room left before the engine's absolute
  // fuel-cut ceiling (8800) — 8000 + 1300 would overshoot it.
  // Neutral and 6th (true top gear) are the only two that intentionally
  // still equal the engine's absolute limit: neutral has no drivetrain
  // load to protect, and 6th has nowhere higher to shift into, so
  // hitting the real redline there is correct, not a fallback.
  const GEAR_REV_LIMIT_RPM = [
    REV_LIMIT_RPM, // N
    3300,          // 1
    4800,          // 2
    6300,          // 3
    7800,          // 4
    8500,          // 5 — now its own ceiling, not a fallback to REV_LIMIT_RPM
    REV_LIMIT_RPM, // 6 — intentionally the true engine redline (top gear)
  ];

  function currentRevLimit() {
    const limit = GEAR_REV_LIMIT_RPM[engagedGearIndex];
    return limit !== undefined ? limit : REV_LIMIT_RPM;
  }

  function isDipping() {
    return dipActive;
  }

  /** Advances (or ends) the start-up flare state machine for this frame.
   *  Returns true if the flare consumed this frame's motion (caller
   *  should skip the normal throttle-chase logic below it). */
  function stepStartFlare(dtSeconds) {
    if (!startFlarePhase) return false;

    // Real gas input takes over immediately — the flare is an idle-only
    // flourish, not something that should fight an actual driver input.
    if (throttlePercent >= START_FLARE_CANCEL_THROTTLE) {
      startFlarePhase = null;
      return false;
    }

    if (now() >= startFlarePhaseUntil) {
      if (startFlarePhase === 'rise') {
        startFlarePhase = 'fall';
        startFlarePhaseUntil = now() + START_FLARE_FALL_MS;
      } else {
        startFlarePhase = null;
        return false;
      }
    }

    if (startFlarePhase === 'rise') {
      currentRpm = approach(currentRpm, START_FLARE_PEAK_RPM, START_FLARE_RISE_RATE_RPM_PER_S, dtSeconds);
    } else if (startFlarePhase === 'fall') {
      currentRpm = approach(currentRpm, IDLE_RPM, START_FLARE_FALL_RATE_RPM_PER_S, dtSeconds);
    }
    currentRpm = Math.min(Math.max(currentRpm, 0), MAX_RPM);
    return true;
  }

  function step(dtSeconds) {
    if (!engineOn) {
      // Ignition off: no target to chase, RPM just coasts down to 0.
      currentRpm = approach(currentRpm, 0, SPINDOWN_RATE_RPM_PER_S, dtSeconds);
      revLimiting = false;
      startFlarePhase = null;
      return;
    }

    if (isDipping()) {
      // Mid-shift: ignore the throttle target entirely and chase the
      // dip target instead — this is the "clutch disconnected" moment.
      // Deliberately does not honor the rev limiter here either; a dip
      // is already well below the limit by construction.
      currentRpm = approach(currentRpm, dipTargetRpm, SHIFT_DIP_RATE_RPM_PER_S, dtSeconds);
      currentRpm = Math.min(Math.max(currentRpm, 0), MAX_RPM);
      // End the dip the instant it actually bottoms out, instead of
      // waiting for a fixed timer — see dipActive comment above for why
      // a fixed window left a dead-flat hold at the bottom for shallow/
      // fast dips. A time-based ceiling still applies as a safety net.
      if (currentRpm <= dipTargetRpm || (now() - dipStartedAt) >= SHIFT_DIP_MAX_MS) {
        dipActive = false;
      }
      return;
    }

    if (stepStartFlare(dtSeconds)) return;

    // Rev limiter hysteresis: engage at the limit, release well below
    // it. The limit itself is now gear-specific (see currentRevLimit).
    const revLimit = currentRevLimit();
    if (currentRpm >= revLimit) revLimiting = true;
    if (revLimiting && currentRpm <= revLimit - REV_LIMIT_HYSTERESIS) revLimiting = false;

    const effectiveThrottle = revLimiting ? 0 : throttlePercent;
    const idleWobble = effectiveThrottle < IDLE_WOBBLE_THROTTLE_THRESHOLD
      ? Math.sin((now() / 1000) * IDLE_WOBBLE_HZ * Math.PI * 2) * IDLE_WOBBLE_RPM
      : 0;
    const targetRpm = IDLE_RPM + (effectiveThrottle / 100) * (MAX_RPM - IDLE_RPM) + idleWobble;

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
      starting: startFlarePhase !== null,
      idleRpm: IDLE_RPM,
      maxRpm: MAX_RPM,
      redlineRpm: REDLINE_RPM,
      revLimitRpm: currentRevLimit(),
    };
  }

  function subscribe(fn) {
    listeners.add(fn);
    fn(getState());
    return () => listeners.delete(fn);
  }

  function start() {
    engineOn = true;
    throttlePercent = 0;
    engagedGearIndex = 0;
    dipActive = false;
    // Kick off the start-up flare (see stepStartFlare) — rise above idle
    // then settle back down to IDLE_RPM (0), instead of the needle
    // jumping straight to a resting number and sticking there.
    startFlarePhase = 'rise';
    startFlarePhaseUntil = now() + START_FLARE_RISE_MS;
  }

  function stop() {
    engineOn = false;
    throttlePercent = 0;
    dipActive = false;
    startFlarePhase = null;
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
    // Coasting shift (throttle released): no power to interrupt, so no
    // artificial dip — RPM just keeps following its existing decel curve
    // through the gear change. See SHIFT_DIP_THROTTLE_THRESHOLD above.
    if (throttlePercent < SHIFT_DIP_THROTTLE_THRESHOLD) return;
    const fraction = GEAR_DIP_FRACTION[engagedGearIndex] !== undefined
      ? GEAR_DIP_FRACTION[engagedGearIndex]
      : 0.32;
    dipTargetRpm = Math.max(IDLE_RPM, currentRpm * (1 - fraction));
    dipActive = true;
    dipStartedAt = now();
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
    GEAR_DIP_FRACTION,
  };
})();
