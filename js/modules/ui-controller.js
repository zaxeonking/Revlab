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
  let speedGaugeRef = null;
  let boostGaugeRef = null;

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
      brakeReadout: document.getElementById('brakeReadout'),
      brakeButton: document.getElementById('brakeButton'),
      brakePedal: document.getElementById('brakePedal'),
      brakePedalMeterFill: document.getElementById('brakePedalMeterFill'),
      gearPlateBrake: document.getElementById('gearPlateBrake'),
      gearPlateBrakeFill: document.getElementById('gearPlateBrakeFill'),
      gearPlateBrakeValue: document.getElementById('gearPlateBrakeValue'),
      startEngineBtn: document.getElementById('startEngineBtn'),

      systemLog: document.getElementById('systemLog'),

      rpmValue: document.getElementById('rpmValue'),
      redlineIndicator: document.getElementById('redlineIndicator'),
      gearIndicator: document.getElementById('gearIndicator'),
      gearValue: document.getElementById('gearValue'),
      gearReadout: document.getElementById('gearReadout'),
      gaugeCaption: document.getElementById('gaugeCaption'),

      speedReadout: document.getElementById('speedValue'),
      speedGaugeUnit: document.getElementById('speedGaugeUnit'),
      speedWarningIndicator: document.getElementById('speedWarningIndicator'),
      speedUnitToggle: document.getElementById('speedUnitToggle'),
      tempReadout: document.getElementById('tempReadout'),
      boostReadout: document.getElementById('boostReadout'),
      boostGaugeValue: document.getElementById('boostGaugeValue'),
      turboSpoolFill: document.getElementById('turboSpoolFill'),

      gearModeToggle: document.getElementById('gearModeToggle'),
      shiftUpBtn: document.getElementById('shiftUpBtn'),
      shiftDownBtn: document.getElementById('shiftDownBtn'),
      gearModeHint: document.getElementById('gearModeHint'),

      mobileShifter: document.getElementById('mobileShifter'),
      mobileGearModeBtn: document.getElementById('mobileGearModeBtn'),
      mobileShiftUpBtn: document.getElementById('mobileShiftUpBtn'),
      mobileShiftDownBtn: document.getElementById('mobileShiftDownBtn'),
      mobileGearValue: document.getElementById('mobileGearValue'),

      engineSelect: document.getElementById('engineSelect'),
      engineSelectHint: document.getElementById('engineSelectHint'),

      gearboxRatios: document.getElementById('gearboxRatios'),
      gearboxFinalDrive: document.getElementById('gearboxFinalDrive'),
      gearboxWheelCirc: document.getElementById('gearboxWheelCirc'),
      gearboxEfficiency: document.getElementById('gearboxEfficiency'),

      shiftLights: document.getElementById('shiftLights'),

      vehicleSetupOpenBtn: document.getElementById('vehicleSetupOpenBtn'),
      vehicleSetupOverlay: document.getElementById('vehicleSetupOverlay'),
      vehicleSetupCloseBtn: document.getElementById('vehicleSetupCloseBtn'),
      vehicleSetupDoneBtn: document.getElementById('vehicleSetupDoneBtn'),
      vehicleSetupResetBtn: document.getElementById('vehicleSetupResetBtn'),
      vehicleSetupEngineGrid: document.getElementById('vehicleSetupEngineGrid'),
      vehicleSetupInductionSelect: document.getElementById('setup-inductionType'),
      vehicleSetupInductionMsg: document.getElementById('setup-inductionType-msg'),
      vehicleSetupDrivetrainGrid: document.getElementById('vehicleSetupDrivetrainGrid'),
      vehicleSetupGearRatios: document.getElementById('vehicleSetupGearRatios'),

      soundLabOpenBtn: document.getElementById('soundLabOpenBtn'),
      soundLabOverlay: document.getElementById('soundLabOverlay'),
      soundLabCloseBtn: document.getElementById('soundLabCloseBtn'),
      soundLabDoneBtn: document.getElementById('soundLabDoneBtn'),
      soundLabResetBtn: document.getElementById('soundLabResetBtn'),
      soundLabGrid: document.getElementById('soundLabGrid'),
      soundLabStatus: document.getElementById('soundLabStatus'),
      soundLabMasterVolume: document.getElementById('soundLabMasterVolume'),
      soundLabMasterVolumeValue: document.getElementById('soundLabMasterVolumeValue'),
    };
  }

  // ---- Shift-light bar --------------------------------------------------
  // Purely a re-presentation of the real RPM signal EngineState already
  // exposes (state.rpmK / state.maxRpmK / state.redlineStartK, both of
  // which pass straight through from RPMSimulator's real constants — see
  // engine-state.js) — no separate random/fake value, same principle as
  // renderGearboxSpec() above never hand-typing numbers RPMSimulator owns.
  const SHIFT_LIGHT_COUNT = 12;
  let shiftLightEls = [];

  function buildShiftLights() {
    if (!els.shiftLights) return;
    els.shiftLights.innerHTML = '';
    shiftLightEls = [];
    for (let i = 0; i < SHIFT_LIGHT_COUNT; i += 1) {
      const t = (i + 1) / SHIFT_LIGHT_COUNT; // 0..1 position along the bar
      const band = t > 0.83 ? 'hi' : t > 0.58 ? 'mid' : 'lo';
      const dot = document.createElement('span');
      dot.className = 'shiftlight';
      dot.dataset.band = band;
      dot.dataset.on = 'false';
      els.shiftLights.appendChild(dot);
      shiftLightEls.push(dot);
    }
  }

  let wasInRedline = false;

  function renderShiftLights(state) {
    if (!shiftLightEls.length) return;
    // Bar fills relative to the redline start, not the absolute dial
    // ceiling, so the lights climb across the whole usable rev range
    // instead of only lighting up in the last sliver before redline.
    const fraction = state.engineOn && state.redlineStartK > 0
      ? Math.min(state.rpmK / state.redlineStartK, 1)
      : 0;
    const litCount = Math.round(fraction * SHIFT_LIGHT_COUNT);

    shiftLightEls.forEach((dot, i) => {
      dot.dataset.on = i < litCount ? 'true' : 'false';
    });

    // Brief flash across the whole bar the instant redline/limiter is
    // hit — a single flash per rising edge, not every frame while held.
    if (state.inRedline && !wasInRedline) {
      shiftLightEls.forEach((dot) => {
        dot.dataset.flash = 'true';
        setTimeout(() => { dot.dataset.flash = 'false'; }, 500);
      });
    }
    wasInRedline = state.inRedline;
  }

  /**
   * Rescales the RPM/speed gauge faces when VEHICLE SETUP has changed
   * Max RPM / Redline RPM / Top Speed — guarded with last-applied
   * tracking so the SVG tick/arc rebuild only runs on an actual change,
   * not on every animation frame (render() runs every frame; rebuilding
   * gauge markup that often would be wasteful and pointless).
   */
  let lastMaxRpmK = null;
  let lastRedlineStartK = null;
  let lastMaxSpeedKmh = null;
  let lastMaxBoostBar = null;

  function syncGaugeScales(state) {
    if (gaugeRef && gaugeRef.reconfigure
      && (state.maxRpmK !== lastMaxRpmK || state.redlineStartK !== lastRedlineStartK)) {
      gaugeRef.reconfigure(state.maxRpmK, state.redlineStartK);
      lastMaxRpmK = state.maxRpmK;
      lastRedlineStartK = state.redlineStartK;
    }
    if (speedGaugeRef && speedGaugeRef.reconfigure && state.maxSpeedKmh !== lastMaxSpeedKmh) {
      speedGaugeRef.reconfigure(state.maxSpeedKmh);
      lastMaxSpeedKmh = state.maxSpeedKmh;
    }
    if (boostGaugeRef && boostGaugeRef.reconfigure && state.maxBoostBar !== lastMaxBoostBar) {
      boostGaugeRef.reconfigure(state.maxBoostBar);
      lastMaxBoostBar = state.maxBoostBar;
    }
  }

  /** Renders the drivetrain spec panel. Now called every frame from
   *  render() (not just once at init) because VEHICLE SETUP can change
   *  gear ratios / final drive / wheel radius at runtime — reads live
   *  via EngineState.getDrivetrainSpec(), so this can never disagree
   *  with what the simulation is actually using. Plain textContent
   *  writes are cheap enough to redo every frame. */
  function renderGearboxSpec() {
    const spec = EngineState.getDrivetrainSpec();
    if (els.gearboxRatios) {
      const labels = spec.gearRatios
        .slice(1) // drop the null neutral entry
        .map((r) => r.toFixed(3))
        .join(' / ');
      els.gearboxRatios.textContent = labels;
    }
    if (els.gearboxFinalDrive) {
      els.gearboxFinalDrive.textContent = `${spec.finalDriveRatio.toFixed(2)} : 1`;
    }
    if (els.gearboxWheelCirc) {
      els.gearboxWheelCirc.innerHTML = `${spec.wheelCircumferenceM.toFixed(2)} <small>M</small>`;
    }
    if (els.gearboxEfficiency) {
      els.gearboxEfficiency.textContent = `${Math.round(spec.drivetrainEfficiency * 100)}%`;
    }
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
    renderShiftLights(state);
    renderGearboxSpec();
    syncGaugeScales(state);

    // Angka RPM sengaja dikunci ke 0 selama gigi N — jarum tetap mengikuti
    // RPM asli (revving di netral tetap kelihatan gerak), tapi angka
    // digital hanya menampilkan RPM saat ada gigi yang benar-benar
    // terhubung ke drivetrain (gearIndex > 0).
    if (els.rpmValue) {
      els.rpmValue.textContent = state.gearIndex === 0 ? '0' : String(state.rpm);
    }

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
    if (els.brakeReadout) els.brakeReadout.textContent = `${Math.round(state.brakePercent || 0)}%`;
    if (els.throttleSlider) {
      els.throttleSlider.disabled = !state.engineOn;
      // Keep slider in sync if throttle was changed by something other
      // than direct user drag (e.g. reset on stop).
      if (Number(els.throttleSlider.value) !== Math.round(state.throttlePercent)) {
        els.throttleSlider.value = String(Math.round(state.throttlePercent));
      }
    }

    if (speedGaugeRef) {
      const overWarnZone = speedGaugeRef.setSpeedKmh(state.speedKmh);
      if (els.speedWarningIndicator) {
        els.speedWarningIndicator.dataset.active = overWarnZone ? 'true' : 'false';
      }
    }
    if (els.speedReadout) {
      const { value, unit } = formatSpeed(state.speedKmh);
      els.speedReadout.textContent = String(value);
      if (els.speedGaugeUnit) els.speedGaugeUnit.textContent = unit;
    }
    if (els.tempReadout) {
      els.tempReadout.innerHTML = `${state.engineTempC} <small>°C</small>`;
    }
    if (els.boostReadout) {
      els.boostReadout.innerHTML = `${state.boostBar.toFixed(2)} <small>BAR</small>`;
    }
    if (boostGaugeRef) boostGaugeRef.setValueBar(state.boostBar);
    if (els.boostGaugeValue) els.boostGaugeValue.textContent = state.boostBar.toFixed(2);
    if (els.turboSpoolFill) {
      // Supercharger/turbo/twin all report a real spoolFraction; naturally
      // aspirated engines report 0 (EngineState forces it there) — the
      // bar just reads empty for NA rather than needing a special case
      // here, same "read whatever the sim already computed" principle
      // every other readout in this file follows.
      const spoolPct = Math.round(Math.max(0, Math.min(1, state.turboSpoolFraction || 0)) * 100);
      els.turboSpoolFill.style.width = `${spoolPct}%`;
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

  /**
   * Same live-off-BrakeController pattern as renderThrottleIndicator()
   * above, just for the brake button/pedal — see BrakeController.subscribe()
   * wiring in init() below.
   */
  function renderBrakeIndicator(percent, held) {
    const rounded = Math.round(percent);
    if (els.brakePedalMeterFill) els.brakePedalMeterFill.style.width = `${rounded}%`;
    if (els.brakeButton) els.brakeButton.dataset.pressed = held ? 'true' : 'false';
    if (els.brakePedal) els.brakePedal.dataset.pressed = held ? 'true' : 'false';
    if (els.gearPlateBrakeFill) els.gearPlateBrakeFill.style.width = `${rounded}%`;
    if (els.gearPlateBrakeValue) els.gearPlateBrakeValue.textContent = `${rounded}%`;
    if (els.gearPlateBrake) els.gearPlateBrake.dataset.active = rounded > 0 ? 'true' : 'false';
  }

  function bindSpeedUnitToggle() {
    if (!els.speedUnitToggle) return;
    els.speedUnitToggle.addEventListener('click', () => {
      speedUnit = speedUnit === 'kmh' ? 'mph' : 'kmh';
      if (speedGaugeRef) speedGaugeRef.setUnit(speedUnit);
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

  /**
   * Shift/Ctrl keyboard gear control. Deliberately separate from
   * ThrottleController's keyboard binding (W/ArrowUp) — that one ramps
   * a held value every frame, this one fires a single discrete shift
   * per keydown, same "one shift per press" contract as the SHIFT ▲▼
   * buttons (shiftUp()/shiftDown() already own the shift-lock/engine-on
   * guards, so this only needs to call them, not re-implement guarding).
   *
   * Pressing either key while in AUTO switches to MANUAL first — same
   * pattern as a sequential-shift paddle in a racing game taking manual
   * control the instant the driver actually shifts, rather than
   * silently no-op'ing (or fighting the automatic gearbox) while still
   * in AUTO.
   */
  function bindGearKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.key !== 'Shift' && e.key !== 'Control') return;

      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (EngineState.getState().gearMode !== 'manual') {
        EngineState.setGearMode('manual');
        logLine('GEAR MODE → MANUAL (otomatis, dari keyboard shift).');
      }

      const before = EngineState.getState().gear;
      if (e.key === 'Shift') {
        const after = EngineState.shiftUp().gear;
        if (after !== before) logLine(`SHIFT UP (Shift) — gigi ${before} → ${after}.`);
      } else {
        const after = EngineState.shiftDown().gear;
        if (after !== before) logLine(`SHIFT DOWN (Ctrl) — gigi ${before} → ${after}.`);
      }
    });
  }

  // ------------------------------------------------------------------
  // PRESET SELECTOR (ENGINE PROFILE dropdown) — options generated from
  // VehicleSetup.getPresets() (backed by vehicle-presets.js), with a
  // leading "STOCK (DEFAULT)" entry and a trailing "CUSTOM" entry that
  // are always present regardless of the preset catalogue. Picking a
  // named preset or STOCK immediately re-configures the whole
  // simulation (params + drivetrain + sound); picking CUSTOM is a
  // no-op on values, it just marks the current configuration as
  // hand-tuned. The dropdown itself is kept in sync the other
  // direction too — editing ANY field in VEHICLE SETUP flips it back
  // to CUSTOM automatically (see VehicleSetup.markCustom(), fired from
  // set()/setGearRatio()/setInductionType()).
  // ------------------------------------------------------------------
  function buildEngineSelect() {
    if (!els.engineSelect) return;
    els.engineSelect.innerHTML = '';

    const stockOption = document.createElement('option');
    stockOption.value = VehicleSetup.STOCK_ID;
    stockOption.textContent = 'STOCK (DEFAULT)';
    els.engineSelect.appendChild(stockOption);

    VehicleSetup.getPresets().forEach((preset) => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      if (preset.description) option.title = preset.description;
      els.engineSelect.appendChild(option);
    });

    const customOption = document.createElement('option');
    customOption.value = VehicleSetup.CUSTOM_ID;
    customOption.textContent = 'CUSTOM';
    els.engineSelect.appendChild(customOption);

    els.engineSelect.addEventListener('change', () => {
      const id = els.engineSelect.value;
      if (id === VehicleSetup.CUSTOM_ID) {
        VehicleSetup.selectCustom();
        logLine('ENGINE PROFILE — CUSTOM (parameter saat ini dipertahankan, siap diubah manual).');
        return;
      }
      if (id === VehicleSetup.STOCK_ID) {
        VehicleSetup.reset();
        logLine('ENGINE PROFILE — STOCK (DEFAULT): semua parameter dikembalikan ke default pabrik.');
        return;
      }
      const result = VehicleSetup.applyPreset(id);
      if (result.ok) {
        logLine(`ENGINE PROFILE — preset diterapkan: ${result.message.replace('Preset diterapkan: ', '')}`);
      }
    });
  }

  /** Keeps the ENGINE PROFILE dropdown showing whatever
   *  currentPresetId VehicleSetup actually reports — called from the
   *  global VehicleSetup.subscribe() below every time ANY field changes,
   *  a preset is applied, or RESET SETUP runs, so it can never drift out
   *  of sync with reality (e.g. hand-editing a field while a preset was
   *  selected flips this back to CUSTOM automatically). */
  function syncEngineSelect(values) {
    if (!els.engineSelect) return;
    if (els.engineSelect.value !== values.currentPresetId) {
      els.engineSelect.value = values.currentPresetId;
    }
  }

  // ------------------------------------------------------------------
  // VEHICLE SETUP panel — form is generated from VehicleSetup's param
  // specs (js/modules/vehicle-setup.js), not hand-typed in index.html,
  // so it can never drift out of sync with the min/max rules actually
  // enforced. Every field applies immediately on change (no separate
  // "Apply" step) — validation happens in VehicleSetup.set()/
  // setGearRatio(), which also pushes the result straight into
  // EngineState.applyVehicleSetup().
  // ------------------------------------------------------------------
  const setupInputEls = {};   // paramKey -> <input>
  const setupMsgEls = {};     // paramKey -> <p> (validation message)
  const setupGearInputEls = []; // index -> <input>
  const setupGearMsgEls = [];   // index -> <p>

  function buildSetupFieldNode(key, spec, inputId) {
    const wrap = document.createElement('div');
    wrap.className = 'setup-field';
    wrap.dataset.key = key;

    const label = document.createElement('label');
    label.className = 'setup-field__label';
    label.setAttribute('for', inputId);
    label.textContent = spec.label;
    if (spec.unit) {
      const unit = document.createElement('span');
      unit.className = 'setup-field__unit';
      unit.textContent = spec.unit;
      label.appendChild(document.createTextNode(' '));
      label.appendChild(unit);
    }

    const input = document.createElement('input');
    input.type = 'number';
    input.id = inputId;
    input.className = 'setup-field__input';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.inputMode = spec.decimals > 0 ? 'decimal' : 'numeric';

    const range = document.createElement('p');
    range.className = 'setup-field__range';
    range.textContent = `${formatSpecNum(spec.min, spec.decimals)} – ${formatSpecNum(spec.max, spec.decimals)}`;

    const msg = document.createElement('p');
    msg.className = 'setup-field__msg';
    msg.setAttribute('aria-live', 'polite');

    wrap.appendChild(label);
    wrap.appendChild(input);
    wrap.appendChild(range);
    wrap.appendChild(msg);

    return { wrap, input, msg };
  }

  function formatSpecNum(n, decimals) {
    return Number(n).toFixed(decimals);
  }

  function buildVehicleSetupForm() {
    if (!els.vehicleSetupEngineGrid || !els.vehicleSetupDrivetrainGrid || !els.vehicleSetupGearRatios) return;

    els.vehicleSetupEngineGrid.innerHTML = '';
    els.vehicleSetupDrivetrainGrid.innerHTML = '';
    els.vehicleSetupGearRatios.innerHTML = '';

    // ---- ENGINE CONFIGURATION — induction type (enum, not a numeric
    // PARAMS entry, so it's built here by hand rather than through
    // buildSetupFieldNode()/VehicleSetup.getParamKeys() below). Options
    // come straight from VehicleSetup.getInductionTypes() so this select
    // can never list a value VehicleSetup itself doesn't recognize. ----
    if (els.vehicleSetupInductionSelect) {
      els.vehicleSetupInductionSelect.innerHTML = '';
      VehicleSetup.getInductionTypes().forEach((type) => {
        const option = document.createElement('option');
        option.value = type.value;
        option.textContent = type.label;
        els.vehicleSetupInductionSelect.appendChild(option);
      });
      els.vehicleSetupInductionSelect.addEventListener('change', () => {
        const result = VehicleSetup.setInductionType(els.vehicleSetupInductionSelect.value);
        if (els.vehicleSetupInductionMsg) {
          els.vehicleSetupInductionMsg.textContent = result.message || '';
          els.vehicleSetupInductionMsg.dataset.state = result.ok ? 'ok' : 'clamped';
        }
        if (result.ok) {
          const label = VehicleSetup.getInductionTypes().find((t) => t.value === result.value);
          logLine(`VEHICLE SETUP — INDUCTION TYPE → ${label ? label.label : result.value}.`);
        }
      });
    }

    VehicleSetup.getParamKeys().forEach((key) => {
      const spec = VehicleSetup.getSpec(key);
      const inputId = `setup-${key}`;
      const { wrap, input, msg } = buildSetupFieldNode(key, spec, inputId);

      input.addEventListener('change', () => {
        const result = VehicleSetup.set(key, input.value);
        applySetupFieldResult(key, input, msg, result, spec);
      });

      setupInputEls[key] = input;
      setupMsgEls[key] = msg;

      const targetGrid = spec.group === 'drivetrain' ? els.vehicleSetupDrivetrainGrid : els.vehicleSetupEngineGrid;
      targetGrid.appendChild(wrap);
    });

    const gearSpec = VehicleSetup.getGearRatioSpec();
    const gearLabels = ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH'];
    for (let i = 0; i < VehicleSetup.GEAR_COUNT; i += 1) {
      const inputId = `setup-gear-${i}`;
      const { wrap, input, msg } = buildSetupFieldNode(`gear-${i}`, { ...gearSpec, label: gearLabels[i] }, inputId);
      wrap.classList.add('setup-field--gear');

      input.addEventListener('change', () => {
        const result = VehicleSetup.setGearRatio(i, input.value);
        applySetupFieldResult(`gear-${i}`, input, msg, result, gearSpec);
      });

      setupGearInputEls[i] = input;
      setupGearMsgEls[i] = msg;
      els.vehicleSetupGearRatios.appendChild(wrap);
    }

    renderVehicleSetupValues(VehicleSetup.getAll());
  }

  /** Writes the clamped/validated value back into the field (so an
   *  out-of-range entry visibly snaps to what actually took effect),
   *  shows the validation message if any, and logs a one-line summary
   *  to the system log — same log every other control in REVLAB uses. */
  function applySetupFieldResult(key, input, msgEl, result, spec) {
    input.value = formatSpecNum(result.value, spec.decimals);
    msgEl.textContent = result.message || '';
    msgEl.dataset.state = result.ok ? 'ok' : 'clamped';
    if (result.message) {
      logLine(`VEHICLE SETUP — ${key}: ${result.message}`);
    } else {
      logLine(`VEHICLE SETUP — ${key} → ${formatSpecNum(result.value, spec.decimals)}${spec.unit ? ' ' + spec.unit : ''}.`);
    }
  }

  /** Re-populates every field from a VehicleSetup snapshot — used after
   *  RESET SETUP and on initial panel build, so the form always mirrors
   *  what's actually applied to the simulation. Clears any stale
   *  validation messages too. */
  function renderVehicleSetupValues(values) {
    if (els.vehicleSetupInductionSelect && document.activeElement !== els.vehicleSetupInductionSelect) {
      els.vehicleSetupInductionSelect.value = values.inductionType;
    }
    if (els.vehicleSetupInductionMsg) {
      els.vehicleSetupInductionMsg.textContent = '';
      els.vehicleSetupInductionMsg.dataset.state = '';
    }
    VehicleSetup.getParamKeys().forEach((key) => {
      const spec = VehicleSetup.getSpec(key);
      const input = setupInputEls[key];
      if (input && document.activeElement !== input) {
        input.value = formatSpecNum(values[key], spec.decimals);
      }
      if (setupMsgEls[key]) {
        setupMsgEls[key].textContent = '';
        setupMsgEls[key].dataset.state = '';
      }
    });
    const gearSpec = VehicleSetup.getGearRatioSpec();
    values.gearRatios.forEach((r, i) => {
      const input = setupGearInputEls[i];
      if (input && document.activeElement !== input) {
        input.value = formatSpecNum(r, gearSpec.decimals);
      }
      if (setupGearMsgEls[i]) {
        setupGearMsgEls[i].textContent = '';
        setupGearMsgEls[i].dataset.state = '';
      }
    });
  }

  // ---- SOUND LAB panel ---------------------------------------------------
  // Builds one card per SoundLab category (Idle / Low / Mid / High /
  // Limiter / Turbo / Shift), generated from SoundLab.CATEGORIES so the
  // markup can never list a category the module doesn't actually support.
  // Each card: hidden <input type="file" accept="audio/*"> + a visible
  // "CHOOSE FILE" button (styled trigger), filename readout, ▶ PREVIEW,
  // ✕ REMOVE, and a per-category volume slider. All file reads go through
  // SoundLab.loadFile(), which only ever uses the local File API /
  // URL.createObjectURL — no network request is made anywhere in this
  // flow (see sound-lab.js header comment).
  let soundLabFileInputEls = {};
  let soundLabFileNameEls = {};
  let soundLabRemoveBtnEls = {};
  let soundLabVolumeEls = {};
  let soundLabVolumeValueEls = {};
  let soundLabPreviewBtnEls = {};
  let soundLabMixMeterEls = {};

  function buildSoundLabGrid() {
    if (!els.soundLabGrid) return;
    els.soundLabGrid.innerHTML = '';
    soundLabFileInputEls = {};
    soundLabFileNameEls = {};
    soundLabRemoveBtnEls = {};
    soundLabVolumeEls = {};
    soundLabVolumeValueEls = {};
    soundLabPreviewBtnEls = {};
    soundLabMixMeterEls = {};

    SoundLab.CATEGORIES.forEach((cat) => {
      const meta = SoundLab.CATEGORY_META[cat];

      const card = document.createElement('div');
      card.className = 'soundlab-card';
      card.dataset.category = cat;

      const inputId = `soundLabFile-${cat}`;

      card.innerHTML = `
        <div class="soundlab-card__head">
          <span class="soundlab-card__label">${meta.label}</span>
          <span class="soundlab-card__badge" data-state="synth">SYNTH</span>
        </div>
        <p class="soundlab-card__hint">${meta.hint}</p>

        <div class="soundlab-card__mixmeter" aria-hidden="true">
          <div class="soundlab-card__mixmeter-fill"></div>
        </div>

        <div class="soundlab-card__file">
          <label class="btn btn--setup soundlab-card__choose" for="${inputId}">PILIH FILE</label>
          <input
            type="file"
            id="${inputId}"
            class="soundlab-card__input"
            accept="audio/*"
            aria-label="Pilih file audio lokal untuk ${meta.label}"
          />
          <span class="soundlab-card__filename" data-empty="true">Tidak ada file dipilih</span>
        </div>

        <div class="soundlab-card__actions">
          <button type="button" class="btn btn--soundlab-mini soundlab-card__preview" disabled>▶ PREVIEW</button>
          <button type="button" class="btn btn--soundlab-mini soundlab-card__remove" disabled>✕ REMOVE</button>
        </div>

        <div class="soundlab-card__volume">
          <span class="field__label">VOLUME</span>
          <input type="range" min="0" max="100" value="100" class="soundlab-card__volumeSlider" />
          <span class="soundlab-card__volumeValue">100%</span>
        </div>
      `;

      els.soundLabGrid.appendChild(card);

      soundLabFileInputEls[cat] = card.querySelector('.soundlab-card__input');
      soundLabFileNameEls[cat] = card.querySelector('.soundlab-card__filename');
      soundLabPreviewBtnEls[cat] = card.querySelector('.soundlab-card__preview');
      soundLabRemoveBtnEls[cat] = card.querySelector('.soundlab-card__remove');
      soundLabVolumeEls[cat] = card.querySelector('.soundlab-card__volumeSlider');
      soundLabVolumeValueEls[cat] = card.querySelector('.soundlab-card__volumeValue');
      soundLabMixMeterEls[cat] = card.querySelector('.soundlab-card__mixmeter-fill');

      // ---- File pick: local File API only, never a network upload ------
      soundLabFileInputEls[cat].addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const result = SoundLab.loadFile(cat, file);
        if (!result.ok) {
          if (result.reason === 'not_audio') {
            logLine(`SOUND LAB — "${file.name}" ditolak: bukan file audio.`);
          } else {
            logLine(`SOUND LAB — gagal memuat file untuk ${meta.label}.`);
          }
          e.target.value = '';
          return;
        }
        logLine(`SOUND LAB — ${meta.label}: "${result.name}" dimuat (lokal, tidak diupload).`);
      });

      soundLabPreviewBtnEls[cat].addEventListener('click', () => {
        SoundLab.preview(cat);
      });

      soundLabRemoveBtnEls[cat].addEventListener('click', () => {
        SoundLab.removeCategory(cat);
        soundLabFileInputEls[cat].value = '';
        logLine(`SOUND LAB — audio custom ${meta.label} dihapus, kembali ke sintesis.`);
      });

      soundLabVolumeEls[cat].addEventListener('input', (e) => {
        const v = Number(e.target.value) / 100;
        SoundLab.setVolume(cat, v);
        soundLabVolumeValueEls[cat].textContent = `${Math.round(v * 100)}%`;
      });
    });
  }

  /** Re-renders every Sound Lab card from SoundLab's current snapshot —
   *  called on init and whenever SoundLab notifies a change (load /
   *  remove / reset / volume), so file pick can happen from anywhere
   *  (including a stale card after RESET SEMUA) and the UI stays truthful. */
  function renderSoundLab(snapshot) {
    if (!els.soundLabGrid) return;
    const data = snapshot || SoundLab.getSnapshot();

    SoundLab.CATEGORIES.forEach((cat) => {
      const info = data.categories[cat];
      const card = els.soundLabGrid.querySelector(`.soundlab-card[data-category="${cat}"]`);
      if (!card) return;
      const badge = card.querySelector('.soundlab-card__badge');
      const filenameEl = soundLabFileNameEls[cat];
      const previewBtn = soundLabPreviewBtnEls[cat];
      const removeBtn = soundLabRemoveBtnEls[cat];
      const volumeEl = soundLabVolumeEls[cat];
      const volumeValueEl = soundLabVolumeValueEls[cat];

      if (info.hasCustom) {
        badge.textContent = 'CUSTOM';
        badge.dataset.state = 'custom';
        filenameEl.textContent = info.fileName;
        filenameEl.dataset.empty = 'false';
        previewBtn.disabled = false;
        removeBtn.disabled = false;
      } else {
        badge.textContent = 'SYNTH';
        badge.dataset.state = 'synth';
        filenameEl.textContent = 'Tidak ada file dipilih';
        filenameEl.dataset.empty = 'true';
        previewBtn.disabled = true;
        removeBtn.disabled = true;
      }

      if (document.activeElement !== volumeEl) {
        volumeEl.value = Math.round(info.volume * 100);
      }
      volumeValueEl.textContent = `${Math.round(info.volume * 100)}%`;
    });

    if (els.soundLabStatus) {
      const customCount = SoundLab.CATEGORIES.filter((cat) => data.categories[cat].hasCustom).length;
      els.soundLabStatus.textContent = customCount === 0
        ? 'Belum ada audio custom — memakai mesin sintesis.'
        : `${customCount} dari ${SoundLab.CATEGORIES.length} kategori memakai audio custom lokal.`;
    }

    if (els.soundLabMasterVolume && document.activeElement !== els.soundLabMasterVolume) {
      els.soundLabMasterVolume.value = Math.round(data.masterVolume * 100);
    }
    if (els.soundLabMasterVolumeValue) {
      els.soundLabMasterVolumeValue.textContent = `${Math.round(data.masterVolume * 100)}%`;
    }
  }

  /** Cheap per-frame visual only — updates the RPM-mix meter bar on each
   *  Sound Lab card. Deliberately separate from renderSoundLab() (which
   *  rebuilds text/badges and only runs on load/remove/volume changes)
   *  so the meter can update every simulation frame without doing any
   *  of that heavier work each tick. Gated on the modal actually being
   *  open so it's a no-op the rest of the time. */
  function renderSoundLabMeters(state) {
    if (!els.soundLabOverlay || els.soundLabOverlay.dataset.open !== 'true') return;
    const snapshot = SoundLab.getSnapshot();
    SoundLab.CATEGORIES.forEach((cat) => {
      const meterEl = soundLabMixMeterEls[cat];
      if (!meterEl) return;
      const mix = snapshot.categories[cat].currentMix || 0;
      meterEl.style.width = `${Math.round(mix * 100)}%`;
    });
  }

  function openSoundLab() {
    if (!els.soundLabOverlay) return;
    els.soundLabOverlay.dataset.open = 'true';
    els.soundLabOverlay.setAttribute('aria-hidden', 'false');
    renderSoundLab();
  }

  function closeSoundLab() {
    if (!els.soundLabOverlay) return;
    els.soundLabOverlay.dataset.open = 'false';
    els.soundLabOverlay.setAttribute('aria-hidden', 'true');
    // Stop any preview that might still be playing when the panel closes.
    SoundLab.CATEGORIES.forEach((cat) => SoundLab.stopPreview(cat));
  }

  function bindSoundLabPanel() {
    if (els.soundLabOpenBtn) els.soundLabOpenBtn.addEventListener('click', openSoundLab);
    if (els.soundLabCloseBtn) els.soundLabCloseBtn.addEventListener('click', closeSoundLab);
    if (els.soundLabDoneBtn) els.soundLabDoneBtn.addEventListener('click', closeSoundLab);
    if (els.soundLabOverlay) {
      els.soundLabOverlay.addEventListener('click', (e) => {
        if (e.target === els.soundLabOverlay) closeSoundLab();
      });
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.soundLabOverlay && els.soundLabOverlay.dataset.open === 'true') {
        closeSoundLab();
      }
    });
    if (els.soundLabResetBtn) {
      els.soundLabResetBtn.addEventListener('click', () => {
        SoundLab.resetAll();
        SoundLab.CATEGORIES.forEach((cat) => {
          if (soundLabFileInputEls[cat]) soundLabFileInputEls[cat].value = '';
        });
        logLine('SOUND LAB — RESET SEMUA: semua kategori kembali ke mesin sintesis.');
      });
    }
    if (els.soundLabMasterVolume) {
      els.soundLabMasterVolume.addEventListener('input', (e) => {
        const v = Number(e.target.value) / 100;
        SoundLab.setMasterVolume(v);
      });
    }
    SoundLab.subscribe(renderSoundLab);
  }

  function openVehicleSetup() {
    if (!els.vehicleSetupOverlay) return;
    els.vehicleSetupOverlay.dataset.open = 'true';
    els.vehicleSetupOverlay.setAttribute('aria-hidden', 'false');
  }

  function closeVehicleSetup() {
    if (!els.vehicleSetupOverlay) return;
    els.vehicleSetupOverlay.dataset.open = 'false';
    els.vehicleSetupOverlay.setAttribute('aria-hidden', 'true');
  }

  function bindVehicleSetupPanel() {
    if (els.vehicleSetupOpenBtn) {
      els.vehicleSetupOpenBtn.addEventListener('click', openVehicleSetup);
    }
    if (els.vehicleSetupCloseBtn) {
      els.vehicleSetupCloseBtn.addEventListener('click', closeVehicleSetup);
    }
    if (els.vehicleSetupDoneBtn) {
      els.vehicleSetupDoneBtn.addEventListener('click', closeVehicleSetup);
    }
    if (els.vehicleSetupOverlay) {
      // Click on the dim backdrop (not the modal card itself) also closes.
      els.vehicleSetupOverlay.addEventListener('click', (e) => {
        if (e.target === els.vehicleSetupOverlay) closeVehicleSetup();
      });
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.vehicleSetupOverlay && els.vehicleSetupOverlay.dataset.open === 'true') {
        closeVehicleSetup();
      }
    });
    if (els.vehicleSetupResetBtn) {
      els.vehicleSetupResetBtn.addEventListener('click', () => {
        const values = VehicleSetup.reset();
        renderVehicleSetupValues(values);
        logLine('VEHICLE SETUP — RESET SETUP: semua parameter dikembalikan ke default pabrik.');
      });
    }
  }

  /** Shared start/stop logic — used by both the START ENGINE button
   *  click and the Spacebar shortcut, so the two trigger paths can
   *  never drift out of sync (e.g. one forgetting the AudioEngine.init()
   *  user-gesture call). */
  function toggleEngine() {
    const wasOn = EngineState.getState().engineOn;
    if (wasOn) {
      EngineState.stopEngine();
      logLine('STOP ENGINE — ignition off, RPM coasting down.');
    } else {
      // AudioContext creation MUST happen inside a real user-gesture
      // handler — both click and keydown qualify. init() is a no-op if
      // the graph already exists from a previous Start Engine trigger.
      const result = AudioEngine.init();
      setAudioStatusLabel(result.ok
        ? 'AUDIO ENGINE: RUNNING'
        : 'AUDIO ENGINE: UNAVAILABLE');
      EngineState.startEngine();
      logLine('START ENGINE — idle RPM engaged.');
    }
  }

  function bindStartButton() {
    if (!els.startEngineBtn) return;
    els.startEngineBtn.addEventListener('click', toggleEngine);
  }

  /** Spacebar = START ENGINE / STOP ENGINE, desktop only (mobile has no
   *  hardware keyboard to speak of). Ignored while focus is in a text
   *  input/textarea/select so typing a space character in, say, a
   *  Vehicle Setup field doesn't accidentally kill the engine — same
   *  guard BrakeController/ThrottleController use for their key
   *  bindings. Also ignored while focus is on any <button>: the browser
   *  already fires a click from Space on a focused button, so handling
   *  it again here would double-toggle (start then immediately stop).
   *  e.repeat guarded too, so holding the key down doesn't rapid-fire. */
  function bindStartKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (e.repeat) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
      e.preventDefault();
      toggleEngine();
    });
  }

  function init(gauge, speedGauge, boostGauge) {
    gaugeRef = gauge;
    speedGaugeRef = speedGauge;
    boostGaugeRef = boostGauge;
    cacheEls();
    buildShiftLights();
    renderGearboxSpec();
    bindThrottleSlider();
    bindSpeedUnitToggle();
    bindGearControls();
    bindGearKeyboard();
    bindStartButton();
    bindStartKeyboard();
    buildEngineSelect();
    buildVehicleSetupForm();
    bindVehicleSetupPanel();
    buildSoundLabGrid();
    bindSoundLabPanel();
    renderSoundLab();
    setAudioStatusLabel('AUDIO ENGINE: NOT INITIALIZED');

    // Single subscription keeps BOTH the ENGINE PROFILE dropdown and the
    // VEHICLE SETUP form fields in sync with VehicleSetup's actual state,
    // no matter which of the three ways it changed (preset picked, RESET
    // SETUP pressed, or a single field hand-edited) — same "one source of
    // truth, re-render from it" pattern EngineState.subscribe() below
    // uses for the cockpit gauges.
    VehicleSetup.subscribe((values) => {
      syncEngineSelect(values);
      renderVehicleSetupValues(values);
    });

    EngineState.subscribe((state) => {
      render(state);
      // AudioEngine.update() is a no-op until AudioEngine.init() has run
      // (first Start Engine click) — safe to call every frame regardless.
      AudioEngine.update(state);
      // SoundLab only ever touches categories that actually have a custom
      // sample loaded (see sound-lab.js) — every other category is left
      // to AudioEngine's synthesis above, untouched. Runs every frame
      // regardless of whether any custom sample is loaded; it's a no-op
      // per-category otherwise.
      SoundLab.update(state);
      renderSoundLabMeters(state);
      if (!state.engineOn) setAudioStatusLabel(
        AudioEngine.getState().isInitialized ? 'AUDIO ENGINE: STANDBY' : 'AUDIO ENGINE: NOT INITIALIZED'
      );
    });

    // Press/hold throttle sources (keyboard W/ArrowUp, desktop button,
    // mobile pedal) all live in ThrottleController — it owns the
    // press/hold/release ramp and feeds EngineState.setThrottle() itself
    // every frame, so ui-controller only needs to render what it reports.
    ThrottleController.init(els);
    ThrottleController.subscribe((percent, held) => renderThrottleIndicator(percent, held));
    BrakeController.init(els);
    BrakeController.subscribe((percent, held) => renderBrakeIndicator(percent, held));

    logLine('UI controller ready — bound to EngineState + RPMSimulator.');
    logLine('Throttle: keyboard (W / ↑), tombol UI, dan pedal mobile aktif.');
    logLine('Gear: Shift (up) / Ctrl (down), tombol SHIFT ▲▼, atau shifter mobile.');
  }

  // Read-only accessor for the current speed display preference
  // ('kmh' | 'mph') — used by AccelerationMode (js/modules/
  // acceleration-mode.js) to decide whether the 0–100 MPH split is
  // applicable, and to format its own SPEED readout in the same unit
  // the driver already has selected in the cockpit.
  function getSpeedUnit() {
    return speedUnit;
  }

  return { init, logLine, setEngineStatus, setAudioStatusLabel, getSpeedUnit };
})();
