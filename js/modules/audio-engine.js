/**
 * REVLAB — audio-engine.js
 * -----------------------------------------------------------------------
 * Layered synthetic engine sound, Web Audio API only (no samples). Five
 * layers, all driven every frame from the same RPM/throttle/revLimiting
 * telemetry frame EngineState already produces:
 *
 *   1. ENGINE LOW    — sub-bass block rumble (two square-wave oscillators,
 *                       fundFreq/4 and fundFreq/2)
 *   2. ENGINE MID    — the main tone/body (sawtooth at fundFreq)
 *   3. ENGINE HIGH   — upper snarl that grows with RPM (sawtooth at
 *                       fundFreq*2 and fundFreq*3)
 *   4. INTAKE/EXHAUST— filtered noise "whoosh/rasp" that mostly answers
 *                       throttle, not just RPM (looping noise buffer ->
 *                       bandpass filter)
 *   5. REV LIMITER   — fuel-cut stutter (LFO modulating the mix bus gain),
 *                       only active while EngineState reports revLimiting
 *
 *   ENGINE LOW ----\
 *   ENGINE MID -----+--> mixBus --(LFO taps in here, layer 5)--> toneFilter --> limiter (compressor) --> masterVolumeGain --> masterFadeGain --> destination
 *   ENGINE HIGH ----+
 *   INTAKE/EXHAUST-/
 *
 * Design rules this file follows throughout:
 *   - Every AudioNode is created exactly ONCE, inside init(). update() —
 *     called every EngineState frame — only ever calls .setTargetAtTime()
 *     on existing AudioParams. No node is ever created, connected, or
 *     started inside update().
 *   - Every per-frame frequency AND gain change goes through glide(),
 *     never a raw `.value =` write, so both pitch and level transitions
 *     are click-free (smooth pitch transition / smooth gain transition).
 *   - AudioContext is created lazily in init(), which is only ever called
 *     from a real user gesture (Start Engine click in ui-controller.js).
 *   - masterVolumeGain is the single "master volume" control (overall
 *     level, independent of engine on/off); masterFadeGain is the
 *     separate on/off fade so the two concerns don't fight each other.
 *   - A DynamicsCompressorNode configured as a hard limiter sits right
 *     before the master gains — five simultaneous layers can sum to
 *     more headroom than any one layer alone accounts for, so this is
 *     the safety net that guarantees no clipping regardless of how the
 *     layers combine.
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

  // ---- Layer 4: INTAKE/EXHAUST (filtered noise) -------------------------
  // Mostly a THROTTLE response (induction roar under load), with a
  // smaller RPM component so it still has *some* presence coasting at
  // high RPM off-throttle. Bandpass center frequency tracks pitch too,
  // so the "whoosh" register rises and falls with the engine instead of
  // sitting static.
  const INTAKE_GAIN_MIN = 0.02;
  const INTAKE_GAIN_MAX = 0.20;
  const INTAKE_THROTTLE_WEIGHT = 0.75; // how much of intake gain throttle drives vs RPM
  const INTAKE_FILTER_MIN_HZ = 500;
  const INTAKE_FILTER_MAX_HZ = 2600;
  const INTAKE_FILTER_Q = 1.1;

  // ---- Layer 5: REV LIMITER (fuel-cut stutter) ---------------------------
  const LIMITER_LFO_HZ = 55;
  const LIMITER_LFO_DEPTH = 0.4;

  // ---- Tone filter (post-mix, all layers) -------------------------------
  const TONE_FILTER_MIN_HZ = 180;
  const TONE_FILTER_MAX_HZ = 2200;
  const TONE_FILTER_Q = 0.9;

  // ---- Bus / master levels ------------------------------------------------
  const MIX_TRIM = 0.75;          // headroom trim before the limiter
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
  // Layer 4 — intake/exhaust
  let noiseSource = null, intakeFilter = null, intakeLayerGain = null;
  // Layer 5 — rev limiter
  let limiterLfo = null, limiterLfoDepthGain = null;

  // Bus / master chain
  let mixBus = null;
  let toneFilter = null;
  let limiterNode = null; // DynamicsCompressorNode used as a simple limiter
  let masterVolumeGain = null;
  let masterFadeGain = null;

  let isInitialized = false;
  let isRunning = false;

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

  /** Builds a short looping white-noise buffer for the intake/exhaust
   *  layer. Called once from init() — this is buffer DATA generation,
   *  not a per-frame node creation, and runs exactly once regardless of
   *  how long the engine runs afterward. Math.random() here is fine: this
   *  is a static noise texture baked once at startup, not part of the
   *  deterministic RPM/gear simulation state. */
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
    // catches whatever headroom five summed layers eat into so the
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

    // ---- Layer 4: INTAKE/EXHAUST -------------------------------------------
    noiseSource = ctx.createBufferSource();
    noiseSource.buffer = buildNoiseBuffer(ctx);
    noiseSource.loop = true;
    intakeFilter = ctx.createBiquadFilter();
    intakeFilter.type = 'bandpass';
    intakeFilter.frequency.value = INTAKE_FILTER_MIN_HZ;
    intakeFilter.Q.value = INTAKE_FILTER_Q;
    intakeLayerGain = ctx.createGain();
    intakeLayerGain.gain.value = INTAKE_GAIN_MIN;
    noiseSource.connect(intakeFilter).connect(intakeLayerGain);
    intakeLayerGain.connect(mixBus);

    // ---- Layer 5: REV LIMITER (modulates mixBus gain, not its own voice) --
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
    noiseSource.start();
    limiterLfo.start();

    isInitialized = true;
    console.info('[AudioEngine] AudioContext + 5-layer synthesis graph initialized.');
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
   *  source are left running silently underneath (cheap, and avoids
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

  /**
   * Per-frame update — called from EngineState's subscribe alongside
   * UIController's own render(), so audio tracks the exact same
   * telemetry frame the gauge/needle are drawing this tick. Only ever
   * touches existing AudioParams via glide() — never creates, connects,
   * or starts a node.
   *
   * frame: { rpm, throttlePercent, revLimiting, engineOn }
   */
  function update(frame) {
    if (!isInitialized) return;

    const fraction = rpmFractionOf(frame.rpm);
    const throttleFraction = clamp01((frame.throttlePercent || 0) / 100);
    const fundFreq = IDLE_FREQ_HZ + fraction * (MAX_FREQ_HZ - IDLE_FREQ_HZ);

    // ---- Layer 1: ENGINE LOW — pitch + level, RPM-driven -------------------
    glide(oscLow1.frequency, fundFreq / 4);
    glide(oscLow2.frequency, fundFreq / 2);
    glide(lowLayerGain.gain, LOW_GAIN_MIN + fraction * (LOW_GAIN_MAX - LOW_GAIN_MIN));

    // ---- Layer 2: ENGINE MID — pitch RPM-driven, level ~constant -----------
    glide(oscMid.frequency, fundFreq);
    glide(midLayerGain.gain, MID_GAIN);

    // ---- Layer 3: ENGINE HIGH — fades in with RPM ---------------------------
    glide(oscHigh1.frequency, fundFreq * 2);
    glide(oscHigh2.frequency, fundFreq * 3);
    glide(highLayerGain.gain, HIGH_GAIN_MIN + fraction * (HIGH_GAIN_MAX - HIGH_GAIN_MIN));
    glide(gainHigh1.gain, 0.7);
    glide(gainHigh2.gain, HIGH2_GAIN_MIN + fraction * (HIGH2_GAIN_MAX - HIGH2_GAIN_MIN));

    // ---- Layer 4: INTAKE/EXHAUST — mostly throttle, some RPM -----------------
    const intakeFromThrottle = throttleFraction * INTAKE_THROTTLE_WEIGHT;
    const intakeFromRpm = fraction * (1 - INTAKE_THROTTLE_WEIGHT);
    const intakeMix = clamp01(intakeFromThrottle + intakeFromRpm);
    glide(intakeLayerGain.gain, INTAKE_GAIN_MIN + intakeMix * (INTAKE_GAIN_MAX - INTAKE_GAIN_MIN));
    glide(intakeFilter.frequency, INTAKE_FILTER_MIN_HZ + fraction * (INTAKE_FILTER_MAX_HZ - INTAKE_FILTER_MIN_HZ));

    // ---- Layer 5: REV LIMITER — stutter only while actually limiting --------
    glide(limiterLfoDepthGain.gain, frame.revLimiting ? LIMITER_LFO_DEPTH : 0, 0.03);

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
