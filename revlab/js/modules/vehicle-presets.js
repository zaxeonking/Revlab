/**
 * REVLAB — vehicle-presets.js
 * -----------------------------------------------------------------------
 * Owns the PRESET SELECTOR's data: a fixed catalogue of six vehicle
 * archetypes (V6 Turbo / V8 / V10 / V12 / Rally / GT), each a COMPLETE
 * VEHICLE SETUP payload — every field VehicleSetup.PARAMS knows about
 * (weight, power, torque, idle/redline/max RPM, throttle response,
 * engine braking, top speed, induction type, turbo size, max boost),
 * plus all 6 gear ratios, final drive, wheel radius, AND a
 * `soundCharacter` profile that reshapes AudioEngine's 9-layer mix so
 * each preset doesn't just drive differently — it sounds like a
 * different engine (V8 burble vs V10 scream vs turbo whine + blow-off).
 *
 * This module is pure data (no DOM, no simulation logic) — same
 * separation of concerns as vehicle-setup.js itself. The bridge into
 * the running sim is VehicleSetup.applyPreset(id), which reads a preset
 * from here, validates/clamps every field the same way manual edits
 * are validated, then pushes the whole thing through
 * EngineState.applyVehicleSetup() (params) and AudioEngine.configureCharacter()
 * (sound) in one shot.
 *
 * soundCharacter fields (all multipliers against AudioEngine's stock
 * layer levels — 1.0 = unchanged, see audio-engine.js configureCharacter()):
 *   pitchMult    — shifts the RPM→Hz mapping for every pitched layer
 *                  (low/mid/high/turbo). >1 = higher-pitched engine note.
 *   lowMix       — ENGINE LOW (sub-bass rumble) level multiplier
 *   midMix       — ENGINE MID (main body tone) level multiplier
 *   highMix      — ENGINE HIGH (upper snarl) level multiplier
 *   intakeMix    — INTAKE (induction roar) level multiplier
 *   exhaustMix   — EXHAUST (RPM-led rasp) level multiplier
 *   turboMix     — TURBO SPOOL (whine) level multiplier — irrelevant
 *                  (silent) for 'na' induction regardless of this value
 *   rasp         — EXHAUST filter Q multiplier — higher = raspier/more
 *                  resonant exhaust note under boost
 * -----------------------------------------------------------------------
 */

const VehiclePresets = (() => {
  const PRESETS = [
    {
      id: 'v6turbo',
      label: 'V6 TURBO',
      description: 'Mid-size sport turbo — raspy mid-range growl, twin-turbo lag and whine.',
      weightKg: 1550,
      enginePowerHp: 420,
      torqueNm: 520,
      idleRpm: 800,
      redlineRpm: 6800,
      maxRpm: 7500,
      throttleResponse: 65,
      engineBraking: 45,
      topSpeedKmh: 290,
      inductionType: 'twin',
      turboSize: 45,
      maxBoostBar: 1.10,
      gearRatios: [3.400, 2.100, 1.500, 1.150, 0.920, 0.760],
      finalDrive: 3.700,
      wheelRadiusCm: 33.0,
      soundCharacter: {
        label: 'V6 TURBO — RASPY MID-RANGE GROWL',
        pitchMult: 0.95, lowMix: 1.05, midMix: 1.15, highMix: 0.85,
        intakeMix: 1.10, exhaustMix: 1.15, turboMix: 1.35, rasp: 1.25,
      },
    },
    {
      id: 'v8',
      label: 'V8',
      description: 'Naturally-aspirated muscle V8 — deep burble, thunderous low-end.',
      weightKg: 1650,
      enginePowerHp: 520,
      torqueNm: 650,
      idleRpm: 750,
      redlineRpm: 7200,
      maxRpm: 7800,
      throttleResponse: 70,
      engineBraking: 55,
      topSpeedKmh: 320,
      inductionType: 'na',
      turboSize: 0,
      maxBoostBar: 0,
      gearRatios: [3.230, 2.190, 1.630, 1.290, 1.030, 0.840],
      finalDrive: 3.310,
      wheelRadiusCm: 34.0,
      soundCharacter: {
        label: 'V8 — DEEP BURBLE, THUNDEROUS LOW-END',
        pitchMult: 0.85, lowMix: 1.35, midMix: 1.20, highMix: 0.70,
        intakeMix: 0.95, exhaustMix: 1.20, turboMix: 0.0, rasp: 1.10,
      },
    },
    {
      id: 'v10',
      label: 'V10',
      description: 'High-revving supercar V10 — screaming top-end snarl.',
      weightKg: 1450,
      enginePowerHp: 610,
      torqueNm: 560,
      idleRpm: 900,
      redlineRpm: 8400,
      maxRpm: 9000,
      throttleResponse: 85,
      engineBraking: 40,
      topSpeedKmh: 330,
      inductionType: 'na',
      turboSize: 0,
      maxBoostBar: 0,
      gearRatios: [3.150, 2.100, 1.560, 1.220, 0.980, 0.800],
      finalDrive: 3.500,
      wheelRadiusCm: 32.5,
      soundCharacter: {
        label: 'V10 — SCREAMING HIGH-REV SNARL',
        pitchMult: 1.20, lowMix: 0.80, midMix: 1.05, highMix: 1.55,
        intakeMix: 1.25, exhaustMix: 1.05, turboMix: 0.0, rasp: 0.90,
      },
    },
    {
      id: 'v12',
      label: 'V12',
      description: 'Grand-touring hypercar V12 — silky, wide harmonic wail.',
      weightKg: 1750,
      enginePowerHp: 720,
      torqueNm: 780,
      idleRpm: 800,
      redlineRpm: 8200,
      maxRpm: 8800,
      throttleResponse: 75,
      engineBraking: 40,
      topSpeedKmh: 350,
      inductionType: 'na',
      turboSize: 0,
      maxBoostBar: 0,
      gearRatios: [3.080, 2.010, 1.480, 1.150, 0.910, 0.720],
      finalDrive: 3.150,
      wheelRadiusCm: 34.5,
      soundCharacter: {
        label: 'V12 — SILKY WIDE HARMONIC WAIL',
        pitchMult: 1.10, lowMix: 0.90, midMix: 1.30, highMix: 1.30,
        intakeMix: 1.05, exhaustMix: 0.95, turboMix: 0.0, rasp: 0.80,
      },
    },
    {
      id: 'rally',
      label: 'RALLY',
      description: 'Turbocharged AWD rally car — gritty chatter, sharp blow-off.',
      weightKg: 1300,
      enginePowerHp: 380,
      torqueNm: 480,
      idleRpm: 950,
      redlineRpm: 7600,
      maxRpm: 8200,
      throttleResponse: 90,
      engineBraking: 60,
      topSpeedKmh: 230,
      inductionType: 'turbo',
      turboSize: 55,
      maxBoostBar: 1.60,
      gearRatios: [3.900, 2.450, 1.750, 1.300, 1.000, 0.780],
      finalDrive: 4.100,
      wheelRadiusCm: 30.0,
      soundCharacter: {
        label: 'RALLY TURBO — GRITTY CHATTER & BLOW-OFF',
        pitchMult: 1.05, lowMix: 0.95, midMix: 1.00, highMix: 1.00,
        intakeMix: 1.30, exhaustMix: 1.35, turboMix: 1.55, rasp: 1.45,
      },
    },
    {
      id: 'gt',
      label: 'GT',
      description: 'Supercharged grand tourer — smooth, refined, effortless power.',
      weightKg: 1900,
      enginePowerHp: 650,
      torqueNm: 820,
      idleRpm: 700,
      redlineRpm: 6600,
      maxRpm: 7200,
      throttleResponse: 55,
      engineBraking: 35,
      topSpeedKmh: 340,
      inductionType: 'super',
      turboSize: 60,
      maxBoostBar: 0.75,
      gearRatios: [3.500, 2.300, 1.700, 1.300, 1.000, 0.780],
      finalDrive: 3.230,
      wheelRadiusCm: 34.0,
      soundCharacter: {
        label: 'GT SUPERCHARGED — SMOOTH REFINED WHINE',
        pitchMult: 0.90, lowMix: 1.15, midMix: 1.10, highMix: 0.80,
        intakeMix: 0.85, exhaustMix: 0.90, turboMix: 1.20, rasp: 0.95,
      },
    },
  ];

  function getAll() {
    return PRESETS.slice();
  }

  function getById(id) {
    return PRESETS.find((p) => p.id === id) || null;
  }

  return { getAll, getById };
})();
