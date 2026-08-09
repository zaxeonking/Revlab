/**
 * REVLAB — gearbox.js
 * -----------------------------------------------------------------------
 * Pure, stateless drivetrain math. This is the ONLY place the formula
 * that ties engine RPM to road speed lives — previously (see git
 * history / README) engine-state.js used a flat per-gear "speed
 * ceiling" lookup table (GEAR_MAX_SPEED_KMH) with no real mechanical
 * relationship to RPM at all. That's replaced here with an actual
 * gear-ratio chain:
 *
 *   engineRPM → (gear ratio × final drive) → wheel RPM → (wheel
 *   circumference) → road speed → (drivetrain efficiency) → displayed
 *   speed
 *
 * Concretely:
 *   wheelRPM  = engineRPM / (gearRatio × finalDrive)
 *   speedKmh  = wheelRPM × wheelCircumferenceM × 0.06 × drivetrainEfficiency
 *               (the 0.06 folds in "m/min → km/h": ×60 min/h, ÷1000 m/km)
 *
 * gearRatio × finalDrive is exactly the total reduction between engine
 * and wheel — a real transmission spec, not a curve fitted to look
 * right. RPM and speed are therefore ALWAYS in a fixed, deterministic
 * ratio to each other for whichever gear is engaged: no Math.random(),
 * no independent timer, nothing here can produce a speed that doesn't
 * correspond to the current RPM (or vice versa — rpmForSpeed() is the
 * exact inverse of speedForRpm(), see below).
 *
 * Neutral (gearIndex 0) has no ratio at all — there is no mechanical
 * path from engine to wheels, which is why speedForRpm() returns 0 for
 * it regardless of RPM (and why engine-state.js separately hard-locks
 * displayed speed to 0 in neutral rather than letting this formula
 * produce a number for a gear that doesn't exist).
 *
 * This module owns none of the vehicle STATE (current gear, current
 * RPM) — engine-state.js still owns that, exactly as before. It only
 * owns the fixed spec numbers and the conversion math, so the same
 * formula can't drift into two different implementations in two
 * different files.
 * -----------------------------------------------------------------------
 */

const Gearbox = (() => {
  // Index 0 = Neutral (no ratio — see file header). Indices 1–6 are
  // 1st–6th gear. Numerically higher ratio = more mechanical advantage
  // = more torque, less speed per engine RPM (1st); numerically lower
  // ratio = less torque, more speed per RPM (6th, "overdrive"-ish).
  // Descending across the array is what makes each successive gear
  // "taller" than the last, same as a real manual gearbox.
  //
  // These used to be fixed constants. They're now mutable, driven by
  // the VEHICLE SETUP panel (js/modules/vehicle-setup.js) — configure()
  // below is the single place that writes to them, so speedForRpm() /
  // rpmForSpeed() always use whatever spec the driver has dialed in.
  // DEFAULT_* is kept so VehicleSetup / a "Reset Setup" action always
  // has a known-good baseline to fall back to.
  const DEFAULT_GEAR_RATIOS = [null, 3.850, 2.615, 1.929, 1.529, 1.276, 1.061];
  const DEFAULT_FINAL_DRIVE_RATIO = 3.900;
  const DEFAULT_WHEEL_RADIUS_CM = 31.5; // → circumference ≈ 1.98m (205/55R16-ish)

  let GEAR_RATIOS = DEFAULT_GEAR_RATIOS.slice();
  let FINAL_DRIVE_RATIO = DEFAULT_FINAL_DRIVE_RATIO;
  let WHEEL_CIRCUMFERENCE_M = 2 * Math.PI * (DEFAULT_WHEEL_RADIUS_CM / 100);

  // Fixed mechanical-loss factor (belt/gear friction, etc.) between the
  // flywheel and the road. Applied as a flat multiplier on the final
  // speed number — it's a deterministic derating, not slip or randomness,
  // so the same RPM in the same gear always yields the same (slightly
  // discounted) speed. Not part of the VEHICLE SETUP parameter list, so
  // this one stays a fixed constant.
  const DRIVETRAIN_EFFICIENCY = 0.92;

  const KMH_PER_WHEEL_RPM_PER_METER = 0.06; // 60 min/h ÷ 1000 m/km

  /**
   * Applies a new drivetrain spec from VEHICLE SETUP. All inputs are
   * expected to already be validated/clamped (see vehicle-setup.js) —
   * this function just adopts them; it doesn't re-validate ranges.
   *   gearRatios     — array of 6 numbers (1st→6th), null entries kept
   *                     out; index 0 (neutral) is always forced to null.
   *   finalDriveRatio — single number
   *   wheelRadiusCm   — wheel radius in cm; converted to circumference
   */
  function configure({ gearRatios, finalDriveRatio, wheelRadiusCm } = {}) {
    if (Array.isArray(gearRatios) && gearRatios.length === 6) {
      GEAR_RATIOS = [null, ...gearRatios.map((r) => Number(r))];
    }
    if (typeof finalDriveRatio === 'number' && finalDriveRatio > 0) {
      FINAL_DRIVE_RATIO = finalDriveRatio;
    }
    if (typeof wheelRadiusCm === 'number' && wheelRadiusCm > 0) {
      WHEEL_CIRCUMFERENCE_M = 2 * Math.PI * (wheelRadiusCm / 100);
    }
  }

  function gearRatioFor(gearIndex) {
    return GEAR_RATIOS[gearIndex] !== undefined ? GEAR_RATIOS[gearIndex] : null;
  }

  /** Total reduction from engine crank to wheel for a given gear, or
   *  null for neutral (no mechanical path exists). */
  function totalReductionFor(gearIndex) {
    const ratio = gearRatioFor(gearIndex);
    if (ratio === null) return null;
    return ratio * FINAL_DRIVE_RATIO;
  }

  /** Deterministic RPM → speed(km/h) for a given engaged gear. Returns
   *  0 for neutral (index 0) or any unknown gear index — no mechanical
   *  link means no derived speed, never a random or stale one. */
  function speedForRpm(engineRpm, gearIndex) {
    const reduction = totalReductionFor(gearIndex);
    if (reduction === null || reduction <= 0) return 0;
    const wheelRpm = engineRpm / reduction;
    return wheelRpm * WHEEL_CIRCUMFERENCE_M * KMH_PER_WHEEL_RPM_PER_METER * DRIVETRAIN_EFFICIENCY;
  }

  /** Exact inverse of speedForRpm() — the engine RPM that would be
   *  needed to hold a given road speed in a given gear. Not currently
   *  called by the simulation loop (RPM stays the master signal, driven
   *  by RPMSimulator's throttle/inertia physics — see that file's
   *  header for why), but kept here as the literal other half of the
   *  RPM↔speed relationship, and useful for future features (e.g.
   *  "what RPM will I land at after this downshift"). Returns null for
   *  neutral, same reasoning as totalReductionFor(). */
  function rpmForSpeed(speedKmh, gearIndex) {
    const reduction = totalReductionFor(gearIndex);
    if (reduction === null) return null;
    const wheelRpm = speedKmh / (WHEEL_CIRCUMFERENCE_M * KMH_PER_WHEEL_RPM_PER_METER * DRIVETRAIN_EFFICIENCY);
    return wheelRpm * reduction;
  }

  // Exposed as functions, not plain properties — GEAR_RATIOS/
  // FINAL_DRIVE_RATIO/WHEEL_CIRCUMFERENCE_M above are *reassigned* (not
  // mutated in place) by configure(), so a property captured once at
  // module-load time (the old `GEAR_RATIOS: GEAR_RATIOS` shorthand)
  // would silently go stale after the first Vehicle Setup change.
  // Callers that want live values must call these, not cache the array.
  return {
    getGearRatios: () => GEAR_RATIOS,
    getFinalDrive: () => FINAL_DRIVE_RATIO,
    getWheelCircumference: () => WHEEL_CIRCUMFERENCE_M,
    getDrivetrainEfficiency: () => DRIVETRAIN_EFFICIENCY,
    DEFAULT_GEAR_RATIOS,
    DEFAULT_FINAL_DRIVE_RATIO,
    DEFAULT_WHEEL_RADIUS_CM,
    configure,
    gearRatioFor,
    totalReductionFor,
    speedForRpm,
    rpmForSpeed,
  };
})();
