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
 * -----------------------------------------------------------------------
 */

document.addEventListener('DOMContentLoaded', () => {
  const gauge = Gauge.init();
  // EngineState's maxSpeedKmh/KMH_PER_MPH are static exports (available
  // as soon as the module's IIFE has run, no EngineState.init() needed
  // yet) — SpeedGauge just needs them to know its dial's top-speed scale.
  const speedGauge = SpeedGauge.init({
    maxSpeedKmh: EngineState.maxSpeedKmh,
    kmhPerMph: EngineState.KMH_PER_MPH,
  });
  EngineState.init();
  UIController.init(gauge, speedGauge);

  console.info('[REVLAB] Cockpit UI loaded. RPMSimulator running (rAF loop, deterministic physics).');
  console.info('[RPMSimulator] current state:', RPMSimulator.getState());
  console.info('[AudioEngine] current state:', AudioEngine.getState());
});
