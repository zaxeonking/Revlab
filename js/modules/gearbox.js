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
  const GEAR_RATIOS = [null, 3.850, 2.615, 1.929, 1.529, 1.276, 1.061];

  // Single final-drive (differential) ratio applied after the gearbox,
  // same for every gear — matches how a real drivetrain is laid out
  // (one differential, N gear ratios ahead of it).
  const FINAL_DRIVE_RATIO = 3.900;

  // Rolling circumference of the driven wheel, in meters — this is what
  // actually converts "wheel revolutions" into "distance travelled".
  // 1.98m corresponds to a roughly 205/55R16-sized tire.
  const WHEEL_CIRCUMFERENCE_M = 1.98;

  // Fixed mechanical-loss factor (belt/gear friction, etc.) between the
  // flywheel and the road. Applied as a flat multiplier on the final
  // speed number — it's a deterministic derating, not slip or randomness,
  // so the same RPM in the same gear always yields the same (slightly
  // discounted) speed.
  const DRIVETRAIN_EFFICIENCY = 0.92;

  const KMH_PER_WHEEL_RPM_PER_METER = 0.06; // 60 min/h ÷ 1000 m/km

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

  return {
    GEAR_RATIOS,
    FINAL_DRIVE_RATIO,
    WHEEL_CIRCUMFERENCE_M,
    DRIVETRAIN_EFFICIENCY,
    gearRatioFor,
    totalReductionFor,
    speedForRpm,
    rpmForSpeed,
  };
})();
