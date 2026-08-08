/**
 * REVLAB — main.js
 * -----------------------------------------------------------------------
 * Entry point. Boots the gauge face, starts the real RPM simulation loop
 * (RPMSimulator, requestAnimationFrame-based), and connects everything
 * to the DOM via UIController. RPM is now a genuine physics simulation
 * (inertia, accel/decel rates, rev limiter) — not a snapshot formula and
 * not random. Throttle can be driven by the slider, keyboard (W /
 * ArrowUp), the desktop throttle button, or the mobile pedal — all via
 * ThrottleController, which UIController wires up. AudioEngine remains
 * a documented stub.
 * -----------------------------------------------------------------------
 */

document.addEventListener('DOMContentLoaded', () => {
  const gauge = Gauge.init();
  EngineState.init();
  UIController.init(gauge);

  // AudioEngine is intentionally left untouched here — its init()/start()
  // stubs are only meant to be called once a real Web Audio API
  // implementation exists in a later stage.
  console.info('[REVLAB] Cockpit UI loaded. RPMSimulator running (rAF loop, deterministic physics).');
  console.info('[RPMSimulator] current state:', RPMSimulator.getState());
  console.info('[AudioEngine] current state:', AudioEngine.getState());
});
