/**
 * REVLAB — main.js
 * -----------------------------------------------------------------------
 * Entry point. Boots the gauge face, starts the real RPM simulation loop
 * (RPMSimulator, requestAnimationFrame-based), and connects everything
 * to the DOM via UIController. RPM is now a genuine physics simulation
 * (inertia, accel/decel rates, rev limiter) — not a snapshot formula and
 * not random. Throttle can be driven by the slider, keyboard (W /
 * ArrowUp), the desktop throttle button, or the mobile pedal — all via
 * ThrottleController, which UIController wires up. AudioEngine is real
 * Web Audio API synthesis now (see audio-engine.js) — but its
 * AudioContext is deliberately NOT created here, since this runs before
 * any user gesture. UIController's Start Engine click handler is what
 * calls AudioEngine.init(), the first time the button is pressed.
 *
 * Boot order matters here: EngineState.init() first (starts the
 * RPMSimulator loop with its own built-in defaults), then
 * VehicleSetup.init() (formally applies VehicleSetup's parameter
 * defaults on top — a no-op in practice since the two sets of defaults
 * are kept identical, but from this point on VehicleSetup is the single
 * source of truth for every tunable in the VEHICLE SETUP panel), THEN
 * SpeedGauge.init() reads the now-authoritative top speed for its dial
 * scale, and finally UIController.init() builds the Vehicle Setup form
 * itself from VehicleSetup's param specs.
 * -----------------------------------------------------------------------
 */

/**
 * Hides the boot-time loading overlay (see index.html #appLoading).
 * Fades it out via its own CSS transition, then removes it from the
 * layout entirely once the fade finishes so it can never intercept a
 * stray tap/click or get announced to assistive tech again. Wrapped so
 * it degrades safely even if the node is missing for some reason.
 */
function hideLoadingOverlay() {
  const overlay = document.getElementById('appLoading');
  if (!overlay) return;
  overlay.classList.remove('is-visible');
  overlay.setAttribute('aria-hidden', 'true');
  window.setTimeout(() => {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }, 320); // matches --dur-med fade-out in components.css, plus a hair of margin
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    const gauge = Gauge.init();
    EngineState.init();
    VehicleSetup.init();

    const speedGauge = SpeedGauge.init({
      maxSpeedKmh: EngineState.getMaxSpeedKmh(),
      kmhPerMph: EngineState.KMH_PER_MPH,
    });

    const boostGauge = BoostGauge.init();

    UIController.init(gauge, speedGauge, boostGauge);
    PerformanceMode.init();
    AccelerationMode.init();
    TelemetryPanel.init();

    console.info('[REVLAB] Cockpit UI loaded. RPMSimulator running (rAF loop, deterministic physics).');
    console.info('[VehicleSetup] current parameters:', VehicleSetup.getAll());
    console.info('[RPMSimulator] current state:', RPMSimulator.getState());
    console.info('[AudioEngine] current state:', AudioEngine.getState());
    console.info('[SoundLab] current snapshot:', SoundLab.getSnapshot());
  } catch (err) {
    // Even if something above throws, the loading overlay must not be
    // left stuck on screen forever — surface the error and still reveal
    // whatever DOM state exists underneath.
    console.error('[REVLAB] Boot error:', err);
  } finally {
    // Wait one frame so the browser has actually painted the initialized
    // gauges/ticks before the overlay starts fading — avoids revealing a
    // single blank/unbuilt frame underneath the fade.
    requestAnimationFrame(() => requestAnimationFrame(hideLoadingOverlay));
  }
});
