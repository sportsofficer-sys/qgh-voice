(function exposeQghCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QGHCore = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function createQghCore() {
  const EPSILON = 1e-9;

  function normalize(angle) {
    return ((angle % 360) + 360) % 360;
  }

  function radians(angle) {
    return angle * Math.PI / 180;
  }

  function turnRadiusNm(speedKt, rateDegPerSecond) {
    const speed = Math.abs(Number(speedKt));
    const rateRadians = Math.abs(Number(rateDegPerSecond)) * Math.PI / 180;
    if (!Number.isFinite(speed) || !Number.isFinite(rateRadians) || rateRadians < EPSILON) {
      return Infinity;
    }
    return speed / 3600 / rateRadians;
  }

  function createOrbit(side, heading) {
    if (side !== 'left' && side !== 'right') throw new Error('Orbit direction must be left or right.');
    if (!Number.isFinite(heading)) throw new Error('Orbit entry heading must be finite.');
    return { side, entryHeading: normalize(heading), degrees: 0, laps: 0 };
  }

  function advanceOrbit(orbit, signedDelta) {
    if (!orbit || !['left', 'right'].includes(orbit.side) || !Number.isFinite(signedDelta)) {
      throw new Error('Orbit state and heading change must be valid.');
    }
    const progress = signedDelta * (orbit.side === 'left' ? -1 : 1);
    if (progress <= 0) return 0;
    orbit.degrees += progress;
    const laps = Math.floor((orbit.degrees + EPSILON) / 360);
    const completed = laps - orbit.laps;
    orbit.laps = laps;
    return completed;
  }

  function orbitAtEntry(orbit) {
    return Math.abs(orbit.degrees - Math.round(orbit.degrees / 360) * 360) <= EPSILON;
  }

  function resumeOrbit(orbit) {
    if (!orbit || !['left', 'right'].includes(orbit.side)) throw new Error('Orbit is not active.');
    orbit.exitRequested = true;
    return orbitAtEntry(orbit);
  }

  function advanceOrbitMotion(plane, speed, rate, duration, orbit) {
    if (!orbit || !['left', 'right'].includes(orbit.side)
      || ![speed, rate, duration].every(Number.isFinite) || speed < 0 || rate <= 0 || duration < 0) {
      throw new Error('Orbit motion needs a valid orbit, speed, positive turn rate and duration.');
    }
    const direction = orbit.side === 'left' ? -1 : 1;
    const remaining = orbit.exitRequested
      ? orbitAtEntry(orbit) ? 0 : 360 - normalize(orbit.degrees)
      : Infinity;
    const turnSeconds = Math.min(duration, remaining / rate);
    const turning = advanceArc(plane, plane.heading, speed, direction * rate, turnSeconds);
    const completedLaps = advanceOrbit(orbit, direction * rate * turnSeconds);
    const exited = Boolean(orbit.exitRequested && remaining <= rate * duration + EPSILON);
    if (!exited) return { ...turning, completedLaps, exited: false };
    // Complete the circle at the selected rate, then fly the remainder straight.
    // Spreading a smaller heading delta over the full step would change the radius.
    const straight = advanceArc(turning, orbit.entryHeading, speed, 0, Math.max(0, duration - turnSeconds));
    return { ...straight, distanceNm: turning.distanceNm + straight.distanceNm, completedLaps, exited: true };
  }

  function advanceArc(point, headingDeg, speedKt, signedRateDegPerSecond, durationSeconds) {
    const x = Number(point && point.x);
    const y = Number(point && point.y);
    const speed = Number(speedKt);
    const duration = Number(durationSeconds);
    const signedRate = Number(signedRateDegPerSecond);
    const rawHeading = Number(headingDeg);
    if (![x, y, speed, duration, signedRate, rawHeading].every(Number.isFinite)) {
      throw new Error('Arc inputs must be finite numbers.');
    }
    const heading = normalize(rawHeading);
    const distanceNm = speed * duration / 3600;
    const deltaDeg = signedRate * duration;
    const startRadians = radians(heading);

    if (Math.abs(deltaDeg) < EPSILON) {
      return {
        x: x + Math.sin(startRadians) * distanceNm,
        y: y - Math.cos(startRadians) * distanceNm,
        heading,
        distanceNm
      };
    }

    const deltaRadians = radians(deltaDeg);
    const endRadians = startRadians + deltaRadians;
    const scale = distanceNm / deltaRadians;

    return {
      x: x + scale * (Math.cos(startRadians) - Math.cos(endRadians)),
      y: y + scale * (Math.sin(startRadians) - Math.sin(endRadians)),
      heading: normalize(heading + deltaDeg),
      distanceNm
    };
  }

  function closestApproachToOverhead(start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared < EPSILON ? 0 : Math.max(0, Math.min(1, -(start.x * dx + start.y * dy) / lengthSquared));
    const x = start.x + dx * t;
    const y = start.y + dy * t;
    return { x, y, t, rangeNm: Math.hypot(x, y) };
  }

  return { normalize, radians, turnRadiusNm, advanceArc, closestApproachToOverhead,
    createOrbit, advanceOrbit, resumeOrbit, advanceOrbitMotion };
});
