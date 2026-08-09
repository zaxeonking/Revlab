/**
 * REVLAB — boost-gauge.js
 * -----------------------------------------------------------------------
 * Renders the radial BOOST gauge (ticks, boost-zone arc, needle) — same
 * construction as gauge.js (RPM tachometer) and speed-gauge.js
 * (speedometer): this module only draws the instrument and exposes a way
 * to set the needle position. It does NOT compute boost itself — that's
 * EngineState's turbo/boost model (js/modules/engine-state.js,
 * stepBoost()), read every frame via EngineState.subscribe() in
 * ui-controller.js, same as every other gauge in REVLAB.
 *
 * Scale is 0..maxBoostBar, where maxBoostBar comes from VEHICLE SETUP's
 * "MAX BOOST" field (js/modules/vehicle-setup.js) — reconfigure() below
 * rescales the dial face (ticks + boost-zone arc) whenever that changes,
 * the same guarded "only rebuild when the value actually changed" call
 * pattern ui-controller.js already uses for Gauge.reconfigure() /
 * SpeedGauge.reconfigure().
 * -----------------------------------------------------------------------
 */

const BoostGauge = (() => {
  const CENTER = { x: 150, y: 150 };
  const RADIUS_TICKS = 118;
  const RADIUS_LABELS = 96;

  // Same sweep as the other two gauges — one shared dial language.
  const ANGLE_START = -130;
  const ANGLE_END = 130;

  // Face scale — 0..MAX_BOOST_BAR. VEHICLE SETUP's "MAX BOOST" field
  // drives this via reconfigure(), same as RPM/speed gauges rescale off
  // their own VEHICLE SETUP fields.
  let MAX_BOOST_BAR = 1.4;
  // The "boost zone" (amber arc, like the RPM gauge's redline) starts at
  // this fraction of MAX_BOOST_BAR — a visual "you're making real boost
  // now" marker, not a hard limit.
  const BOOST_ZONE_START_FRACTION = 0.55;

  let ticksGroupEl = null;
  let zonePathEl = null;

  function polarToXY(cx, cy, r, angleDeg) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return {
      x: cx + r * Math.cos(rad),
      y: cy + r * Math.sin(rad),
    };
  }

  function angleForValue(valueBar) {
    const t = MAX_BOOST_BAR > 0 ? Math.min(Math.max(valueBar / MAX_BOOST_BAR, 0), 1) : 0;
    return ANGLE_START + t * (ANGLE_END - ANGLE_START);
  }

  /** Picks a "nice" tick step (in bar) so the face doesn't try to draw a
   *  tick for every 0.01 bar at small scales or a cramped mess at large
   *  ones — mirrors how a real boost gauge's face is silkscreened at a
   *  fixed set of round numbers regardless of the exact ceiling. */
  function tickStepFor(maxBar) {
    if (maxBar <= 1.0) return 0.2;
    if (maxBar <= 2.0) return 0.4;
    return 0.5;
  }

  function buildTicks(svgGroup) {
    svgGroup.innerHTML = '';
    const ns = 'http://www.w3.org/2000/svg';
    const step = tickStepFor(MAX_BOOST_BAR);

    for (let v = 0; v <= MAX_BOOST_BAR + 1e-9; v += step) {
      const angle = angleForValue(v);
      const outer = polarToXY(CENTER.x, CENTER.y, RADIUS_TICKS, angle);
      const inner = polarToXY(CENTER.x, CENTER.y, RADIUS_TICKS - 16, angle);

      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', inner.x.toFixed(2));
      line.setAttribute('y1', inner.y.toFixed(2));
      line.setAttribute('x2', outer.x.toFixed(2));
      line.setAttribute('y2', outer.y.toFixed(2));
      line.setAttribute('class', 'gauge__tick gauge__tick--major');
      svgGroup.appendChild(line);

      const labelPos = polarToXY(CENTER.x, CENTER.y, RADIUS_LABELS, angle);
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', labelPos.x.toFixed(2));
      text.setAttribute('y', (labelPos.y + 4).toFixed(2));
      text.setAttribute('class', 'gauge__tick-label');
      text.textContent = v.toFixed(1);
      svgGroup.appendChild(text);

      // Minor tick at the half-step, purely visual density.
      if (v + step <= MAX_BOOST_BAR + 1e-9) {
        const midAngle = angleForValue(v + step / 2);
        const mOuter = polarToXY(CENTER.x, CENTER.y, RADIUS_TICKS, midAngle);
        const mInner = polarToXY(CENTER.x, CENTER.y, RADIUS_TICKS - 8, midAngle);
        const mLine = document.createElementNS(ns, 'line');
        mLine.setAttribute('x1', mInner.x.toFixed(2));
        mLine.setAttribute('y1', mInner.y.toFixed(2));
        mLine.setAttribute('x2', mOuter.x.toFixed(2));
        mLine.setAttribute('y2', mOuter.y.toFixed(2));
        mLine.setAttribute('class', 'gauge__tick');
        svgGroup.appendChild(mLine);
      }
    }
  }

  function buildZoneArc(pathEl) {
    if (MAX_BOOST_BAR <= 0) {
      pathEl.setAttribute('d', '');
      return;
    }
    const startAngle = angleForValue(MAX_BOOST_BAR * BOOST_ZONE_START_FRACTION);
    const endAngle = angleForValue(MAX_BOOST_BAR);
    const r = RADIUS_TICKS + 10;
    const start = polarToXY(CENTER.x, CENTER.y, r, startAngle);
    const end = polarToXY(CENTER.x, CENTER.y, r, endAngle);
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;

    const d = `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
    pathEl.setAttribute('d', d);
  }

  /** Sets the needle to a given boost pressure (bar). Purely a
   *  visual/UI method — does not imply an engine is running. */
  function setNeedleValueBar(needleGroupEl, valueBar) {
    const angle = angleForValue(valueBar);
    needleGroupEl.style.transform = `rotate(${angle.toFixed(2)}deg)`;
  }

  /**
   * Rescales the dial face itself — rebuilds tick labels and the
   * boost-zone arc for a new MAX BOOST ceiling, leaving the needle's
   * current angle alone (the next setValueBar() call moves it). Called
   * from ui-controller.js whenever EngineState's live maxBoostBar
   * actually changes, guarded so it doesn't rebuild the SVG every
   * animation frame for nothing.
   */
  function reconfigure(maxBoostBar) {
    if (typeof maxBoostBar === 'number' && maxBoostBar >= 0) MAX_BOOST_BAR = maxBoostBar;
    if (ticksGroupEl) buildTicks(ticksGroupEl);
    if (zonePathEl) buildZoneArc(zonePathEl);
  }

  function init() {
    ticksGroupEl = document.getElementById('boostGaugeTicks');
    zonePathEl = document.getElementById('boostGaugeZone');
    const needleGroup = document.getElementById('boostGaugeNeedle');

    if (!ticksGroupEl || !zonePathEl || !needleGroup) return null;

    buildTicks(ticksGroupEl);
    buildZoneArc(zonePathEl);
    setNeedleValueBar(needleGroup, 0); // idle / off position

    return {
      setValueBar: (valueBar) => setNeedleValueBar(needleGroup, valueBar),
      reconfigure,
      get maxBoostBar() { return MAX_BOOST_BAR; },
    };
  }

  return { init };
})();
