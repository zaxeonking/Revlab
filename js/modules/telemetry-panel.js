/**
 * REVLAB — telemetry-panel.js
 * -----------------------------------------------------------------------
 * TELEMETRY PANEL — a dedicated panel (same modal pattern as PERFORMANCE
 * MODE / ACCELERATION MODE) with two halves:
 *
 *   1. A realtime data grid: SPEED (KM/H or MPH, follows the cockpit's
 *      own unit toggle), RPM, GEAR, THROTTLE, TORQUE, POWER, BOOST,
 *      TEMPERATURE, ENGINE LOAD — all read straight off EngineState's
 *      per-frame snapshot, nothing computed locally.
 *
 *   2. An EVENT LOG: ENGINE START, GEAR SHIFT, REDLINE, LIMITER,
 *      OVERHEAT, TOP SPEED, ENGINE STOP. Every one of these is detected
 *      by EDGE-DETECTING fields that are already part of EngineState's
 *      snapshot (engineOn, gearShiftEventId, inRedline, revLimiting,
 *      engineTempC, speedKmh vs maxSpeedKmh) — exactly the same pattern
 *      AudioEngine already uses for blowOffEventId/gearShiftEventId, and
 *      the same "derive, don't invent" rule every other panel in REVLAB
 *      follows. This module owns no simulation state of its own beyond
 *      the previous-frame values needed to detect a transition, and the
 *      log entries themselves. Nothing here is timer-driven or random —
 *      an event only ever gets logged because the simulation state it
 *      watches actually changed.
 *
 * Detection runs on EVERY EngineState frame regardless of whether the
 * panel is open (so opening it later still shows what already happened
 * this session, the same way the cockpit's own system log works) —
 * only the DOM re-render is skipped while closed.
 * -----------------------------------------------------------------------
 */

const TelemetryPanel = (() => {
  // Temperature threshold for the OVERHEAT event. EngineState's thermal
  // model (engine-state.js) maps engine temp directly from RPM fraction,
  // topping out at OPERATING_TEMP_C (92°C) at max RPM — this threshold
  // sits just under that ceiling, so OVERHEAT only fires under genuinely
  // sustained high-RPM running, not an ordinary shift through the gears.
  const OVERHEAT_TEMP_C = 88;

  // How close (km/h) the displayed speed has to sit to the current
  // Top Speed governor (VEHICLE SETUP) to count as "at" it — the
  // approach-toward-target speed smoothing in engine-state.js means the
  // display can hover a fraction of a km/h under the hard cap.
  const TOP_SPEED_EPSILON_KMH = 0.5;

  const MAX_LOG_ENTRIES = 300;

  const EVENT_META = {
    start: { tag: 'ENGINE START', tone: 'ok' },
    stop: { tag: 'ENGINE STOP', tone: 'neutral' },
    shift: { tag: 'GEAR SHIFT', tone: 'cyan' },
    redline: { tag: 'REDLINE', tone: 'amber' },
    limiter: { tag: 'LIMITER', tone: 'red' },
    overheat: { tag: 'OVERHEAT', tone: 'red' },
    topspeed: { tag: 'TOP SPEED', tone: 'ok' },
  };

  let els = {};
  let isOpen = false;
  let logEntries = []; // [{ t, type, message }]

  // ---- Edge-detection memory (previous frame's values) -------------------
  let prevEngineOn = false;
  let prevGearShiftEventId = 0;
  let prevGearLabel = 'N';
  let prevInRedline = false;
  let prevRevLimiting = false;
  let prevOverheat = false;
  let prevAtTopSpeed = false;
  let primed = false; // avoids a false ENGINE START/STOP edge on the very first frame

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function timeLabel() {
    return new Date().toTimeString().slice(0, 8);
  }

  function mphActive() {
    return typeof UIController !== 'undefined'
      && UIController.getSpeedUnit
      && UIController.getSpeedUnit() === 'mph';
  }

  function cacheEls() {
    els = {
      openBtn: document.getElementById('telemetryPanelOpenBtn'),
      overlay: document.getElementById('telemetryPanelOverlay'),
      closeBtn: document.getElementById('telemetryPanelCloseBtn'),
      doneBtn: document.getElementById('telemetryPanelDoneBtn'),
      clearLogBtn: document.getElementById('telemetryClearLogBtn'),

      speed: document.getElementById('telemetrySpeed'),
      speedUnit: document.getElementById('telemetrySpeedUnit'),
      rpm: document.getElementById('telemetryRpm'),
      gear: document.getElementById('telemetryGear'),
      throttle: document.getElementById('telemetryThrottle'),
      torque: document.getElementById('telemetryTorque'),
      power: document.getElementById('telemetryPower'),
      boost: document.getElementById('telemetryBoost'),
      temp: document.getElementById('telemetryTemp'),
      load: document.getElementById('telemetryLoad'),

      log: document.getElementById('telemetryEventLog'),
    };
  }

  // ---- Realtime data grid --------------------------------------------------
  function renderReadouts(state) {
    const useMph = mphActive();
    const speedValue = useMph
      ? Math.round(state.speedKmh / EngineState.KMH_PER_MPH)
      : Math.round(state.speedKmh);

    if (els.speed) els.speed.textContent = `${speedValue}`;
    if (els.speedUnit) els.speedUnit.textContent = useMph ? 'MPH' : 'KM/H';
    if (els.rpm) els.rpm.textContent = `${Math.round(state.rpm)}`;
    if (els.gear) els.gear.textContent = state.gear;
    if (els.throttle) els.throttle.textContent = `${Math.round(state.throttlePercent)}`;
    if (els.torque) els.torque.textContent = `${state.torqueNm}`;
    if (els.power) els.power.textContent = `${state.powerHp}`;
    if (els.boost) els.boost.textContent = state.boostBar.toFixed(2);
    if (els.temp) els.temp.textContent = `${Math.round(state.engineTempC)}`;
    if (els.load) els.load.textContent = `${state.engineLoadPercent}`;
  }

  // ---- Event log -----------------------------------------------------------
  function pushEvent(type, message) {
    const meta = EVENT_META[type];
    const entry = { t: now(), wallTime: timeLabel(), type, tag: meta.tag, tone: meta.tone, message };
    logEntries.push(entry);
    if (logEntries.length > MAX_LOG_ENTRIES) logEntries.shift();
    if (isOpen) appendLogRow(entry);
    // Mirror into the cockpit's own system log too, so an event is
    // visible even for someone who never opens this panel — same
    // "one source of truth, multiple listeners" idea used elsewhere.
    if (typeof UIController !== 'undefined' && UIController.logLine) {
      UIController.logLine(`${meta.tag} — ${message}`);
    }
  }

  function buildLogRow(entry) {
    const row = document.createElement('div');
    row.className = 'telemetry-log__row';
    row.dataset.tone = entry.tone;

    const time = document.createElement('span');
    time.className = 'telemetry-log__time';
    time.textContent = entry.wallTime;

    const tag = document.createElement('span');
    tag.className = 'telemetry-log__tag';
    tag.textContent = entry.tag;

    const msg = document.createElement('span');
    msg.className = 'telemetry-log__msg';
    msg.textContent = entry.message;

    row.appendChild(time);
    row.appendChild(tag);
    row.appendChild(msg);
    return row;
  }

  function appendLogRow(entry) {
    if (!els.log) return;
    els.log.appendChild(buildLogRow(entry));
    els.log.scrollTop = els.log.scrollHeight;
  }

  function renderFullLog() {
    if (!els.log) return;
    els.log.innerHTML = '';
    if (logEntries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'telemetry-log__empty';
      empty.textContent = 'Belum ada event — jalankan simulasi (START ENGINE) untuk mulai mencatat.';
      els.log.appendChild(empty);
      return;
    }
    logEntries.forEach((entry) => els.log.appendChild(buildLogRow(entry)));
    els.log.scrollTop = els.log.scrollHeight;
  }

  function clearLog() {
    logEntries = [];
    if (isOpen) renderFullLog();
    if (typeof UIController !== 'undefined' && UIController.logLine) {
      UIController.logLine('TELEMETRY PANEL — event log dibersihkan.');
    }
  }

  // ---- Edge detection (runs every frame, panel open or not) ---------------
  function detectEvents(state) {
    if (!primed) {
      // First frame ever seen: just capture a baseline, don't fire
      // ENGINE START/STOP off of whatever state the page happened to
      // boot into.
      prevEngineOn = state.engineOn;
      prevGearShiftEventId = state.gearShiftEventId;
      prevGearLabel = state.gear;
      prevInRedline = state.inRedline;
      prevRevLimiting = state.revLimiting;
      prevOverheat = state.engineOn && state.engineTempC >= OVERHEAT_TEMP_C;
      prevAtTopSpeed = false;
      primed = true;
      return;
    }

    // ENGINE START / ENGINE STOP — edge on state.engineOn itself, so it
    // fires no matter which button/panel actually triggered it (cockpit
    // START ENGINE, PERFORMANCE MODE START, ACCELERATION MODE LAUNCH).
    if (state.engineOn && !prevEngineOn) {
      pushEvent('start', `Mesin menyala — idle ${Math.round(state.rpm)} RPM.`);
      // A fresh engine start is a clean slate for every other edge.
      prevInRedline = false;
      prevRevLimiting = false;
      prevOverheat = false;
      prevAtTopSpeed = false;
    } else if (!state.engineOn && prevEngineOn) {
      pushEvent('stop', 'Mesin dimatikan.');
      prevInRedline = false;
      prevRevLimiting = false;
      prevOverheat = false;
      prevAtTopSpeed = false;
    }

    // GEAR SHIFT — edge on the shift-event counter EngineState already
    // increments once per real gear-to-gear shift (see signalShiftEvent()
    // in engine-state.js), so N→1st launch engagement is correctly
    // excluded, same as the shift-sound trigger it was built for.
    if (state.gearShiftEventId !== prevGearShiftEventId) {
      pushEvent('shift', `${prevGearLabel} → ${state.gear} @ ${Math.round(state.rpm)} RPM.`);
      prevGearShiftEventId = state.gearShiftEventId;
    }
    prevGearLabel = state.gear;

    // REDLINE — edge on entering the redline zone (not re-fired every
    // frame while RPM stays up there).
    if (state.inRedline && !prevInRedline) {
      pushEvent('redline', `RPM memasuki zona redline (${Math.round(state.rpm)} RPM).`);
    }
    prevInRedline = state.inRedline;

    // LIMITER — edge on the fuel-cut actually engaging. A held-WOT rev
    // bounce can fire this more than once in quick succession, which is
    // correct — that IS the real limiter bouncing on/off, not log spam.
    if (state.revLimiting && !prevRevLimiting) {
      pushEvent('limiter', `Rev limiter aktif — fuel cut @ ${Math.round(state.rpm)} RPM.`);
    }
    prevRevLimiting = state.revLimiting;

    // OVERHEAT — edge on engine temp crossing the threshold while running.
    const isOverheat = state.engineOn && state.engineTempC >= OVERHEAT_TEMP_C;
    if (isOverheat && !prevOverheat) {
      pushEvent('overheat', `Suhu mesin ${Math.round(state.engineTempC)}°C — melewati ambang aman.`);
    }
    prevOverheat = isOverheat;

    // TOP SPEED — edge on the displayed speed reaching the current Top
    // Speed governor (VEHICLE SETUP), the same hard cap deriveFromFrame()
    // clamps targetSpeedKmh to.
    const atCap = state.engineOn
      && state.maxSpeedKmh > 0
      && state.speedKmh >= state.maxSpeedKmh - TOP_SPEED_EPSILON_KMH;
    if (atCap && !prevAtTopSpeed) {
      pushEvent('topspeed', `Top speed governor tercapai — ${Math.round(state.maxSpeedKmh)} KM/H.`);
    }
    prevAtTopSpeed = atCap;
  }

  function onFrame(state) {
    detectEvents(state);
    if (isOpen) renderReadouts(state);
  }

  // ---- Open / close --------------------------------------------------------
  function open() {
    if (!els.overlay) return;
    isOpen = true;
    els.overlay.dataset.open = 'true';
    els.overlay.setAttribute('aria-hidden', 'false');
    renderReadouts(EngineState.getState());
    renderFullLog();
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
    if (els.clearLogBtn) els.clearLogBtn.addEventListener('click', clearLog);
    if (els.overlay) {
      els.overlay.addEventListener('click', (e) => {
        if (e.target === els.overlay) close();
      });
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) close();
    });
  }

  function init() {
    cacheEls();
    bindPanel();
    EngineState.subscribe(onFrame);
  }

  return { init, open, close };
})();
