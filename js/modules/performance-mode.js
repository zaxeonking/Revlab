/**
 * REVLAB — performance-mode.js
 * -----------------------------------------------------------------------
 * PERFORMANCE MODE — a dedicated panel (modal, same pattern as VEHICLE
 * SETUP) focused on raw numbers and graphs rather than the cockpit gauge
 * face: SPEED / RPM / TORQUE / POWER / BOOST / THROTTLE / GEAR readouts,
 * four realtime canvas graphs (Speed over time, RPM over time, Torque
 * curve, Power curve), and its own SIMULATION START / PAUSE / RESET
 * controls.
 *
 * Every number here comes from EngineState — this module owns NO
 * simulation logic of its own, only:
 *   1. Two rolling time-series buffers (speed, rpm) it fills from each
 *      EngineState frame while the panel is open.
 *   2. Rendering — plain <canvas> 2D, no chart library, consistent with
 *      the rest of REVLAB being framework-free.
 *
 * START / PAUSE / RESET map straight onto EngineState's simulation
 * controls (EngineState.startEngine/pauseSimulation/resumeSimulation/
 * resetSimulation, which themselves wrap RPMSimulator — see
 * rpm-simulator.js and engine-state.js):
 *   - START  → starts the engine if it's off, or resumes if paused.
 *   - PAUSE  → freezes the ENTIRE simulation loop in place (every gauge,
 *              readout, and graph across all of REVLAB holds still, not
 *              just this panel — see RPMSimulator.pause()).
 *   - RESET  → stops the engine, snaps every reading back to a clean
 *              baseline, and clears this panel's graph history.
 *
 * Torque/Power reference curves (the two "curve" graphs) are recomputed
 * from EngineState.getTorqueCurve() each time the panel redraws them —
 * cheap (a few dozen points) and guarantees the curve can never drift out
 * of sync with whatever VEHICLE SETUP currently has dialed in for Torque/
 * Idle/Redline/Max RPM.
 * -----------------------------------------------------------------------
 */

const PerformanceMode = (() => {
  // How much history the two time-series graphs (Speed, RPM) keep, in
  // milliseconds — a rolling window, not a fixed sample count, so the
  // graph reads the same whether the frame rate is 30fps or 144fps.
  const HISTORY_WINDOW_MS = 15000;

  let els = {};
  let isOpen = false;
  let unsubscribe = null;

  // Rolling buffers: [{ t, speedKmh, rpm }]. `t` is performance.now() so
  // it's directly comparable to itself across frames without depending
  // on a fixed tick rate.
  let history = [];

  // Colors pulled from the design tokens (variables.css) rather than
  // re-hardcoding hex values here, so a palette change stays in one file.
  let colorCyan = '#2ee3f2';
  let colorAmber = '#ff9d1a';
  let colorRed = '#ff2f3a';
  let colorGrid = '#24262c';
  let colorText = '#52555f';

  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    colorCyan = cs.getPropertyValue('--accent-cyan').trim() || colorCyan;
    colorAmber = cs.getPropertyValue('--accent-amber').trim() || colorAmber;
    colorRed = cs.getPropertyValue('--accent-red').trim() || colorRed;
    colorGrid = cs.getPropertyValue('--border-0').trim() || colorGrid;
    colorText = cs.getPropertyValue('--text-2').trim() || colorText;
  }

  function cacheEls() {
    els = {
      openBtn: document.getElementById('performanceModeOpenBtn'),
      overlay: document.getElementById('performanceModeOverlay'),
      closeBtn: document.getElementById('performanceModeCloseBtn'),
      doneBtn: document.getElementById('performanceModeDoneBtn'),

      startBtn: document.getElementById('perfStartBtn'),
      pauseBtn: document.getElementById('perfPauseBtn'),
      resetBtn: document.getElementById('perfResetBtn'),
      simStateLabel: document.getElementById('perfSimStateLabel'),

      speed: document.getElementById('perfSpeed'),
      rpm: document.getElementById('perfRpm'),
      torque: document.getElementById('perfTorque'),
      power: document.getElementById('perfPower'),
      boost: document.getElementById('perfBoost'),
      throttle: document.getElementById('perfThrottle'),
      gear: document.getElementById('perfGear'),

      canvasSpeed: document.getElementById('perfGraphSpeed'),
      canvasRpm: document.getElementById('perfGraphRpm'),
      canvasTorque: document.getElementById('perfGraphTorque'),
      canvasPower: document.getElementById('perfGraphPower'),
    };
  }

  // ---- Canvas sizing -----------------------------------------------------
  // Backing-store size is set from the element's rendered CSS size ×
  // devicePixelRatio (crisp on retina/high-DPI without blurring), redone
  // whenever the panel opens (the modal is display:none-equivalent while
  // closed, so any earlier measurement would read 0×0) and on resize.
  function sizeCanvas(canvas) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function sizeAllCanvases() {
    [els.canvasSpeed, els.canvasRpm, els.canvasTorque, els.canvasPower].forEach(sizeCanvas);
  }

  // ---- Grid / axis helpers -----------------------------------------------
  function drawGrid(ctx, w, h, hLines = 3) {
    ctx.save();
    ctx.strokeStyle = colorGrid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= hLines; i += 1) {
      const y = Math.round((h / hLines) * i) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawLabel(ctx, text, x, y, align = 'left', color = colorText) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // ---- Time-series graph (Speed over time / RPM over time) --------------
  function drawTimeSeries(canvas, valueKey, maxValue, color, unit) {
    const sized = sizeCanvas(canvas);
    if (!sized) return;
    const { ctx, w, h } = sized;
    ctx.clearRect(0, 0, w, h);
    drawGrid(ctx, w, h, 3);

    if (history.length < 2 || maxValue <= 0) {
      drawLabel(ctx, 'MENUNGGU DATA SIMULATOR…', 6, 4, 'left');
      return;
    }

    const newestT = history[history.length - 1].t;
    const oldestVisibleT = newestT - HISTORY_WINDOW_MS;
    const pad = 4;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    let started = false;
    history.forEach((point) => {
      if (point.t < oldestVisibleT) return;
      const x = ((point.t - oldestVisibleT) / HISTORY_WINDOW_MS) * w;
      const v = Math.min(point[valueKey], maxValue);
      const y = h - pad - (v / maxValue) * (h - pad * 2);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    // Fill under the line for a bit of telemetry-graph "area" feel.
    if (started) {
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fillStyle = color + '22';
      ctx.fill();
    }
    ctx.restore();

    const last = history[history.length - 1];
    drawLabel(ctx, `${Math.round(last[valueKey])} ${unit}`, w - 6, 4, 'right', color);
    drawLabel(ctx, `${HISTORY_WINDOW_MS / 1000}s`, 6, h - 12, 'left');
  }

  // ---- Curve graph (Torque curve / Power curve) --------------------------
  // Plots the full-throttle reference curve across idle→max RPM, plus a
  // marker at the CURRENT actual reading (which may sit below the curve
  // at part throttle — see engine-state.js's loadFactor blend).
  function drawCurveGraph(canvas, curve, valueKey, maxValue, color, unit, currentRpm, currentValue, engineOn) {
    const sized = sizeCanvas(canvas);
    if (!sized) return;
    const { ctx, w, h } = sized;
    ctx.clearRect(0, 0, w, h);
    drawGrid(ctx, w, h, 3);

    if (!curve.length || maxValue <= 0) return;

    const minRpm = curve[0].rpm;
    const maxRpm = curve[curve.length - 1].rpm;
    const rpmSpan = Math.max(1, maxRpm - minRpm);
    const pad = 4;

    const xFor = (rpm) => ((rpm - minRpm) / rpmSpan) * w;
    const yFor = (v) => h - pad - (Math.min(v, maxValue) / maxValue) * (h - pad * 2);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    curve.forEach((point, i) => {
      const x = xFor(point.rpm);
      const y = yFor(point[valueKey]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = color + '1a';
    ctx.fill();
    ctx.restore();

    // Current operating point — only meaningful with the engine running.
    if (engineOn && currentRpm >= minRpm) {
      const x = xFor(currentRpm);
      const y = yFor(currentValue);
      ctx.save();
      ctx.strokeStyle = colorAmber;
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = colorAmber;
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      drawLabel(ctx, `${Math.round(currentValue)} ${unit} @ ${Math.round(currentRpm)} RPM`, w - 6, 4, 'right', colorAmber);
    } else {
      drawLabel(ctx, `PEAK ${Math.round(maxValue)} ${unit}`, w - 6, 4, 'right', color);
    }
  }

  // ---- Readouts ------------------------------------------------------------
  function renderReadouts(state) {
    if (els.speed) els.speed.textContent = `${state.speedKmh} `;
    if (els.rpm) els.rpm.textContent = `${Math.round(state.rpm)} `;
    if (els.torque) els.torque.textContent = `${state.torqueNm} `;
    if (els.power) els.power.textContent = `${state.powerHp} `;
    if (els.boost) els.boost.textContent = `${state.boostBar.toFixed(2)} `;
    if (els.throttle) els.throttle.textContent = `${Math.round(state.throttlePercent)} `;
    if (els.gear) els.gear.textContent = state.gear;
  }

  function renderSimControls(state) {
    const paused = !!state.paused;
    const running = state.engineOn;

    if (els.startBtn) els.startBtn.disabled = running && !paused;
    if (els.pauseBtn) els.pauseBtn.disabled = !running || paused;
    if (els.simStateLabel) {
      els.simStateLabel.textContent = !running
        ? 'SIMULATION: STOPPED'
        : paused
          ? 'SIMULATION: PAUSED'
          : 'SIMULATION: RUNNING';
      els.simStateLabel.dataset.state = !running ? 'stopped' : paused ? 'paused' : 'running';
    }
  }

  function renderGraphs(state) {
    // Speed / RPM — time series, scaled to the current dial ceilings so
    // they track VEHICLE SETUP changes (Top Speed / Max RPM) live.
    drawTimeSeries(els.canvasSpeed, 'speedKmh', state.maxSpeedKmh, colorCyan, 'KM/H');
    drawTimeSeries(els.canvasRpm, 'rpm', state.maxRpmK * 1000, colorAmber, 'RPM');

    // Torque / Power — reference curve + current operating point.
    const curve = EngineState.getTorqueCurve(40);
    const maxTorque = curve.reduce((m, p) => Math.max(m, p.torqueNm), 1);
    const maxPower = curve.reduce((m, p) => Math.max(m, p.powerHp), 1);
    drawCurveGraph(els.canvasTorque, curve, 'torqueNm', maxTorque * 1.08, colorCyan, 'NM', state.rpm, state.torqueNm, state.engineOn);
    drawCurveGraph(els.canvasPower, curve, 'powerHp', maxPower * 1.08, colorAmber, 'HP', state.rpm, state.powerHp, state.engineOn);
  }

  function pushHistory(state) {
    const t = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    history.push({ t, speedKmh: state.engineOn ? state.speedKmh : 0, rpm: state.engineOn ? state.rpm : 0 });
    const cutoff = t - HISTORY_WINDOW_MS - 500; // small buffer past the visible window
    while (history.length && history[0].t < cutoff) history.shift();
  }

  function onFrame(state) {
    if (!isOpen) return; // no work at all while the panel is closed
    pushHistory(state);
    renderReadouts(state);
    renderSimControls(state);
    renderGraphs(state);
  }

  // ---- Open / close --------------------------------------------------------
  function open() {
    if (!els.overlay) return;
    isOpen = true;
    els.overlay.dataset.open = 'true';
    els.overlay.setAttribute('aria-hidden', 'false');
    readPalette();
    // Layout only settles once the modal is actually visible, so size the
    // canvases (and draw one frame immediately) on the next frame.
    requestAnimationFrame(() => {
      sizeAllCanvases();
      renderSimControls(EngineState.getState());
      renderGraphs(EngineState.getState());
    });
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
    window.addEventListener('resize', () => {
      if (isOpen) sizeAllCanvases();
    });
  }

  function bindSimControls() {
    if (els.startBtn) {
      els.startBtn.addEventListener('click', () => {
        const state = EngineState.getState();
        if (state.paused) {
          EngineState.resumeSimulation();
          UIController.logLine('PERFORMANCE MODE — RESUME simulasi.');
        } else if (!state.engineOn) {
          if (typeof AudioEngine !== 'undefined' && AudioEngine.init) {
            const result = AudioEngine.init();
            UIController.setAudioStatusLabel(result.ok ? 'AUDIO ENGINE: RUNNING' : 'AUDIO ENGINE: UNAVAILABLE');
          }
          EngineState.startEngine();
          UIController.logLine('PERFORMANCE MODE — START simulasi.');
        }
      });
    }
    if (els.pauseBtn) {
      els.pauseBtn.addEventListener('click', () => {
        EngineState.pauseSimulation();
        UIController.logLine('PERFORMANCE MODE — PAUSE simulasi (semua telemetri dibekukan).');
      });
    }
    if (els.resetBtn) {
      els.resetBtn.addEventListener('click', () => {
        EngineState.resetSimulation();
        history = [];
        UIController.logLine('PERFORMANCE MODE — RESET simulasi ke kondisi awal.');
        if (isOpen) {
          renderReadouts(EngineState.getState());
          renderSimControls(EngineState.getState());
          renderGraphs(EngineState.getState());
        }
      });
    }
  }

  function init() {
    cacheEls();
    readPalette();
    bindPanel();
    bindSimControls();
    unsubscribe = EngineState.subscribe(onFrame);
  }

  return { init, open, close };
})();
