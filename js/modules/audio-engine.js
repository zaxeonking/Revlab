/**
 * REVLAB — audio-engine.js
 * -----------------------------------------------------------------------
 * Layered synthetic engine sound, Web Audio API only (no samples). Nine
 * layers, all driven every frame from the same telemetry frame
 * EngineState already produces (RPM, throttle, revLimiting, boost/spool,
 * blow-off + gear-shift EVENTS):
 *
 *   1. ENGINE LOW    — sub-bass block rumble (two square-wave oscillators,
 *                       fundFreq/4 and fundFreq/2)
 *   2. ENGINE MID    — the main tone/body (sawtooth at fundFreq)
 *   3. ENGINE HIGH   — upper snarl that grows with RPM (sawtooth at
 *                       fundFreq*2 and fundFreq*3)
 *   4. INTAKE        — filtered noise "induction roar", mostly THROTTLE-
 *                       driven (looping noise buffer -> bandpass filter)
 *   5. EXHAUST       — a SEPARATE filtered-noise layer, mostly RPM-driven,
 *                       lower register, gains rasp as boost comes on
 *   6. TURBO SPOOL    — rising whine tied to EngineState's turboSpoolFraction
 *                       (persistent oscillator, silent when induction is NA)
 *   7. BLOW-OFF       — one-shot "pssh" burst (persistent noise -> bandpass,
 *                       gain/filter ENVELOPE fired on EngineState's
 *                       blowOffEventId incrementing — never a new node)
 *   8. GEAR SHIFT     — one-shot mechanical "thunk" (persistent low
 *                       oscillator + persistent filtered-noise click, gain
 *                       ENVELOPE fired on EngineState's gearShiftEventId
 *                       incrementing)
 *   9. REV LIMITER    — fuel-cut stutter (LFO modulating the mix bus gain),
 *                       only active while EngineState reports revLimiting
 *
 *   ENGINE LOW -----\
 *   ENGINE MID ------+
 *   ENGINE HIGH -----+
 *   INTAKE ----------+--> mixBus --(LFO taps in here, layer 9)--> toneFilter --> limiter (compressor) --> masterVolumeGain --> masterFadeGain --> destination
 *   EXHAUST ---------+
 *   TURBO SPOOL -----+
 *   BLOW-OFF --------+
 *   GEAR SHIFT ------/
 *
 * Design rules this file follows throughout:
 *   - Every AudioNode is created exactly ONCE, inside init(). update() —
 *     called every EngineState frame — only ever calls .setTargetAtTime()
 *     (continuous layers) or schedules a short envelope on an EXISTING
 *     AudioParam (one-shot layers 7/8). No node is ever created,
 *     connected, or started inside update(), and no node is ever created
 *     per animation frame OR per event — the blow-off and gear-shift
 *     nodes are built once in init() and simply re-triggered.
 *   - Every per-frame frequency AND gain change on the CONTINUOUS layers
 *     (1–6, 9) goes through glide(), never a raw `.value =` write, so
 *     both pitch and level transitions are click-free.
 *   - The ONE-SHOT layers (7, 8) use standard Web Audio scheduled-ramp
 *     envelopes (setValueAtTime/linearRamp/exponentialRamp) on their own
 *     persistent gain — the correct mechanism for a percussive hit, and
 *     still touches only existing AudioParams, never a raw `.value =`.
 *   - Every layer reads the SAME EngineState frame every tick (or the
 *     same monotonically-increasing event id for the one-shot layers),
 *     so sound is always a pure function of current simulation state —
 *     nothing here keeps sound-only state that could drift from what the
 *     gauges/telemetry are showing.
 *   - AudioContext is created lazily in init(), which is only ever called
 *     from a real user gesture (Start Engine click in ui-controller.js).
 *   - masterVolumeGain is the single "master volume" control (overall
 *     level, independent of engine on/off); masterFadeGain is the
 *     separate on/off fade so the two concerns don't fight each other.
 *   - A DynamicsCompressorNode configured as a hard limiter sits right
 *     before the master gains — up to nine simultaneous layers can sum
 *     to more headroom than any one layer alone accounts for (blow-off
 *     and gear-shift bursts especially), so this is the safety net that
 *     guarantees no clipping regardless of how the layers combine.
 * -----------------------------------------------------------------------
 */

const AudioEngine = (() => {
  const MAX_RPM = 9000; // mirrors RPMSimulator.MAX_RPM — kept local so this
                         // module has no hard load-order dependency on it.

  // ---- Pitch mapping (RPM -> Hz), shared by every pitched layer -------
  const IDLE_FREQ_HZ = 30;
  const MAX_FREQ_HZ = 250;

  // ---- Layer 1: ENGINE LOW (sub-bass rumble) ---------------------------
  // Square waves: strong low harmonics at the same fundamental Hz is what
  // reads as "heavy," not just "quiet and low." Always present — this is
  // the layer that gives the tone its floor at every RPM.
  const LOW_GAIN_MIN = 0.50; // at idle
  const LOW_GAIN_MAX = 0.24; // at redline — recedes but never disappears

  // ---- Layer 2: ENGINE MID (main body/tone) ----------------------------
  const MID_GAIN = 0.30; // fairly constant — this is the "always there" core tone

  // ---- Layer 3: ENGINE HIGH (upper snarl) -------------------------------
  const HIGH_GAIN_MIN = 0.03; // near-silent at idle
  const HIGH_GAIN_MAX = 0.22; // present bite near redline
  const HIGH2_GAIN_MIN = 0.01;
  const HIGH2_GAIN_MAX = 0.12;

  // ---- Layer 4: INTAKE (filtered noise, throttle-led) --------------------
  // Induction roar under load — mostly a THROTTLE response, with a
  // smaller RPM component so it still has *some* presence coasting at
  // high RPM off-throttle. Bandpass center frequency tracks pitch too,
  // so the "whoosh" register rises and falls with the engine instead of
  // sitting static. Sits in a HIGHER register than EXHAUST below, so the
  // two read as distinct sound sources instead of one blob.
  const INTAKE_GAIN_MIN = 0.02;
  const INTAKE_GAIN_MAX = 0.18;
  const INTAKE_THROTTLE_WEIGHT = 0.80; // how much of intake gain throttle drives vs RPM
  const INTAKE_FILTER_MIN_HZ = 700;
  const INTAKE_FILTER_MAX_HZ = 3000;
  const INTAKE_FILTER_Q = 1.1;

  // ---- Layer 5: EXHAUST (filtered noise, RPM-led) -------------------------
  // A separate noise chain from INTAKE — lower register "rasp", mostly
  // RPM-driven (exhaust note follows engine speed more than pedal
  // position), with a smaller throttle component (load still audibly
  // opens it up). Gains extra edge (gain + filter Q) as boost builds —
  // a turbocharged exhaust note gets raspier under boost, not just louder.
  const EXHAUST_GAIN_MIN = 0.03;
  const EXHAUST_GAIN_MAX = 0.24;
  const EXHAUST_THROTTLE_WEIGHT = 0.40; // RPM dominant, unlike intake
  const EXHAUST_FILTER_MIN_HZ = 220;
  const EXHAUST_FILTER_MAX_HZ = 1350;
  const EXHAUST_FILTER_Q_BASE = 1.2;
  const EXHAUST_FILTER_Q_BOOST_BONUS = 1.4; // added on top of base, scaled by boost fraction
  const EXHAUST_BOOST_GAIN_BONUS = 0.16;    // extra gain, scaled by boost fraction

  // ---- Layer 6: TURBO SPOOL (rising whine) --------------------------------
  // Pitch + level both track EngineState's turboSpoolFraction (0..1) —
  // NOT RPM/throttle directly, so this layer inherits the turbo-lag feel
  // (or supercharger's near-instant response) EngineState's boost model
  // already computes, instead of duplicating that physics here.
  const TURBO_MIN_FREQ_HZ = 320;
  const TURBO_MAX_FREQ_HZ = 2100;
  const TURBO_GAIN_MAX = 0.16; // at full spool
  const TURBO_SPOOL_GAIN_CURVE = 1.6; // >1 = gain rises faster near full spool than linear

  // ---- Layer 7: BLOW-OFF (one-shot "pssh") --------------------------------
  const BLOWOFF_PEAK_GAIN = 0.55;
  const BLOWOFF_ATTACK_S = 0.012;
  const BLOWOFF_DECAY_S = 0.42;
  const BLOWOFF_FILTER_START_HZ = 3200;
  const BLOWOFF_FILTER_END_HZ = 500;
  const BLOWOFF_FILTER_Q = 0.8;

  // ---- Layer 8: GEAR SHIFT (one-shot mechanical thunk) --------------------
  const SHIFT_PEAK_GAIN = 0.5;
  const SHIFT_ATTACK_S = 0.006;
  const SHIFT_DECAY_S = 0.16;
  const SHIFT_THUNK_FREQ_HZ = 85;
  const SHIFT_CLICK_FILTER_HZ = 380;
  const SHIFT_CLICK_FILTER_Q = 1.4;

  // ---- Layer 9: REV LIMITER (fuel-cut stutter) ---------------------------
  const LIMITER_LFO_HZ = 55;
  const LIMITER_LFO_DEPTH = 0.4;

  // ---- Tone filter (post-mix, all layers) -------------------------------
  const TONE_FILTER_MIN_HZ = 180;
  const TONE_FILTER_MAX_HZ = 2200;
  const TONE_FILTER_Q = 0.9;

  // ---- Bus / master levels ------------------------------------------------
  const MIX_TRIM = 0.72;          // headroom trim before the limiter (slightly lower than before — more layers now)
  const RUNNING_LEVEL = 1.0;      // masterFadeGain target while engine is "on"
  const DEFAULT_MASTER_VOLUME = 0.85; // masterVolumeGain default — future UI slider hook
  const PARAM_SMOOTH_TC = 0.045;  // setTargetAtTime time constant for per-frame params
  const MASTER_FADE_IN_TC = 0.12;
  const MASTER_FADE_OUT_TC = 0.35; // slower: engine "spins down and fades" together

  let ctx = null;

  // Layer 1 — low
  let oscLow1 = null, oscLow2 = null, gainLow1 = null, gainLow2 = null, lowLayerGain = null;
  // Layer 2 — mid
  let oscMid = null, gainMid = null, midLayerGain = null;
  // Layer 3 — high
  let oscHigh1 = null, oscHigh2 = null, gainHigh1 = null, gainHigh2 = null, highLayerGain = null;
  // Layer 4 — intake
  let intakeNoiseSource = null, intakeFilter = null, intakeLayerGain = null;
  // Layer 5 — exhaust
  let exhaustNoiseSource = null, exhaustFilter = null, exhaustLayerGain = null;
  // Layer 6 — turbo spool
  let oscTurbo = null, turboLayerGain = null;
  // Layer 7 — blow-off (persistent, gated to silence between events)
  let blowOffNoiseSource = null, blowOffFilter = null, blowOffGain = null;
  // Layer 8 — gear shift (persistent, gated to silence between events)
  let oscShiftThunk = null, shiftThunkGain = null;
  let shiftClickNoiseSource = null, shiftClickFilter = null, shiftClickGain = null;
  let shiftLayerGain = null; // sums thunk + click, one gate for both
  // Layer 9 — rev limiter
  let limiterLfo = null, limiterLfoDepthGain = null;

  // Bus / master chain
  let mixBus = null;
  let toneFilter = null;
  let limiterNode = null; // DynamicsCompressorNode used as a simple limiter
  let masterVolumeGain = null;
  let masterFadeGain = null;

  let isInitialized = false;
  let isRunning = false;

  // Edge-detection for the one-shot event layers (blow-off / gear shift) —
  // EngineState hands us monotonically-increasing counters each frame;
  // we only fire the envelope when the counter actually CHANGES, so a
  // held telemetry frame (or several updates during the same event)
  // never retriggers the same hit. `null` means "not seen a frame yet" —
  // the very first frame after init() just syncs to current, it never
  // fires (there's no prior event to have just happened).
  let lastBlowOffEventId = null;
  let lastGearShiftEventId = null;

  function clamp01(n) {
    return Math.min(Math.max(n, 0), 1);
  }

  function rpmFractionOf(rpm) {
    return clamp01(rpm / MAX_RPM);
  }

  /** Ramps an AudioParam smoothly toward target — the one function every
   *  per-frame update below goes through, so nothing ever gets a raw,
   *  click-prone `.value =` write (smooth pitch AND smooth gain, same
   *  mechanism). */
  function glide(param, target, timeConstant = PARAM_SMOOTH_TC) {
    if (!ctx) return;
    param.setTargetAtTime(target, ctx.currentTime, timeConstant);
  }

  /** Builds a short looping white-noise buffer, shared (by reference) by
   *  every noise-based layer (intake / exhaust / blow-off) — one AudioBuffer
   *  object feeding three separate persistent BufferSourceNodes. Called
   *  once from init() — this is buffer DATA generation, not a per-frame
   *  or per-layer node creation, and runs exactly once regardless of how
   *  long the engine runs afterward or how many layers reuse it.
   *  Math.random() here is fine: this is a static noise texture baked
   *  once at startup, not part of the deterministic RPM/gear/boost
   *  simulation state. */
  function buildNoiseBuffer(audioCtx) {
    const seconds = 2;
    const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * seconds, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /**
   * Builds the persistent audio graph exactly once. Must be called from
   * inside a real user-gesture event handler (Start Engine click) — an
   * AudioContext created outside a gesture starts 'suspended' in most
   * browsers and some never allow it to produce sound at all.
   */
  function init() {
    if (isInitialized) return { ok: true, alreadyInitialized: true };

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      console.warn('[AudioEngine] Web Audio API not available in this browser.');
      return { ok: false, reason: 'unsupported' };
    }
    ctx = new Ctx();

    // ---- Bus nodes first, so layers below have somewhere to connect ----
    mixBus = ctx.createGain();
    mixBus.gain.value = MIX_TRIM;

    toneFilter = ctx.createBiquadFilter();
    toneFilter.type = 'lowpass';
    toneFilter.frequency.value = TONE_FILTER_MIN_HZ;
    toneFilter.Q.value = TONE_FILTER_Q;

    // Simple limiter: a DynamicsCompressorNode pushed hard (low threshold,
    // ~20:1 ratio, fast attack) behaves as a brickwall-ish limiter —
    // catches whatever headroom nine summed layers eat into so the
    // output never clips, without needing custom DSP.
    limiterNode = ctx.createDynamicsCompressor();
    limiterNode.threshold.value = -6;
    limiterNode.knee.value = 0;
    limiterNode.ratio.value = 20;
    limiterNode.attack.value = 0.003;
    limiterNode.release.value = 0.12;

    masterVolumeGain = ctx.createGain();
    masterVolumeGain.gain.value = DEFAULT_MASTER_VOLUME;

    masterFadeGain = ctx.createGain();
    masterFadeGain.gain.value = 0; // starts silent; start() fades this in

    mixBus.connect(toneFilter);
    toneFilter.connect(limiterNode);
    limiterNode.connect(masterVolumeGain);
    masterVolumeGain.connect(masterFadeGain);
    masterFadeGain.connect(ctx.destination);

    // ---- Layer 1: ENGINE LOW ---------------------------------------------
    oscLow1 = ctx.createOscillator();
    oscLow2 = ctx.createOscillator();
    oscLow1.type = 'square';
    oscLow2.type = 'square';
    oscLow1.frequency.value = IDLE_FREQ_HZ / 4;
    oscLow2.frequency.value = IDLE_FREQ_HZ / 2;
    gainLow1 = ctx.createGain();
    gainLow2 = ctx.createGain();
    gainLow1.gain.value = 0.6;
    gainLow2.gain.value = 0.4;
    lowLayerGain = ctx.createGain();
    lowLayerGain.gain.value = LOW_GAIN_MIN;
    oscLow1.connect(gainLow1).connect(lowLayerGain);
    oscLow2.connect(gainLow2).connect(lowLayerGain);
    lowLayerGain.connect(mixBus);

    // ---- Layer 2: ENGINE MID ----------------------------------------------
    oscMid = ctx.createOscillator();
    oscMid.type = 'sawtooth';
    oscMid.frequency.value = IDLE_FREQ_HZ;
    gainMid = ctx.createGain();
    gainMid.gain.value = 1;
    midLayerGain = ctx.createGain();
    midLayerGain.gain.value = MID_GAIN;
    oscMid.connect(gainMid).connect(midLayerGain);
    midLayerGain.connect(mixBus);

    // ---- Layer 3: ENGINE HIGH ----------------------------------------------
    oscHigh1 = ctx.createOscillator();
    oscHigh2 = ctx.createOscillator();
    oscHigh1.type = 'sawtooth';
    oscHigh2.type = 'sawtooth';
    oscHigh1.frequency.value = IDLE_FREQ_HZ * 2;
    oscHigh2.frequency.value = IDLE_FREQ_HZ * 3;
    gainHigh1 = ctx.createGain();
    gainHigh2 = ctx.createGain();
    gainHigh1.gain.value = 0.7;
    gainHigh2.gain.value = 0.3;
    highLayerGain = ctx.createGain();
    highLayerGain.gain.value = HIGH_GAIN_MIN;
    oscHigh1.connect(gainHigh1).connect(highLayerGain);
    oscHigh2.connect(gainHigh2).connect(highLayerGain);
    highLayerGain.connect(mixBus);

    // ---- Shared noise buffer — one AudioBuffer, reused by three
    // independent persistent BufferSourceNodes below (intake / exhaust /
    // blow-off). Building it once here means none of those three layers
    // ever needs its own buffer-generation pass. ------------------------
    const sharedNoiseBuffer = buildNoiseBuffer(ctx);

    // ---- Layer 4: INTAKE ---------------------------------------------------
    intakeNoiseSource = ctx.createBufferSource();
    intakeNoiseSource.buffer = sharedNoiseBuffer;
    intakeNoiseSource.loop = true;
    intakeFilter = ctx.createBiquadFilter();
    intakeFilter.type = 'bandpass';
    intakeFilter.frequency.value = INTAKE_FILTER_MIN_HZ;
    intakeFilter.Q.value = INTAKE_FILTER_Q;
    intakeLayerGain = ctx.createGain();
    intakeLayerGain.gain.value = INTAKE_GAIN_MIN;
    intakeNoiseSource.connect(intakeFilter).connect(intakeLayerGain);
    intakeLayerGain.connect(mixBus);

    // ---- Layer 5: EXHAUST --------------------------------------------------
    exhaustNoiseSource = ctx.createBufferSource();
    exhaustNoiseSource.buffer = sharedNoiseBuffer;
    exhaustNoiseSource.loop = true;
    exhaustFilter = ctx.createBiquadFilter();
    exhaustFilter.type = 'bandpass';
    exhaustFilter.frequency.value = EXHAUST_FILTER_MIN_HZ;
    exhaustFilter.Q.value = EXHAUST_FILTER_Q_BASE;
    exhaustLayerGain = ctx.createGain();
    exhaustLayerGain.gain.value = EXHAUST_GAIN_MIN;
    exhaustNoiseSource.connect(exhaustFilter).connect(exhaustLayerGain);
    exhaustLayerGain.connect(mixBus);

    // ---- Layer 6: TURBO SPOOL -----------------------------------------------
    oscTurbo = ctx.createOscillator();
    oscTurbo.type = 'sine';
    oscTurbo.frequency.value = TURBO_MIN_FREQ_HZ;
    turboLayerGain = ctx.createGain();
    turboLayerGain.gain.value = 0; // silent until spooled
    oscTurbo.connect(turboLayerGain);
    turboLayerGain.connect(mixBus);

    // ---- Layer 7: BLOW-OFF (persistent, silent until triggered) -----------
    blowOffNoiseSource = ctx.createBufferSource();
    blowOffNoiseSource.buffer = sharedNoiseBuffer;
    blowOffNoiseSource.loop = true;
    blowOffFilter = ctx.createBiquadFilter();
    blowOffFilter.type = 'bandpass';
    blowOffFilter.frequency.value = BLOWOFF_FILTER_START_HZ;
    blowOffFilter.Q.value = BLOWOFF_FILTER_Q;
    blowOffGain = ctx.createGain();
    blowOffGain.gain.value = 0; // silent between events — triggerBlowOff() below is the only thing that moves this
    blowOffNoiseSource.connect(blowOffFilter).connect(blowOffGain);
    blowOffGain.connect(mixBus);

    // ---- Layer 8: GEAR SHIFT (persistent, silent until triggered) ---------
    oscShiftThunk = ctx.createOscillator();
    oscShiftThunk.type = 'sine';
    oscShiftThunk.frequency.value = SHIFT_THUNK_FREQ_HZ;
    shiftThunkGain = ctx.createGain();
    shiftThunkGain.gain.value = 0.8; // fixed relative level within the shift layer
    oscShiftThunk.connect(shiftThunkGain);

    shiftClickNoiseSource = ctx.createBufferSource();
    shiftClickNoiseSource.buffer = sharedNoiseBuffer;
    shiftClickNoiseSource.loop = true;
    shiftClickFilter = ctx.createBiquadFilter();
    shiftClickFilter.type = 'bandpass';
    shiftClickFilter.frequency.value = SHIFT_CLICK_FILTER_HZ;
    shiftClickFilter.Q.value = SHIFT_CLICK_FILTER_Q;
    shiftClickGain = ctx.createGain();
    shiftClickGain.gain.value = 0.5; // fixed relative level within the shift layer
    shiftClickNoiseSource.connect(shiftClickFilter).connect(shiftClickGain);

    shiftLayerGain = ctx.createGain();
    shiftLayerGain.gain.value = 0; // silent between events — triggerGearShift() below is the only thing that moves this
    shiftThunkGain.connect(shiftLayerGain);
    shiftClickGain.connect(shiftLayerGain);
    shiftLayerGain.connect(mixBus);

    // ---- Layer 9: REV LIMITER (modulates mixBus gain, not its own voice) --
    // Connected straight into mixBus.gain: an oscillator feeding an
    // AudioParam adds its (depth-scaled) waveform on top of whatever the
    // param's own value is — the standard Web Audio param-modulation
    // pattern, no extra mixer node needed.
    limiterLfo = ctx.createOscillator();
    limiterLfo.type = 'square';
    limiterLfo.frequency.value = LIMITER_LFO_HZ;
    limiterLfoDepthGain = ctx.createGain();
    limiterLfoDepthGain.gain.value = 0; // silent until revLimiting turns it on
    limiterLfo.connect(limiterLfoDepthGain);
    limiterLfoDepthGain.connect(mixBus.gain);

    // Every oscillator/noise source starts exactly once, here.
    oscLow1.start();
    oscLow2.start();
    oscMid.start();
    oscHigh1.start();
    oscHigh2.start();
    intakeNoiseSource.start();
    exhaustNoiseSource.start();
    oscTurbo.start();
    blowOffNoiseSource.start();
    oscShiftThunk.start();
    shiftClickNoiseSource.start();
    limiterLfo.start();

    isInitialized = true;
    console.info('[AudioEngine] AudioContext + 9-layer synthesis graph initialized.');
    return { ok: true };
  }

  /** Fades the whole engine tone in via masterFadeGain. Safe to call
   *  repeatedly — it just re-targets the same fade. */
  function start() {
    if (!isInitialized) {
      console.warn('[AudioEngine] start() called before init().');
      return { ok: false, reason: 'not_initialized' };
    }
    if (ctx.state === 'suspended') ctx.resume();
    glide(masterFadeGain.gain, RUNNING_LEVEL, MASTER_FADE_IN_TC);
    isRunning = true;
    return { ok: true };
  }

  /** Fades the engine tone out via masterFadeGain. All oscillators/noise
   *  sources are left running silently underneath (cheap, and avoids
   *  re-triggering start-up clicks on the next Start Engine press) — only
   *  the fade gain is pulled to 0, on a slower time constant so the tone
   *  visibly "spins down" alongside RPM coasting to 0 instead of cutting
   *  off the instant the button is pressed. */
  function stop() {
    if (!isInitialized) return { ok: false, reason: 'not_initialized' };
    glide(masterFadeGain.gain, 0, MASTER_FADE_OUT_TC);
    isRunning = false;
    return { ok: true };
  }

  /** Master volume control — independent of engine on/off. Not yet wired
   *  to a UI control, but exposed here so one exists (0..1, clamped). */
  function setMasterVolume(volume0to1) {
    if (!isInitialized) return { ok: false, reason: 'not_initialized' };
    glide(masterVolumeGain.gain, clamp01(volume0to1), 0.05);
    return { ok: true };
  }

  /** Fires the blow-off "pssh" envelope on the ALREADY-EXISTING blow-off
   *  noise/filter/gain chain built in init() — no node is created here,
   *  only a scheduled ramp on blowOffGain.gain (+ a filter frequency
   *  sweep for the characteristic falling-pitch hiss). Safe to call
   *  mid-envelope (a second event before the first finishes): the
   *  cancelScheduledValues()+setValueAtTime(current value) pair means the
   *  new envelope always starts from wherever the gain actually is, never
   *  jumps. */
  function triggerBlowOff() {
    if (!ctx) return;
    const t = ctx.currentTime;

    blowOffGain.gain.cancelScheduledValues(t);
    blowOffGain.gain.setValueAtTime(Math.max(blowOffGain.gain.value, 0.0001), t);
    blowOffGain.gain.linearRampToValueAtTime(BLOWOFF_PEAK_GAIN, t + BLOWOFF_ATTACK_S);
    blowOffGain.gain.exponentialRampToValueAtTime(0.0008, t + BLOWOFF_ATTACK_S + BLOWOFF_DECAY_S);
    blowOffGain.gain.linearRampToValueAtTime(0, t + BLOWOFF_ATTACK_S + BLOWOFF_DECAY_S + 0.01);

    blowOffFilter.frequency.cancelScheduledValues(t);
    blowOffFilter.frequency.setValueAtTime(BLOWOFF_FILTER_START_HZ, t);
    blowOffFilter.frequency.exponentialRampToValueAtTime(
      BLOWOFF_FILTER_END_HZ,
      t + BLOWOFF_ATTACK_S + BLOWOFF_DECAY_S
    );
  }

  /** Fires the gear-shift "thunk" envelope on the ALREADY-EXISTING
   *  oscillator + filtered-noise chain built in init() — same
   *  cancel-then-ramp-from-current-value pattern as triggerBlowOff(), so
   *  back-to-back rapid shifts (fast paddle-tapping) never click or pop. */
  function triggerGearShift() {
    if (!ctx) return;
    const t = ctx.currentTime;

    shiftLayerGain.gain.cancelScheduledValues(t);
    shiftLayerGain.gain.setValueAtTime(Math.max(shiftLayerGain.gain.value, 0.0001), t);
    shiftLayerGain.gain.linearRampToValueAtTime(SHIFT_PEAK_GAIN, t + SHIFT_ATTACK_S);
    shiftLayerGain.gain.exponentialRampToValueAtTime(0.0008, t + SHIFT_ATTACK_S + SHIFT_DECAY_S);
    shiftLayerGain.gain.linearRampToValueAtTime(0, t + SHIFT_ATTACK_S + SHIFT_DECAY_S + 0.01);
  }

  /**
   * Per-frame update — called from EngineState's subscribe alongside
   * UIController's own render(), so audio tracks the exact same
   * telemetry frame the gauge/needle are drawing this tick. Continuous
   * layers only ever touch existing AudioParams via glide(); the two
   * one-shot layers (blow-off, gear shift) are edge-detected off
   * EngineState's monotonic event counters and fire through
   * triggerBlowOff()/triggerGearShift() above — never a node creation
   * either way.
   *
   * frame: { rpm, throttlePercent, revLimiting, engineOn, boostBar,
   *          maxBoostBar, turboSpoolFraction, inductionType,
   *          blowOffEventId, gearShiftEventId }
   */
  function update(frame) {
    if (!isInitialized) return;

    const fraction = rpmFractionOf(frame.rpm);
    const throttleFraction = clamp01((frame.throttlePercent || 0) / 100);
    const fundFreq = IDLE_FREQ_HZ + fraction * (MAX_FREQ_HZ - IDLE_FREQ_HZ);
    const spoolFraction = clamp01(frame.turboSpoolFraction || 0);
    const boostFraction = frame.maxBoostBar > 0 ? clamp01((frame.boostBar || 0) / frame.maxBoostBar) : 0;
    const inductionType = frame.inductionType || 'na';

    // ---- SOUND LAB crossfade -------------------------------------------------
    // If the user has loaded a custom sample for a given band (via
    // SoundLab, sound-lab.js), duck this synth layer's gain by
    // (1 - customMix) so the synth fades OUT in exact lockstep with the
    // custom sample fading IN across a band crossfade — not just a hard
    // on/off duck. Falls back to full synth (duck = 1) whenever SoundLab
    // isn't loaded yet or has no custom sample for that category — so
    // this is a no-op if sound-lab.js is ever removed/omitted.
    const SL = window.SoundLab;
    const slSnapshot = SL ? SL.getSnapshot() : null;
    const duck = (category) => {
      if (!slSnapshot || !slSnapshot.categories[category] || !slSnapshot.categories[category].hasCustom) return 1;
      return clamp01(1 - slSnapshot.categories[category].currentMix);
    };
    const lowDuck = duck('low');
    const midDuck = duck('mid');
    const highDuck = duck('high');
    const limiterDuck = duck('limiter');

    // ---- Layer 1: ENGINE LOW — pitch + level, RPM-driven -------------------
    glide(oscLow1.frequency, fundFreq / 4);
    glide(oscLow2.frequency, fundFreq / 2);
    glide(lowLayerGain.gain, (LOW_GAIN_MIN + fraction * (LOW_GAIN_MAX - LOW_GAIN_MIN)) * lowDuck);

    // ---- Layer 2: ENGINE MID — pitch RPM-driven, level ~constant -----------
    glide(oscMid.frequency, fundFreq);
    glide(midLayerGain.gain, MID_GAIN * midDuck);

    // ---- Layer 3: ENGINE HIGH — fades in with RPM ---------------------------
    glide(oscHigh1.frequency, fundFreq * 2);
    glide(oscHigh2.frequency, fundFreq * 3);
    glide(highLayerGain.gain, (HIGH_GAIN_MIN + fraction * (HIGH_GAIN_MAX - HIGH_GAIN_MIN)) * highDuck);
    glide(gainHigh1.gain, 0.7);
    glide(gainHigh2.gain, HIGH2_GAIN_MIN + fraction * (HIGH2_GAIN_MAX - HIGH2_GAIN_MIN));

    // ---- Layer 4: INTAKE — mostly throttle, some RPM -------------------------
    const intakeFromThrottle = throttleFraction * INTAKE_THROTTLE_WEIGHT;
    const intakeFromRpm = fraction * (1 - INTAKE_THROTTLE_WEIGHT);
    const intakeMix = clamp01(intakeFromThrottle + intakeFromRpm);
    glide(intakeLayerGain.gain, INTAKE_GAIN_MIN + intakeMix * (INTAKE_GAIN_MAX - INTAKE_GAIN_MIN));
    glide(intakeFilter.frequency, INTAKE_FILTER_MIN_HZ + fraction * (INTAKE_FILTER_MAX_HZ - INTAKE_FILTER_MIN_HZ));

    // ---- Layer 5: EXHAUST — mostly RPM, some throttle, rasps up with boost --
    const exhaustFromThrottle = throttleFraction * EXHAUST_THROTTLE_WEIGHT;
    const exhaustFromRpm = fraction * (1 - EXHAUST_THROTTLE_WEIGHT);
    const exhaustMix = clamp01(exhaustFromThrottle + exhaustFromRpm);
    const exhaustGain = EXHAUST_GAIN_MIN
      + exhaustMix * (EXHAUST_GAIN_MAX - EXHAUST_GAIN_MIN)
      + boostFraction * EXHAUST_BOOST_GAIN_BONUS;
    glide(exhaustLayerGain.gain, exhaustGain);
    glide(exhaustFilter.frequency, EXHAUST_FILTER_MIN_HZ + fraction * (EXHAUST_FILTER_MAX_HZ - EXHAUST_FILTER_MIN_HZ));
    glide(exhaustFilter.Q, EXHAUST_FILTER_Q_BASE + boostFraction * EXHAUST_FILTER_Q_BOOST_BONUS);

    // ---- Layer 6: TURBO SPOOL — pitch + level track spoolFraction, not RPM --
    // Silent entirely for naturally-aspirated (inductionType === 'na') —
    // EngineState's own spool model already forces spoolFraction toward 0
    // for 'na', but gating gain here too means this layer never has a
    // stray audible tail from residual param smoothing.
    const turboAudible = inductionType !== 'na';
    glide(oscTurbo.frequency, TURBO_MIN_FREQ_HZ + spoolFraction * (TURBO_MAX_FREQ_HZ - TURBO_MIN_FREQ_HZ));
    glide(turboLayerGain.gain, turboAudible ? TURBO_GAIN_MAX * Math.pow(spoolFraction, TURBO_SPOOL_GAIN_CURVE) : 0);

    // ---- Layer 7: BLOW-OFF — one-shot, edge-detected on blowOffEventId ------
    if (lastBlowOffEventId === null) {
      lastBlowOffEventId = frame.blowOffEventId || 0;
    } else if ((frame.blowOffEventId || 0) !== lastBlowOffEventId) {
      lastBlowOffEventId = frame.blowOffEventId;
      triggerBlowOff();
    }

    // ---- Layer 8: GEAR SHIFT — one-shot, edge-detected on gearShiftEventId --
    if (lastGearShiftEventId === null) {
      lastGearShiftEventId = frame.gearShiftEventId || 0;
    } else if ((frame.gearShiftEventId || 0) !== lastGearShiftEventId) {
      lastGearShiftEventId = frame.gearShiftEventId;
      triggerGearShift();
    }

    // ---- Layer 9: REV LIMITER — stutter only while actually limiting --------
    glide(limiterLfoDepthGain.gain, (frame.revLimiting ? LIMITER_LFO_DEPTH : 0) * limiterDuck, 0.03);

    // ---- Shared tone filter (all layers) — opens up with RPM -----------------
    glide(toneFilter.frequency, TONE_FILTER_MIN_HZ + fraction * (TONE_FILTER_MAX_HZ - TONE_FILTER_MIN_HZ));

    // ---- Engine on/off tracks the fade bus, independent of the per-layer
    // glides above so a stop() fade-out still hears RPM (and therefore
    // pitch) coasting down underneath it. -------------------------------------
    if (frame.engineOn && !isRunning) start();
    if (!frame.engineOn && isRunning) stop();
  }

  function getState() {
    return {
      isInitialized,
      isRunning,
      implemented: true,
      contextState: ctx ? ctx.state : 'uninitialized',
    };
  }

  return { init, start, stop, update, setMasterVolume, getState };
})();
