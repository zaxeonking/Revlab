/**
 * REVLAB — engine-state.js
 * -----------------------------------------------------------------------
 * Telemetry layer built on top of RPMSimulator (the real, physics-based
 * RPM signal — see js/modules/rpm-simulator.js). This module does NOT
 * own or invent RPM itself anymore; every frame it reads the current
 * simulated RPM and derives the rest of the dashboard (gear, speed,
 * engine temp, boost, status) from it using fixed, deterministic
 * formulas. No Math.random(), no independent timers.
 *
 * This stays a small pub/sub store so the UI layer never touches
 * RPMSimulator or raw numbers directly:
 *
 *   - UIController only ever calls EngineState.getState() / .subscribe()
 *     and forwards user input via EngineState.startEngine() / .stopEngine()
 *     / .setThrottle() / .shiftUp() / .shiftDown() / .setGearMode().
 *   - A future, more complete engine simulator can replace the derive*()
 *     functions below (gear ratios, drivetrain, thermal model, turbo
 *     model) without the UI layer changing at all.
 *
 * Gear logic (`stepGear`) is a small state machine, not a pure lookup,
 * so it can add hysteresis (different RPM thresholds going up vs down)
 * and a shift-lock delay (a brief window after any shift during which
 * no further shift is allowed) — see stepGear() below for why a plain
 * "gearForRpm(rpm)" lookup causes visible flicker at the boundaries.
 * On top of the lock, every actual shift also tells RPMSimulator to
 * dip RPM briefly (RPMSimulator.triggerShiftDip()) and to scale
 * acceleration by the newly engaged gear (RPMSimulator.setGear()) —
 * see rpm-simulator.js for why a shift needs to visibly cost something
 * in RPM, not just silently swap the gear label.
 * -----------------------------------------------------------------------
 */

const EngineState = (() => {
  const AMBIENT_TEMP_C = 24;
  const OPERATING_TEMP_C = 92;
  const MAX_BOOST_BAR = 1.4;
  const MAX_SPEED_KMH = 260;
  // Per-gear speed limiter. Speed used to be derived straight from
  // rpmFraction with no gear awareness at all — meaning revving in
  // NEUTRAL visibly moved the speed readout even though no gear is
  // engaged to actually turn the wheels, and every gear mapped RPM to
  // speed identically. Index 0 (N) is always 0: neutral disconnects the
  // engine from the drivetrain, so the needle can spin all it wants
  // without the car going anywhere. Indices 1–6 are each gear's own
  // speed ceiling (reached at redline while held in that gear) — a real
  // per-gear "limiter" in the sense the user asked for: 1st gear simply
  // cannot produce 6th-gear speeds no matter how hard it's revved.
  const GEAR_MAX_SPEED_KMH = [0, 45, 85, 130, 175, 215, MAX_SPEED_KMH];
  const KMH_PER_MPH = 1.609344;

  const MAX_RPM = RPMSimulator.MAX_RPM;
  const IDLE_RPM = RPMSimulator.IDLE_RPM;
  const REDLINE_RPM = RPMSimulator.REDLINE_RPM;

  // ---- Gear table -----------------------------------------------------
  // Gears are 1-indexed into this array; index 0 is neutral. Each entry
  // carries the RPM that triggers an upshift out of it, and the RPM
  // that triggers a downshift back into it from the gear above — the
  // gap between those two is the hysteresis band. Going up shifts at a
  // HIGHER rpm than coming back down, exactly like a real gearbox: you
  // don't downshift back the instant RPM dips 1 rpm below the upshift
  // point, or the transmission would hunt/flicker between two gears
  // forever at a steady-ish RPM.
  // BUG FIX (gear hunting between 2↔3, and structurally at every
  // boundary from 2nd gear up): downAt used to be picked independently
  // of the shift-dip model. Every real upshift calls
  // RPMSimulator.triggerShiftDip(), which yanks RPM down by
  // SHIFT_DIP_FRACTION (~32%) the instant the new gear engages. If that
  // post-shift floor lands BELOW the new gear's downAt, the very next
  // stepGear() check (as soon as the shift-lock window clears) sees
  // "RPM below downAt" and immediately shifts back down — which then
  // dips RPM again, undershoots the gear below's own downAt, and so on.
  // That's exactly the naik-turun/2-3 hunting bug. Fix: derive downAt
  // FROM the dip math itself (same SHIFT_DIP_FRACTION RPMSimulator
  // actually uses, so the two can never drift out of sync again) with
  // a safety margin, so the post-dip recovery always lands comfortably
  // above the downshift threshold instead of right on top of it.
  const GEAR_DIP_FRACTION = RPMSimulator.GEAR_DIP_FRACTION;
  const DOWNSHIFT_SAFETY_MARGIN_RPM = 150;
  // enteringGearIndex = which gear's dip fraction applies (the gear you
  // land IN after the upshift that this downAt is guarding against —
  // e.g. GEARS[2].downAt uses the dip fraction for ENTERING 2nd, since
  // that's the dip whose post-shift floor this threshold has to clear).
  function safeDownAt(prevUpAt, enteringGearIndex) {
    const fraction = GEAR_DIP_FRACTION[enteringGearIndex] !== undefined
      ? GEAR_DIP_FRACTION[enteringGearIndex]
      : 0.32;
    return Math.round(prevUpAt * (1 - fraction)) - DOWNSHIFT_SAFETY_MARGIN_RPM;
  }

  const GEARS = [
    { label: 'N', upAt: 1200, downAt: null },
    // 1st–4th upAt now equal that gear's own rev-limiter ceiling
    // (RPMSimulator.GEAR_REV_LIMIT_RPM: 3300 / 4800 / 6300 / 7800) —
    // previously AUTO upshifted at much lower, "comfort" points (2000 /
    // 3500 / 5000 / 6500) that had nothing to do with each gear's actual
    // limiter, so AUTO was pulling out of every low gear early ("kecepetan")
    // while MANUAL let you rev the same gear a couple thousand rpm further.
    // Now AUTO holds each gear out to (essentially) its own redline before
    // shifting, same ceiling MANUAL respects — a shift now happens right
    // as the limiter would've started cutting fuel anyway, instead of well
    // before it.
    { label: '1', upAt: 3300, downAt: null },
    { label: '2', upAt: 4800, downAt: safeDownAt(3300, 2) },
    { label: '3', upAt: 6300, downAt: safeDownAt(4800, 3) },
    { label: '4', upAt: 7800, downAt: safeDownAt(6300, 4) },
    { label: '5', upAt: 8000, downAt: safeDownAt(7800, 5) },
    { label: '6', upAt: null, downAt: safeDownAt(8000, 6) },
  ];
  const MAX_GEAR_INDEX = GEARS.length - 1;

  // How long (ms) the gearbox "locks" after any shift before it will
  // shift again — models clutch/synchro engagement time. This is what
  // turns an instant snap into a believable brief pause between shifts.
  // Kept comfortably above RPMSimulator's SHIFT_DIP_MS (450ms) so the
  // dip always has time to fully settle onto its target before the next
  // stepGear() check — the safeDownAt() margin above only works if the
  // dip has actually finished by the time the lock releases.
  const SHIFT_LOCK_MS = 550;

  let state = {
    status: 'off',        // 'off' | 'idle' | 'running' | 'redline'
    engineOn: false,
    rpmK: 0,
    rpm: 0,
    throttlePercent: 0,
    gear: 'N',
    gearIndex: 0,
    gearMode: 'auto',      // 'auto' | 'manual'
    shifting: false,       // true during the brief shift-lock window
    canShiftUp: false,
    canShiftDown: false,
    speedKmh: 0,
    engineTempC: AMBIENT_TEMP_C,
    boostBar: 0,
    inRedline: false,
    revLimiting: false,
    maxRpmK: MAX_RPM / 1000,
    redlineStartK: REDLINE_RPM / 1000,
  };

  // Internal gearbox state, separate from the public snapshot above so
  // stepGear() has somewhere to keep the shift-lock timer without it
  // leaking into every EngineState.getState() consumer.
  let gearIndex = 0;
  let gearMode = 'auto'; // 'auto' | 'manual'
  let shiftLockUntil = 0; // performance.now() timestamp

  // ---- Displayed-speed smoothing -------------------------------------
  // Speed is derived per-gear (GEAR_MAX_SPEED_KMH), so the instant a
  // shift completes, the SAME rpm maps to a different speed ceiling in
  // the new gear — road speed can't actually pop like that just because
  // the engine picked a new ratio. Rate-limiting the DISPLAYED number
  // (same "approach toward a target at a capped rate" pattern
  // RPMSimulator already uses for RPM itself) smooths that pop out
  // without touching the underlying formula, so a shift reads as a
  // hand-off instead of a jump — noticeable on both an accelerating
  // upshift and a coasting/throttle-release downshift.
  const SPEED_DISPLAY_RATE_KMH_PER_S = 260;
  let displaySpeedKmh = 0;
  let lastSpeedTs = null;

  function approachSpeed(current, target, dtSeconds) {
    const maxStep = SPEED_DISPLAY_RATE_KMH_PER_S * dtSeconds;
    if (current < target) return Math.min(target, current + maxStep);
    if (current > target) return Math.max(target, current - maxStep);
    return current;
  }

  const listeners = new Set();

  function notify() {
    listeners.forEach((fn) => fn({ ...state }));
  }

  function subscribe(fn) {
    listeners.add(fn);
    fn({ ...state });
    return () => listeners.delete(fn);
  }

  function getState() {
    return { ...state };
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function isShiftLocked() {
    return now() < shiftLockUntil;
  }

  function engageShiftLock() {
    shiftLockUntil = now() + SHIFT_LOCK_MS;
  }

  /**
   * Advances the gearbox state machine by at most one gear per call,
   * given the current RPM. Called every simulation frame in auto mode;
   * in manual mode this is skipped entirely (see deriveFromFrame) and
   * shiftUp()/shiftDown() are the only things that can move gearIndex.
   *
   * Why not a plain lookup table? A pure "gearForRpm(rpm)" function is
   * stateless, so at a shift boundary (say exactly 3500rpm) any tiny
   * RPM wobble flips the gear back and forth every single frame — no
   * delay, no hysteresis, it just mirrors whatever rpm currently is.
   * This function instead only evaluates "should I shift" using the
   * boundary appropriate to the *current* gear, applies at most one
   * shift, and then locks out further shifts for SHIFT_LOCK_MS — so a
   * shift always reads as one deliberate step-then-pause, not a flicker.
   */
  function stepGear(rpm, engineOn) {
    if (!engineOn) {
      gearIndex = 0;
      return;
    }
    if (isShiftLocked()) return;

    const current = GEARS[gearIndex];

    if (current.upAt !== null && rpm >= current.upAt && gearIndex < MAX_GEAR_INDEX) {
      const enteringFromNeutral = gearIndex === 0;
      gearIndex += 1;
      RPMSimulator.setGear(gearIndex);
      if (enteringFromNeutral) {
        // Engaging 1st from a standing start isn't a shift BETWEEN two
        // already-spinning gears — there's no established drivetrain
        // motion to interrupt, so it shouldn't cost the same
        // clutch/synchro jeda (pause) or RPM dip a real gear-to-gear
        // shift does. Gas it and it's straight into 1st; the normal
        // shift-lock/dip machinery only kicks in starting with the
        // 1st→2nd shift and up.
      } else {
        engageShiftLock();
        RPMSimulator.triggerShiftDip();
      }
      return;
    }

    if (current.downAt !== null && rpm < current.downAt && gearIndex > 1) {
      gearIndex -= 1;
      engageShiftLock();
      RPMSimulator.setGear(gearIndex);
      RPMSimulator.triggerShiftDip();
      return;
    }

    // Falling back to neutral: only from 1st gear, once RPM has coasted
    // down close to idle. 1st has no downAt (it holds all the way to
    // idle rather than downshifting into a lower gear), so this special
    // case is what returns the gearbox to N.
    if (gearIndex === 1 && rpm <= IDLE_RPM + 50) {
      gearIndex = 0;
      engageShiftLock();
      RPMSimulator.setGear(gearIndex);
      // No triggerShiftDip() here on purpose: coasting to a stop and
      // settling into neutral isn't a driver-initiated shift event, it's
      // just running out of RPM — there's no clutch snap to model, RPM
      // is already right at idle with nowhere further to dip.
    }
  }

  /** Deterministic placeholder gear lookup from current RPM (legacy — kept
   *  only as a fallback reference for manual-mode display math, no longer
   *  used to drive shifts directly). */
  function gearForRpm(rpm) {
    if (rpm <= IDLE_RPM + 50) return 'N';
    if (rpm < 2000) return '1';
    if (rpm < 3500) return '2';
    if (rpm < 5000) return '3';
    if (rpm < 6500) return '4';
    if (rpm < 8000) return '5';
    return '6';
  }

  /**
   * Recomputes every derived telemetry field from a fresh RPMSimulator
   * frame. Pure aside from the gearbox step, which is intentionally
   * stateful (see stepGear above) — everything else here still follows
   * the same input-in/output-out shape as before.
   */
  function deriveFromFrame(frame) {
    const rpmFraction = frame.rpm / MAX_RPM;
    const inRedline = frame.rpm >= REDLINE_RPM;

    state.engineOn = frame.engineOn;
    state.rpm = frame.rpm;
    state.rpmK = frame.rpmK;
    state.throttlePercent = frame.throttlePercent;
    state.revLimiting = frame.revLimiting;
    state.inRedline = inRedline;

    if (!frame.engineOn) {
      gearIndex = 0;
    } else if (gearMode === 'auto' && !frame.starting) {
      // Skip auto-shift logic while the start-up rev flare (see
      // rpm-simulator.js) is playing out. BUG: the flare deliberately
      // revs RPM up to ~1650 to sell the "engine catching" moment, but
      // that's well above Neutral's own upAt (1200) — so the instant the
      // engine started, the gearbox saw "RPM past 1200" and silently
      // auto-upshifted out of N into 1st before the driver ever asked to
      // move, leaving SPEED reading a nonzero value while the gear badge
      // still looked like it should've stayed at N. Gear now only
      // reacts to RPM once the flare has finished settling into idle.
      stepGear(frame.rpm, frame.engineOn);
    }
    // In manual mode, gearIndex only ever changes via shiftUp()/shiftDown().

    state.gearIndex = gearIndex;
    state.gear = GEARS[gearIndex].label;
    state.gearMode = gearMode;
    // "shifting" reflects the actual RPM dip happening in RPMSimulator
    // (frame.shifting) OR-ed with our own shift-lock window — the two
    // usually overlap almost exactly (dip is 450ms, lock is 550ms) but
    // using both means the UI never shows "not shifting" for the few ms
    // where one has ended and the other hasn't quite caught up.
    state.shifting = frame.engineOn && (frame.shifting || isShiftLocked());
    state.canShiftUp = frame.engineOn && gearIndex < MAX_GEAR_INDEX && !isShiftLocked();
    state.canShiftDown = frame.engineOn && gearIndex > 0 && !isShiftLocked();

    // Speed now depends on the ENGAGED GEAR, not raw rpmFraction alone:
    // gearIndex 0 (N) is hard-locked to 0 regardless of RPM, and every
    // other gear is capped at its own entry in GEAR_MAX_SPEED_KMH —
    // see the table above for why.
    let targetSpeedKmh = 0;
    if (frame.engineOn && gearIndex > 0) {
      const rpmAboveIdleFraction = Math.min(
        Math.max((frame.rpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM), 0),
        1
      );
      targetSpeedKmh = rpmAboveIdleFraction * GEAR_MAX_SPEED_KMH[gearIndex];
    }

    const nowTs = now();
    const dtSeconds = lastSpeedTs === null ? 0 : Math.min((nowTs - lastSpeedTs) / 1000, 0.1);
    lastSpeedTs = nowTs;

    if (!frame.engineOn || gearIndex === 0) {
      // No drivetrain connection at all — either ignition off, or the
      // gearbox is in neutral. Snap straight to 0 rather than smoothing
      // the display down: the wheels are physically disconnected from
      // the engine the instant neutral is engaged (coasting to a stop
      // and dropping into N, or a manual shift down to N), same as when
      // the engine itself stops. BUG: this used to only check
      // frame.engineOn, so falling into neutral while the engine kept
      // running left the speed readout gliding down over ~1s through
      // the SPEED_DISPLAY_RATE_KMH_PER_S ramp instead of reading 0
      // immediately.
      displaySpeedKmh = 0;
    } else {
      displaySpeedKmh = approachSpeed(displaySpeedKmh, targetSpeedKmh, dtSeconds);
    }
    state.speedKmh = Math.round(displaySpeedKmh);
    state.boostBar = frame.engineOn
      ? Math.round(Math.max(0, frame.throttlePercent / 100 - 0.15) * MAX_BOOST_BAR * 100) / 100
      : 0;
    state.engineTempC = frame.engineOn
      ? Math.round(AMBIENT_TEMP_C + rpmFraction * (OPERATING_TEMP_C - AMBIENT_TEMP_C))
      : AMBIENT_TEMP_C;

    if (!frame.engineOn) {
      state.status = 'off';
    } else if (frame.revLimiting) {
      state.status = 'redline';
    } else if (frame.rpm > IDLE_RPM + 50) {
      state.status = 'running';
    } else {
      state.status = 'idle';
    }

    notify();
  }

  function startEngine() {
    RPMSimulator.start();
    return getState();
  }

  function stopEngine() {
    RPMSimulator.stop();
    return getState();
  }

  function setThrottle(percent) {
    RPMSimulator.setThrottle(percent);
    return getState();
  }

  /** Switches between 'auto' (gearbox shifts itself off RPM) and
   *  'manual' (only shiftUp()/shiftDown() move the gearbox). Switching
   *  INTO manual keeps whatever gear auto mode was already in — no
   *  jump — so the driver picks up exactly where the automatic left off. */
  function setGearMode(mode) {
    if (mode !== 'auto' && mode !== 'manual') return getState();
    gearMode = mode;
    return getState();
  }

  /** Manual upshift. No-op (and shift-lock still respected) if already
   *  in top gear, engine off, or mid-shift-lock from a previous shift —
   *  same physical shift-lock timer auto mode uses, so manual shifts
   *  feel exactly as deliberate/paced as automatic ones. Also triggers
   *  the same RPM dip as an automatic shift — a manual paddle/button
   *  shift still has a clutch/synchro moment in real life. */
  function shiftUp() {
    if (!state.engineOn || isShiftLocked()) return getState();
    if (gearIndex >= MAX_GEAR_INDEX) return getState();
    gearIndex += 1;
    engageShiftLock();
    RPMSimulator.setGear(gearIndex);
    RPMSimulator.triggerShiftDip();
    return getState();
  }

  /** Manual downshift. Never shifts below 1st into neutral from the
   *  paddle/button — neutral is only reached by coasting to idle in 1st,
   *  matching how a real sequential shifter behaves. Also dips RPM, same
   *  as shiftUp(). */
  function shiftDown() {
    if (!state.engineOn || isShiftLocked()) return getState();
    if (gearIndex <= 1) return getState();
    gearIndex -= 1;
    engageShiftLock();
    RPMSimulator.setGear(gearIndex);
    RPMSimulator.triggerShiftDip();
    return getState();
  }

  function init() {
    RPMSimulator.init();
    RPMSimulator.subscribe(deriveFromFrame);
    return getState();
  }

  return {
    init,
    subscribe,
    getState,
    startEngine,
    stopEngine,
    setThrottle,
    setGearMode,
    shiftUp,
    shiftDown,
    maxRpmK: MAX_RPM / 1000,
    redlineStartK: REDLINE_RPM / 1000,
    KMH_PER_MPH,
  };
})();
