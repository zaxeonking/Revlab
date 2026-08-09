/**
 * REVLAB — vehicle-setup.js
 * -----------------------------------------------------------------------
 * Owns the VEHICLE SETUP panel's data: the 12 tunable parameters, their
 * min/max validation, defaults (for RESET SETUP), and pub/sub so the UI
 * can re-render form fields whenever a value is set or reset.
 *
 * This module does NOT touch the DOM and does NOT know about
 * RPMSimulator / Gearbox / ThrottleController directly — every time a
 * parameter is validated and stored, it hands the FULL current parameter
 * set to EngineState.applyVehicleSetup(), which is the single place that
 * translates "Weight 1400kg / Engine Power 480hp / ..." into the actual
 * physics constants those other modules run on (see engine-state.js).
 * That keeps this file a plain data+validation model, same separation of
 * concerns as EngineState is to RPMSimulator.
 *
 * Every parameter here maps to something that visibly changes the
 * simulation:
 *   weightKg         → accel rate (heavier = slower to rev/accelerate)
 *   enginePowerHp     → accel rate (more power = faster to rev)
 *   torqueNm          → accel rate (more torque = faster to rev)
 *   idleRpm           → RPM the engine settles to off-throttle
 *   redlineRpm        → gauge redline zone + gear upshift points
 *   maxRpm            → absolute fuel-cut ceiling + gauge face scale
 *   gearRatios (×6)   → RPM↔speed relationship per gear (Gearbox)
 *   finalDrive        → RPM↔speed relationship, all gears (Gearbox)
 *   wheelRadiusCm     → RPM↔speed relationship, all gears (Gearbox)
 *   throttleResponse  → how fast the pedal ramp reaches 100%
 *   engineBraking     → how fast RPM falls off-throttle / on shutdown
 *   topSpeedKmh       → hard speed governor + speedometer dial scale
 *
 * At DEFAULTS, every one of those reproduces the exact hand-tuned numbers
 * RPMSimulator / Gearbox / ThrottleController shipped with before this
 * panel existed — dialing anything away from default is what makes the
 * difference audible/visible in the sim, not the mere existence of the
 * panel.
 * -----------------------------------------------------------------------
 */

const VehicleSetup = (() => {
  // ---- Parameter specs (single source of truth for the form + validation) ----
  // decimals controls both step rounding and how the UI formats the value.
  const PARAMS = {
    weightKg: {
      label: 'WEIGHT', unit: 'KG', group: 'engine',
      min: 700, max: 3000, step: 10, decimals: 0, default: 1350,
    },
    enginePowerHp: {
      label: 'ENGINE POWER', unit: 'HP', group: 'engine',
      min: 60, max: 1200, step: 5, decimals: 0, default: 420,
    },
    torqueNm: {
      label: 'TORQUE', unit: 'NM', group: 'engine',
      min: 60, max: 1400, step: 5, decimals: 0, default: 430,
    },
    idleRpm: {
      label: 'IDLE RPM', unit: 'RPM', group: 'engine',
      min: 500, max: 1500, step: 50, decimals: 0, default: 800,
    },
    redlineRpm: {
      label: 'REDLINE RPM', unit: 'RPM', group: 'engine',
      min: 4000, max: 11000, step: 100, decimals: 0, default: 7500,
    },
    maxRpm: {
      label: 'MAX RPM', unit: 'RPM', group: 'engine',
      min: 4500, max: 12000, step: 100, decimals: 0, default: 9000,
    },
    throttleResponse: {
      label: 'THROTTLE RESPONSE', unit: '%', group: 'engine',
      min: 0, max: 100, step: 1, decimals: 0, default: 60,
    },
    engineBraking: {
      label: 'ENGINE BRAKING', unit: '%', group: 'engine',
      min: 0, max: 100, step: 1, decimals: 0, default: 50,
    },
    topSpeedKmh: {
      label: 'TOP SPEED', unit: 'KM/H', group: 'engine',
      min: 80, max: 400, step: 5, decimals: 0, default: 260,
    },
    finalDrive: {
      label: 'FINAL DRIVE', unit: ': 1', group: 'drivetrain',
      min: 2.0, max: 6.0, step: 0.01, decimals: 3, default: 3.900,
    },
    wheelRadiusCm: {
      label: 'WHEEL RADIUS', unit: 'CM', group: 'drivetrain',
      min: 22, max: 40, step: 0.5, decimals: 1, default: 31.5,
    },
  };

  // Gear ratios are one parameter with 6 slots (1st→6th), each with its
  // own min/max — modeled separately from PARAMS because they're an
  // array, not a scalar.
  const GEAR_RATIO_SPEC = {
    label: 'GEAR RATIOS', unit: '', group: 'drivetrain',
    min: 0.700, max: 5.500, step: 0.005, decimals: 3,
    defaults: [3.850, 2.615, 1.929, 1.529, 1.276, 1.061],
  };
  const GEAR_COUNT = 6;

  // Minimum gap enforced between idle/redline/max so the derived gear
  // table in EngineState.buildGears() always has room to work with —
  // without this a user could set redline = max and produce a gearbox
  // with no usable rev range.
  const MIN_IDLE_TO_REDLINE_GAP = 1500;
  const MIN_REDLINE_TO_MAX_GAP = 500;

  // ---- Current values (starts at defaults) ----
  let values = null;
  resetInternal();

  function resetInternal() {
    values = {};
    Object.keys(PARAMS).forEach((key) => { values[key] = PARAMS[key].default; });
    values.gearRatios = GEAR_RATIO_SPEC.defaults.slice();
  }

  const listeners = new Set();
  function notify(meta) {
    const snapshot = getAll();
    listeners.forEach((fn) => fn(snapshot, meta));
  }

  function subscribe(fn) {
    listeners.add(fn);
    fn(getAll(), { reason: 'subscribe' });
    return () => listeners.delete(fn);
  }

  function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }

  function clampToSpec(spec, rawValue) {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) {
      return { ok: false, value: spec.default, message: 'Nilai tidak valid — dikembalikan ke default.' };
    }
    if (n < spec.min) {
      return { ok: false, value: spec.min, message: `Di bawah minimum (${formatNum(spec.min, spec.decimals)}) — dibatasi ke minimum.` };
    }
    if (n > spec.max) {
      return { ok: false, value: spec.max, message: `Di atas maksimum (${formatNum(spec.max, spec.decimals)}) — dibatasi ke maksimum.` };
    }
    return { ok: true, value: round(n, spec.decimals), message: '' };
  }

  function formatNum(n, decimals) {
    return Number(n).toFixed(decimals);
  }

  /**
   * Validates + stores one scalar parameter (anything in PARAMS, not
   * gear ratios) and re-applies the whole setup to the simulation.
   * Returns { ok, value, message } — `value` is always the clamped,
   * final value stored (even when ok is false, so the caller/UI can
   * write it back into the input to show what actually took effect).
   */
  function set(key, rawValue) {
    const spec = PARAMS[key];
    if (!spec) return { ok: false, value: rawValue, message: 'Parameter tidak dikenal.' };

    let result = clampToSpec(spec, rawValue);
    values[key] = result.value;

    // ---- Cross-field validation: idle < redline < max, with margins ----
    // Applied AFTER the direct clamp above so moving one of the three
    // out of order nudges the others back into a valid band instead of
    // silently producing a gearbox with zero usable rev range.
    if (key === 'idleRpm' || key === 'redlineRpm' || key === 'maxRpm') {
      const fixed = enforceRpmOrdering(key);
      if (fixed) {
        result = { ok: false, value: values[key], message: fixed };
      }
    }

    applyToSimulation();
    notify({ reason: 'set', key });
    return { ok: result.ok, value: values[key], message: result.message };
  }

  /** Keeps idleRpm < redlineRpm < maxRpm with minimum gaps, adjusting
   *  the OTHER two fields around whichever one was just changed rather
   *  than rejecting the edit outright. Returns a message if it had to
   *  intervene, or '' if the values were already in order. */
  function enforceRpmOrdering(changedKey) {
    let { idleRpm, redlineRpm, maxRpm } = values;
    let touched = false;

    if (redlineRpm - idleRpm < MIN_IDLE_TO_REDLINE_GAP) {
      touched = true;
      if (changedKey === 'idleRpm') {
        redlineRpm = clampToSpec(PARAMS.redlineRpm, idleRpm + MIN_IDLE_TO_REDLINE_GAP).value;
      } else {
        idleRpm = clampToSpec(PARAMS.idleRpm, redlineRpm - MIN_IDLE_TO_REDLINE_GAP).value;
      }
    }
    if (maxRpm - redlineRpm < MIN_REDLINE_TO_MAX_GAP) {
      touched = true;
      if (changedKey === 'maxRpm') {
        redlineRpm = clampToSpec(PARAMS.redlineRpm, maxRpm - MIN_REDLINE_TO_MAX_GAP).value;
      } else {
        maxRpm = clampToSpec(PARAMS.maxRpm, redlineRpm + MIN_REDLINE_TO_MAX_GAP).value;
      }
    }

    if (!touched) return '';

    values.idleRpm = idleRpm;
    values.redlineRpm = redlineRpm;
    values.maxRpm = maxRpm;
    return 'Disesuaikan agar Idle < Redline < Max RPM tetap punya jarak yang wajar.';
  }

  /** Validates + stores one gear ratio slot (index 0 = 1st gear ... 5 = 6th). */
  function setGearRatio(index, rawValue) {
    if (index < 0 || index >= GEAR_COUNT) {
      return { ok: false, value: rawValue, message: 'Indeks gigi tidak valid.' };
    }
    const result = clampToSpec(GEAR_RATIO_SPEC, rawValue);
    values.gearRatios[index] = result.value;
    applyToSimulation();
    notify({ reason: 'setGearRatio', index });
    return result;
  }

  function get(key) {
    return values[key];
  }

  function getAll() {
    return { ...values, gearRatios: values.gearRatios.slice() };
  }

  function getSpec(key) {
    return PARAMS[key];
  }

  function getGearRatioSpec() {
    return GEAR_RATIO_SPEC;
  }

  function getParamKeys() {
    return Object.keys(PARAMS);
  }

  /** Resets every parameter (including all 6 gear ratios) back to its
   *  factory default and re-applies to the simulation. This is what the
   *  RESET SETUP button calls. */
  function reset() {
    resetInternal();
    applyToSimulation();
    notify({ reason: 'reset' });
    return getAll();
  }

  /** Pushes the full current parameter set into EngineState — the only
   *  bridge from this data model into the actual running simulation. */
  function applyToSimulation() {
    if (typeof EngineState === 'undefined' || !EngineState.applyVehicleSetup) return;
    EngineState.applyVehicleSetup(getAll());
  }

  function init() {
    // Apply once at boot so RPMSimulator/Gearbox/ThrottleController are
    // explicitly configured from VehicleSetup's defaults (a no-op vs.
    // their own built-in defaults, but makes this module the one true
    // source of truth going forward instead of two copies of "default").
    applyToSimulation();
    return getAll();
  }

  return {
    init,
    subscribe,
    get,
    getAll,
    set,
    setGearRatio,
    reset,
    getSpec,
    getGearRatioSpec,
    getParamKeys,
    GEAR_COUNT,
  };
})();
