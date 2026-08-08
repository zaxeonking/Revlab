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
  const GEARS = [
    { label: 'N', upAt: 1200, downAt: null },
    { label: '1', upAt: 2000, downAt: null },
    { label: '2', upAt: 3500, downAt: 1500 },
    { label: '3', upAt: 5000, downAt: 2700 },
    { label: '4', upAt: 6500, downAt: 4000 },
    { label: '5', upAt: 8000, downAt: 5200 },
    { label: '6', upAt: null, downAt: 6600 },
  ];
  const MAX_GEAR_INDEX = GEARS.length - 1;

  // How long (ms) the gearbox "locks" after any shift before it will
  // shift again — models clutch/synchro engagement time. This is what
  // turns an instant snap into a believable brief pause between shifts.
  const SHIFT_LOCK_MS = 260;

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
      gearIndex += 1;
      engageShiftLock();
      RPMSimulator.setGear(gearIndex);
      RPMSimulator.triggerShiftDip();
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
    } else if (gearMode === 'auto') {
      stepGear(frame.rpm, frame.engineOn);
    }
    // In manual mode, gearIndex only ever changes via shiftUp()/shiftDown().

    state.gearIndex = gearIndex;
    state.gear = GEARS[gearIndex].label;
    state.gearMode = gearMode;
    // "shifting" reflects the actual RPM dip happening in RPMSimulator
    // (frame.shifting) OR-ed with our own shift-lock window — the two
    // usually overlap almost exactly (dip is 220ms, lock is 260ms) but
    // using both means the UI never shows "not shifting" for the few ms
    // where one has ended and the other hasn't quite caught up.
    state.shifting = frame.engineOn && (frame.shifting || isShiftLocked());
    state.canShiftUp = frame.engineOn && gearIndex < MAX_GEAR_INDEX && !isShiftLocked();
    state.canShiftDown = frame.engineOn && gearIndex > 0 && !isShiftLocked();

    state.speedKmh = frame.engineOn ? Math.round(rpmFraction * MAX_SPEED_KMH) : 0;
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
