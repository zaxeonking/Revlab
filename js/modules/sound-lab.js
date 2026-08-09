/**
 * REVLAB — sound-lab.js
 * -----------------------------------------------------------------------
 * SOUND LAB: lets the user load their OWN local audio files for five
 * continuous RPM-band engine layers plus two one-shot triggers, and has
 * RPM itself act as the crossfade controller between them — same "RPM
 * drives the mix" principle audio-engine.js already uses for its
 * synthesized layers, just applied to real sample playback instead of
 * oscillators.
 *
 *   - IDLE       continuous bed, loops under idleRpm .. idleTopRpm
 *   - LOW RPM    continuous bed, loops through the low RPM band
 *   - MID RPM    continuous bed, loops through the mid RPM band
 *   - HIGH RPM   continuous bed, loops through the high RPM band, up to redline
 *   - LIMITER    continuous bed, only audible while revLimiting is true
 *   - TURBO      one-shot trigger, fired on a boost spike (blow-off feel)
 *   - SHIFT      one-shot trigger, fired the instant a gear shift happens
 *
 * RPM → BAND MAPPING (real engine constants, not arbitrary numbers)
 * -----------------------------------------------------------------------
 * Band edges are read from RPMSimulator's actual idle/redline/max RPM
 * (js/modules/rpm-simulator.js), the SAME constants EngineState and the
 * gauge/shift-lights already use — so "LOW RPM" in Sound Lab means
 * exactly the RPM range the rest of the cockpit calls low RPM, and stays
 * correct even if VEHICLE SETUP changes idle/redline/max at runtime
 * (computeBandEdges() re-reads RPMSimulator's live getters every frame —
 * three cheap getter calls, no allocation).
 *
 *   idleRpm ---- idleTop ---- lowTop ---- midTop ---- highTop(redline/max)
 *      [  IDLE  ][   LOW RPM  ][  MID RPM ][   HIGH RPM   ]
 *                                                 [ LIMITER: revLimiting only ]
 *
 * CROSSFADE — REUSABLE NODES, NEVER RESTARTED
 * -----------------------------------------------------------------------
 * Each continuous category gets exactly ONE persistent graph, built once
 * the first time a file is loaded for that category:
 *
 *   <audio loop> --MediaElementAudioSourceNode--> GainNode(band) --> masterBus --> destination
 *
 * The <audio> element is .play()'d exactly once (the first frame its
 * band-mix becomes audible) and is then left running continuously,
 * looped, for the rest of the session — RPM changes NEVER call
 * .play()/.pause()/.load() again on a continuous category. All RPM/
 * crossfade response happens purely through GainNode.gain automation
 * (AudioParam.setTargetAtTime, exactly like audio-engine.js's glide()),
 * which is click-free and never touches playback position. Adjacent
 * bands overlap smoothly (linear crossfade over a shared transition zone
 * at each edge) instead of hard-cutting, so moving the needle across a
 * boundary fades one sample out while fading the next one in.
 *
 * PRIVACY / "no upload" contract
 * -----------------------------------------------------------------------
 * Every file picked here is read ONLY through the browser File API
 * (<input type="file">, then URL.createObjectURL()). Nothing is ever
 * sent over the network — there is no fetch()/XHR to any endpoint
 * anywhere in this file. The resulting blob: URL lives purely in this
 * tab's memory and is revoked (URL.revokeObjectURL) the moment the
 * sample is removed/replaced or the page unloads. Sample bytes are NOT
 * persisted (no localStorage / IndexedDB) — a page reload starts fresh.
 *
 * FALLBACK CONTRACT
 * -----------------------------------------------------------------------
 * SoundLab never silences a category on its own. For every category with
 * no custom sample loaded, AudioEngine's synthesized layer for that
 * category is simply left doing what it already does (see
 * audio-engine.js, which reads SoundLab.hasCustom() per-layer to duck
 * itself out only where a custom sample is actually taking over).
 *
 * SPEED IS UNTOUCHED
 * -----------------------------------------------------------------------
 * This module only ever READS frame.rpm as a mix-control input. Speed
 * remains the simulator's own output, computed independently by
 * EngineState/RPMSimulator from gear ratio + wheel circumference + RPM
 * exactly as before — nothing here writes back into engine state.
 * -----------------------------------------------------------------------
 */

const SoundLab = (() => {
  const CONTINUOUS = ['idle', 'low', 'mid', 'high', 'limiter'];
  const ONE_SHOT = ['turbo', 'shift'];
  const ALL = [...CONTINUOUS, ...ONE_SHOT];

  const CATEGORY_META = {
    idle:    { label: 'IDLE',     kind: 'continuous', hint: 'Diputar pada band RPM idle (mesin diam/langsam).' },
    low:     { label: 'LOW RPM',  kind: 'continuous', hint: 'Diputar pada band RPM rendah, crossfade dari IDLE.' },
    mid:     { label: 'MID RPM',  kind: 'continuous', hint: 'Diputar pada band RPM menengah, crossfade dari LOW.' },
    high:    { label: 'HIGH RPM', kind: 'continuous', hint: 'Diputar pada band RPM tinggi menjelang redline.' },
    limiter: { label: 'LIMITER',  kind: 'continuous', hint: 'Diputar hanya saat rev limiter aktif (fuel-cut).' },
    turbo:   { label: 'TURBO',    kind: 'oneshot',    hint: 'Dipicu sekali saat boost naik tajam (blow-off).' },
    shift:   { label: 'SHIFT',    kind: 'oneshot',    hint: 'Dipicu sekali setiap kali gigi berpindah.' },
  };

  // How much of each band, at its edges, overlaps with its neighbor for
  // a smooth crossfade instead of a hard cut. Expressed as a fraction of
  // the smaller of the two adjacent band widths.
  const CROSSFADE_FRACTION = 0.35;
  const GAIN_SMOOTH_TC = 0.08; // AudioParam.setTargetAtTime time constant

  // Per-category state.
  // audio/objectUrl/file: local file plumbing.
  // ctx-side sourceNode/gainNode: the REUSABLE Web Audio graph — built
  // once per loaded file, torn down only on removeCategory()/reload,
  // NEVER rebuilt on a per-frame basis.
  const slots = {};
  ALL.forEach((cat) => {
    slots[cat] = {
      file: null,
      objectUrl: null,
      audioEl: null,
      sourceNode: null,   // MediaElementAudioSourceNode, created once per audioEl
      gainNode: null,     // GainNode, created once per audioEl — the crossfade fader
      volume: 1,          // 0..1 per-category volume (user-set, independent of RPM fade)
      started: false,     // true once audioEl.play() has actually been called
    };
  });

  let masterVolume = 1;
  let listeners = [];

  // ---- Shared audio graph tail: masterBus -> destination -----------------
  // Built lazily, once, the first time any category actually needs a
  // real AudioContext (i.e. the first file load). Kept separate from
  // AudioEngine's own AudioContext deliberately — SoundLab must work
  // (preview, etc.) even before the cockpit's Start Engine gesture has
  // created AudioEngine's context.
  let ctx = null;
  let masterBus = null;

  function ensureContext() {
    if (ctx) return ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    masterBus = ctx.createGain();
    masterBus.gain.value = masterVolume;
    masterBus.connect(ctx.destination);
    return ctx;
  }

  function notify() {
    const snapshot = getSnapshot();
    listeners.forEach((fn) => {
      try { fn(snapshot); } catch (err) { console.error('[SoundLab] listener error', err); }
    });
  }

  function subscribe(fn) {
    listeners.push(fn);
    return () => { listeners = listeners.filter((l) => l !== fn); };
  }

  function isAudioCategory(category) {
    return Object.prototype.hasOwnProperty.call(slots, category);
  }

  function clamp01(n) {
    return Math.min(Math.max(n, 0), 1);
  }

  function effectiveVolume(category) {
    const slot = slots[category];
    if (!slot) return 0;
    return clamp01(slot.volume) * clamp01(masterVolume);
  }

  /** Ramps a gain node's value smoothly — the crossfade primitive every
   *  band-mix update below goes through, never a raw `.value =` write,
   *  matching the click-free discipline AudioEngine's glide() uses. */
  function glideGain(gainNode, target, timeConstant = GAIN_SMOOTH_TC) {
    if (!ctx || !gainNode) return;
    gainNode.gain.setTargetAtTime(target, ctx.currentTime, timeConstant);
  }

  /**
   * Loads a user-picked local File into a category slot and builds its
   * REUSABLE playback graph exactly once:
   *   <audio> --createMediaElementSource--> GainNode --> masterBus
   * This graph is built here and only here — never inside update().
   * Uses URL.createObjectURL, a purely local, in-memory reference; the
   * file's bytes never leave the browser and no network request is made.
   */
  function loadFile(category, file) {
    if (!isAudioCategory(category)) return { ok: false, reason: 'unknown_category' };
    if (!file) return { ok: false, reason: 'no_file' };
    if (!file.type.startsWith('audio/')) {
      return { ok: false, reason: 'not_audio' };
    }

    const audioCtx = ensureContext();
    if (!audioCtx) return { ok: false, reason: 'unsupported' };

    // Clean up any previous sample/graph for this category first, so
    // object URLs and audio nodes never leak across repeated picks.
    releaseSlot(category, { silent: true });

    const slot = slots[category];
    const objectUrl = URL.createObjectURL(file);
    const audioEl = new Audio(objectUrl);
    audioEl.preload = 'auto';
    audioEl.loop = CATEGORY_META[category].kind === 'continuous';

    // Build the reusable node graph ONCE for this element. A
    // MediaElementAudioSourceNode can only ever be created once per
    // <audio> element (a second call throws), which is exactly the
    // "build once, never rebuild" contract this module wants — it's
    // structurally impossible to accidentally re-create this per frame.
    const sourceNode = audioCtx.createMediaElementSource(audioEl);
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = 0; // starts silent; RPM-band mix fades it in via update()
    sourceNode.connect(gainNode).connect(masterBus);

    slot.file = file;
    slot.objectUrl = objectUrl;
    slot.audioEl = audioEl;
    slot.sourceNode = sourceNode;
    slot.gainNode = gainNode;
    slot.started = false;

    notify();
    return { ok: true, name: file.name, size: file.size };
  }

  /** Releases a single category's sample: pauses playback, disconnects
   *  the graph, revokes the object URL, and clears the slot. */
  function releaseSlot(category, opts = {}) {
    const slot = slots[category];
    if (!slot) return;
    if (slot.gainNode) {
      try { slot.gainNode.disconnect(); } catch (e) { /* already disconnected */ }
      slot.gainNode = null;
    }
    if (slot.sourceNode) {
      try { slot.sourceNode.disconnect(); } catch (e) { /* already disconnected */ }
      slot.sourceNode = null;
    }
    if (slot.audioEl) {
      slot.audioEl.pause();
      slot.audioEl.src = '';
      slot.audioEl = null;
    }
    if (slot.objectUrl) {
      URL.revokeObjectURL(slot.objectUrl);
      slot.objectUrl = null;
    }
    slot.file = null;
    slot.started = false;
    if (!opts.silent) notify();
  }

  function removeCategory(category) {
    if (!isAudioCategory(category)) return { ok: false };
    releaseSlot(category);
    return { ok: true };
  }

  function resetAll() {
    ALL.forEach((cat) => releaseSlot(cat, { silent: true }));
    masterVolume = 1;
    if (masterBus) masterBus.gain.value = masterVolume;
    notify();
    return { ok: true };
  }

  function hasCustom(category) {
    const slot = slots[category];
    return !!(slot && slot.audioEl);
  }

  function getFileName(category) {
    const slot = slots[category];
    return slot && slot.file ? slot.file.name : null;
  }

  function getVolume(category) {
    const slot = slots[category];
    return slot ? slot.volume : 1;
  }

  function setVolume(category, volume0to1) {
    const slot = slots[category];
    if (!slot) return;
    slot.volume = clamp01(volume0to1);
    // Re-apply through the current band-mix fraction rather than
    // overwriting it outright, so a mid-band volume tweak doesn't undo
    // the RPM crossfade already in progress.
    if (slot.gainNode) glideGain(slot.gainNode, (lastBandMix[category] || 0) * effectiveVolume(category), 0.05);
    notify();
  }

  function setMasterVolume(volume0to1) {
    masterVolume = clamp01(volume0to1);
    if (masterBus) glideGain(masterBus, masterVolume, 0.05);
    notify();
  }

  function getMasterVolume() {
    return masterVolume;
  }

  /** Plays a short local preview of a loaded category sample at full
   *  volume regardless of live RPM — independent of engine-sound
   *  playback, used by the "▶ preview" button in the Sound Lab panel.
   *  Does not touch the reusable node graph's connections, only the
   *  transport (currentTime/play) and its own gain value momentarily. */
  function preview(category) {
    const slot = slots[category];
    if (!slot || !slot.audioEl || !slot.gainNode) return { ok: false, reason: 'no_sample' };
    try {
      slot.audioEl.currentTime = 0;
      if (ctx && ctx.state === 'suspended') ctx.resume();
      glideGain(slot.gainNode, effectiveVolume(category), 0.02);
      const p = slot.audioEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      slot.started = true;
    } catch (err) {
      console.warn('[SoundLab] preview() failed', err);
      return { ok: false, reason: 'playback_error' };
    }
    return { ok: true };
  }

  function stopPreview(category) {
    const slot = slots[category];
    if (!slot || !slot.audioEl) return;
    // Only actually pause if the live RPM mix isn't also using this
    // element right now (band mix ~0) — otherwise closing a preview
    // shouldn't cut off audio the RPM crossfade currently needs playing.
    if ((lastBandMix[category] || 0) <= 0.001) {
      slot.audioEl.pause();
      slot.audioEl.currentTime = 0;
      slot.started = false;
    }
    if (slot.gainNode) glideGain(slot.gainNode, (lastBandMix[category] || 0) * effectiveVolume(category), 0.05);
  }

  // ---- RPM band edges — read from real engine constants, not hardcoded ---
  function computeBandEdges() {
    const RS = window.RPMSimulator;
    const idleRpm = RS ? RS.getIdleRpm() : 800;
    const redlineRpm = RS ? RS.getRedlineRpm() : 7500;
    const maxRpm = RS ? RS.getMaxRpm() : 9000;

    // Idle occupies a narrow band right at idle; low/mid/high split the
    // remaining span up to redline evenly; limiter is a separate,
    // non-RPM-range trigger (revLimiting flag) layered on top instead of
    // occupying its own slice of the RPM axis.
    const idleTop = idleRpm + Math.max(150, (redlineRpm - idleRpm) * 0.05);
    const workingSpan = Math.max(1, redlineRpm - idleTop);
    const lowTop = idleTop + workingSpan / 3;
    const midTop = idleTop + (workingSpan * 2) / 3;
    const highTop = Math.max(redlineRpm, maxRpm);

    return { idleRpm, idleTop, lowTop, midTop, highTop, redlineRpm, maxRpm };
  }

  /** Given the current RPM and the computed band edges, returns a
   *  { idle, low, mid, high } mix object where each value is 0..1 — a
   *  linear crossfade driven purely by RPM position, recomputed fresh
   *  every frame from rpm (a pure function of rpm + edges, no hidden
   *  state), then only ever APPLIED via smoothed gain glides. */
  function computeBandMix(rpm, edges) {
    const { idleRpm, idleTop, lowTop, midTop, highTop } = edges;

    function edgeFade(x, bandStart, bandEnd, prevWidth, nextWidth) {
      // 1.0 in the band's stable middle, fading linearly to 0 across a
      // CROSSFADE_FRACTION-sized zone shared with each neighboring band.
      const inFade = Math.min(prevWidth * CROSSFADE_FRACTION, (bandEnd - bandStart) / 2);
      const outFade = Math.min(nextWidth * CROSSFADE_FRACTION, (bandEnd - bandStart) / 2);
      if (x <= bandStart - inFade || x >= bandEnd + outFade) return 0;
      if (x < bandStart + inFade && inFade > 0) {
        return clamp01((x - (bandStart - inFade)) / (2 * inFade));
      }
      if (x > bandEnd - outFade && outFade > 0) {
        return clamp01(((bandEnd + outFade) - x) / (2 * outFade));
      }
      return 1;
    }

    const idleWidth = Math.max(1, idleTop - idleRpm);
    const lowWidth = Math.max(1, lowTop - idleTop);
    const midWidth = Math.max(1, midTop - lowTop);
    const highWidth = Math.max(1, highTop - midTop);

    const raw = {
      idle: edgeFade(rpm, idleRpm - idleWidth * 0.5, idleTop, idleWidth, lowWidth),
      low: edgeFade(rpm, idleTop, lowTop, idleWidth, midWidth),
      mid: edgeFade(rpm, lowTop, midTop, lowWidth, highWidth),
      high: edgeFade(rpm, midTop, highTop, midWidth, highWidth),
    };

    // Below idle band entirely (engine just starting) — treat as idle.
    if (rpm < idleRpm) raw.idle = 1;

    // Normalize so overlapping fade zones never sum above 1 (keeps
    // total perceived loudness roughly constant through a crossfade
    // instead of briefly ducking or spiking at the boundary).
    const sum = raw.idle + raw.low + raw.mid + raw.high;
    if (sum > 1) {
      raw.idle /= sum; raw.low /= sum; raw.mid /= sum; raw.high /= sum;
    }
    return raw;
  }

  // Last-applied mix per category — used by setVolume()/stopPreview() so
  // a volume tweak or preview-stop re-applies against the crossfade
  // position currently in effect rather than fighting it.
  const lastBandMix = { idle: 0, low: 0, mid: 0, high: 0, limiter: 0 };

  /** Starts an <audio> element's continuous loop exactly once. Safe to
   *  call every frame — it's a no-op after the first real start, which
   *  is the whole point: RPM changes drive gain, never playback
   *  transport, after this first call. */
  function ensureStarted(category) {
    const slot = slots[category];
    if (!slot || !slot.audioEl || slot.started) return;
    if (ctx && ctx.state === 'suspended') ctx.resume();
    const p = slot.audioEl.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    slot.started = true;
  }

  /** Stops a continuous category's transport — only called when the
   *  engine itself turns off, NOT on every RPM-band change (band changes
   *  only ever touch gain, per the module contract). */
  function stopContinuous(category) {
    const slot = slots[category];
    if (!slot || !slot.audioEl) return;
    slot.audioEl.pause();
    slot.audioEl.currentTime = 0;
    slot.started = false;
  }

  let liveRunning = false;

  /**
   * Per-frame update — called from the same EngineState.subscribe tick
   * that drives AudioEngine.update(), so SoundLab tracks the exact same
   * telemetry frame the gauge/needle/synth are rendering this tick.
   *
   * RPM IS THE CONTROLLER: computeBandMix(frame.rpm, ...) decides how
   * loud each loaded custom sample is, every frame — but the actual
   * audio nodes (<audio>, MediaElementAudioSourceNode, GainNode) were
   * all built once in loadFile() and are NEVER recreated or restarted
   * here. Only glideGain() (a smoothed AudioParam ramp) is called
   * per-frame, exactly mirroring how audio-engine.js's own update()
   * only ever calls glide() on already-built nodes.
   *
   * frame: { rpm, rpmK, maxRpmK, throttlePercent, revLimiting, engineOn,
   *          boostBar, shifting }
   */
  function update(frame) {
    if (!frame.engineOn) {
      if (liveRunning) {
        CONTINUOUS.forEach((cat) => {
          if (hasCustom(cat)) stopContinuous(cat);
          lastBandMix[cat] = 0;
        });
        liveRunning = false;
      }
      return;
    }
    liveRunning = true;

    const edges = computeBandEdges();
    const mix = computeBandMix(frame.rpm || 0, edges);

    ['idle', 'low', 'mid', 'high'].forEach((cat) => {
      lastBandMix[cat] = mix[cat];
      if (!hasCustom(cat)) return;
      // Start the loop once (no-op every subsequent frame), then only
      // ever move its gain — never its transport — from here on.
      if (mix[cat] > 0.001) ensureStarted(cat);
      glideGain(slots[cat].gainNode, mix[cat] * effectiveVolume(cat));
    });

    // LIMITER: not an RPM-range band — an independent overlay gated
    // purely by the revLimiting flag, same as AudioEngine's own limiter
    // stutter layer. Reuses the exact same ensureStarted/glideGain
    // pattern as the RPM bands above — no separate code path for
    // "starting" vs "fading."
    lastBandMix.limiter = frame.revLimiting ? 1 : 0;
    if (hasCustom('limiter')) {
      if (frame.revLimiting) {
        ensureStarted('limiter');
        glideGain(slots.limiter.gainNode, effectiveVolume('limiter'), 0.03);
      } else {
        glideGain(slots.limiter.gainNode, 0, 0.03);
      }
    }

    // TURBO one-shot: fire once per boost spike, on the rising edge past
    // a threshold, not every frame boost happens to be high. One-shots
    // reuse the SAME persistent graph as the continuous categories
    // (built once in loadFile()) — firing one just restarts ITS OWN
    // transport from 0, which is the expected behavior for a discrete
    // trigger sound (unlike the continuous beds, whose transport is
    // never touched after their first start).
    if (hasCustom('turbo')) {
      const boost = frame.boostBar || 0;
      if (boost > TURBO_TRIGGER_BAR && !turboFiredThisSpike) {
        fireOneShot('turbo');
        turboFiredThisSpike = true;
      } else if (boost < TURBO_RESET_BAR) {
        turboFiredThisSpike = false;
      }
    }

    // SHIFT one-shot: fire on the rising edge of frame.shifting.
    if (hasCustom('shift')) {
      if (frame.shifting && !shiftWasActive) {
        fireOneShot('shift');
      }
      shiftWasActive = !!frame.shifting;
    }
  }

  const TURBO_TRIGGER_BAR = 0.55;
  const TURBO_RESET_BAR = 0.25;
  let turboFiredThisSpike = false;
  let shiftWasActive = false;

  function fireOneShot(category) {
    const slot = slots[category];
    if (!slot || !slot.audioEl || !slot.gainNode) return;
    try {
      if (ctx && ctx.state === 'suspended') ctx.resume();
      slot.audioEl.currentTime = 0;
      glideGain(slot.gainNode, effectiveVolume(category), 0.01);
      const p = slot.audioEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (err) {
      console.warn(`[SoundLab] one-shot "${category}" failed`, err);
    }
  }

  function getSnapshot() {
    const categories = {};
    const edges = computeBandEdges();
    ALL.forEach((cat) => {
      categories[cat] = {
        label: CATEGORY_META[cat].label,
        kind: CATEGORY_META[cat].kind,
        hint: CATEGORY_META[cat].hint,
        hasCustom: hasCustom(cat),
        fileName: getFileName(cat),
        fileSize: slots[cat].file ? slots[cat].file.size : null,
        volume: slots[cat].volume,
        currentMix: lastBandMix[cat] || 0,
      };
    });
    return { categories, masterVolume, anyCustom: ALL.some(hasCustom), rpmBandEdges: edges };
  }

  window.addEventListener('beforeunload', () => {
    ALL.forEach((cat) => releaseSlot(cat, { silent: true }));
  });

  return {
    CATEGORIES: ALL,
    CATEGORY_META,
    loadFile,
    removeCategory,
    resetAll,
    hasCustom,
    getFileName,
    getVolume,
    setVolume,
    getMasterVolume,
    setMasterVolume,
    preview,
    stopPreview,
    update,
    subscribe,
    getSnapshot,
  };
})();
