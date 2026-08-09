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

document.addEventListener('DOMContentLoaded', () => {
  const gauge = Gauge.init();
  EngineState.init();
  VehicleSetup.init();

  const speedGauge = SpeedGauge.init({
    maxSpeedKmh: EngineState.getMaxSpeedKmh(),
    kmhPerMph: EngineState.KMH_PER_MPH,
  });

  UIController.init(gauge, speedGauge);
  PerformanceMode.init();

  console.info('[REVLAB] Cockpit UI loaded. RPMSimulator running (rAF loop, deterministic physics).');
  console.info('[VehicleSetup] current parameters:', VehicleSetup.getAll());
  console.info('[RPMSimulator] current state:', RPMSimulator.getState());
  console.info('[AudioEngine] current state:', AudioEngine.getState());
});
