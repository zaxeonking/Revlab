/**
 * REVLAB — gauge.js
 * -----------------------------------------------------------------------
 * Renders the radial RPM tachometer (ticks, redline arc, needle position).
 * This module only draws the instrument and exposes a way to set the
 * needle angle. It does NOT generate or read any real RPM value — that
 * will come from the audio/simulation engine in a later stage.
 * -----------------------------------------------------------------------
 */

const Gauge = (() => {
  const CENTER = { x: 150, y: 150 };
  const RADIUS_TICKS = 118;
  const RADIUS_LABELS = 96;

  // Gauge sweeps from -130deg to +130deg (0 at bottom-left, max at bottom-right)
  const ANGLE_START = -130;
  const ANGLE_END = 130;
  const MAX_RPM_K = 9; // gauge face goes 0..9 (x1000 RPM) — placeholder scale
  const REDLINE_START_K = 7.5;

  function polarToXY(cx, cy, r, angleDeg) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return {
      x: cx + r * Math.cos(rad),
      y: cy + r * Math.sin(rad),
    };
  }

  function angleForValue(valueK) {
    const t = Math.min(Math.max(valueK / MAX_RPM_K, 0), 1);
    return ANGLE_START + t * (ANGLE_END - ANGLE_START);
  }

  function buildTicks(svgGroup) {
    svgGroup.innerHTML = '';
    const ns = 'http://www.w3.org/2000/svg';

    for (let k = 0; k <= MAX_RPM_K; k += 1) {
      const isMajor = true; // every integer is a major tick on this simple face
      const angle = angleForValue(k);
      const outer = polarToXY(CENTER.x, CENTER.y, RADIUS_TICKS, angle);
      const inner = polarToXY(CENTER.x, CENTER.y, RADIUS_TICKS - (isMajor ? 16 : 8), angle);

      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', inner.x.toFixed(2));
      line.setAttribute('y1', inner.y.toFixed(2));
      line.setAttribute('x2', outer.x.toFixed(2));
      line.setAttribute('y2', outer.y.toFixed(2));
      line.setAttribute('class', isMajor ? 'gauge__tick gauge__tick--major' : 'gauge__tick');
      svgGroup.appendChild(line);

      const labelPos = polarToXY(CENTER.x, CENTER.y, RADIUS_LABELS, angle);
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', labelPos.x.toFixed(2));
      text.setAttribute('y', (labelPos.y + 4).toFixed(2));
      text.setAttribute('class', 'gauge__tick-label');
      text.textContent = String(k);
      svgGroup.appendChild(text);

      // Minor tick between major ticks (visual density only, not a real reading)
      if (k < MAX_RPM_K) {
        const midAngle = angleForValue(k + 0.5);
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

  function buildRedlineArc(pathEl) {
    const startAngle = angleForValue(REDLINE_START_K);
    const endAngle = angleForValue(MAX_RPM_K);
    const r = RADIUS_TICKS + 10;
    const start = polarToXY(CENTER.x, CENTER.y, r, startAngle);
    const end = polarToXY(CENTER.x, CENTER.y, r, endAngle);
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;

    const d = `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
    pathEl.setAttribute('d', d);
  }

  /**
   * Sets the needle to a given RPM (in thousands, e.g. 3.2 = 3200 RPM).
   * Purely a visual/UI method — does not imply an engine is running.
   */
  function setNeedleValueK(needleGroupEl, valueK) {
    const angle = angleForValue(valueK);
    needleGroupEl.style.transform = `rotate(${angle.toFixed(2)}deg)`;
  }

  function init() {
    const ticksGroup = document.getElementById('gaugeTicks');
    const redlinePath = document.getElementById('gaugeRedline');
    const needleGroup = document.getElementById('gaugeNeedle');

    if (!ticksGroup || !redlinePath || !needleGroup) return null;

    buildTicks(ticksGroup);
    buildRedlineArc(redlinePath);
    setNeedleValueK(needleGroup, 0); // idle / off position

    return {
      setValueK: (valueK) => setNeedleValueK(needleGroup, valueK),
      maxRpmK: MAX_RPM_K,
      redlineStartK: REDLINE_START_K,
    };
  }

  return { init };
})();
