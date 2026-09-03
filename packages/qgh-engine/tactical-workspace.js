(function initialiseTacticalReviewRenderer() {
  'use strict';

  const Core = window.QGHCore || {};
  const normalize = Core.normalize || (value => ((Number(value) % 360) + 360) % 360);
  const radians = Core.radians || (value => Number(value) * Math.PI / 180);

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

  function colourAt(color, progress) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(color || ''));
    if (!match) return '#007d7d';
    const source = match[1];
    const target = [
      parseInt(source.slice(0, 2), 16),
      parseInt(source.slice(2, 4), 16),
      parseInt(source.slice(4, 6), 16)
    ];
    const start = [218, 227, 224];
    const ratio = Math.max(0, Math.min(1, Number(progress) || 0));
    const channel = index => Math.round(start[index] + (target[index] - start[index]) * ratio);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
  }

  function lineDash(style) {
    if (style === 'dash') return [10, 7];
    if (style === 'dot') return [2, 6];
    if (style === 'dashdot') return [10, 5, 2, 5];
    return [];
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

  function drawAircraft(context, x, y, heading, color, callsign, focused) {
    context.save();
    context.translate(x, y);
    context.rotate(radians(heading));
    context.fillStyle = color;
    context.strokeStyle = '#fffefa';
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(0, -9);
    context.lineTo(5.5, 7);
    context.lineTo(0, 4.5);
    context.lineTo(-5.5, 7);
    context.closePath();
    context.fill();
    context.stroke();
    context.restore();

    context.strokeStyle = color;
    context.lineWidth = focused ? 2.5 : 1.5;
    context.beginPath();
    context.arc(x, y, focused ? 13 : 11, 0, Math.PI * 2);
    context.stroke();
    context.fillStyle = '#17262b';
    context.font = '600 10px IBM Plex Sans, Arial';
    context.textAlign = 'center';
    context.textBaseline = 'bottom';
    context.fillText(callsign, x, y - (focused ? 17 : 15));
  }

  function drawFormationCluster(context, x, y, heading, leader, wingmen, focused) {
    drawAircraft(
      context, x, y, heading, leader.color || '#007d7d', leader.callsign || leader.id || 'LEAD', focused
    );
    const offsets = [{ x: 12, y: 8 }, { x: -12, y: 8 }, { x: 0, y: 15 }];
    context.save();
    context.translate(x, y);
    context.rotate(radians(heading));
    wingmen.forEach((wingman, index) => {
      const offset = offsets[index % offsets.length];
      context.fillStyle = wingman.color || '#52646a';
      context.strokeStyle = '#fffefa';
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(offset.x, offset.y, 4.5, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    });
    context.restore();
  }

  function drawTrack(context, path, count, cx, cy, scale, aircraft, focusedId) {
    const visibleSegments = Math.max(0, count - 1);
    if (!visibleSegments) return;
    const bands = Math.min(40, visibleSegments);
    const finalIndex = Math.max(1, path.length - 1);
    context.save();
    const isFocused = Boolean(focusedId && aircraft.id === focusedId);
    context.globalAlpha = (aircraft.formationRole === 'FORMATION' ? .66 : 1) * (focusedId && !isFocused ? .42 : 1);
    context.lineWidth = isFocused ? 3.8 : 3;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.setLineDash(aircraft.formationRole === 'FORMATION' ? lineDash('dash') : lineDash(aircraft.lineStyle));

    for (let band = 0; band < bands; band += 1) {
      const fromIndex = Math.floor(band * visibleSegments / bands);
      const toIndex = Math.max(fromIndex + 1, Math.floor((band + 1) * visibleSegments / bands));
      context.strokeStyle = colourAt(aircraft.color, toIndex / finalIndex);
      context.beginPath();
      for (let index = fromIndex; index <= toIndex; index += 1) {
        const point = path[index];
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        const x = cx + point.x * scale;
        const y = cy + point.y * scale;
        if (index === fromIndex) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }
    context.setLineDash([]);
    context.restore();
  }

  function modelCount(model, aircraft) {
    const candidate = model.counts && model.counts[aircraft.id];
    const byCallsign = model.counts && model.counts[aircraft.callsign];
    const requested = candidate ?? byCallsign ?? model.count ?? aircraft.path.length;
    return Math.max(1, Math.min(Math.floor(Number(requested) || aircraft.path.length), aircraft.path.length));
  }

  function resolveCanvas(model) {
    if (model.canvas && typeof model.canvas.getContext === 'function') return model.canvas;
    const target = typeof model.canvas === 'string' ? model.canvas : (model.canvasId || 'tactical-plot');
    return document.getElementById(target) || document.getElementById('plot');
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

  function canvasSize(canvas, model) {
    const bounds = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
    const width = Math.max(280, Math.floor(
      model.width || canvas.clientWidth || (bounds && bounds.width) || 960
    ));
    const height = Math.max(240, Math.floor(
      model.height || canvas.clientHeight || (bounds && bounds.height) || Math.round(width * .8)
    ));
    const pixelRatio = clamp(Number(window.devicePixelRatio) || 1, 1, 2);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    const context = canvas.getContext('2d');
    if (context && typeof context.setTransform === 'function') {
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    }
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

    const resetGesture = () => {
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
      resetGesture();
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
      resetGesture();
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

  function fitViewport() {
    const canvas = document.getElementById('tTacticalPlot');
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

  function setZoomEnabled(enabled) {
    const canvas = document.getElementById('tTacticalPlot');
    const plot = canvas && canvas.parentElement;
    viewport.enabled = Boolean(enabled);
    if (!viewport.enabled) fitViewport();
    if (plot) plot.classList.toggle('zoom-enabled', viewport.enabled);
  }

  function draw(model) {
    if (!model || !model.cfg || !Array.isArray(model.aircraft) || !model.aircraft.length) return false;
    const canvas = resolveCanvas(model);
    if (!canvas || typeof canvas.getContext !== 'function') return false;
    bindViewport(canvas);
    const { context, width, height } = canvasSize(canvas, model);
    if (!context) return false;

    const aircraft = model.aircraft.filter(item => Array.isArray(item.path) && item.path.length);
    if (!aircraft.length) return false;

    const maxPointRange = aircraft.flatMap(item => item.path).reduce((maximum, point) => {
      return point && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? Math.max(maximum, Math.hypot(point.x, point.y))
        : maximum;
    }, 0);
    const maxRange = Math.max(35, Math.ceil(Math.max(Number(model.maxRange) || 0, maxPointRange) / 5) * 5);
    const cx = width / 2;
    const cy = height / 2;
    const scale = Math.min(width, height) * .47 / maxRange;
    const outerRadius = maxRange * scale * .95;
    const cfg = model.cfg;
    const finalRadial = normalize(Number(cfg.inbound) + 180);
    const focusedId = model.focusedId || model.activeId || null;

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
      { bearing: 0, label: 'N · 000°' }, { bearing: 90, label: 'E · 090°' },
      { bearing: 180, label: 'S · 180°' }, { bearing: 270, label: 'W · 270°' }
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

    [
      { bearing: 45, label: 'NE' }, { bearing: 135, label: 'SE' },
      { bearing: 225, label: 'SW' }, { bearing: 315, label: 'NW' }
    ].forEach(quadrant => {
      const label = pointOnBearing(cx, cy, outerRadius * .5, quadrant.bearing);
      context.fillStyle = '#a0adaa';
      context.font = '600 10px IBM Plex Sans, Arial';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(quadrant.label, label.x, label.y);
    });

    const outbound = normalize(Number(cfg.outbound));
    const outboundStart = pointOnBearing(cx, cy, outerRadius * .14, outbound);
    const outboundEnd = pointOnBearing(cx, cy, outerRadius * .86, outbound);
    drawArrow(context, outboundStart, outboundEnd, '#2d7b79', 2);
    drawCourseLabel(context, cx, cy, outerRadius * .72, outbound, [
      `OUTBOUND ${String(Math.round(outbound)).padStart(3, '0')}°M`, 'AWAY FROM VDF'
    ], '#286967');

    const inboundStart = pointOnBearing(cx, cy, outerRadius * .9, finalRadial);
    const inboundEnd = pointOnBearing(cx, cy, outerRadius * .17, finalRadial);
    drawArrow(context, inboundStart, inboundEnd, '#6b4b96', 2);
    drawCourseLabel(context, cx, cy, outerRadius * .74, finalRadial, [
      `FINAL / INBOUND ${String(Math.round(Number(cfg.inbound))).padStart(3, '0')}°M`,
      `QDR ${String(Math.round(finalRadial)).padStart(3, '0')}°M · RADIAL FROM VDF`
    ], '#5b427f');

    context.save();
    context.translate(cx, cy);
    context.rotate(radians(Number(cfg.runway) || 0));
    context.fillStyle = '#17262b';
    context.fillRect(-5, -36, 10, 72);
    context.fillStyle = '#fffefa';
    for (let y = -27; y < 28; y += 12) context.fillRect(-2, y, 4, 6);
    context.restore();
    context.fillStyle = '#52646a';
    context.font = '600 11px IBM Plex Sans, Arial';
    context.textAlign = 'left';
    context.fillText(`RWY ${String(Math.round(Number(cfg.runway) || 0)).padStart(3, '0')}°M`, cx + 11, cy - 40);

    const visibleAircraftList = Array.isArray(model.visibleIds)
      ? aircraft.filter(item => model.visibleIds.includes(item.id))
      : aircraft;

    visibleAircraftList.forEach(item => drawTrack(context, item.path, modelCount(model, item), cx, cy, scale, item, focusedId));

    const formationLeader = visibleAircraftList.find(item => item.formationRole === 'LEAD');
    const attachedWingmen = visibleAircraftList.filter(item => item.formationRole === 'FORMATION');

    visibleAircraftList.forEach(item => {
      const count = modelCount(model, item);
      const start = item.path[0];
      const current = item.path[count - 1];
      if (start && item.formationRole !== 'FORMATION') {
        context.fillStyle = item.color || '#007d7d';
        context.beginPath();
        context.arc(cx + start.x * scale, cy + start.y * scale, 6, 0, Math.PI * 2);
        context.fill();
      }
      if (current && item.formationRole !== 'FORMATION' && !(item.formationRole === 'LEAD' && attachedWingmen.length)) drawAircraft(
        context, cx + current.x * scale, cy + current.y * scale, current.heading || 0,
        item.color || '#007d7d', item.callsign || item.id || 'AIRCRAFT', focusedId === item.id
      );
    });

    if (formationLeader && attachedWingmen.length) {
      const count = modelCount(model, formationLeader);
      const current = formationLeader.path[count - 1];
      if (current) drawFormationCluster(
        context, cx + current.x * scale, cy + current.y * scale, current.heading || 0,
        formationLeader, attachedWingmen, focusedId === formationLeader.id
      );
    }

    const visibleAircraft = visibleAircraftList.length;
    const focused = visibleAircraftList.find(item => item.id === focusedId);
    context.fillStyle = '#52646a';
    context.font = '600 10px IBM Plex Sans, Arial';
    context.textAlign = 'left';
    context.fillText(`VISIBLE ${visibleAircraft}/${aircraft.length}`, 22, 24);
    if (focused) {
      context.fillStyle = focused.color || '#007d7d';
      context.fillText(`FOCUS · ${focused.callsign || focused.id}`, 22, 40);
    }

    context.fillStyle = '#007d7d';
    context.font = '600 13px IBM Plex Sans, Arial';
    context.textAlign = 'center';
    context.fillText('VDF / OVERHEAD', cx, cy + 5);
    return true;
  }

  window.QGHTacticalReview = {
    draw,
    fit: fitViewport,
    setZoomEnabled
  };
})();
