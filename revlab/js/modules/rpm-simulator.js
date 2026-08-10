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
 * This module now also reads (never writes) Gearbox.gearRatioFor() —
 * see triggerShiftDip() below — so the RPM landed on after a shift is
 * always the exact mechanical result of the ratio change, computed from
 * the same gear-ratio spec Gearbox/VEHICLE SETUP already own, instead
 * of a second, independently-tuned approximation living in this file.
 * gearbox.js must be loaded before this file (see index.html script
 * order) since Gearbox is referenced directly by name, not injected.
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
  // ---- Engine profile ----
  // These used to be fixed constants tuned by hand. They're now the
  // simulator's default profile — VEHICLE SETUP (vehicle-setup.js, via
  // EngineState.applyVehicleSetup()) calls configure() below to replace
  // them with whatever the driver has dialed in (Idle/Redline/Max RPM,
  // weight/power/torque → accel rate, engine braking → decel/spindown
  // rate, gear ratios → per-gear accel multiplier stays fixed but the
  // baseline it multiplies now moves). At their DEFAULT_* values the
  // simulation behaves byte-for-byte the same as before this became
  // configurable — VehicleSetup's own defaults are chosen to match.
  const DEFAULT_IDLE_RPM = 800;
  const DEFAULT_MAX_RPM = 9000;          // absolute ceiling — matches gauge face (9 x 1000)
  const DEFAULT_REDLINE_RPM = 7500;      // visual redline zone start — matches gauge.js REDLINE_START_K
  const DEFAULT_REV_LIMIT_RPM = 8800;    // engine's absolute fuel-cut ceiling (top gear / neutral use this)

  let IDLE_RPM = DEFAULT_IDLE_RPM;
  let MAX_RPM = DEFAULT_MAX_RPM;
  let REDLINE_RPM = DEFAULT_REDLINE_RPM;
  let REV_LIMIT_RPM = DEFAULT_REV_LIMIT_RPM;
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

  // Base rates before the per-gear multiplier below is applied. Now
  // driven by VEHICLE SETUP's Weight / Engine Power / Torque (higher
  // power-to-weight → faster accel) and Engine Braking (higher → faster
  // decel/spindown) — see EngineState.applyVehicleSetup() for the
  // formula. DEFAULT_* below matches the hand-tuned values this file
  // used before it became configurable, so the stock profile feels
  // identical to before.
  const DEFAULT_ACCEL_RATE_RPM_PER_S = 3450; // gear-1 baseline (see GEAR_ACCEL_MULT)
  const DEFAULT_DECEL_RATE_RPM_PER_S = 1500;
  const DEFAULT_SPINDOWN_RATE_RPM_PER_S = 2000; // how fast RPM falls to 0 with ignition off (coasting)

  let ACCEL_RATE_RPM_PER_S = DEFAULT_ACCEL_RATE_RPM_PER_S;
  let DECEL_RATE_RPM_PER_S = DEFAULT_DECEL_RATE_RPM_PER_S;
  let SPINDOWN_RATE_RPM_PER_S = DEFAULT_SPINDOWN_RATE_RPM_PER_S;

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
  // Rate bumped back up from 2200 → 3200 to keep pace with the much
  // deeper fractions below — a half-RPM dip at the old slow rate would
  // take over a second to bottom out, which starts to feel floaty/laggy
  // rather than a firm kick. At this rate a dip stays under ~0.8s even
  // for the biggest gap (gear 4) while still moving as one continuous,
  // visibly-animated slope the whole way down — the "smooth" part isn't
  // about being slow, it's about never freezing mid-motion (see
  // dipActive/step() above), which holds regardless of how deep or fast
  // the dip itself is.
  const SHIFT_DIP_RATE_RPM_PER_S = 3200;
  // Dip target is no longer a hand-tuned flat fraction of currentRpm.
  // It's the exact mechanical result of the ratio change between the
  // gear being LEFT and the gear being ENTERED:
  //
  //   newRPM = currentRPM × newGearRatio / currentGearRatio
  //
  // This is the same formula a real synchro/clutch produces: the
  // engine's speed doesn't change instantly at the moment of the shift,
  // but the gear ratio it's coupled to does, so its RPM is recalculated
  // against the new ratio the instant drive is re-engaged. See
  // triggerShiftDip() below, which reads both ratios from Gearbox
  // (single source of truth — gearbox.js) rather than duplicating them
  // here. GEAR_DIP_FRACTION is gone; nothing here is a tuned constant
  // anymore, it's derived from the same gear-ratio spec VEHICLE SETUP
  // already drives.

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
  // PERFORMANCE MODE — pause freezes the whole physics loop exactly where
  // it stands (no step(), no notify()) so every gauge/readout/graph in
  // REVLAB holds its last value instead of coasting or resetting. This is
  // deliberately a loop-level pause, not a per-module one, so nothing
  // downstream (engine-state.js derived telemetry, gauges, graphs) needs
  // its own pause logic — they simply stop receiving new frames.
  let paused = false;
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
  // Default shape kept for reference; EngineState.applyVehicleSetup()
  // recomputes and overwrites this (via configure()) every time Idle/
  // Redline/Max RPM change, from the SAME per-gear upshift points it
  // builds its GEARS table from — so this can never drift out of sync
  // with the thresholds AUTO mode actually shifts at.
  let GEAR_REV_LIMIT_RPM = [
    DEFAULT_REV_LIMIT_RPM, // N
    3300,                  // 1
    4800,                  // 2
    6300,                  // 3
    7800,                  // 4
    8500,                  // 5 — now its own ceiling, not a fallback to REV_LIMIT_RPM
    DEFAULT_REV_LIMIT_RPM, // 6 — intentionally the true engine redline (top gear)
  ];

  function currentRevLimit() {
    const limit = GEAR_REV_LIMIT_RPM[engagedGearIndex];
    return limit !== undefined ? limit : REV_LIMIT_RPM;
  }

  /**
   * Adopts a new engine profile from VEHICLE SETUP. Every field is
   * optional — only what's passed in gets overwritten, so callers can
   * send a partial update. Values are expected to already be validated
   * (see vehicle-setup.js); this function trusts them as-is.
   */
  function configure(partial = {}) {
    if (typeof partial.idleRpm === 'number') IDLE_RPM = partial.idleRpm;
    if (typeof partial.maxRpm === 'number') MAX_RPM = partial.maxRpm;
    if (typeof partial.redlineRpm === 'number') REDLINE_RPM = partial.redlineRpm;
    if (typeof partial.revLimitRpm === 'number') REV_LIMIT_RPM = partial.revLimitRpm;
    if (typeof partial.accelRateBase === 'number') ACCEL_RATE_RPM_PER_S = partial.accelRateBase;
    if (typeof partial.decelRate === 'number') DECEL_RATE_RPM_PER_S = partial.decelRate;
    if (typeof partial.spindownRate === 'number') SPINDOWN_RATE_RPM_PER_S = partial.spindownRate;
    if (Array.isArray(partial.gearRevLimitRpm) && partial.gearRevLimitRpm.length === 7) {
      GEAR_REV_LIMIT_RPM = partial.gearRevLimitRpm.slice();
    }
    // Keep currentRpm inside the new ceiling immediately (e.g. Max RPM
    // dialed down below where the needle currently sits) instead of
    // waiting for the next step() to clamp it.
    currentRpm = Math.min(currentRpm, MAX_RPM);
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
    if (paused) {
      // Still keep rAF alive (cheap) so resume() doesn't need to restart
      // the loop machinery — but deliberately skip step()/notify(): no
      // new RPM math, no new frame handed to EngineState, which is what
      // makes everything downstream hold perfectly still.
      lastTimestamp = timestamp;
      rafHandle = requestAnimationFrame(loop);
      return;
    }
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
      paused,
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

  /** PERFORMANCE MODE — PAUSE. Freezes the physics loop in place (see
   *  loop() above); does not touch engineOn/currentRpm/gear at all, so
   *  RESUME picks up from exactly where it left off. */
  function pause() {
    paused = true;
  }

  /** PERFORMANCE MODE — resumes a paused loop. lastTimestamp is reset so
   *  the first frame after resuming doesn't see a huge dt from the wall-
   *  clock time that passed while paused (same guard MAX_DT_S exists for,
   *  belt-and-braces here since that gap could otherwise be seconds/minutes). */
  function resume() {
    paused = false;
    lastTimestamp = null;
  }

  function isPaused() {
    return paused;
  }

  /** PERFORMANCE MODE — RESET. Hard-stops the simulation and snaps RPM
   *  straight to 0 (unlike stop(), which lets RPM coast down naturally —
   *  a RESET is meant to instantly return to a known, clean baseline, not
   *  simulate ignition-off spindown). Also clears paused/dip/flare state
   *  so a subsequent start() begins completely fresh. */
  function reset() {
    engineOn = false;
    throttlePercent = 0;
    currentRpm = 0;
    revLimiting = false;
    dipActive = false;
    startFlarePhase = null;
    engagedGearIndex = 0;
    paused = false;
    lastTimestamp = null;
    notify();
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
   *
   * The dip target is now computed from the actual gear-ratio spec via
   * Gearbox.gearRatioFor(), not a tuned flat fraction:
   *
   *   newRPM = currentRPM × newGearRatio / currentGearRatio
   *
   * fromGearIndex/toGearIndex are the gear being left and the gear
   * being entered (both 1–6; engine-state.js never dips a 0↔1 neutral
   * engagement — see the "enteringFromNeutral" branch in stepGear()).
   * If either index has no ratio (defensive only — shouldn't happen for
   * a real shift) this falls back to the previous engine RPM unchanged,
   * i.e. no dip, rather than guessing.
   */
  function triggerShiftDip(fromGearIndex, toGearIndex) {
    if (!engineOn) return;
    // Coasting shift (throttle released): no power to interrupt, so no
    // artificial dip — RPM just keeps following its existing decel curve
    // through the gear change. See SHIFT_DIP_THROTTLE_THRESHOLD above.
    if (throttlePercent < SHIFT_DIP_THROTTLE_THRESHOLD) return;

    const currentGearRatio = Gearbox.gearRatioFor(fromGearIndex);
    const newGearRatio = Gearbox.gearRatioFor(toGearIndex);
    if (!currentGearRatio || !newGearRatio) return; // neutral or unknown gear — nothing to recalc against

    const computedRpm = currentRpm * (newGearRatio / currentGearRatio);
    dipTargetRpm = Math.min(Math.max(computedRpm, IDLE_RPM), MAX_RPM);
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
    pause,
    resume,
    isPaused,
    reset,
    setThrottle,
    setGear,
    triggerShiftDip,
    configure,
    // Function getters, not plain properties — IDLE_RPM/MAX_RPM/etc.
    // above are reassigned by configure(), so a value captured once at
    // module-load time would go stale after the first Vehicle Setup
    // change (same reasoning as Gearbox's getGearRatios()/etc.).
    getIdleRpm: () => IDLE_RPM,
    getMaxRpm: () => MAX_RPM,
    getRedlineRpm: () => REDLINE_RPM,
    getRevLimitRpm: () => REV_LIMIT_RPM,
  };
})();
