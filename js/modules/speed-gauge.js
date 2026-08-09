/**
 * REVLAB — speed-gauge.js
 * -----------------------------------------------------------------------
 * Renders the radial SPEED gauge (ticks, warning/red zone arc, needle
 * position) — the main/hero instrument now (see index.html: this SVG
 * lives in .panel--gauge, the tachometer moved to a secondary compact
 * widget). Structurally this mirrors gauge.js (same polar-coordinate
 * tick/arc math, same needle-rotation approach) but is driven by SPEED,
 * not RPM, and additionally understands KM/H vs MPH so its tick labels
 * can be relabeled on unit toggle without moving the needle.
 *
 * Needle position is unit-INVARIANT: the fraction (currentSpeed / maxSpeed)
 * is identical whether both numbers are in km/h or both in mph, since
 * unit conversion is linear. So toggling units only ever re-renders tick
 * LABELS (buildTicks) — the needle angle math (angleForFraction) never
 * needs to know which unit is active.
 *
 * This module does NOT read EngineState directly and does NOT own any
 * timer — like gauge.js, it only exposes a way to set the needle
 * fraction and current unit; ui-controller.js is what feeds it real
 * data from EngineState every frame.
 * -----------------------------------------------------------------------
 */

const SpeedGauge = (() => {
  const CENTER = { x: 150, y: 150 };
  const RADIUS_TICKS = 118;
  const RADIUS_LABELS = 96;

  // Same sweep as the RPM gauge so both instruments read consistently.
  const ANGLE_START = -130;
  const ANGLE_END = 130;
  const TICK_COUNT = 6; // 0, 0.2, 0.4, 0.6, 0.8, 1.0 of max speed

  // Warning/red zone: last portion of the dial, same idea as the RPM
  // gauge's redline arc — "if diperlukan" (needed) because a top-speed
  // simulator without any visual ceiling cue reads as if there's no
  // limit at all. Starts at 85% of max speed.
  const WARN_ZONE_START_FRACTION = 0.85;

  let maxSpeedKmh = 260;
  let kmhPerMph = 1.609344;
  let unit = 'kmh'; // 'kmh' | 'mph'

  let ticksGroupEl = null;
  let warnArcEl = null;
  let needleGroupEl = null;

  function polarToXY(cx, cy, r, angleDeg) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return {
      x: cx + r * Math.cos(rad),
      y: cy + r * Math.sin(rad),
    };
  }

  function angleForFraction(fraction) {
    const t = Math.min(Math.max(fraction, 0), 1);
    return ANGLE_START + t * (ANGLE_END - ANGLE_START);
  }

  /** Max value of the dial IN THE CURRENTLY SELECTED UNIT — only used
   *  for computing tick LABEL text, never for the needle angle itself
   *  (see file header: fraction is unit-invariant). */
  function maxValueInUnit() {
    return unit === 'mph' ? maxSpeedKmh / kmhPerMph : maxSpeedKmh;
  }

  function formatTickLabel(fraction) {
    return String(Math.round(maxValueInUnit() * fraction));
  }

  function buildTicks() {
    if (!ticksGroupEl) return;
    ticksGroupEl.innerHTML = '';
    const ns = 'http://www.w3.org/2000/svg';

    for (let i = 0; i <= TICK_COUNT; i += 1) {
      const fraction = i / TICK_COUNT;
      const angle = angleForFraction(fraction);
      const outer = polarToXY(CENTER.x, CENTER.y, RADIUS_TICKS, angle);
      const inner = polarToXY(CENTER.x, CENTER.y, RADIUS_TICKS - 16, angle);

      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', inner.x.toFixed(2));
      line.setAttribute('y1', inner.y.toFixed(2));
      line.setAttribute('x2', outer.x.toFixed(2));
      line.setAttribute('y2', outer.y.toFixed(2));
      line.setAttribute('class', 'gauge__tick gauge__tick--major');
      ticksGroupEl.appendChild(line);

      const labelPos = polarToXY(CENTER.x, CENTER.y, RADIUS_LABELS, angle);
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', labelPos.x.toFixed(2));
      text.setAttribute('y', (labelPos.y + 4).toFixed(2));
      text.setAttribute('class', 'gauge__tick-label');
      text.textContent = formatTickLabel(fraction);
      ticksGroupEl.appendChild(text);

      // Minor tick between majors (visual density only, no label).
      if (i < TICK_COUNT) {
        const midAngle = angleForFraction(fraction + 0.5 / TICK_COUNT);
        const mOuter = polarToXY(CENTER.x, CENTER.y, RADIUS_TICKS, midAngle);
        const mInner = polarToXY(CENTER.x, CENTER.y, RADIUS_TICKS - 8, midAngle);
        const mLine = document.createElementNS(ns, 'line');
        mLine.setAttribute('x1', mInner.x.toFixed(2));
        mLine.setAttribute('y1', mInner.y.toFixed(2));
        mLine.setAttribute('x2', mOuter.x.toFixed(2));
        mLine.setAttribute('y2', mOuter.y.toFixed(2));
        mLine.setAttribute('class', 'gauge__tick');
        ticksGroupEl.appendChild(mLine);
      }
    }
  }

  function buildWarnArc() {
    if (!warnArcEl) return;
    const startAngle = angleForFraction(WARN_ZONE_START_FRACTION);
    const endAngle = angleForFraction(1);
    const r = RADIUS_TICKS + 10;
    const start = polarToXY(CENTER.x, CENTER.y, r, startAngle);
    const end = polarToXY(CENTER.x, CENTER.y, r, endAngle);
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;

    const d = `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
    warnArcEl.setAttribute('d', d);
  }

  /**
   * Sets the needle position from a speed value (already in km/h — the
   * one internal unit EngineState works in) plus the vehicle's top
   * speed. Purely visual: does not imply anything is actually moving.
   */
  function setSpeedKmh(speedKmh) {
    if (!needleGroupEl) return;
    const fraction = maxSpeedKmh > 0 ? speedKmh / maxSpeedKmh : 0;
    const angle = angleForFraction(fraction);
    needleGroupEl.style.transform = `rotate(${angle.toFixed(2)}deg)`;
    return fraction >= WARN_ZONE_START_FRACTION;
  }

  /** Switches which unit the tick LABELS are printed in. Needle angle is
   *  untouched (see file header) — only buildTicks() re-runs. */
  function setUnit(nextUnit) {
    if (nextUnit !== 'kmh' && nextUnit !== 'mph') return;
    unit = nextUnit;
    buildTicks();
  }

  function init(config = {}) {
    ticksGroupEl = document.getElementById('speedGaugeTicks');
    warnArcEl = document.getElementById('speedGaugeWarnArc');
    needleGroupEl = document.getElementById('speedGaugeNeedle');

    if (!ticksGroupEl || !warnArcEl || !needleGroupEl) return null;

    maxSpeedKmh = config.maxSpeedKmh || maxSpeedKmh;
    kmhPerMph = config.kmhPerMph || kmhPerMph;

    buildTicks();
    buildWarnArc();
    setSpeedKmh(0);

    return {
      setSpeedKmh,
      setUnit,
      maxSpeedKmh,
      warnZoneStartFraction: WARN_ZONE_START_FRACTION,
    };
  }

  return { init };
})();
