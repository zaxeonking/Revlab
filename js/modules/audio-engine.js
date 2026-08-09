/**
 * REVLAB — audio-engine.js
 * -----------------------------------------------------------------------
 * Real Web Audio API engine tone, driven every frame by EngineState.
 * No samples, no <audio> tags — the whole "engine" is a small synthesis
 * graph that RPM pushes around in real time:
 *
 *   osc(low)  --gainLow--\
 *   osc(fund) --gainFund---+--> mixGain --> lowpass filter --> ampGain --> masterGain --> destination
 *   osc(harm) --gainHarm--/                                        ^
 *                                                    limiterLfo --gainLfoDepth (redline stutter)
 *
 *   - AudioContext is created lazily, inside AudioEngine.init(), and
 *     init() is only ever called from a real user gesture (the Start
 *     Engine button click in ui-controller.js) — browsers block
 *     AudioContext from producing sound otherwise, and starting it
 *     unprompted would also just be rude.
 *   - RPM is the ONLY thing that drives pitch (fundamental + harmonic +
 *     sub oscillator frequencies, and the filter's cutoff). Throttle is
 *     used only as a small secondary "bite" on top of that — it never
 *     moves pitch on its own, so two moments at the same RPM sound like
 *     the same RPM even if one is throttle-on and one is coasting.
 *   - Every AudioParam that changes every frame (frequency, filter
 *     cutoff, gains) is moved with setTargetAtTime, never a raw `.value =`
 *     write — a raw write at 60fps still produces audible zipper/stair-
 *     step noise, setTargetAtTime is the standard click-free way to glide
 *     a param toward a new target every frame.
 *   - Levels are sized with headroom (three oscillators summed well
 *     under 1.0, master bus under 1.0) instead of relying on a limiter/
 *     compressor node, so nothing clips even when the redline-stutter
 *     LFO pushes gain up momentarily.
 * -----------------------------------------------------------------------
 */

const AudioEngine = (() => {
  // ---- Pitch mapping (RPM -> Hz) --------------------------------------
  // Idle sits low and rumbly; redline/rev-limit sits bright and urgent.
  // Linear across the full 0..MAX_RPM range, matching RPMSimulator's own
  // 0-as-idle-baseline scale (see rpm-simulator.js) so "idle" here means
  // the same thing it means there.
  const MAX_RPM = 9000; // mirrors RPMSimulator.MAX_RPM — kept local so this
                         // module has no hard load-order dependency on it.
  const IDLE_FREQ_HZ = 42;
  const MAX_FREQ_HZ = 340;

  // Harmonic oscillator (one octave above fundamental) fades IN with RPM
  // — idle reads as a soft low rumble, high RPM reads brighter/angrier
  // as that upper harmonic gains presence. Sub oscillator (one octave
  // below) does the opposite: strong low-end body at idle/low RPM,
  // fading out up top so it doesn't turn into mud at high revs.
  const HARMONIC_GAIN_MIN = 0.05;
  const HARMONIC_GAIN_MAX = 0.30;
  const SUB_GAIN_MIN = 0.35;
  const SUB_GAIN_MAX = 0.10;
  const FUND_GAIN = 0.34;

  // Throttle's ONLY job is a small extra bite on the harmonic layer —
  // pitch itself never moves from throttle, only RPM moves pitch.
  const THROTTLE_BITE_MAX = 0.10;

  // Filter opens up as RPM climbs — muffled/rounded at idle, snarling
  // and present near redline. Q kept modest so it colors the tone
  // without ringing/whistling.
  const FILTER_FREQ_MIN_HZ = 280;
  const FILTER_FREQ_MAX_HZ = 3200;
  const FILTER_Q = 0.9;

  // Redline stutter: a low-frequency oscillator modulates the amp gain
  // to sound like fuel-cut chatter, only while EngineState reports
  // revLimiting. 55Hz sits in the classic "brrrp" rev-limiter range.
  const LIMITER_LFO_HZ = 55;
  const LIMITER_LFO_DEPTH = 0.38;

  const RUNNING_LEVEL = 0.55; // master bus target level while engine is "on"
  const PARAM_SMOOTH_TC = 0.045; // setTargetAtTime time constant for per-frame params
  const MASTER_FADE_IN_TC = 0.12;
  const MASTER_FADE_OUT_TC = 0.35; // slower: lets the engine "spin down and fade" together

  let ctx = null;
  let masterGain = null;
  let ampGain = null;
  let filter = null;
  let mixGain = null;

  let oscFund = null;
  let oscHarm = null;
  let oscSub = null;
  let gainFund = null;
  let gainHarm = null;
  let gainSub = null;

  let limiterLfo = null;
  let limiterLfoDepthGain = null;

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
   *  click-prone `.value =` write. */
  function glide(param, target, timeConstant = PARAM_SMOOTH_TC) {
    if (!ctx) return;
    param.setTargetAtTime(target, ctx.currentTime, timeConstant);
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

    // ---- Oscillators (the only pitch sources) --------------------------
    oscFund = ctx.createOscillator();
    oscHarm = ctx.createOscillator();
    oscSub = ctx.createOscillator();
    oscFund.type = 'sawtooth';
    oscHarm.type = 'sawtooth';
    oscSub.type = 'sawtooth';
    oscFund.frequency.value = IDLE_FREQ_HZ;
    oscHarm.frequency.value = IDLE_FREQ_HZ * 2;
    oscSub.frequency.value = IDLE_FREQ_HZ / 2;

    gainFund = ctx.createGain();
    gainHarm = ctx.createGain();
    gainSub = ctx.createGain();
    gainFund.gain.value = FUND_GAIN;
    gainHarm.gain.value = HARMONIC_GAIN_MIN;
    gainSub.gain.value = SUB_GAIN_MIN;

    // ---- Mix -> filter -> amp -> master ---------------------------------
    mixGain = ctx.createGain();
    mixGain.gain.value = 1;

    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = FILTER_FREQ_MIN_HZ;
    filter.Q.value = FILTER_Q;

    ampGain = ctx.createGain();
    ampGain.gain.value = 1; // modulated by the redline LFO around this baseline

    masterGain = ctx.createGain();
    masterGain.gain.value = 0; // starts silent; start() fades this in

    oscFund.connect(gainFund).connect(mixGain);
    oscHarm.connect(gainHarm).connect(mixGain);
    oscSub.connect(gainSub).connect(mixGain);
    mixGain.connect(filter);
    filter.connect(ampGain);
    ampGain.connect(masterGain);
    masterGain.connect(ctx.destination);

    // ---- Redline stutter LFO --------------------------------------------
    // Connected straight into ampGain.gain: an oscillator feeding an
    // AudioParam adds its (depth-scaled) waveform on top of whatever the
    // param's own value is — exactly how Web Audio expects param
    // modulation to be wired, no extra "mixer" node needed for this part.
    limiterLfo = ctx.createOscillator();
    limiterLfo.type = 'square';
    limiterLfo.frequency.value = LIMITER_LFO_HZ;
    limiterLfoDepthGain = ctx.createGain();
    limiterLfoDepthGain.gain.value = 0; // silent until revLimiting turns it on
    limiterLfo.connect(limiterLfoDepthGain);
    limiterLfoDepthGain.connect(ampGain.gain);

    oscFund.start();
    oscHarm.start();
    oscSub.start();
    limiterLfo.start();

    isInitialized = true;
    console.info('[AudioEngine] AudioContext + synthesis graph initialized.');
    return { ok: true };
  }

  /** Fades the engine tone in. Safe to call repeatedly (e.g. re-clicking
   *  Start Engine) — it just re-targets the same fade. */
  function start() {
    if (!isInitialized) {
      console.warn('[AudioEngine] start() called before init().');
      return { ok: false, reason: 'not_initialized' };
    }
    if (ctx.state === 'suspended') ctx.resume();
    glide(masterGain.gain, RUNNING_LEVEL, MASTER_FADE_IN_TC);
    isRunning = true;
    return { ok: true };
  }

  /** Fades the engine tone out. Oscillators are left running silently
   *  (cheap, and avoids re-triggering start-up clicks) — only the
   *  master bus gain is pulled to 0, on a slower time constant so the
   *  tone visibly "spins down" alongside RPM coasting to 0 rather than
   *  cutting off the instant the button is pressed. */
  function stop() {
    if (!isInitialized) return { ok: false, reason: 'not_initialized' };
    glide(masterGain.gain, 0, MASTER_FADE_OUT_TC);
    isRunning = false;
    return { ok: true };
  }

  /**
   * Per-frame update — called from EngineState's subscribe alongside
   * UIController's own render(), so audio tracks the exact same
   * telemetry frame the gauge/needle are drawing this tick.
   *
   * frame: { rpm, throttlePercent, revLimiting, engineOn }
   */
  function update(frame) {
    if (!isInitialized) return;

    const fraction = rpmFractionOf(frame.rpm);
    const throttleFraction = clamp01((frame.throttlePercent || 0) / 100);

    // ---- Pitch: RPM is the only driver ----------------------------------
    const fundFreq = IDLE_FREQ_HZ + fraction * (MAX_FREQ_HZ - IDLE_FREQ_HZ);
    glide(oscFund.frequency, fundFreq);
    glide(oscHarm.frequency, fundFreq * 2);
    glide(oscSub.frequency, fundFreq / 2);

    // ---- Harmonic balance: brighter/thinner low-end as RPM climbs -------
    const harmGain = HARMONIC_GAIN_MIN + fraction * (HARMONIC_GAIN_MAX - HARMONIC_GAIN_MIN)
      + throttleFraction * THROTTLE_BITE_MAX; // small extra bite under power only
    const subGain = SUB_GAIN_MIN + fraction * (SUB_GAIN_MAX - SUB_GAIN_MIN);
    glide(gainHarm.gain, harmGain);
    glide(gainSub.gain, Math.max(subGain, 0));

    // ---- Filter: opens up with RPM, matching the "gets louder/sharper
    // toward redline" brief -----------------------------------------------
    const filterFreq = FILTER_FREQ_MIN_HZ + fraction * (FILTER_FREQ_MAX_HZ - FILTER_FREQ_MIN_HZ);
    glide(filter.frequency, filterFreq);

    // ---- Redline limiter stutter -----------------------------------------
    glide(limiterLfoDepthGain.gain, frame.revLimiting ? LIMITER_LFO_DEPTH : 0, 0.03);

    // ---- Engine on/off tracks the master bus, independent of the frame-
    // by-frame glides above so a stop() fade-out still hears RPM (and
    // therefore pitch) coasting down underneath it. -----------------------
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

  return { init, start, stop, update, getState };
})();
