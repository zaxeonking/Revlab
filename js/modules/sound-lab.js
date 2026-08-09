/**
 * REVLAB — sound-lab.js
 * -----------------------------------------------------------------------
 * SOUND LAB: lets the user load their OWN local audio files for seven
 * engine-sound categories and have REVLAB play those instead of the
 * synthesized Web Audio layers in audio-engine.js.
 *
 *   - IDLE       continuous bed, looped while engine is on & near idle
 *   - LOW RPM    continuous bed, looped, low RPM band
 *   - MID RPM    continuous bed, looped, mid RPM band
 *   - HIGH RPM   continuous bed, looped, high RPM band
 *   - LIMITER    continuous bed, looped, only while revLimiting is true
 *   - TURBO      one-shot trigger, fired on a boost spike (blow-off feel)
 *   - SHIFT      one-shot trigger, fired the instant a gear shift happens
 *
 * PRIVACY / "no upload" contract
 * -----------------------------------------------------------------------
 * Every file picked here is read ONLY through the browser File API
 * (<input type="file">, then URL.createObjectURL()). Nothing is ever
 * sent over the network — there is no fetch()/XHR/fromEntries() to any
 * endpoint anywhere in this file. The resulting blob: URL lives purely
 * in this tab's memory and is revoked (URL.revokeObjectURL) the moment
 * the sample is removed/replaced or the page unloads. Sample bytes are
 * NOT persisted (no localStorage / IndexedDB) — a page reload starts
 * fresh, which is the correct, honest behavior for "local only, nothing
 * leaves this device."
 *
 * FALLBACK CONTRACT
 * -----------------------------------------------------------------------
 * SoundLab never silences a category on its own. For every category with
 * no custom sample loaded, AudioEngine's synthesized layer for that
 * category is simply left doing what it already does (see
 * audio-engine.js). SoundLab.hasCustom(category) is the single query
 * AudioEngine/UIController use to decide, per category, "play the custom
 * <audio> element" vs "let the synth layer speak" — so mixing (e.g. a
 * custom IDLE sample with synthesized everything-else) works with no
 * special-casing anywhere else.
 * -----------------------------------------------------------------------
 */

const SoundLab = (() => {
  // ---- Categories --------------------------------------------------------
  const CONTINUOUS = ['idle', 'low', 'mid', 'high', 'limiter'];
  const ONE_SHOT = ['turbo', 'shift'];
  const ALL = [...CONTINUOUS, ...ONE_SHOT];

  const CATEGORY_META = {
    idle:    { label: 'IDLE',     kind: 'continuous', hint: 'Diputar saat mesin idle / RPM rendah diam.' },
    low:     { label: 'LOW RPM',  kind: 'continuous', hint: 'Diputar pada band RPM rendah.' },
    mid:     { label: 'MID RPM',  kind: 'continuous', hint: 'Diputar pada band RPM menengah.' },
    high:    { label: 'HIGH RPM', kind: 'continuous', hint: 'Diputar pada band RPM tinggi / mendekati redline.' },
    limiter: { label: 'LIMITER',  kind: 'continuous', hint: 'Diputar saat rev limiter aktif (fuel-cut).' },
    turbo:   { label: 'TURBO',    kind: 'oneshot',    hint: 'Dipicu sekali saat boost naik tajam (blow-off).' },
    shift:   { label: 'SHIFT',    kind: 'oneshot',    hint: 'Dipicu sekali setiap kali gigi berpindah.' },
  };

  // Per-category state: { file, objectUrl, audioEl, volume }
  const slots = {};
  ALL.forEach((cat) => {
    slots[cat] = {
      file: null,        // File object (name/size only ever read, never uploaded)
      objectUrl: null,    // blob: URL, local to this tab
      audioEl: null,      // <audio> element used for playback/preview
      volume: 1,          // 0..1 per-category volume
    };
  });

  let masterVolume = 1; // 0..1, applied on top of per-category volume
  let listeners = [];    // UI subscribers, notified on any slot change

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

  function effectiveVolume(category) {
    const slot = slots[category];
    if (!slot) return 0;
    return Math.min(Math.max(slot.volume, 0), 1) * Math.min(Math.max(masterVolume, 0), 1);
  }

  /**
   * Loads a user-picked local File into a category slot. Called from the
   * <input type="file"> change handler. Uses URL.createObjectURL — a
   * purely local, in-memory reference; the file's bytes never leave the
   * browser and no network request is made.
   */
  function loadFile(category, file) {
    if (!isAudioCategory(category)) return { ok: false, reason: 'unknown_category' };
    if (!file) return { ok: false, reason: 'no_file' };
    if (!file.type.startsWith('audio/')) {
      return { ok: false, reason: 'not_audio' };
    }

    const slot = slots[category];

    // Clean up any previous sample for this category first, so object
    // URLs never leak across repeated picks.
    releaseSlot(category, { silent: true });

    const objectUrl = URL.createObjectURL(file);
    const audioEl = new Audio(objectUrl);
    audioEl.preload = 'auto';
    audioEl.loop = CATEGORY_META[category].kind === 'continuous';
    audioEl.volume = effectiveVolume(category);

    slot.file = file;
    slot.objectUrl = objectUrl;
    slot.audioEl = audioEl;

    notify();
    return { ok: true, name: file.name, size: file.size };
  }

  /** Releases a single category's sample: pauses playback, revokes the
   *  object URL (freeing the memory), and clears the slot. */
  function releaseSlot(category, opts = {}) {
    const slot = slots[category];
    if (!slot) return;
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
    if (!opts.silent) notify();
  }

  function removeCategory(category) {
    if (!isAudioCategory(category)) return { ok: false };
    releaseSlot(category);
    return { ok: true };
  }

  /** Resets every category back to "no custom audio" — full fallback to
   *  the synthesized engine. */
  function resetAll() {
    ALL.forEach((cat) => releaseSlot(cat, { silent: true }));
    masterVolume = 1;
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
    slot.volume = Math.min(Math.max(volume0to1, 0), 1);
    if (slot.audioEl) slot.audioEl.volume = effectiveVolume(category);
    notify();
  }

  function setMasterVolume(volume0to1) {
    masterVolume = Math.min(Math.max(volume0to1, 0), 1);
    ALL.forEach((cat) => {
      const slot = slots[cat];
      if (slot.audioEl) slot.audioEl.volume = effectiveVolume(cat);
    });
    notify();
  }

  function getMasterVolume() {
    return masterVolume;
  }

  /** Plays a short local preview of a loaded category sample from the
   *  start, independent of the live engine-sound playback state — used
   *  by the "▶ preview" button in the Sound Lab panel. */
  function preview(category) {
    const slot = slots[category];
    if (!slot || !slot.audioEl) return { ok: false, reason: 'no_sample' };
    try {
      slot.audioEl.pause();
      slot.audioEl.currentTime = 0;
      slot.audioEl.volume = effectiveVolume(category);
      const p = slot.audioEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (err) {
      console.warn('[SoundLab] preview() failed', err);
      return { ok: false, reason: 'playback_error' };
    }
    return { ok: true };
  }

  function stopPreview(category) {
    const slot = slots[category];
    if (slot && slot.audioEl) {
      slot.audioEl.pause();
      slot.audioEl.currentTime = 0;
    }
  }

  // ---- Live engine-sound playback (continuous beds) ------------------------
  // One custom <audio> element per continuous category can be looping at
  // once; which one(s) are actually audible is driven by gain via
  // .volume, mirroring how AudioEngine crossfades its own synth layers by
  // RPM band. Kept dead simple and dependency-free (no Web Audio graph
  // needed for playback — <audio>.volume is enough for a bed crossfade).
  let liveRunning = false;

  function ensureContinuousPlaying(category) {
    const slot = slots[category];
    if (!slot || !slot.audioEl) return;
    if (slot.audioEl.paused) {
      const p = slot.audioEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }

  function pauseContinuous(category) {
    const slot = slots[category];
    if (slot && slot.audioEl && !slot.audioEl.paused) slot.audioEl.pause();
  }

  /**
   * Per-frame update, called from the same EngineState.subscribe tick
   * that drives AudioEngine.update(). Only touches categories that
   * actually HAVE a custom sample loaded — every other category is left
   * alone so AudioEngine's synth keeps handling it untouched.
   *
   * frame: { rpm, rpmK, maxRpmK, throttlePercent, revLimiting, engineOn,
   *          boostBar, shifting }
   */
  function update(frame) {
    if (!frame.engineOn) {
      if (liveRunning) {
        CONTINUOUS.forEach(pauseContinuous);
        liveRunning = false;
      }
      return;
    }
    liveRunning = true;

    const maxRpmK = frame.maxRpmK || 9;
    const rpmFraction = Math.min(Math.max((frame.rpmK || 0) / maxRpmK, 0), 1);

    // Same three-band split the shift lights already use elsewhere in
    // the UI (lo <58%, mid 58–83%, hi >83%) — kept consistent so "LOW /
    // MID / HIGH RPM" in Sound Lab means the same thing a driver would
    // expect from the shift-light bar.
    const band = rpmFraction > 0.83 ? 'high' : rpmFraction > 0.58 ? 'mid' : 'low';

    // IDLE bed: audible near-idle only (throttle mostly closed, low band).
    const idleActive = band === 'low' && frame.throttlePercent < 15;

    ['idle', 'low', 'mid', 'high'].forEach((cat) => {
      if (!hasCustom(cat)) return;
      const active = cat === 'idle' ? idleActive : cat === band;
      if (active) {
        ensureContinuousPlaying(cat);
        slots[cat].audioEl.volume = effectiveVolume(cat);
      } else {
        // Fade toward silent rather than hard-stop, then pause once low —
        // avoids an audible click when crossing band boundaries.
        slots[cat].audioEl.volume = 0;
      }
    });

    if (hasCustom('limiter')) {
      if (frame.revLimiting) {
        ensureContinuousPlaying('limiter');
        slots.limiter.audioEl.volume = effectiveVolume('limiter');
      } else {
        pauseContinuous('limiter');
      }
    }

    // TURBO one-shot: fire once per boost spike, on the rising edge past
    // a threshold, not every frame boost happens to be high.
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
    if (!slot || !slot.audioEl) return;
    try {
      slot.audioEl.currentTime = 0;
      slot.audioEl.volume = effectiveVolume(category);
      const p = slot.audioEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (err) {
      console.warn(`[SoundLab] one-shot "${category}" failed`, err);
    }
  }

  function getSnapshot() {
    const categories = {};
    ALL.forEach((cat) => {
      categories[cat] = {
        label: CATEGORY_META[cat].label,
        kind: CATEGORY_META[cat].kind,
        hint: CATEGORY_META[cat].hint,
        hasCustom: hasCustom(cat),
        fileName: getFileName(cat),
        fileSize: slots[cat].file ? slots[cat].file.size : null,
        volume: slots[cat].volume,
      };
    });
    return { categories, masterVolume, anyCustom: ALL.some(hasCustom) };
  }

  // Revoke any remaining object URLs on unload — good citizenship even
  // though the browser would reclaim tab memory anyway.
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
