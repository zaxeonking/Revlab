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
 *     / .setThrottle().
 *   - A future, more complete engine simulator can replace the derive*()
 *     functions below (gear ratios, drivetrain, thermal model, turbo
 *     model) without the UI layer changing at all.
 * -----------------------------------------------------------------------
 */

const EngineState = (() => {
  const AMBIENT_TEMP_C = 24;
  const OPERATING_TEMP_C = 92;
  const MAX_BOOST_BAR = 1.4;
  const MAX_SPEED_KMH = 260;

  const MAX_RPM = RPMSimulator.MAX_RPM;
  const IDLE_RPM = RPMSimulator.IDLE_RPM;
  const REDLINE_RPM = RPMSimulator.REDLINE_RPM;

  let state = {
    status: 'off',        // 'off' | 'idle' | 'running' | 'redline'
    engineOn: false,
    rpmK: 0,
    rpm: 0,
    throttlePercent: 0,
    gear: 'N',
    speedKmh: 0,
    engineTempC: AMBIENT_TEMP_C,
    boostBar: 0,
    inRedline: false,
    revLimiting: false,
    maxRpmK: MAX_RPM / 1000,
    redlineStartK: REDLINE_RPM / 1000,
  };

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

  /** Deterministic placeholder gear lookup from current RPM. */
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
   * frame. Pure — same input always produces the same output.
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

    state.gear = frame.engineOn ? gearForRpm(frame.rpm) : 'N';
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
    maxRpmK: MAX_RPM / 1000,
    redlineStartK: REDLINE_RPM / 1000,
  };
})();
