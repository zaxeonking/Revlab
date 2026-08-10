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
  // ---- Engine configuration: induction type (enum, not a numeric PARAMS
  // entry — the min/max/step model above doesn't fit a category choice).
  // This is the "engine configuration" ENGINE-STATE's turbo/boost model
  // reads (js/modules/engine-state.js, stepBoost()) alongside turboSize/
  // maxBoostBar below, to decide HOW boost responds to throttle + RPM:
  //   na    — no forced induction, boost always 0.
  //   turbo — single turbo: boost needs both throttle AND RPM (exhaust
  //           flow) to build, with spool lag governed by turboSize.
  //   twin  — twin-turbo: same demand model as 'turbo' but smaller
  //           turbines spool noticeably faster (less lag) at the same
  //           turboSize setting.
  //   super — supercharger: mechanically (belt) driven off the crank, so
  //           it tracks RPM almost immediately — no exhaust-flow spool
  //           lag the way a turbo has.
  const INDUCTION_TYPES = [
    { value: 'na', label: 'NATURALLY ASPIRATED' },
    { value: 'turbo', label: 'SINGLE TURBO' },
    { value: 'twin', label: 'TWIN-TURBO' },
    { value: 'super', label: 'SUPERCHARGER' },
  ];
  const DEFAULT_INDUCTION_TYPE = 'turbo';

  // ---- Sound character: multiplier profile AudioEngine's 9-layer mix
  // reads (see audio-engine.js configureCharacter()) so a preset doesn't
  // just drive differently, it SOUNDS like a different engine. 1.0 on
  // every multiplier = AudioEngine's original stock balance, which is
  // exactly what STOCK/DEFAULT below reproduces. ----------------------
  const DEFAULT_SOUND_CHARACTER = {
    label: 'STOCK', pitchMult: 1, lowMix: 1, midMix: 1, highMix: 1,
    intakeMix: 1, exhaustMix: 1, turboMix: 1, rasp: 1,
  };

  // ---- Preset selector state (see vehicle-presets.js for the actual
  // preset catalogue) — 'stock' is the factory-default state this module
  // already boots into, 'custom' means the driver has hand-edited at
  // least one field since the last preset/reset, and any other id is one
  // of VehiclePresets' six named vehicles. -----------------------------
  const STOCK_ID = 'stock';
  const CUSTOM_ID = 'custom';

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
    turboSize: {
      label: 'TURBO SIZE', unit: '%', group: 'engine',
      min: 0, max: 100, step: 1, decimals: 0, default: 55,
      hint: 'Kecil = spool cepat, boost lebih rendah. Besar = spool lambat (turbo lag), boost lebih tinggi.',
    },
    maxBoostBar: {
      label: 'MAX BOOST', unit: 'BAR', group: 'engine',
      min: 0.0, max: 2.5, step: 0.05, decimals: 2, default: 0.90,
      hint: 'Batas atas tekanan boost saat forced induction terpasang penuh.',
    },
    finalDrive: {
      label: 'FINAL DRIVE', unit: ': 1', group: 'drivetrain',
      min: 2.0, max: 6.0, step: 0.01, decimals: 3, default: 3.565,
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

  // Minimum ratio STEP enforced between every pair of consecutive gears
  // (gear[i] must be at least this many times bigger than gear[i+1]).
  // Without this, nothing stopped e.g. 2nd/3rd/4th from being hand-typed
  // close enough together that a shift barely changes RPM at all — the
  // ratio math (newRPM = currentRPM × newRatio/oldRatio) is completely
  // correct either way, but a ~1–2% gap between gears reads as "nothing
  // happened" on the tach and can even trigger AUTO's upshift and
  // downshift thresholds almost back-to-back. 0.08 (8%) is deliberately
  // looser than the smallest gap in the STOCK defaults (1st→6th run
  // ~47%/36%/26%/17%/17%, so even the closest pair — 5th→6th — has
  // roughly double this margin) specifically so the stock ratios and any
  // reasonable close-ratio gearbox a driver dials in are never touched;
  // it only ever kicks in once gears are pushed genuinely too close.
  const MIN_GEAR_RATIO_STEP_FRACTION = 0.08;

  /** Cascades gear[i] > gear[i+1] × (1 + MIN_GEAR_RATIO_STEP_FRACTION)
   *  outward from changedIndex in both directions, nudging the OTHER
   *  slots apart (same "adjust the neighbors, don't reject the edit"
   *  pattern enforceRpmOrdering() uses above) rather than rejecting a
   *  gear ratio edit outright. Each nudge is clamped back into
   *  GEAR_RATIO_SPEC's own min/max, so a request to spread gears apart
   *  can never push a ratio out of its valid range — it just spreads as
   *  far as it can within that range. Returns a message if it had to
   *  intervene, or '' if the ratios were already properly spaced. */
  function enforceGearRatioSpacing(changedIndex) {
    const step = 1 + MIN_GEAR_RATIO_STEP_FRACTION;
    let touched = false;

    // Higher gears (rightward from the edit) must each be far enough
    // BELOW the gear to their left.
    for (let i = Math.max(changedIndex, 0) + 1; i < GEAR_COUNT; i += 1) {
      const maxAllowed = values.gearRatios[i - 1] / step;
      if (values.gearRatios[i] > maxAllowed) {
        touched = true;
        values.gearRatios[i] = clampToSpec(GEAR_RATIO_SPEC, maxAllowed).value;
      }
    }
    // Lower gears (leftward from the edit) must each be far enough
    // ABOVE the gear to their right.
    for (let i = Math.min(changedIndex, GEAR_COUNT - 1) - 1; i >= 0; i -= 1) {
      const minAllowed = values.gearRatios[i + 1] * step;
      if (values.gearRatios[i] < minAllowed) {
        touched = true;
        values.gearRatios[i] = clampToSpec(GEAR_RATIO_SPEC, minAllowed).value;
      }
    }

    return touched
      ? 'Gigi lain disesuaikan agar tetap punya jarak rasio yang wajar (tidak berdempetan).'
      : '';
  }

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
    values.inductionType = DEFAULT_INDUCTION_TYPE;
    values.soundCharacter = { ...DEFAULT_SOUND_CHARACTER };
    values.currentPresetId = STOCK_ID;
    values.currentPresetLabel = 'STOCK (DEFAULT)';
  }

  /** Marks the current parameter set as hand-edited — called by every
   *  scalar/gear/induction setter below so the PRESET SELECTOR's dropdown
   *  reflects reality: the instant the driver changes ANY field away from
   *  whatever preset (or STOCK) was last applied, this is no longer that
   *  preset's exact configuration. Does not touch `values` otherwise and
   *  never re-applies to the simulation itself (the caller already does
   *  that for the field it just changed). */
  function markCustom() {
    if (values.currentPresetId === CUSTOM_ID) return;
    values.currentPresetId = CUSTOM_ID;
    values.currentPresetLabel = 'CUSTOM';
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

    markCustom();
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
    const spacingMessage = enforceGearRatioSpacing(index);
    markCustom();
    applyToSimulation();
    notify({ reason: 'setGearRatio', index });
    return { ...result, message: spacingMessage || result.message };
  }

  /** Validates + stores the induction-type enum (engine configuration).
   *  Same "reapply whole setup to EngineState" flow as set()/
   *  setGearRatio() above, just without a min/max clamp since this is a
   *  category choice, not a number. */
  function setInductionType(rawValue) {
    const match = INDUCTION_TYPES.find((t) => t.value === rawValue);
    if (!match) {
      return { ok: false, value: values.inductionType, message: 'Tipe induksi tidak dikenal.' };
    }
    values.inductionType = match.value;
    markCustom();
    applyToSimulation();
    notify({ reason: 'setInductionType' });
    return { ok: true, value: values.inductionType, message: '' };
  }

  /**
   * Applies a full preset from VehiclePresets (js/modules/vehicle-presets.js)
   * in ONE shot: every scalar PARAMS field, all 6 gear ratios, induction
   * type, AND the sound character profile — then a single
   * applyToSimulation() call (rather than one per field, like set() would
   * do) so the simulation never sees a half-applied intermediate preset.
   * Every value still goes through the SAME clampToSpec() validation as a
   * manual edit, so a preset can never push a field outside its declared
   * min/max even if the preset data itself is ever hand-edited badly.
   */
  function applyPreset(id) {
    const preset = (typeof VehiclePresets !== 'undefined') ? VehiclePresets.getById(id) : null;
    if (!preset) {
      return { ok: false, value: id, message: 'Preset tidak dikenal.' };
    }

    Object.keys(PARAMS).forEach((key) => {
      if (preset[key] !== undefined) {
        values[key] = clampToSpec(PARAMS[key], preset[key]).value;
      }
    });
    // Re-run the same idle/redline/max ordering guard set() uses, in case
    // a preset's three RPM fields were ever edited too close together.
    enforceRpmOrdering('maxRpm');

    if (Array.isArray(preset.gearRatios)) {
      preset.gearRatios.forEach((ratio, index) => {
        if (index < GEAR_COUNT) {
          values.gearRatios[index] = clampToSpec(GEAR_RATIO_SPEC, ratio).value;
        }
      });
      // Safety net in case a preset's own data was ever hand-edited with
      // gears too close together — same guard setGearRatio() runs on a
      // manual edit, just swept across the whole preset in one go
      // (changedIndex -1 so every pair from 1st→6th gets checked).
      enforceGearRatioSpacing(-1);
    }

    if (preset.inductionType) {
      const match = INDUCTION_TYPES.find((t) => t.value === preset.inductionType);
      if (match) values.inductionType = match.value;
    }

    values.soundCharacter = preset.soundCharacter
      ? { ...DEFAULT_SOUND_CHARACTER, ...preset.soundCharacter }
      : { ...DEFAULT_SOUND_CHARACTER };

    values.currentPresetId = preset.id;
    values.currentPresetLabel = preset.label;

    applyToSimulation();
    notify({ reason: 'preset', id: preset.id });
    return { ok: true, value: preset.id, message: `Preset diterapkan: ${preset.label}.` };
  }

  /** Explicitly marks CUSTOM without changing any values — what the
   *  PRESET SELECTOR's "CUSTOM" option calls when picked directly (as
   *  opposed to markCustom() above, which fires implicitly the moment any
   *  field is hand-edited while a named preset/STOCK was active). */
  function selectCustom() {
    markCustom();
    notify({ reason: 'custom' });
    return getAll();
  }

  function getPresets() {
    return (typeof VehiclePresets !== 'undefined') ? VehiclePresets.getAll() : [];
  }

  function getInductionTypes() {
    return INDUCTION_TYPES.slice();
  }

  function get(key) {
    return values[key];
  }

  function getAll() {
    return {
      ...values,
      gearRatios: values.gearRatios.slice(),
      soundCharacter: { ...values.soundCharacter },
    };
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
    setInductionType,
    getInductionTypes,
    reset,
    getSpec,
    getGearRatioSpec,
    getParamKeys,
    GEAR_COUNT,
    applyPreset,
    selectCustom,
    getPresets,
    STOCK_ID,
    CUSTOM_ID,
  };
})();
