(function initialiseReviewRenderer() {
  'use strict';

  const { normalize, radians } = window.QGHCore;

  function pointOnBearing(cx, cy, radius, bearing) {
    const angle = radians(bearing);
    return { x: cx + Math.sin(angle) * radius, y: cy - Math.cos(angle) * radius };
  }

  function labelAlignment(bearing) {
    const eastWest = Math.sin(radians(bearing));
    if (eastWest > .22) return 'left';
    if (eastWest < -.22) return 'right';
    return 'center';
  }

  function drawArrow(context, from, to, color, width) {
    const direction = Math.atan2(to.y - from.y, to.x - from.x);
    const head = 8;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = width;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.beginPath();
    context.moveTo(to.x, to.y);
    context.lineTo(to.x - Math.cos(direction - Math.PI / 7) * head, to.y - Math.sin(direction - Math.PI / 7) * head);
    context.lineTo(to.x - Math.cos(direction + Math.PI / 7) * head, to.y - Math.sin(direction + Math.PI / 7) * head);
    context.closePath();
    context.fill();
  }

  function drawCourseLabel(context, cx, cy, distance, bearing, lines, color) {
    const point = pointOnBearing(cx, cy, distance, bearing);
    context.fillStyle = color;
    context.font = '600 11px IBM Plex Sans, Arial';
    context.textAlign = labelAlignment(bearing);
    context.textBaseline = 'middle';
    lines.forEach((line, index) => context.fillText(line, point.x, point.y + index * 14));
  }

  function drawAircraft(context, x, y, heading) {
    context.save();
    context.translate(x, y);
    context.rotate(radians(heading));
    context.fillStyle = '#17262b';
    context.strokeStyle = '#fffefa';
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(0, -8);
    context.lineTo(5, 6);
    context.lineTo(0, 4);
    context.lineTo(-5, 6);
    context.closePath();
    context.fill();
    context.stroke();
    context.restore();
    context.strokeStyle = '#007d7d';
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(x, y, 10, 0, Math.PI * 2);
    context.stroke();
  }

  function trackColor(progress) {
    const start = [139, 158, 156];
    const end = [0, 125, 125];
    const ratio = Math.max(0, Math.min(1, progress));
    const channel = index => Math.round(start[index] + (end[index] - start[index]) * ratio);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
  }

  function drawFlightTrack(context, path, count, cx, cy, scale) {
    const visibleSegments = count - 1;
    if (visibleSegments < 1) return;
    const bands = Math.min(36, visibleSegments);
    const finalIndex = Math.max(1, path.length - 1);
    context.lineWidth = 3;
    context.lineJoin = 'round';
    context.lineCap = 'round';

    for (let band = 0; band < bands; band += 1) {
      const fromIndex = Math.floor(band * visibleSegments / bands);
      const toIndex = Math.max(fromIndex + 1, Math.floor((band + 1) * visibleSegments / bands));
      context.strokeStyle = trackColor(toIndex / finalIndex);
      context.beginPath();
      for (let index = fromIndex; index <= toIndex; index += 1) {
        const point = path[index];
        const x = cx + point.x * scale;
        const y = cy + point.y * scale;
        if (index === fromIndex) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }
  }

  function turnLabel(turn) {
    if (!turn) return 'NOT ESTABLISHED';
    return `${turn.side.toUpperCase()} ${Math.round(turn.degrees)}° · ${turn.way}`;
  }

  const viewport = {
    enabled: false,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    pointers: new Map(),
    dragStart: null,
    pinchStart: null,
    bound: false
  };

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function canvasSize(canvas) {
    const fallbackWidth = 900;
    const fallbackHeight = 720;
    const bounds = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
    const width = Math.max(280, Math.round(
      canvas.clientWidth || (bounds && bounds.width) || fallbackWidth
    ));
    const height = Math.max(240, Math.round(
      canvas.clientHeight || (bounds && bounds.height) || Math.round(width * .8) || fallbackHeight
    ));
    const pixelRatio = clamp(Number(window.devicePixelRatio) || 1, 1, 2);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    const context = canvas.getContext('2d');
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    return { context, width, height };
  }

  function applyViewport(canvas) {
    if (!canvas) return;
    canvas.style.transform = `translate(${viewport.offsetX}px, ${viewport.offsetY}px) scale(${viewport.zoom})`;
  }

  function pointerDistance(points) {
    const [first, second] = points;
    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  function bindViewport(canvas) {
    const plot = canvas && canvas.parentElement;
    if (!canvas || !plot || viewport.bound) return;
    viewport.bound = true;

    const updateDragStart = () => {
      const points = [...viewport.pointers.values()];
      if (points.length === 1) {
        viewport.dragStart = {
          x: points[0].x,
          y: points[0].y,
          offsetX: viewport.offsetX,
          offsetY: viewport.offsetY
        };
        viewport.pinchStart = null;
      } else if (points.length >= 2) {
        viewport.dragStart = null;
        viewport.pinchStart = { distance: pointerDistance(points), zoom: viewport.zoom };
      }
    };

    plot.addEventListener('wheel', event => {
      if (!viewport.enabled) return;
      event.preventDefault();
      viewport.zoom = clamp(viewport.zoom + (event.deltaY < 0 ? .14 : -.14), 1, 4);
      applyViewport(canvas);
    }, { passive: false });

    plot.addEventListener('pointerdown', event => {
      if (!viewport.enabled) return;
      event.preventDefault();
      viewport.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (typeof plot.setPointerCapture === 'function') plot.setPointerCapture(event.pointerId);
      plot.classList.add('is-panning');
      updateDragStart();
    });

    plot.addEventListener('pointermove', event => {
      if (!viewport.enabled || !viewport.pointers.has(event.pointerId)) return;
      event.preventDefault();
      viewport.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = [...viewport.pointers.values()];
      if (points.length === 1 && viewport.dragStart) {
        viewport.offsetX = viewport.dragStart.offsetX + points[0].x - viewport.dragStart.x;
        viewport.offsetY = viewport.dragStart.offsetY + points[0].y - viewport.dragStart.y;
      } else if (points.length >= 2 && viewport.pinchStart) {
        viewport.zoom = clamp(viewport.pinchStart.zoom * (pointerDistance(points) / viewport.pinchStart.distance), 1, 4);
      }
      applyViewport(canvas);
    });

    const finishPointer = event => {
      if (!viewport.pointers.has(event.pointerId)) return;
      viewport.pointers.delete(event.pointerId);
      if (!viewport.pointers.size) plot.classList.remove('is-panning');
      updateDragStart();
    };
    plot.addEventListener('pointerup', finishPointer);
    plot.addEventListener('pointercancel', finishPointer);
    canvas.addEventListener('keydown', event => {
      if (!viewport.enabled) return;
      const step = 28;
      let handled = true;
      switch (event.key) {
        case '+':
        case '=':
          viewport.zoom = clamp(viewport.zoom + .14, 1, 4);
          break;
        case '-':
        case '_':
          viewport.zoom = clamp(viewport.zoom - .14, 1, 4);
          break;
        case 'ArrowLeft':
          viewport.offsetX -= step;
          break;
        case 'ArrowRight':
          viewport.offsetX += step;
          break;
        case 'ArrowUp':
          viewport.offsetY -= step;
          break;
        case 'ArrowDown':
          viewport.offsetY += step;
          break;
        case '0':
          fitViewport();
          break;
        default:
          handled = false;
      }
      if (!handled) return;
      event.preventDefault();
      if (event.key !== '0') applyViewport(canvas);
    });
  }

  function setZoomEnabled(enabled) {
    const canvas = document.getElementById('plot');
    const plot = canvas && canvas.parentElement;
    viewport.enabled = Boolean(enabled);
    if (!viewport.enabled) fitViewport();
    if (plot) plot.classList.toggle('zoom-enabled', viewport.enabled);
  }

  function fitViewport() {
    const canvas = document.getElementById('plot');
    const plot = canvas && canvas.parentElement;
    viewport.zoom = 1;
    viewport.offsetX = 0;
    viewport.offsetY = 0;
    viewport.pointers.clear();
    viewport.dragStart = null;
    viewport.pinchStart = null;
    if (plot) plot.classList.remove('is-panning');
    applyViewport(canvas);
  }

  function drawReview(model) {
    const canvas = document.getElementById('plot');
    if (!canvas || !model || !model.cfg || !model.path.length) return;

    bindViewport(canvas);
    const { context, width, height } = canvasSize(canvas);
    const count = Math.max(1, Math.min(model.count || model.path.length, model.path.length));
    const { cfg, path } = model;
    const cx = width / 2;
    const cy = height / 2;
    const maxRange = Math.max(35, Math.ceil((model.maxRange || cfg.distance) / 5) * 5);
    const scale = Math.min(width, height) * .47 / maxRange;
    const outerRadius = maxRange * scale * .95;
    const finalRadial = normalize(cfg.inbound + 180);

    context.clearRect(0, 0, width, height);
    context.fillStyle = '#fffefa';
    context.fillRect(0, 0, width, height);

    context.strokeStyle = '#d1d8d4';
    context.lineWidth = 1;
    for (let ring = 5; ring <= maxRange; ring += 5) {
      context.beginPath();
      context.arc(cx, cy, ring * scale, 0, Math.PI * 2);
      context.stroke();
      if (ring % 10 === 0) {
        context.fillStyle = '#617177';
        context.font = '11px IBM Plex Sans, Arial';
        context.textAlign = 'left';
        context.fillText(`${ring} NM`, cx + 7, cy - ring * scale + 14);
      }
    }

    const cardinals = [
      { bearing: 0, label: 'N · 000°' },
      { bearing: 90, label: 'E · 090°' },
      { bearing: 180, label: 'S · 180°' },
      { bearing: 270, label: 'W · 270°' }
    ];
    context.setLineDash([5, 8]);
    context.strokeStyle = '#d7dfdb';
    cardinals.forEach(cardinal => {
      const end = pointOnBearing(cx, cy, outerRadius, cardinal.bearing);
      context.beginPath();
      context.moveTo(cx, cy);
      context.lineTo(end.x, end.y);
      context.stroke();
      const label = pointOnBearing(cx, cy, outerRadius + 17, cardinal.bearing);
      context.fillStyle = '#6b7a7d';
      context.font = '600 10px IBM Plex Sans, Arial';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(cardinal.label, label.x, label.y);
    });
    context.setLineDash([]);

    const quadrants = [
      { bearing: 45, label: 'NE' },
      { bearing: 135, label: 'SE' },
      { bearing: 225, label: 'SW' },
      { bearing: 315, label: 'NW' }
    ];
    context.fillStyle = '#a0aaa8';
    context.font = '600 10px IBM Plex Sans, Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    quadrants.forEach(quadrant => {
      const position = pointOnBearing(cx, cy, outerRadius * .56, quadrant.bearing);
      context.fillText(quadrant.label, position.x, position.y);
    });

    const outboundStart = pointOnBearing(cx, cy, outerRadius * .14, cfg.outbound);
    const outboundEnd = pointOnBearing(cx, cy, outerRadius * .86, cfg.outbound);
    drawArrow(context, outboundStart, outboundEnd, '#2d7b79', 2);
    drawCourseLabel(context, cx, cy, outerRadius * .72, cfg.outbound, [
      `OUTBOUND ${String(Math.round(cfg.outbound)).padStart(3, '0')}°M`,
      'AWAY FROM VDF'
    ], '#286967');

    const inboundStart = pointOnBearing(cx, cy, outerRadius * .9, finalRadial);
    const inboundEnd = pointOnBearing(cx, cy, outerRadius * .17, finalRadial);
    drawArrow(context, inboundStart, inboundEnd, '#6b4b96', 2);
    drawCourseLabel(context, cx, cy, outerRadius * .74, finalRadial, [
      `FINAL / INBOUND ${String(Math.round(cfg.inbound)).padStart(3, '0')}°M`,
      `QDR ${String(Math.round(finalRadial)).padStart(3, '0')}°M · RADIAL FROM VDF`
    ], '#5b427f');

    context.save();
    context.translate(cx, cy);
    context.rotate(radians(cfg.runway));
    context.fillStyle = '#17262b';
    context.fillRect(-5, -36, 10, 72);
    context.fillStyle = '#fffefa';
    for (let y = -27; y < 28; y += 12) context.fillRect(-2, y, 4, 6);
    context.restore();
    context.fillStyle = '#52646a';
    context.font = '600 11px IBM Plex Sans, Arial';
    context.textAlign = 'left';
    context.fillText(`RWY ${String(Math.round(cfg.runway)).padStart(3, '0')}°M`, cx + 11, cy - 40);

    if (model.turns && (model.turns.overhead || model.turns.base)) {
      context.fillStyle = '#52646a';
      context.font = '600 10px IBM Plex Sans, Arial';
      context.textAlign = 'left';
      context.fillText(`OVERHEAD TURN · ${turnLabel(model.turns.overhead)}`, 22, 23);
      context.fillText(`BASE TURN · ${turnLabel(model.turns.base)}`, 22, 39);
    }

    drawFlightTrack(context, path, count, cx, cy, scale);

    const start = path[0];
    const current = path[count - 1];
    if (start) {
      context.fillStyle = '#16875f';
      context.beginPath();
      context.arc(cx + start.x * scale, cy + start.y * scale, 7, 0, Math.PI * 2);
      context.fill();
    }
    if (current) drawAircraft(context, cx + current.x * scale, cy + current.y * scale, current.heading);

    context.fillStyle = '#007d7d';
    context.font = '600 13px IBM Plex Sans, Arial';
    context.textAlign = 'center';
    context.fillText('VDF / OVERHEAD', cx, cy + 5);
  }

  window.QGHReview = {
    draw: drawReview,
    fit: fitViewport,
    setZoomEnabled
  };
})();
