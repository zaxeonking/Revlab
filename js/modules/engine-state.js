/**
 * REVLAB — engine-state.js
 * -----------------------------------------------------------------------
 * Telemetry layer built on top of RPMSimulator (the real, physics-based
 * RPM signal — see js/modules/rpm-simulator.js). This module does NOT
 * own or invent RPM itself anymore; every frame it reads the current
 * simulated RPM and derives the rest of the dashboard (gear, speed,
 * engine temp, boost, status) from it using fixed, deterministic
 * formulas. No Math.random(), no independent timers.
 *
 * This stays a small pub/sub store so the UI layer never touches
 * RPMSimulator or raw numbers directly:
 *
 *   - UIController only ever calls EngineState.getState() / .subscribe()
 *     and forwards user input via EngineState.startEngine() / .stopEngine()
 *     / .setThrottle() / .shiftUp() / .shiftDown() / .setGearMode().
 *   - A future, more complete engine simulator can replace the derive*()
 *     functions below (thermal model, turbo model, etc.) without the UI
 *     layer changing at all. Gear ratios / final drive / wheel
 *     circumference / drivetrain efficiency are no longer placeholders —
 *     see js/modules/gearbox.js, the single source of truth for how RPM
 *     and speed relate to each other.
 *
 * Gear logic (`stepGear`) is a small state machine, not a pure lookup,
 * so it can add hysteresis (different RPM thresholds going up vs down)
 * and a shift-lock delay (a brief window after any shift during which
 * no further shift is allowed) — see stepGear() below for why a plain
 * "gearForRpm(rpm)" lookup causes visible flicker at the boundaries.
 * On top of the lock, every actual shift also tells RPMSimulator to
 * dip RPM briefly (RPMSimulator.triggerShiftDip()) and to scale
 * acceleration by the newly engaged gear (RPMSimulator.setGear()) —
 * see rpm-simulator.js for why a shift needs to visibly cost something
 * in RPM, not just silently swap the gear label.
 * -----------------------------------------------------------------------
 */

const EngineState = (() => {
  const AMBIENT_TEMP_C = 24;
  const OPERATING_TEMP_C = 92;
  // `let`, not `const`: VEHICLE SETUP's "MAX BOOST" field can change this
  // at runtime — see applyVehicleSetup() below. Default mirrors
  // VehicleSetup's own maxBoostBar default.
  let MAX_BOOST_BAR = 0.90;
  // Dial ceiling for the speedometer face — kept as a display value (fed
  // to SpeedGauge for its tick scale) that now ALSO acts as a real
  // governor: deriveFromFrame() below caps the driven speed target at
  // this number, so VEHICLE SETUP's "Top Speed" parameter is more than
  // cosmetic. Speed itself still comes from genuine gear-ratio × final-
  // drive × wheel-circumference × efficiency math (js/modules/gearbox.js)
  // up to that cap — RPM and speed are always related through the actual
  // mechanical ratio of whichever gear is engaged, not an arbitrary
  // "gear N tops out at X km/h" table. Neutral (index 0) still has no
  // mechanical path to the wheels at all — displayed speed is hard-locked
  // to 0 there regardless of RPM.
  // `let`, not `const`: VEHICLE SETUP can change this at runtime — see
  // applyVehicleSetup() below.
  const DEFAULT_MAX_SPEED_KMH = 260;
  let MAX_SPEED_KMH = DEFAULT_MAX_SPEED_KMH;
  const KMH_PER_MPH = 1.609344;

  // Baseline vehicle spec these formulas were tuned against — used only
  // to turn VEHICLE SETUP's absolute Weight/Power/Torque numbers into a
  // relative performance factor (see applyVehicleSetup()). Matches
  // VehicleSetup's own DEFAULT_* so the stock profile reproduces
  // RPMSimulator's original hand-tuned feel exactly.
  const BASELINE_WEIGHT_KG = 1350;
  const BASELINE_POWER_HP = 420;
  const BASELINE_TORQUE_NM = 430;

  // ---- PERFORMANCE MODE: torque / power model --------------------------
  // REVLAB never had an actual output-torque or power number before —
  // VEHICLE SETUP's Torque/Engine Power fields only fed into the
  // accel-rate blend above (see applyVehicleSetup()). PERFORMANCE MODE
  // needs a real, RPM-dependent torque curve to plot and to derive
  // instantaneous Power (kW comes straight from Torque × RPM, it isn't an
  // independent input). Kept deterministic like everything else here —
  // a fixed-shape curve (rise → peak → gentle fall), scaled by whatever
  // peak torque VEHICLE SETUP currently has dialed in, and by throttle
  // position (a part-throttle point sits proportionally below the curve,
  // same as a real dyno pull at less than WOT).
  //
  // Peak torque sits at ~42% of the way from idle to max RPM — a
  // plausible naturally-aspirated placement (mirrors why 3rd/4th gear
  // upshift fractions in buildGears() land in a similar band). Below
  // that the curve rises with a soft power curve (torque builds as RPM
  // comes on cam); above it, torque falls off gradually toward redline/
  // max the way a real engine's volumetric efficiency drops at high RPM,
  // never to zero.
  const TORQUE_PEAK_FRACTION = 0.42;
  const TORQUE_AT_IDLE_FRACTION = 0.28;   // fraction of peak torque available right off idle
  const TORQUE_AT_MAX_FRACTION = 0.55;    // fraction of peak torque still available at max rpm
  // Below this throttle %, the curve is still shown at full value on the
  // reference graph (it's an engine property, not a moment-in-time
  // reading), but the actual instantaneous torque/power readouts blend
  // toward a low idle-load floor so the numbers don't read "full engine
  // torque" while just sitting there blipping the throttle.
  const TORQUE_THROTTLE_FLOOR = 0.15;

  /** Torque available at a given RPM, AT FULL THROTTLE, as a fraction of
   *  peak torque (0..~1). Pure function of RPM shape — this is "the
   *  engine's torque curve" independent of current throttle position. */
  function torqueCurveFraction(rpm) {
    const span = Math.max(1, MAX_RPM - IDLE_RPM);
    const x = clamp((rpm - IDLE_RPM) / span, 0, 1);
    if (x <= TORQUE_PEAK_FRACTION) {
      const t = x / TORQUE_PEAK_FRACTION;
      // Ease-out rise from idle fraction up to 1.0 at the peak — sqrt
      // shape builds quickly off idle then rounds off approaching peak,
      // instead of a plain straight ramp.
      return TORQUE_AT_IDLE_FRACTION + (1 - TORQUE_AT_IDLE_FRACTION) * Math.sqrt(t);
    }
    const t = (x - TORQUE_PEAK_FRACTION) / (1 - TORQUE_PEAK_FRACTION);
    // Gentle fall from peak to the max-rpm floor.
    return 1 - (1 - TORQUE_AT_MAX_FRACTION) * (t * t * (3 - 2 * t)); // smoothstep falloff
  }

  /** Full torque (Nm) / power (hp, kW) curve across the current idle→max
   *  RPM range, sampled at `steps` points, at full throttle — the
   *  reference curve PERFORMANCE MODE's Torque/Power graphs plot. Peak
   *  torque comes from VEHICLE SETUP's torqueNm; power is derived FROM
   *  torque × rpm (not a separate input), same relationship real engines
   *  have. Recomputed on demand rather than cached, since it only runs
   *  when a graph redraws (a handful of times/sec at most), not per
   *  physics tick. */
  function computeCurve(steps = 40) {
    const points = [];
    const span = Math.max(1, MAX_RPM - IDLE_RPM);
    for (let i = 0; i <= steps; i += 1) {
      const rpm = IDLE_RPM + (span * i) / steps;
      const torqueNm = Math.round(peakTorqueNm * torqueCurveFraction(rpm));
      const powerHp = Math.round((torqueNm * rpm) / 7127);
      points.push({ rpm: Math.round(rpm), torqueNm, powerHp });
    }
    return points;
  }

  // `let`, not `const`: mirrors VehicleSetup's torqueNm — see
  // applyVehicleSetup() below.
  let peakTorqueNm = BASELINE_TORQUE_NM;

  // `let`, not `const`: these three mirror whatever VEHICLE SETUP has
  // currently applied (see applyVehicleSetup()) — everything below that
  // used to read RPMSimulator.MAX_RPM etc. as a load-time constant now
  // reads these instead, kept in lockstep by applyVehicleSetup().
  let MAX_RPM = RPMSimulator.getMaxRpm();
  let IDLE_RPM = RPMSimulator.getIdleRpm();
  let REDLINE_RPM = RPMSimulator.getRedlineRpm();

  // ---- Gear table -----------------------------------------------------
  // Gears are 1-indexed into this array; index 0 is neutral. Each entry
  // carries the RPM that triggers an upshift out of it, and the RPM
  // that triggers a downshift back into it from the gear above — the
  // gap between those two is the hysteresis band. Going up shifts at a
  // HIGHER rpm than coming back down, exactly like a real gearbox: you
  // don't downshift back the instant RPM dips 1 rpm below the upshift
  // point, or the transmission would hunt/flicker between two gears
  // forever at a steady-ish RPM.
  // BUG FIX (gear hunting between 2↔3, and structurally at every
  // boundary from 2nd gear up): downAt used to be picked independently
  // of the shift-dip model. Every real upshift calls
  // RPMSimulator.triggerShiftDip(), which yanks RPM down by
  // SHIFT_DIP_FRACTION (~32%) the instant the new gear engages. If that
  // post-shift floor lands BELOW the new gear's downAt, the very next
  // stepGear() check (as soon as the shift-lock window clears) sees
  // "RPM below downAt" and immediately shifts back down — which then
  // dips RPM again, undershoots the gear below's own downAt, and so on.
  // That's exactly the naik-turun/2-3 hunting bug. Fix: derive downAt
  // FROM the dip math itself (same SHIFT_DIP_FRACTION RPMSimulator
  // actually uses, so the two can never drift out of sync again) with
  // a safety margin, so the post-dip recovery always lands comfortably
  // above the downshift threshold instead of right on top of it.
  const GEAR_DIP_FRACTION = RPMSimulator.GEAR_DIP_FRACTION;
  const DOWNSHIFT_SAFETY_MARGIN_RPM = 150;
  // enteringGearIndex = which gear's dip fraction applies (the gear you
  // land IN after the upshift that this downAt is guarding against —
  // e.g. GEARS[2].downAt uses the dip fraction for ENTERING 2nd, since
  // that's the dip whose post-shift floor this threshold has to clear).
  function safeDownAt(prevUpAt, enteringGearIndex) {
    const fraction = GEAR_DIP_FRACTION[enteringGearIndex] !== undefined
      ? GEAR_DIP_FRACTION[enteringGearIndex]
      : 0.32;
    return Math.round(prevUpAt * (1 - fraction)) - DOWNSHIFT_SAFETY_MARGIN_RPM;
  }

  /**
   * Builds the gear table (upshift/downshift thresholds) AND the per-gear
   * rev-limiter ceilings RPMSimulator uses, from just three VEHICLE SETUP
   * numbers: idle/redline/max RPM. Both used to be hand-typed constants;
   * deriving them from formulas here is what lets Redline RPM / Max RPM
   * actually move the gearbox's shift points instead of only moving the
   * gauge needle's ceiling.
   *
   * The fractions below (0.375 / 0.545 / 0.716 / 0.886 / 0.909 of the
   * fuel-cut ceiling) are chosen to reproduce the ORIGINAL hand-tuned
   * upshift points (3300/4800/6300/7800/8000) exactly when fed the
   * original defaults (idle 800, redline 7500, max 9000) — so the stock
   * profile behaves identically to before this became configurable.
   */
  function buildGears(idleRpm, redlineRpm, maxRpm) {
    // Fuel-cut ceiling: a little under Max RPM, same "headroom below the
    // absolute limit" idea the original REV_LIMIT_RPM (8800 vs a 9000
    // dial ceiling) used.
    const revLimit = Math.max(redlineRpm + 200, maxRpm - 200);

    const UPSHIFT_FRACTIONS = [0.375, 0.545, 0.716, 0.886, 0.909]; // gears 1..5
    const upAtArr = UPSHIFT_FRACTIONS.map((f) => Math.round(f * revLimit));
    // Neutral → 1st happens once RPM clears a bit above idle — scales
    // with Idle RPM so a higher-idling engine still needs a deliberate
    // stab of throttle to leave neutral, not just its own idle lope.
    const neutralUpAt = Math.max(idleRpm + 200, Math.round(idleRpm * 1.5));

    const gears = [
      { label: 'N', upAt: neutralUpAt, downAt: null },
      // 1st–4th upAt equal that gear's own rev-limiter ceiling — AUTO
      // holds each gear out to (essentially) its own redline before
      // shifting, same ceiling MANUAL respects — a shift happens right
      // as the limiter would've started cutting fuel anyway.
      { label: '1', upAt: upAtArr[0], downAt: null },
      { label: '2', upAt: upAtArr[1], downAt: safeDownAt(upAtArr[0], 2) },
      { label: '3', upAt: upAtArr[2], downAt: safeDownAt(upAtArr[1], 3) },
      { label: '4', upAt: upAtArr[3], downAt: safeDownAt(upAtArr[2], 4) },
      { label: '5', upAt: upAtArr[4], downAt: safeDownAt(upAtArr[3], 5) },
      { label: '6', upAt: null, downAt: safeDownAt(upAtArr[4], 6) },
    ];

    // Per-gear fuel-cut ceiling RPMSimulator actually enforces (see
    // rpm-simulator.js currentRevLimit()) — 1st–4th match their own
    // upAt exactly (AUTO shifts you out before you'd ever reach it),
    // 5th gets a little headroom past its upAt (manual-mode-only, same
    // 1.0625x the original 8000→8500 ratio used), neutral and 6th (top
    // gear) both use the engine's true ceiling.
    const gearRevLimitRpm = [
      revLimit,
      upAtArr[0],
      upAtArr[1],
      upAtArr[2],
      upAtArr[3],
      Math.round(upAtArr[4] * 1.0625),
      revLimit,
    ];

    return { gears, revLimit, gearRevLimitRpm };
  }

  let GEARS = buildGears(IDLE_RPM, REDLINE_RPM, MAX_RPM).gears;
  let MAX_GEAR_INDEX = GEARS.length - 1;

  // How long (ms) the gearbox "locks" after any shift before it will
  // shift again — models clutch/synchro engagement time. This is what
  // turns an instant snap into a believable brief pause between shifts.
  // RPMSimulator's dip now ends dynamically (the instant it reaches its
  // target — see dipActive in rpm-simulator.js), which for the shallow
  // low-gear fractions is well under this window, so this lock is
  // comfortably long enough for the dip to have already finished
  // settling by the time it releases — the safeDownAt() margin above
  // only holds if that's true.
  const SHIFT_LOCK_MS = 550;

  // ---- TURBO / BOOST MODEL ----------------------------------------------
  // Boost is now a small physics simulation of its own, not a one-line
  // formula off throttle alone — it follows the same "approach a target
  // at a capped rate" pattern RPMSimulator uses for RPM and the speed
  // display above use for speed, so it's deterministic (no
  // Math.random()) and frame-rate independent (driven by dtSeconds).
  //
  // Two separate quantities, on purpose:
  //   spoolFraction  — how "spun up" the turbo/supercharger currently is
  //                     (0..1). This is turbine/rotor INERTIA: it persists
  //                     for a moment even after you lift off the throttle,
  //                     exactly like a real turbo keeps spinning briefly.
  //   boostBar       — actual manifold pressure right now. Gated by
  //                     THROTTLE on top of spoolFraction: lifting off the
  //                     gas vents accumulated pressure near-instantly
  //                     (wastegate/blow-off valve opening) even while the
  //                     turbine is still spooled — which is exactly what
  //                     produces the classic "still spinning, but boost
  //                     just dumped" blow-off moment, and is what
  //                     triggerBlowOffIfNeeded() below listens for.
  //
  // ENGINE CONFIGURATION (from VEHICLE SETUP) changes THREE things here:
  //   inductionType — na engines never build boost at all; turbo/twin
  //                   need RPM (exhaust flow) as well as throttle to
  //                   spool; twin spools faster than a single turbo of
  //                   the same size; super (supercharger) is belt-driven
  //                   off the crank, so it tracks RPM almost immediately
  //                   with no exhaust-flow lag.
  //   turboSizeFrac — bigger turbo (closer to 1) spools slower (more lag)
  //                   in exchange for a higher realistic ceiling; smaller
  //                   spools fast but is easier to overwhelm. Only
  //                   affects spool RATE, not the boost ceiling itself —
  //                   the ceiling is MAX_BOOST_BAR, set independently.
  //   MAX_BOOST_BAR — the ceiling spoolFraction × throttle gate scales
  //                   against.
  const BLOWOFF_THRESHOLD_BAR = 0.15;  // boost has to have been at least this high…
  const BLOWOFF_THROTTLE_DROP = 0.18;  // …and throttle has to drop at least this much in one frame to count as a lift, not just easing off gently
  const BLOWOFF_COOLDOWN_MS = 350;     // minimum gap between two blow-off events, so one hard lift can't fire it twice off two consecutive frames
  let INDUCTION_TYPE = 'turbo';        // 'na' | 'turbo' | 'twin' | 'super'
  let turboSizeFrac = 0.55;            // 0..1, from VEHICLE SETUP's turboSize (%)

  let spoolFraction = 0;
  let boostBar = 0;
  let prevThrottleFracForBoost = 0;
  let blowOffCooldownUntil = 0;
  let blowOffEventId = 0;   // incremented once per detected blow-off — AudioEngine edge-detects on this
  let shiftEventId = 0;     // incremented once per real gear-to-gear shift — AudioEngine edge-detects on this

  function approachClamped(current, target, ratePerSec, dtSeconds) {
    const maxStep = Math.max(0, ratePerSec) * dtSeconds;
    if (current < target) return Math.min(target, current + maxStep);
    if (current > target) return Math.max(target, current - maxStep);
    return current;
  }

  /** How hard the turbine/rotor is being asked to spin, 0..1, given
   *  current throttle + RPM. This is the "demand" spoolFraction chases —
   *  NOT the boost pressure itself (see comment block above). */
  function spoolDemand(throttleFraction, rpmFraction) {
    if (INDUCTION_TYPE === 'na') return 0;
    if (INDUCTION_TYPE === 'super') {
      // Belt-driven off the crank: demand tracks RPM directly, throttle
      // only gates whether the manifold is actually being asked to build
      // pressure (closed throttle = no load even at high RPM).
      return clamp(throttleFraction * (0.20 + 0.80 * rpmFraction), 0, 1);
    }
    // turbo / twin: needs BOTH throttle (load) and RPM (exhaust gas flow)
    // — full throttle at low RPM still spools slowly, which is the
    // classic low-rpm turbo-lag feel this weighting produces.
    return clamp(throttleFraction * (0.35 + 0.65 * rpmFraction), 0, 1);
  }

  /** Rate (fraction of full spool per second) spoolFraction is allowed
   *  to move toward its demand this frame — asymmetric (rising slower
   *  than falling, same idea as throttle ramp / RPM accel-decel). */
  function spoolRate(rising) {
    if (INDUCTION_TYPE === 'super') {
      // No real exhaust-flow lag — near-instant either direction.
      return rising ? 9.0 : 9.0;
    }
    const sizeDrag = 0.35 + turboSizeFrac; // bigger turbo => smaller denominator below => slower
    const twinBonus = INDUCTION_TYPE === 'twin' ? 1.6 : 1.0; // smaller individual turbines spool faster
    const base = rising ? 2.6 : 4.2; // falling (spooling down) is quicker than spooling up
    return (base * twinBonus) / sizeDrag;
  }

  /** Advances the turbo/boost model by one physics tick. Pure state
   *  update (spoolFraction, boostBar, blow-off detection) — mirrors the
   *  RPM/speed pattern elsewhere in this file: no Math.random(), driven
   *  only by throttle/RPM/dtSeconds/engine configuration. */
  function stepBoost(throttleFraction, rpmFraction, dtSeconds, engineOn) {
    if (!engineOn || INDUCTION_TYPE === 'na') {
      spoolFraction = approachClamped(spoolFraction, 0, spoolRate(false), dtSeconds);
      boostBar = 0;
      prevThrottleFracForBoost = throttleFraction;
      return;
    }

    const demand = spoolDemand(throttleFraction, rpmFraction);
    const rising = demand >= spoolFraction;
    spoolFraction = approachClamped(spoolFraction, demand, spoolRate(rising), dtSeconds);

    // Throttle gate: manifold pressure needs the throttle plate open to
    // hold boost — closing it (even with the turbine still spun up)
    // vents pressure fast, via the wastegate/BOV. Smoothstep so it's not
    // a hard on/off snap.
    const gateT = clamp((throttleFraction - 0.10) / 0.35, 0, 1);
    const throttleGate = gateT * gateT * (3 - 2 * gateT);
    const targetBoost = spoolFraction * MAX_BOOST_BAR * throttleGate;

    // Boost pressure itself reacts a bit faster than the turbine's own
    // inertia (it's just gas filling/venting a manifold, not a spinning
    // mass), especially on the way down — that gap between "boost drops
    // fast" and "spoolFraction drops slower" is exactly what makes a
    // blow-off event read as physically real rather than a mute cut.
    const boostRisePerSec = MAX_BOOST_BAR * 3.2;
    const boostFallPerSec = MAX_BOOST_BAR * 7.0;
    boostBar = approachClamped(
      boostBar,
      targetBoost,
      targetBoost >= boostBar ? boostRisePerSec : boostFallPerSec,
      dtSeconds
    );

    triggerBlowOffIfNeeded(throttleFraction);
    prevThrottleFracForBoost = throttleFraction;
  }

  /** Detects a hard throttle lift while meaningful boost is present and
   *  fires a one-shot blow-off event (via blowOffEventId — AudioEngine
   *  watches for this counter changing, same pattern as shiftEventId).
   *  Superchargers don't have a blow-off valve in the same dramatic
   *  sense a turbo does, so this only fires for turbo/twin. */
  function triggerBlowOffIfNeeded(throttleFraction) {
    if (INDUCTION_TYPE !== 'turbo' && INDUCTION_TYPE !== 'twin') return;
    const throttleDrop = prevThrottleFracForBoost - throttleFraction;
    if (
      boostBar >= BLOWOFF_THRESHOLD_BAR &&
      throttleDrop >= BLOWOFF_THROTTLE_DROP &&
      now() >= blowOffCooldownUntil
    ) {
      blowOffEventId += 1;
      blowOffCooldownUntil = now() + BLOWOFF_COOLDOWN_MS;
    }
  }

  /** Marks a real gear-to-gear shift for AudioEngine's gear-shift sound
   *  (edge-detected off shiftEventId, same pattern as blow-off) AND
   *  triggers RPMSimulator's RPM dip — replaces every direct
   *  RPMSimulator.triggerShiftDip() call site so the two can never fall
   *  out of sync (a shift dip without a shift sound, or vice versa). */
  function signalShiftEvent() {
    shiftEventId += 1;
    RPMSimulator.triggerShiftDip();
  }

  let state = {
    status: 'off',        // 'off' | 'idle' | 'running' | 'redline'
    engineOn: false,
    rpmK: 0,
    rpm: 0,
    throttlePercent: 0,
    gear: 'N',
    gearIndex: 0,
    gearMode: 'auto',      // 'auto' | 'manual'
    shifting: false,       // true during the brief shift-lock window
    canShiftUp: false,
    canShiftDown: false,
    speedKmh: 0,
    engineTempC: AMBIENT_TEMP_C,
    boostBar: 0,
    maxBoostBar: MAX_BOOST_BAR,
    turboSpoolFraction: 0,
    inductionType: INDUCTION_TYPE,
    blowOffEventId: 0,
    gearShiftEventId: 0,
    inRedline: false,
    revLimiting: false,
    maxRpmK: MAX_RPM / 1000,
    redlineStartK: REDLINE_RPM / 1000,
    maxSpeedKmh: MAX_SPEED_KMH,
    // PERFORMANCE MODE additions — see torqueCurveFraction()/computeCurve()
    // above for how these are derived.
    torqueNm: 0,
    powerHp: 0,
    powerKw: 0,
    paused: false,
  };

  // Internal gearbox state, separate from the public snapshot above so
  // stepGear() has somewhere to keep the shift-lock timer without it
  // leaking into every EngineState.getState() consumer.
  let gearIndex = 0;
  let gearMode = 'auto'; // 'auto' | 'manual'
  let shiftLockUntil = 0; // performance.now() timestamp

  // ---- Displayed-speed smoothing -------------------------------------
  // Speed is derived per-gear via Gearbox.speedForRpm(), so the instant a
  // shift completes, the SAME rpm maps to a different speed ceiling in
  // the new gear — road speed can't actually pop like that just because
  // the engine picked a new ratio. Rate-limiting the DISPLAYED number
  // (same "approach toward a target at a capped rate" pattern
  // RPMSimulator already uses for RPM itself) smooths that pop out
  // without touching the underlying formula, so a shift reads as a
  // hand-off instead of a jump — noticeable on both an accelerating
  // upshift and a coasting/throttle-release downshift.
  const SPEED_DISPLAY_RATE_KMH_PER_S = 260;
  let displaySpeedKmh = 0;
  let lastSpeedTs = null;

  function approachSpeed(current, target, dtSeconds) {
    const maxStep = SPEED_DISPLAY_RATE_KMH_PER_S * dtSeconds;
    if (current < target) return Math.min(target, current + maxStep);
    if (current > target) return Math.max(target, current - maxStep);
    return current;
  }

  const listeners = new Set();

  function notify() {
    listeners.forEach((fn) => fn({ ...state }));
  }

  function subscribe(fn) {
    listeners.add(fn);
    fn({ ...state });
    return () => listeners.delete(fn);
  }

  function getState() {
    return { ...state };
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function isShiftLocked() {
    return now() < shiftLockUntil;
  }

  function engageShiftLock() {
    shiftLockUntil = now() + SHIFT_LOCK_MS;
  }

  /**
   * Advances the gearbox state machine by at most one gear per call,
   * given the current RPM. Called every simulation frame in auto mode;
   * in manual mode this is skipped entirely (see deriveFromFrame) and
   * shiftUp()/shiftDown() are the only things that can move gearIndex.
   *
   * Why not a plain lookup table? A pure "gearForRpm(rpm)" function is
   * stateless, so at a shift boundary (say exactly 3500rpm) any tiny
   * RPM wobble flips the gear back and forth every single frame — no
   * delay, no hysteresis, it just mirrors whatever rpm currently is.
   * This function instead only evaluates "should I shift" using the
   * boundary appropriate to the *current* gear, applies at most one
   * shift, and then locks out further shifts for SHIFT_LOCK_MS — so a
   * shift always reads as one deliberate step-then-pause, not a flicker.
   */
  function stepGear(rpm, engineOn) {
    if (!engineOn) {
      gearIndex = 0;
      return;
    }
    if (isShiftLocked()) return;

    const current = GEARS[gearIndex];

    if (current.upAt !== null && rpm >= current.upAt && gearIndex < MAX_GEAR_INDEX) {
      const enteringFromNeutral = gearIndex === 0;
      gearIndex += 1;
      RPMSimulator.setGear(gearIndex);
      if (enteringFromNeutral) {
        // Engaging 1st from a standing start isn't a shift BETWEEN two
        // already-spinning gears — there's no established drivetrain
        // motion to interrupt, so it shouldn't cost the same
        // clutch/synchro jeda (pause) or RPM dip a real gear-to-gear
        // shift does. Gas it and it's straight into 1st; the normal
        // shift-lock/dip machinery only kicks in starting with the
        // 1st→2nd shift and up.
      } else {
        engageShiftLock();
        signalShiftEvent();
      }
      return;
    }

    if (current.downAt !== null && rpm < current.downAt && gearIndex > 1) {
      gearIndex -= 1;
      engageShiftLock();
      RPMSimulator.setGear(gearIndex);
      signalShiftEvent();
      return;
    }

    // Falling back to neutral: only from 1st gear, once RPM has coasted
    // down close to idle. 1st has no downAt (it holds all the way to
    // idle rather than downshifting into a lower gear), so this special
    // case is what returns the gearbox to N.
    if (gearIndex === 1 && rpm <= IDLE_RPM + 50) {
      gearIndex = 0;
      engageShiftLock();
      RPMSimulator.setGear(gearIndex);
      // No triggerShiftDip() here on purpose: coasting to a stop and
      // settling into neutral isn't a driver-initiated shift event, it's
      // just running out of RPM — there's no clutch snap to model, RPM
      // is already right at idle with nowhere further to dip.
    }
  }

  /** Deterministic placeholder gear lookup from current RPM (legacy — kept
   *  only as a fallback reference for manual-mode display math, no longer
   *  used to drive shifts directly). */
  function gearForRpm(rpm) {
    if (rpm <= IDLE_RPM + 50) return 'N';
    if (rpm < 2000) return '1';
    if (rpm < 3500) return '2';
    if (rpm < 5000) return '3';
    if (rpm < 6500) return '4';
    if (rpm < 8000) return '5';
    return '6';
  }

  /**
   * Recomputes every derived telemetry field from a fresh RPMSimulator
   * frame. Pure aside from the gearbox step, which is intentionally
   * stateful (see stepGear above) — everything else here still follows
   * the same input-in/output-out shape as before.
   */
  function deriveFromFrame(frame) {
    const rpmFraction = frame.rpm / MAX_RPM;
    const inRedline = frame.rpm >= REDLINE_RPM;

    state.engineOn = frame.engineOn;
    state.rpm = frame.rpm;
    state.rpmK = frame.rpmK;
    state.throttlePercent = frame.throttlePercent;
    state.revLimiting = frame.revLimiting;
    state.inRedline = inRedline;
    state.paused = !!frame.paused;

    // ---- PERFORMANCE MODE: instantaneous torque / power -----------------
    // Full-throttle curve value at this RPM, blended down toward an idle
    // load floor by how far off-throttle we currently are — see the
    // TORQUE_THROTTLE_FLOOR comment above computeCurve() for why this
    // isn't just "curve value × throttle%" (that would read as ~0 torque
    // at idle, which isn't right — an idling engine still has torque, it
    // just isn't being asked to use much of it).
    if (frame.engineOn) {
      const throttleFrac = frame.throttlePercent / 100;
      const loadFactor = TORQUE_THROTTLE_FLOOR + (1 - TORQUE_THROTTLE_FLOOR) * throttleFrac;
      const curveFrac = torqueCurveFraction(frame.rpm);
      state.torqueNm = Math.round(peakTorqueNm * curveFrac * loadFactor);
      state.powerHp = Math.round((state.torqueNm * frame.rpm) / 7127);
      state.powerKw = Math.round(state.powerHp * 0.7457 * 10) / 10;
    } else {
      state.torqueNm = 0;
      state.powerHp = 0;
      state.powerKw = 0;
    }

    if (!frame.engineOn) {
      gearIndex = 0;
    } else if (gearMode === 'auto' && !frame.starting) {
      // Skip auto-shift logic while the start-up rev flare (see
      // rpm-simulator.js) is playing out. BUG: the flare deliberately
      // revs RPM up to ~1650 to sell the "engine catching" moment, but
      // that's well above Neutral's own upAt (1200) — so the instant the
      // engine started, the gearbox saw "RPM past 1200" and silently
      // auto-upshifted out of N into 1st before the driver ever asked to
      // move, leaving SPEED reading a nonzero value while the gear badge
      // still looked like it should've stayed at N. Gear now only
      // reacts to RPM once the flare has finished settling into idle.
      stepGear(frame.rpm, frame.engineOn);
    }
    // In manual mode, gearIndex only ever changes via shiftUp()/shiftDown().

    state.gearIndex = gearIndex;
    state.gear = GEARS[gearIndex].label;
    state.gearMode = gearMode;
    // "shifting" reflects the actual RPM dip happening in RPMSimulator
    // (frame.shifting) OR-ed with our own shift-lock window — the dip
    // now usually finishes well before the 550ms lock does (it ends the
    // instant it bottoms out, not on a fixed timer), so this OR is what
    // keeps the indicator lit for the full, longer shift-lock pause
    // instead of dropping out early once the dip itself is done.
    state.shifting = frame.engineOn && (frame.shifting || isShiftLocked());
    state.canShiftUp = frame.engineOn && gearIndex < MAX_GEAR_INDEX && !isShiftLocked();
    state.canShiftDown = frame.engineOn && gearIndex > 0 && !isShiftLocked();

    // Speed now comes from real drivetrain math (Gearbox.speedForRpm),
    // not a per-gear ceiling lookup: gearIndex 0 (N) has no ratio, so
    // it's hard-locked to 0 regardless of RPM (see comment above and
    // the displaySpeedKmh branch below); every other gear's speed is
    // engineRpm run through that gear's actual ratio × final drive ×
    // wheel circumference × efficiency — so a given RPM in 1st and the
    // SAME RPM in 6th now correctly produce different, mechanically
    // real speeds, related through the gear ratio rather than an
    // arbitrary table.
    let targetSpeedKmh = 0;
    if (frame.engineOn && gearIndex > 0) {
      // Governor: VEHICLE SETUP's Top Speed caps the driven target
      // regardless of what the raw gear-ratio math would otherwise
      // produce — same as a real ECU/speed limiter cutting in.
      targetSpeedKmh = Math.min(Gearbox.speedForRpm(frame.rpm, gearIndex), MAX_SPEED_KMH);
    }

    const nowTs = now();
    const dtSeconds = lastSpeedTs === null ? 0 : Math.min((nowTs - lastSpeedTs) / 1000, 0.1);
    lastSpeedTs = nowTs;

    // ---- TURBO / BOOST — see stepBoost() above for the full model.
    // Same dtSeconds this tick's speed smoothing uses, so boost and
    // speed advance against the exact same slice of real time.
    stepBoost(frame.throttlePercent / 100, rpmFraction, dtSeconds, frame.engineOn);
    state.boostBar = Math.round(boostBar * 100) / 100;
    state.turboSpoolFraction = Math.round(spoolFraction * 1000) / 1000;
    state.inductionType = INDUCTION_TYPE;
    state.blowOffEventId = blowOffEventId;
    state.gearShiftEventId = shiftEventId;

    if (!frame.engineOn || gearIndex === 0) {
      // No drivetrain connection at all — either ignition off, or the
      // gearbox is in neutral. Snap straight to 0 rather than smoothing
      // the display down: the wheels are physically disconnected from
      // the engine the instant neutral is engaged (coasting to a stop
      // and dropping into N, or a manual shift down to N), same as when
      // the engine itself stops. BUG: this used to only check
      // frame.engineOn, so falling into neutral while the engine kept
      // running left the speed readout gliding down over ~1s through
      // the SPEED_DISPLAY_RATE_KMH_PER_S ramp instead of reading 0
      // immediately.
      displaySpeedKmh = 0;
    } else {
      displaySpeedKmh = approachSpeed(displaySpeedKmh, targetSpeedKmh, dtSeconds);
    }
    state.speedKmh = Math.round(displaySpeedKmh);
    state.engineTempC = frame.engineOn
      ? Math.round(AMBIENT_TEMP_C + rpmFraction * (OPERATING_TEMP_C - AMBIENT_TEMP_C))
      : AMBIENT_TEMP_C;

    if (!frame.engineOn) {
      state.status = 'off';
    } else if (frame.revLimiting) {
      state.status = 'redline';
    } else if (frame.rpm > IDLE_RPM + 50) {
      state.status = 'running';
    } else {
      state.status = 'idle';
    }

    notify();
  }

  function startEngine() {
    RPMSimulator.start();
    return getState();
  }

  function stopEngine() {
    RPMSimulator.stop();
    return getState();
  }

  /** PERFORMANCE MODE — Pause. Freezes RPMSimulator's loop (see
   *  rpm-simulator.js pause()) so every derived reading here simply stops
   *  receiving new frames and holds exactly where it was — gauges, the
   *  telemetry panel, and PerformanceMode's graphs all freeze together
   *  with no separate pause plumbing needed in any of them. */
  function pauseSimulation() {
    RPMSimulator.pause();
    state.paused = true;
    notify();
    return getState();
  }

  /** PERFORMANCE MODE — Resume from pause. */
  function resumeSimulation() {
    RPMSimulator.resume();
    state.paused = false;
    return getState();
  }

  /** PERFORMANCE MODE — Reset. Hard-resets RPMSimulator (RPM snaps to 0,
   *  engine off, not a coast-down) AND this module's own gearbox/speed/
   *  shift-lock state, so a RESET always returns to an identical, known
   *  baseline — gear N, 0 speed, 0 throttle, no residual shift-lock
   *  timer left over from before the reset. */
  function resetSimulation() {
    RPMSimulator.reset();
    gearIndex = 0;
    gearMode = 'auto';
    shiftLockUntil = 0;
    displaySpeedKmh = 0;
    lastSpeedTs = null;
    spoolFraction = 0;
    boostBar = 0;
    prevThrottleFracForBoost = 0;
    blowOffCooldownUntil = 0;
    state = {
      ...state,
      status: 'off',
      engineOn: false,
      rpmK: 0,
      rpm: 0,
      throttlePercent: 0,
      gear: 'N',
      gearIndex: 0,
      gearMode: 'auto',
      shifting: false,
      canShiftUp: false,
      canShiftDown: false,
      speedKmh: 0,
      engineTempC: AMBIENT_TEMP_C,
      boostBar: 0,
      turboSpoolFraction: 0,
      inRedline: false,
      revLimiting: false,
      torqueNm: 0,
      powerHp: 0,
      powerKw: 0,
      paused: false,
    };
    notify();
    return getState();
  }

  function setThrottle(percent) {
    RPMSimulator.setThrottle(percent);
    return getState();
  }

  /** Switches between 'auto' (gearbox shifts itself off RPM) and
   *  'manual' (only shiftUp()/shiftDown() move the gearbox). Switching
   *  INTO manual keeps whatever gear auto mode was already in — no
   *  jump — so the driver picks up exactly where the automatic left off. */
  function setGearMode(mode) {
    if (mode !== 'auto' && mode !== 'manual') return getState();
    gearMode = mode;
    return getState();
  }

  /** Manual upshift. No-op (and shift-lock still respected) if already
   *  in top gear, engine off, or mid-shift-lock from a previous shift —
   *  same physical shift-lock timer auto mode uses, so manual shifts
   *  feel exactly as deliberate/paced as automatic ones. Also triggers
   *  the same RPM dip as an automatic shift — a manual paddle/button
   *  shift still has a clutch/synchro moment in real life. */
  function shiftUp() {
    if (!state.engineOn || isShiftLocked()) return getState();
    if (gearIndex >= MAX_GEAR_INDEX) return getState();
    gearIndex += 1;
    engageShiftLock();
    RPMSimulator.setGear(gearIndex);
    signalShiftEvent();
    return getState();
  }

  /** Manual downshift. Never shifts below 1st into neutral from the
   *  paddle/button — neutral is only reached by coasting to idle in 1st,
   *  matching how a real sequential shifter behaves. Also dips RPM, same
   *  as shiftUp(). */
  function shiftDown() {
    if (!state.engineOn || isShiftLocked()) return getState();
    if (gearIndex <= 1) return getState();
    gearIndex -= 1;
    engageShiftLock();
    RPMSimulator.setGear(gearIndex);
    signalShiftEvent();
    return getState();
  }

  function init() {
    RPMSimulator.init();
    RPMSimulator.subscribe(deriveFromFrame);
    return getState();
  }

  function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
  }

  /**
   * The one place VEHICLE SETUP's 12 parameters actually reach the
   * simulation. Called by VehicleSetup (js/modules/vehicle-setup.js)
   * once at boot (with its defaults, a no-op vs. the original hand-tuned
   * behavior) and again every time the driver changes + validates a
   * field, or hits RESET SETUP.
   *
   * `setup` shape: { weightKg, enginePowerHp, torqueNm, idleRpm,
   * redlineRpm, maxRpm, gearRatios: [r1..r6], finalDrive, wheelRadiusCm,
   * throttleResponse (0–100), engineBraking (0–100), topSpeedKmh }
   *
   * Everything here is deterministic arithmetic on the inputs — no
   * Math.random(), same principle every other module in REVLAB follows.
   */
  function applyVehicleSetup(setup) {
    IDLE_RPM = setup.idleRpm;
    REDLINE_RPM = setup.redlineRpm;
    MAX_RPM = setup.maxRpm;
    MAX_SPEED_KMH = setup.topSpeedKmh;
    peakTorqueNm = setup.torqueNm;

    // ---- Engine configuration → turbo/boost model (see stepBoost() above) --
    INDUCTION_TYPE = setup.inductionType || 'na';
    turboSizeFrac = clamp((setup.turboSize ?? 55) / 100, 0, 1);
    MAX_BOOST_BAR = Math.max(0, setup.maxBoostBar ?? 0);

    const built = buildGears(IDLE_RPM, REDLINE_RPM, MAX_RPM);
    GEARS = built.gears;
    MAX_GEAR_INDEX = GEARS.length - 1;
    // Keep the current gear in range in the (currently impossible, but
    // cheap to guard) case the gear count ever changes.
    if (gearIndex > MAX_GEAR_INDEX) gearIndex = MAX_GEAR_INDEX;

    // ---- Performance factor: Weight / Engine Power / Torque → accel ----
    // Power and torque both raise the accel rate, lighter weight raises
    // it too (more power-to-weight); weighted blend so no single number
    // dominates. Clamped to a sane multiplier band so extreme setup
    // values (e.g. 60hp + 3000kg) slow the sim down a lot without ever
    // fully freezing the needle or making it snap instantly.
    const powerFactor = setup.enginePowerHp / BASELINE_POWER_HP;
    const torqueFactor = setup.torqueNm / BASELINE_TORQUE_NM;
    const weightFactor = BASELINE_WEIGHT_KG / setup.weightKg;
    const perfFactor = clamp(
      powerFactor * 0.40 + torqueFactor * 0.35 + weightFactor * 0.25,
      0.25,
      3.5
    );
    const accelRateBase = Math.round(3450 * perfFactor);

    // ---- Engine Braking (0–100) → decel / spindown rate ----
    // Linear ramps chosen so the DEFAULT (50) reproduces RPMSimulator's
    // original hand-tuned DECEL/SPINDOWN rates exactly.
    const decelRate = Math.round(300 + setup.engineBraking * 24);   // 0→300, 50→1500, 100→2700
    const spindownRate = Math.round(500 + setup.engineBraking * 30); // 0→500, 50→2000, 100→3500

    RPMSimulator.configure({
      idleRpm: IDLE_RPM,
      maxRpm: MAX_RPM,
      redlineRpm: REDLINE_RPM,
      revLimitRpm: built.revLimit,
      accelRateBase,
      decelRate,
      spindownRate,
      gearRevLimitRpm: built.gearRevLimitRpm,
    });
    RPMSimulator.setGear(gearIndex);

    Gearbox.configure({
      gearRatios: setup.gearRatios,
      finalDriveRatio: setup.finalDrive,
      wheelRadiusCm: setup.wheelRadiusCm,
    });

    // ---- Throttle Response (0–100) → pedal ramp rate ----
    // Chosen so the DEFAULT (60) reproduces ThrottleController's
    // original 260 (up) / 190 (down) %/s ramp exactly.
    const rampUpRate = 40 + setup.throttleResponse * (220 / 60);
    ThrottleController.configure({
      rampUpRate,
      rampDownRate: rampUpRate * (190 / 260),
    });

    // Keep the public snapshot's dial-scale fields in sync immediately
    // (rather than waiting for the next RPMSimulator frame) so the
    // gauges can rescale the instant Setup is applied, even while the
    // engine is off and no frames are ticking.
    state.maxRpmK = MAX_RPM / 1000;
    state.redlineStartK = REDLINE_RPM / 1000;
    state.maxSpeedKmh = MAX_SPEED_KMH;
    state.maxBoostBar = MAX_BOOST_BAR;
    state.inductionType = INDUCTION_TYPE;

    notify();
    return getState();
  }

  /** Live read of the drivetrain spec panel numbers — a function (not a
   *  cached property) because Gearbox's values can change at runtime via
   *  applyVehicleSetup() above. */
  function getDrivetrainSpec() {
    return {
      gearRatios: Gearbox.getGearRatios(),
      finalDriveRatio: Gearbox.getFinalDrive(),
      wheelCircumferenceM: Gearbox.getWheelCircumference(),
      drivetrainEfficiency: Gearbox.getDrivetrainEfficiency(),
    };
  }

  return {
    init,
    subscribe,
    getState,
    startEngine,
    stopEngine,
    pauseSimulation,
    resumeSimulation,
    resetSimulation,
    setThrottle,
    setGearMode,
    shiftUp,
    shiftDown,
    applyVehicleSetup,
    getDrivetrainSpec,
    getTorqueCurve: computeCurve,
    getMaxSpeedKmh: () => MAX_SPEED_KMH,
    KMH_PER_MPH,
  };
})();
