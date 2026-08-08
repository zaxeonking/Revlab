/**
 * REVLAB — ui-controller.js
 * -----------------------------------------------------------------------
 * Wires DOM elements to EngineState. This module owns NO telemetry logic
 * itself — it only renders whatever EngineState.getState() / subscribe()
 * hands it, and forwards user input (throttle slider, start/stop button)
 * back into EngineState. EngineState now updates on every simulation
 * frame (RPM is a real requestAnimationFrame physics loop under the
 * hood — see rpm-simulator.js), so render() below runs continuously and
 * is what drives the gauge needle, not the input event handlers.
 * -----------------------------------------------------------------------
 */

const UIController = (() => {
  let els = {};
  let gaugeRef = null;

  function cacheEls() {
    els = {
      engineStatusChip: document.getElementById('engineStatusChip'),
      engineStatusLabel: document.getElementById('engineStatusLabel'),
      audioStatusLabel: document.getElementById('audioStatusLabel'),

      throttleSlider: document.getElementById('throttleSlider'),
      throttleReadout: document.getElementById('throttleReadout'),
      throttleButton: document.getElementById('throttleButton'),
      throttlePedal: document.getElementById('throttlePedal'),
      throttleIndicatorFill: document.getElementById('throttleIndicatorFill'),
      throttleIndicatorValue: document.getElementById('throttleIndicatorValue'),
      throttlePedalMeterFill: document.getElementById('throttlePedalMeterFill'),
      startEngineBtn: document.getElementById('startEngineBtn'),

      systemLog: document.getElementById('systemLog'),

      rpmValue: document.getElementById('rpmValue'),
      redlineIndicator: document.getElementById('redlineIndicator'),
      gearIndicator: document.getElementById('gearIndicator'),
      gearValue: document.getElementById('gearValue'),
      gearReadout: document.getElementById('gearReadout'),
      gaugeCaption: document.getElementById('gaugeCaption'),

      speedReadout: document.getElementById('speedReadout'),
      speedUnitToggle: document.getElementById('speedUnitToggle'),
      tempReadout: document.getElementById('tempReadout'),
      boostReadout: document.getElementById('boostReadout'),

      gearModeToggle: document.getElementById('gearModeToggle'),
      shiftUpBtn: document.getElementById('shiftUpBtn'),
      shiftDownBtn: document.getElementById('shiftDownBtn'),
      gearModeHint: document.getElementById('gearModeHint'),

      mobileShifter: document.getElementById('mobileShifter'),
      mobileGearModeBtn: document.getElementById('mobileGearModeBtn'),
      mobileShiftUpBtn: document.getElementById('mobileShiftUpBtn'),
      mobileShiftDownBtn: document.getElementById('mobileShiftDownBtn'),
      mobileGearValue: document.getElementById('mobileGearValue'),
    };
  }

  // Speed unit is a pure display preference — it never touches
  // EngineState, which always keeps speed internally in km/h. Toggling
  // just changes how the same number is formatted on screen.
  let speedUnit = 'kmh'; // 'kmh' | 'mph'

  const GEAR_MODE_HINTS = {
    auto: 'Mode AUTO — gearbox berpindah sendiri berdasarkan RPM (dengan jeda perpindahan).',
    manual: 'Mode MANUAL — gunakan tombol SHIFT untuk pindah gigi. Rev limiter tetap aktif jika RPM mentok tanpa shift.',
  };

  function formatSpeed(speedKmh) {
    if (speedUnit === 'mph') {
      const mph = Math.round(speedKmh / EngineState.KMH_PER_MPH);
      return { value: mph, unit: 'MPH' };
    }
    return { value: speedKmh, unit: 'KM/H' };
  }

  function logLine(message) {
    if (!els.systemLog) return;
    const time = new Date().toTimeString().slice(0, 8);
    const line = document.createElement('p');
    line.className = 'log__line';
    line.textContent = `[${time}] ${message}`;
    els.systemLog.appendChild(line);
    els.systemLog.scrollTop = els.systemLog.scrollHeight;
  }

  function setEngineStatus(state, label) {
    if (!els.engineStatusChip || !els.engineStatusLabel) return;
    els.engineStatusChip.dataset.state = state;
    els.engineStatusLabel.textContent = label;
  }

  function setAudioStatusLabel(label) {
    if (els.audioStatusLabel) els.audioStatusLabel.textContent = label;
  }

  const STATUS_LABELS = {
    off: 'ENGINE OFF',
    idle: 'ENGINE IDLE',
    running: 'ENGINE RUNNING',
    redline: 'REV LIMITER',
  };

  const STATUS_CHIP_STATE = {
    off: 'off',
    idle: 'idle',
    running: 'idle',
    redline: 'redline',
  };

  const CAPTIONS = {
    off: 'Mesin mati. Tekan START ENGINE untuk mengaktifkan simulasi RPM.',
    idle: 'Mesin idle. Geser THROTTLE INPUT untuk menaikkan RPM.',
    running: 'Simulasi RPM aktif — inersia mesin membuat perubahan bertahap.',
    redline: 'Rev limiter aktif — fuel cut menahan RPM di batas maksimum.',
  };

  /**
   * Renders a full EngineState snapshot into the DOM, including the
   * gauge needle. Called on every EngineState notification — which now
   * fires on every simulation frame, not just on user input.
   */
  function render(state) {
    if (gaugeRef) gaugeRef.setValueK(state.rpmK);

    if (els.rpmValue) els.rpmValue.textContent = String(state.rpm);

    if (els.redlineIndicator) {
      els.redlineIndicator.dataset.active = state.inRedline ? 'true' : 'false';
    }

    if (els.gearIndicator) els.gearIndicator.dataset.shifting = state.shifting ? 'true' : 'false';
    if (els.gearValue) els.gearValue.textContent = state.gear;
    if (els.gearReadout) els.gearReadout.textContent = state.gear;

    if (els.shiftUpBtn) els.shiftUpBtn.disabled = state.gearMode !== 'manual' || !state.canShiftUp;
    if (els.shiftDownBtn) els.shiftDownBtn.disabled = state.gearMode !== 'manual' || !state.canShiftDown;

    // Mobile shifter mirrors the desktop gear controls 1:1 — same
    // disabled/canShift logic, just a second set of DOM nodes docked
    // above the gas pedal instead of inside the telemetry panel.
    if (els.mobileGearValue) els.mobileGearValue.textContent = state.gear;
    if (els.mobileShiftUpBtn) els.mobileShiftUpBtn.disabled = state.gearMode !== 'manual' || !state.canShiftUp;
    if (els.mobileShiftDownBtn) els.mobileShiftDownBtn.disabled = state.gearMode !== 'manual' || !state.canShiftDown;
    if (els.mobileGearModeBtn) {
      els.mobileGearModeBtn.textContent = state.gearMode === 'manual' ? 'MANUAL' : 'AUTO';
      els.mobileGearModeBtn.dataset.mode = state.gearMode;
    }
    // Keep the desktop AUTO/MANUAL segmented control and its hint text
    // in sync too — driven here (every frame) rather than only inside
    // the desktop toggle's own click handler, so switching mode from
    // the mobile pill (or any future control) can't leave the desktop
    // panel showing a stale mode.
    if (els.gearModeToggle) {
      els.gearModeToggle.querySelectorAll('.segmented__btn').forEach((b) => {
        b.setAttribute('aria-pressed', b.dataset.mode === state.gearMode ? 'true' : 'false');
      });
    }
    if (els.gearModeHint) els.gearModeHint.textContent = GEAR_MODE_HINTS[state.gearMode] || '';

    if (els.throttleReadout) els.throttleReadout.textContent = `${Math.round(state.throttlePercent)}%`;
    if (els.throttleSlider) {
      els.throttleSlider.disabled = !state.engineOn;
      // Keep slider in sync if throttle was changed by something other
      // than direct user drag (e.g. reset on stop).
      if (Number(els.throttleSlider.value) !== Math.round(state.throttlePercent)) {
        els.throttleSlider.value = String(Math.round(state.throttlePercent));
      }
    }

    if (els.speedReadout) {
      const { value, unit } = formatSpeed(state.speedKmh);
      els.speedReadout.innerHTML = `${value} <small id="speedUnitLabel">${unit}</small>`;
    }
    if (els.tempReadout) {
      els.tempReadout.innerHTML = `${state.engineTempC} <small>°C</small>`;
    }
    if (els.boostReadout) {
      els.boostReadout.innerHTML = `${state.boostBar.toFixed(2)} <small>BAR</small>`;
    }

    if (els.gaugeCaption) {
      els.gaugeCaption.textContent = CAPTIONS[state.status] || CAPTIONS.off;
    }

    setEngineStatus(STATUS_CHIP_STATE[state.status] || 'off', STATUS_LABELS[state.status] || 'ENGINE OFF');

    if (els.startEngineBtn) {
      els.startEngineBtn.textContent = state.engineOn ? 'STOP ENGINE' : 'START ENGINE';
      els.startEngineBtn.classList.toggle('btn--danger', state.engineOn);
    }
  }

  function bindThrottleSlider() {
    if (!els.throttleSlider) return;
    els.throttleSlider.addEventListener('input', (e) => {
      EngineState.setThrottle(Number(e.target.value));
      // No direct gauge/DOM writes here — the simulation loop's next
      // frame (via render()) is what actually moves the needle/values.
    });
  }

  /**
   * Realtime throttle indicator — driven directly by ThrottleController's
   * own rAF loop (not EngineState), so it reflects the smoothed
   * press/hold/release ramp itself, live, regardless of which input
   * source (keyboard, button, pedal, or slider-via-EngineState) is
   * currently driving RPM.
   */
  function renderThrottleIndicator(percent, held) {
    const rounded = Math.round(percent);
    if (els.throttleIndicatorFill) els.throttleIndicatorFill.style.width = `${rounded}%`;
    if (els.throttleIndicatorValue) els.throttleIndicatorValue.textContent = `${rounded}%`;
    if (els.throttlePedalMeterFill) els.throttlePedalMeterFill.style.width = `${rounded}%`;
    if (els.throttleButton) els.throttleButton.dataset.pressed = held ? 'true' : 'false';
    if (els.throttlePedal) els.throttlePedal.dataset.pressed = held ? 'true' : 'false';
  }

  function bindSpeedUnitToggle() {
    if (!els.speedUnitToggle) return;
    els.speedUnitToggle.addEventListener('click', () => {
      speedUnit = speedUnit === 'kmh' ? 'mph' : 'kmh';
      // Re-render immediately off the last known state so the switch
      // feels instant rather than waiting for the next sim frame.
      render(EngineState.getState());
      logLine(`Satuan kecepatan diubah ke ${speedUnit === 'mph' ? 'MPH' : 'KM/H'}.`);
    });
  }

  function bindGearControls() {
    if (els.gearModeToggle) {
      els.gearModeToggle.addEventListener('click', (e) => {
        const btn = e.target.closest('.segmented__btn');
        if (!btn) return;
        const mode = btn.dataset.mode;
        EngineState.setGearMode(mode);
        // Segmented buttons + hint text now sync from render() on the
        // next frame, same as every other state-driven UI element.

        logLine(mode === 'manual'
          ? 'GEAR MODE → MANUAL — gunakan tombol SHIFT.'
          : 'GEAR MODE → AUTO — gearbox kembali mengendalikan sendiri.');
      });
    }

    if (els.shiftUpBtn) {
      els.shiftUpBtn.addEventListener('click', () => {
        const before = EngineState.getState().gear;
        const after = EngineState.shiftUp().gear;
        if (after !== before) logLine(`SHIFT UP — gigi ${before} → ${after}.`);
      });
    }

    if (els.shiftDownBtn) {
      els.shiftDownBtn.addEventListener('click', () => {
        const before = EngineState.getState().gear;
        const after = EngineState.shiftDown().gear;
        if (after !== before) logLine(`SHIFT DOWN — gigi ${before} → ${after}.`);
      });
    }

    // Mobile shifter — same EngineState calls as the desktop controls,
    // just a second set of listeners on the buttons docked by the gas
    // pedal.
    if (els.mobileGearModeBtn) {
      els.mobileGearModeBtn.addEventListener('click', () => {
        const nextMode = EngineState.getState().gearMode === 'manual' ? 'auto' : 'manual';
        EngineState.setGearMode(nextMode);
        logLine(nextMode === 'manual'
          ? 'GEAR MODE → MANUAL — gunakan tombol SHIFT.'
          : 'GEAR MODE → AUTO — gearbox kembali mengendalikan sendiri.');
      });
    }

    if (els.mobileShiftUpBtn) {
      els.mobileShiftUpBtn.addEventListener('click', () => {
        const before = EngineState.getState().gear;
        const after = EngineState.shiftUp().gear;
        if (after !== before) logLine(`SHIFT UP — gigi ${before} → ${after}.`);
      });
    }

    if (els.mobileShiftDownBtn) {
      els.mobileShiftDownBtn.addEventListener('click', () => {
        const before = EngineState.getState().gear;
        const after = EngineState.shiftDown().gear;
        if (after !== before) logLine(`SHIFT DOWN — gigi ${before} → ${after}.`);
      });
    }
  }

  function bindStartButton() {
    if (!els.startEngineBtn) return;
    els.startEngineBtn.addEventListener('click', () => {
      const wasOn = EngineState.getState().engineOn;
      if (wasOn) {
        EngineState.stopEngine();
        logLine('STOP ENGINE — ignition off, RPM coasting down.');
      } else {
        EngineState.startEngine();
        logLine('START ENGINE — idle RPM engaged.');
      }
    });
  }

  function init(gauge) {
    gaugeRef = gauge;
    cacheEls();
    bindThrottleSlider();
    bindSpeedUnitToggle();
    bindGearControls();
    bindStartButton();
    setAudioStatusLabel('AUDIO ENGINE: NOT INITIALIZED');

    EngineState.subscribe((state) => render(state));

    // Press/hold throttle sources (keyboard W/ArrowUp, desktop button,
    // mobile pedal) all live in ThrottleController — it owns the
    // press/hold/release ramp and feeds EngineState.setThrottle() itself
    // every frame, so ui-controller only needs to render what it reports.
    ThrottleController.init(els);
    ThrottleController.subscribe((percent, held) => renderThrottleIndicator(percent, held));

    logLine('UI controller ready — bound to EngineState + RPMSimulator.');
    logLine('Throttle: keyboard (W / ↑), tombol UI, dan pedal mobile aktif.');
  }

  return { init, logLine, setEngineStatus, setAudioStatusLabel };
})();
