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
      startEngineBtn: document.getElementById('startEngineBtn'),

      systemLog: document.getElementById('systemLog'),

      rpmValue: document.getElementById('rpmValue'),
      redlineIndicator: document.getElementById('redlineIndicator'),
      gearIndicator: document.getElementById('gearValue'),
      gearReadout: document.getElementById('gearReadout'),
      gaugeCaption: document.getElementById('gaugeCaption'),

      speedReadout: document.getElementById('speedReadout'),
      tempReadout: document.getElementById('tempReadout'),
      boostReadout: document.getElementById('boostReadout'),
    };
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

    if (els.gearIndicator) els.gearIndicator.textContent = state.gear;
    if (els.gearReadout) els.gearReadout.textContent = state.gear;

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
      els.speedReadout.innerHTML = `${state.speedKmh} <small>KM/H</small>`;
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
    bindStartButton();
    setAudioStatusLabel('AUDIO ENGINE: NOT INITIALIZED');

    EngineState.subscribe((state) => render(state));

    logLine('UI controller ready — bound to EngineState + RPMSimulator.');
  }

  return { init, logLine, setEngineStatus, setAudioStatusLabel };
})();
