/**
 * REVLAB — acceleration-mode.js
 * -----------------------------------------------------------------------
 * ACCELERATION MODE — a dedicated panel (same modal pattern as
 * PERFORMANCE MODE / VEHICLE SETUP) for standing-start acceleration
 * runs: 0–60 / 0–100 / 0–160 / 0–200 KM/H, plus 0–100 MPH when the
 * cockpit's speed unit toggle is currently set to MPH.
 *
 * Like every other panel in REVLAB, this module owns NO simulation
 * physics of its own. It only:
 *   1. Drives a LAUNCH sequence through EngineState's existing public
 *      API (resetSimulation → startEngine → setThrottle(100)) — the
 *      exact same RPMSimulator/Gearbox physics every other control in
 *      the cockpit uses. There is no separate "drag strip" simulator.
 *   2. Reads EngineState.subscribe() frames (real RPM → real gear-ratio
 *      speed, see gearbox.js) and detects the instant the ALREADY-
 *      COMPUTED speedKmh crosses each split threshold, using linear
 *      interpolation between the previous and current frame's speed —
 *      the same technique real drag-strip timing lights use to report
 *      a time finer than the sensor's own sample rate. No Math.random(),
 *      no hand-typed/looked-up results: every split time is a direct
 *      function of the simulator's own speed-over-time signal.
 *
 * Launch behavior:
 *   - LAUNCH always starts from a clean, stationary baseline — engine
 *     off, gear N, speed 0 — by calling EngineState.resetSimulation()
 *     first, so "0 KPH" is never assumed, it's enforced.
 *   - Gear mode is forced to AUTO for the duration of the run (a 0–60
 *     test needs the gearbox to shift itself the way a driver would
 *     bang through the gears at full throttle) and restored to
 *     whatever the driver had selected once the run ends.
 *   - Throttle is commanded to 100% the instant the engine starts.
 *     RPMSimulator's own start-flare cancels itself the moment real
 *     throttle input arrives (see START_FLARE_CANCEL_THROTTLE in
 *     rpm-simulator.js) — so flooring it immediately reproduces a
 *     "foot already on the floor, dump the clutch" launch rather than
 *     an idle blip, using physics that already existed, not a special
 *     case.
 *   - Elapsed time starts at that same instant (throttle-to-floor /
 *     brake release) — the conventional t=0 for a standing-start run.
 * -----------------------------------------------------------------------
 */

const AccelerationMode = (() => {
  // Fixed KM/H split ladder — always attempted, regardless of which
  // display unit is currently selected.
  const KMH_SPLITS = [
    { key: 'kmh60', label: '0–60 KM/H', targetKmh: 60 },
    { key: 'kmh100', label: '0–100 KM/H', targetKmh: 100 },
    { key: 'kmh160', label: '0–160 KM/H', targetKmh: 160 },
    { key: 'kmh200', label: '0–200 KM/H', targetKmh: 200 },
  ];
  const MPH_SPLIT_KEY = 'mph100';
  const MPH_SPLIT_TARGET_MPH = 100;

  // How long (ms) speed has to sit essentially flat before a stalled
  // run (vehicle physically can't reach a target split — e.g. VEHICLE
  // SETUP's Top Speed governor is set below 200 km/h) is called instead
  // of leaving the timer running forever.
  const PLATEAU_MS = 1500;
  const PLATEAU_EPSILON_KMH = 0.08;

  let els = {};
  let isOpen = false;

  // ---- Run state --------------------------------------------------------
  // 'idle'      — no run yet / after RESET, waiting for LAUNCH
  // 'running'   — timer live, watching for splits
  // 'complete'  — every applicable split was reached
  // 'capped'    — speed plateaued before every applicable split was reached
  // 'aborted'   — driver hit STOP mid-run
  let runState = 'idle';
  let startTs = null;
  let prevSpeedKmh = 0;
  let prevT = null;
  let plateauSince = null;
  let splits = {};       // key -> elapsedMs | null
  let priorGearMode = null;

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
  }

  function mphActive() {
    return typeof UIController !== 'undefined'
      && UIController.getSpeedUnit
      && UIController.getSpeedUnit() === 'mph';
  }

  function activeSplitDefs() {
    const defs = KMH_SPLITS.slice();
    if (mphActive()) {
      defs.push({
        key: MPH_SPLIT_KEY,
        label: '0–100 MPH',
        targetKmh: MPH_SPLIT_TARGET_MPH * EngineState.KMH_PER_MPH,
      });
    }
    return defs;
  }

  function resetRunData() {
    splits = {};
    KMH_SPLITS.forEach((s) => { splits[s.key] = null; });
    splits[MPH_SPLIT_KEY] = null;
    startTs = null;
    prevSpeedKmh = 0;
    prevT = null;
    plateauSince = null;
  }

  resetRunData();

  function cacheEls() {
    els = {
      openBtn: document.getElementById('accelModeOpenBtn'),
      overlay: document.getElementById('accelModeOverlay'),
      closeBtn: document.getElementById('accelModeCloseBtn'),
      doneBtn: document.getElementById('accelModeDoneBtn'),

      launchBtn: document.getElementById('accelLaunchBtn'),
      stopBtn: document.getElementById('accelStopBtn'),
      resetBtn: document.getElementById('accelResetBtn'),
      statusLabel: document.getElementById('accelStatusLabel'),

      speed: document.getElementById('accelSpeed'),
      speedUnit: document.getElementById('accelSpeedUnit'),
      gear: document.getElementById('accelGear'),
      rpm: document.getElementById('accelRpm'),
      throttle: document.getElementById('accelThrottle'),
      elapsed: document.getElementById('accelElapsed'),

      ladder: document.getElementById('accelLadder'),
    };
  }

  // ---- Split detection ----------------------------------------------------
  // Interpolates the exact crossing instant between the previous and
  // current simulator frame, rather than just stamping "now" the frame
  // AFTER the threshold was already exceeded — the same reason real
  // timing equipment interpolates between sensor samples instead of
  // reporting whichever sample happened to land first.
  function checkSplit(def, currentSpeedKmh, currentT) {
    if (splits[def.key] !== null && splits[def.key] !== undefined) return;
    if (currentSpeedKmh < def.targetKmh) return;

    let crossT = currentT;
    if (currentSpeedKmh > prevSpeedKmh) {
      const frac = clamp((def.targetKmh - prevSpeedKmh) / (currentSpeedKmh - prevSpeedKmh), 0, 1);
      crossT = prevT + frac * (currentT - prevT);
    }
    splits[def.key] = Math.max(0, crossT - startTs);
  }

  function formatSeconds(ms) {
    if (ms === null || ms === undefined) return null;
    return (ms / 1000).toFixed(2);
  }

  // ---- Ladder rendering ---------------------------------------------------
  function renderLadder() {
    if (!els.ladder) return;
    const defs = activeSplitDefs();
    els.ladder.innerHTML = '';

    defs.forEach((def) => {
      const row = document.createElement('div');
      row.className = 'accel-row';

      const label = document.createElement('span');
      label.className = 'accel-row__label';
      label.textContent = def.label;
      row.appendChild(label);

      const value = document.createElement('span');
      value.className = 'accel-row__value';

      const t = splits[def.key];
      if (t !== null && t !== undefined) {
        value.textContent = `${formatSeconds(t)} s`;
        value.dataset.state = 'done';
        row.dataset.state = 'done';
      } else if (runState === 'capped' || runState === 'aborted') {
        value.textContent = 'TIDAK TERCAPAI';
        value.dataset.state = 'missed';
        row.dataset.state = 'missed';
      } else if (runState === 'running') {
        value.textContent = '—';
        value.dataset.state = 'pending';
        row.dataset.state = 'pending';
      } else {
        value.textContent = '—';
        value.dataset.state = 'idle';
        row.dataset.state = 'idle';
      }

      row.appendChild(value);
      els.ladder.appendChild(row);
    });
  }

  // ---- Readouts ------------------------------------------------------------
  function renderReadouts(state) {
    const useMph = mphActive();
    const speedValue = useMph
      ? Math.round(state.speedKmh / EngineState.KMH_PER_MPH)
      : Math.round(state.speedKmh);
    if (els.speed) els.speed.textContent = `${speedValue}`;
    if (els.speedUnit) els.speedUnit.textContent = useMph ? 'MPH' : 'KM/H';
    if (els.gear) els.gear.textContent = state.gear;
    if (els.rpm) els.rpm.textContent = `${Math.round(state.rpm)}`;
    if (els.throttle) els.throttle.textContent = `${Math.round(state.throttlePercent)}`;

    let elapsedMs = 0;
    if (startTs !== null) {
      const endT = (runState === 'running') ? now() : (lastFrameT || now());
      elapsedMs = Math.max(0, endT - startTs);
    }
    if (els.elapsed) els.elapsed.textContent = formatSeconds(elapsedMs) || '0.00';
  }

  function renderStatus() {
    if (!els.statusLabel) return;
    const labels = {
      idle: 'STANDBY — SIAP LAUNCH',
      running: 'LAUNCHING…',
      complete: 'RUN SELESAI',
      capped: 'BERHENTI — TOP SPEED KENDARAAN TERCAPAI',
      aborted: 'RUN DIBATALKAN',
    };
    els.statusLabel.textContent = labels[runState] || 'STANDBY';
    els.statusLabel.dataset.state = runState;

    if (els.launchBtn) els.launchBtn.disabled = runState === 'running';
    if (els.stopBtn) els.stopBtn.disabled = runState !== 'running';
  }

  // ---- Run lifecycle --------------------------------------------------------
  function finishRun(finalState) {
    runState = finalState;
    if (typeof EngineState.setThrottle === 'function') EngineState.setThrottle(0);
    if (priorGearMode) {
      EngineState.setGearMode(priorGearMode);
      priorGearMode = null;
    }
    renderStatus();
    renderLadder();
    if (typeof UIController !== 'undefined' && UIController.logLine) {
      const summary = activeSplitDefs()
        .map((d) => `${d.label}=${formatSeconds(splits[d.key]) || '—'}`)
        .join(' | ');
      UIController.logLine(`ACCELERATION MODE — run ${finalState === 'complete' ? 'selesai' : finalState === 'capped' ? 'capped di top speed' : 'dibatalkan'}: ${summary}`);
    }
  }

  let lastFrameT = null;

  function onFrame(state) {
    const t = now();
    lastFrameT = t;

    if (runState === 'running') {
      const speed = state.speedKmh;

      activeSplitDefs().forEach((def) => checkSplit(def, speed, t));

      // Plateau / stall detection — vehicle stopped accelerating
      // (governor cap, or engine died) before every applicable split
      // was reached.
      if (Math.abs(speed - prevSpeedKmh) < PLATEAU_EPSILON_KMH) {
        if (plateauSince === null) plateauSince = t;
      } else {
        plateauSince = null;
      }

      const defs = activeSplitDefs();
      const allDone = defs.every((d) => splits[d.key] !== null && splits[d.key] !== undefined);
      const stalled = plateauSince !== null && (t - plateauSince) > PLATEAU_MS;

      prevSpeedKmh = speed;
      prevT = t;

      if (!state.engineOn) {
        finishRun('aborted');
      } else if (allDone) {
        finishRun('complete');
      } else if (stalled) {
        finishRun('capped');
      }
    }

    if (isOpen) {
      renderReadouts(state);
      renderLadder();
    }
  }

  function launch() {
    if (runState === 'running') return;

    priorGearMode = EngineState.getState().gearMode;
    resetRunData();
    runState = 'running';

    EngineState.resetSimulation();
    EngineState.setGearMode('auto');

    if (typeof AudioEngine !== 'undefined' && AudioEngine.init) {
      const result = AudioEngine.init();
      if (typeof UIController !== 'undefined' && UIController.setAudioStatusLabel) {
        UIController.setAudioStatusLabel(result.ok ? 'AUDIO ENGINE: RUNNING' : 'AUDIO ENGINE: UNAVAILABLE');
      }
    }

    EngineState.startEngine();
    EngineState.setThrottle(100);

    const t = now();
    startTs = t;
    prevT = t;
    lastFrameT = t;
    prevSpeedKmh = 0;
    plateauSince = null;

    renderStatus();
    renderLadder();

    if (typeof UIController !== 'undefined' && UIController.logLine) {
      UIController.logLine('ACCELERATION MODE — LAUNCH: start dari 0 KPH, throttle 100%, gear AUTO.');
    }
  }

  function stopRun() {
    if (runState !== 'running') return;
    finishRun('aborted');
  }

  function resetRun() {
    EngineState.resetSimulation();
    if (priorGearMode) {
      EngineState.setGearMode(priorGearMode);
      priorGearMode = null;
    }
    resetRunData();
    runState = 'idle';
    renderStatus();
    renderLadder();
    renderReadouts(EngineState.getState());
    if (typeof UIController !== 'undefined' && UIController.logLine) {
      UIController.logLine('ACCELERATION MODE — RESET.');
    }
  }

  // ---- Open / close --------------------------------------------------------
  function open() {
    if (!els.overlay) return;
    isOpen = true;
    els.overlay.dataset.open = 'true';
    els.overlay.setAttribute('aria-hidden', 'false');
    renderStatus();
    renderLadder();
    renderReadouts(EngineState.getState());
  }

  function close() {
    if (!els.overlay) return;
    isOpen = false;
    els.overlay.dataset.open = 'false';
    els.overlay.setAttribute('aria-hidden', 'true');
  }

  function bindPanel() {
    if (els.openBtn) els.openBtn.addEventListener('click', open);
    if (els.closeBtn) els.closeBtn.addEventListener('click', close);
    if (els.doneBtn) els.doneBtn.addEventListener('click', close);
    if (els.overlay) {
      els.overlay.addEventListener('click', (e) => {
        if (e.target === els.overlay) close();
      });
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) close();
    });
  }

  function bindControls() {
    if (els.launchBtn) els.launchBtn.addEventListener('click', launch);
    if (els.stopBtn) els.stopBtn.addEventListener('click', stopRun);
    if (els.resetBtn) els.resetBtn.addEventListener('click', resetRun);
  }

  function init() {
    cacheEls();
    bindPanel();
    bindControls();
    renderStatus();
    renderLadder();
    EngineState.subscribe(onFrame);
  }

  return { init, open, close };
})();
