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

  return { normalize, radians, turnRadiusNm, advanceArc, closestApproachToOverhead };
});
