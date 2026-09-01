// script.js - the browser side of the whiteboard
//
// coordinates are stored and transmitted as PROPORTIONS of the canvas (0-1
// on each axis), not raw pixels - two people with different window sizes or
// screen sizes would otherwise see each other's drawings in the wrong place,
// or partly off their own board entirely. pixel positions only exist at the
// moment something is actually drawn to this browser's own canvas.

const MARKER_COLORS = ['#2b2b2e', '#e0483e', '#2f6fed', '#2f9e5c', '#ef8a2c', '#8b5cf6'];

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const cursorLayer = document.getElementById('cursorLayer');
const connectionBanner = document.getElementById('connectionBanner');
const presenceList = document.getElementById('presenceList');

let myId = null;
let isOwner = false;
let currentColor = MARKER_COLORS[0];
let currentWidth = 4;
let erasing = false;

// ===== canvas sizing =====
let strokeHistory = []; // finished strokes only, in normalised coordinates

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawAll();
}

function toPixels(point) {
  const rect = canvas.getBoundingClientRect();
  return { x: point.x * rect.width, y: point.y * rect.height };
}

function toNormalised(pixelPoint) {
  const rect = canvas.getBoundingClientRect();
  return { x: pixelPoint.x / rect.width, y: pixelPoint.y / rect.height };
}

function redrawAll() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  strokeHistory.forEach((s) => drawStroke(s, s.points));
}

window.addEventListener('resize', resizeCanvas);

// draws (a portion of) a stroke. `points` is passed separately from
// `stroke` so the same function can draw either a finished stroke's full
// point list, or just the newest couple of points of one still in progress.
// the eraser is real destination-out compositing, not a same-colour-as-
// the-background trick - that way it actually removes what's underneath,
// regardless of what colour the board happens to be.
function drawStroke(stroke, points) {
  if (!points || points.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = stroke.isEraser ? 'destination-out' : 'source-over';

  if (points.length === 1) {
    // a click with no drag still leaves a mark - the same way pressing a
    // real marker to a whiteboard without moving it leaves a dot. without
    // this, a plain click was stored in history but never actually visible,
    // since a line needs at least two points to draw at all.
    const p = toPixels(points[0]);
    ctx.fillStyle = stroke.isEraser ? 'rgba(0,0,0,1)' : stroke.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, stroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.strokeStyle = stroke.isEraser ? 'rgba(0,0,0,1)' : stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const first = toPixels(points[0]);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const p = toPixels(points[i]);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();
}

// ===== local drawing state =====
let isDrawing = false;
let activeStroke = null; // { id, color, width, isEraser, points: [normalised points] }
let lastSentPointIndex = 0;

// tracks whether the connection dropped at any point during the CURRENT
// stroke. if it did, the server has already cancelled whatever partial
// version of this stroke it saw (see the server's close handler) and its
// strokeId is now meaningless - a client that reconnects gets a brand new
// clientId, so there's no way to resume the old server-side record even if
// we wanted to. rather than trying, a stroke that was ever touched by a
// disconnect gets resent as one complete, self-contained stroke-complete
// message instead of continuing the live start/point/end protocol.
let strokeWentOffline = false;

function uniqueStrokeId() {
  return `${myId || 'anon'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  const point = e.touches ? e.touches[0] : e;
  return toNormalised({ x: point.clientX - rect.left, y: point.clientY - rect.top });
}

// used only for the live per-point protocol (stroke-start/point/end).
// deliberately does NOT queue while offline, unlike send() below - a
// fragment of the live protocol is meaningless without its start already
// having reached the server, so there's nothing useful to queue and replay
// later. see endStroke() for what happens instead.
function sendLive(data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function startStroke(e) {
  isDrawing = true;
  const pos = pointerPos(e);
  activeStroke = {
    id: uniqueStrokeId(),
    color: currentColor,
    width: erasing ? currentWidth * 4 : currentWidth,
    isEraser: erasing,
    points: [pos],
  };
  lastSentPointIndex = 0;

  const isOnlineNow = socket && socket.readyState === WebSocket.OPEN;
  strokeWentOffline = !isOnlineNow;

  if (isOnlineNow) {
    sendLive({ type: 'stroke-start', strokeId: activeStroke.id, color: activeStroke.color, width: activeStroke.width, isEraser: activeStroke.isEraser, point: pos });
  }
  // draw the initial point immediately, so a plain click shows its dot
  // right away rather than waiting for mouseup
  drawStroke(activeStroke, activeStroke.points);
}

// sending every single point as its own message would work, but throttling
// keeps the message rate sane on a fast mouse without making the line look
// segmented - points still accumulate locally every frame for a smooth
// local line, just not every one is transmitted individually
let lastPointSend = 0;
const POINT_SEND_INTERVAL = 35; // ms

function extendStroke(e) {
  if (!isDrawing) return;
  const pos = pointerPos(e);
  activeStroke.points.push(pos);
  drawStroke(activeStroke, activeStroke.points.slice(-2));

  if (strokeWentOffline) return; // no point sending live fragments now - see startStroke

  const now = performance.now();
  if (now - lastPointSend >= POINT_SEND_INTERVAL) {
    lastPointSend = now;
    sendLive({ type: 'stroke-point', strokeId: activeStroke.id, point: pos });
    lastSentPointIndex = activeStroke.points.length - 1;
  }
}

function endStroke() {
  if (!isDrawing) return;
  isDrawing = false;

  if (activeStroke.points.length === 0) {
    activeStroke = null;
    return;
  }

  if (strokeWentOffline) {
    // this stroke was interrupted by a disconnect (or started while
    // already offline). the server never has a complete, valid version of
    // it under its old strokeId - so send the whole thing fresh, as one
    // self-contained message, rather than trying to finish the old one
    strokeHistory.push(activeStroke);
    send({
      type: 'stroke-complete',
      stroke: { color: activeStroke.color, width: activeStroke.width, isEraser: activeStroke.isEraser, points: activeStroke.points },
    });
  } else {
    const finalPoint = activeStroke.points[activeStroke.points.length - 1];
    if (lastSentPointIndex !== activeStroke.points.length - 1) {
      sendLive({ type: 'stroke-point', strokeId: activeStroke.id, point: finalPoint });
    }
    sendLive({ type: 'stroke-end', strokeId: activeStroke.id });
    strokeHistory.push(activeStroke);
  }

  activeStroke = null;
}

canvas.addEventListener('mousedown', startStroke);
canvas.addEventListener('mousemove', extendStroke);
window.addEventListener('mouseup', endStroke);

canvas.addEventListener('touchstart', (e) => { e.preventDefault(); startStroke(e); }, { passive: false });
canvas.addEventListener('touchmove', (e) => { e.preventDefault(); extendStroke(e); }, { passive: false });
canvas.addEventListener('touchend', endStroke);

// live cursor position, throttled the same way stroke points are. uses
// sendLive rather than send - there's no value in queueing a backlog of
// stale mouse positions while offline and dumping them all on reconnect
let lastCursorSend = 0;
canvas.addEventListener('mousemove', (e) => {
  const now = performance.now();
  if (now - lastCursorSend < 40) return;
  lastCursorSend = now;
  sendLive({ type: 'cursor', point: pointerPos(e) });
});

// ===== toolbar =====
const colorRow = document.getElementById('colorRow');
MARKER_COLORS.forEach((color, i) => {
  const swatch = document.createElement('button');
  swatch.className = 'marker-swatch' + (i === 0 ? ' selected' : '');
  swatch.style.background = color;
  swatch.setAttribute('aria-label', `Select marker colour ${color}`);
  swatch.addEventListener('click', () => {
    currentColor = color;
    erasing = false;
    document.getElementById('eraserBtn').setAttribute('aria-pressed', 'false');
    document.querySelectorAll('.marker-swatch').forEach((s) => s.classList.remove('selected'));
    swatch.classList.add('selected');
  });
  colorRow.appendChild(swatch);
});

document.getElementById('widthSlider').addEventListener('input', (e) => {
  currentWidth = Number(e.target.value);
});

const eraserBtn = document.getElementById('eraserBtn');
eraserBtn.addEventListener('click', () => {
  erasing = !erasing;
  eraserBtn.setAttribute('aria-pressed', String(erasing));
});

const clearBtn = document.getElementById('clearBtn');
clearBtn.addEventListener('click', () => {
  if (!isOwner) {
    alert('only the room owner can clear the board for everyone');
    return;
  }
  if (!confirm('Clear the board for everyone?')) return;
  strokeHistory = [];
  redrawAll();
  send({ type: 'clear' });
});

function updateOwnerUI() {
  clearBtn.style.opacity = isOwner ? '1' : '0.5';
  clearBtn.title = isOwner ? '' : 'only the room owner can clear the board';
}

// ===== remote cursors =====
const remoteCursorEls = new Map();

function updateRemoteCursor(data) {
  let el = remoteCursorEls.get(data.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'remote-cursor';
    el.innerHTML = `<span class="dot" style="background:${data.color}"></span><span class="tag" style="background:${data.color}">${data.name}</span>`;
    cursorLayer.appendChild(el);
    remoteCursorEls.set(data.id, el);
  }
  const rect = canvas.getBoundingClientRect();
  const px = toPixels(data.point);
  el.style.left = `${px.x}px`;
  el.style.top = `${px.y}px`;
}

function removeRemoteCursor(id) {
  const el = remoteCursorEls.get(id);
  if (el) {
    el.remove();
    remoteCursorEls.delete(id);
  }
}

// ===== presence list =====
function renderPresence(presence) {
  presenceList.innerHTML = '';
  presence.forEach((p) => {
    const dot = document.createElement('div');
    dot.className = 'presence-dot';
    dot.style.background = p.color;
    dot.title = p.name + (p.id === myId ? ' (you)' : '') + (p.isOwner ? ' - room owner' : '');
    dot.textContent = p.name.slice(0, 1);
    if (p.isOwner) dot.style.boxShadow = '0 0 0 2px gold';
    presenceList.appendChild(dot);
  });
}

// ===== remote in-progress strokes =====
// mirrors our own activeStroke, but one per remote client+strokeId, so
// several people can be mid-stroke at once without interfering
const remoteInProgress = new Map();

// ===== offline queue =====
// if the connection drops mid-drawing, send() below queues the message
// instead of silently losing it. on reconnect, the server sends a fresh
// (and possibly different) strokeHistory - flushOfflineQueue() replays
// whatever we drew in the meantime ON TOP of that fresh history, both
// locally (so it doesn't just vanish from our own screen) and to the
// server (so it isn't lost for everyone else either)
//
// this only ever holds fully self-contained messages now (stroke-complete,
// clear) - never fragments of the live start/point/end protocol, since
// those can't be usefully resumed after a reconnect issues a new clientId
// (see the big comment by strokeWentOffline above, and the server's close
// handler). that's what makes flushing this safe: every queued message can
// just be replayed and drawn exactly as it is, with nothing to reconstruct.
let offlineQueue = [];

function send(data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  } else {
    offlineQueue.push(data);
  }
}

function flushOfflineQueue() {
  if (offlineQueue.length === 0) return;
  const queued = offlineQueue;
  offlineQueue = [];

  queued.forEach((msg) => {
    if (msg.type === 'stroke-complete') {
      // draw it locally on top of the fresh history we just got from the
      // server, then forward it on so the rest of the room gets it too
      strokeHistory.push(msg.stroke);
      drawStroke(msg.stroke, msg.stroke.points);
    }
    socket.send(JSON.stringify(msg));
  });
}

// if the connection drops mid-stroke, finish it locally right away rather
// than leaving it hanging indefinitely. endStroke() checks strokeWentOffline
// and takes care of sending it as a stroke-complete once reconnected,
// instead of trying to continue the now-abandoned live sequence
function abandonActiveStrokeIfAny() {
  if (isDrawing) {
    strokeWentOffline = true;
    endStroke();
  }
}

// ===== websocket connection =====
let socket = null;

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${window.location.host}`);

  socket.addEventListener('open', () => {
    connectionBanner.textContent = 'connected';
    connectionBanner.classList.add('connected');
  });

  socket.addEventListener('close', () => {
    connectionBanner.textContent = 'reconnecting…';
    connectionBanner.classList.remove('connected');
    abandonActiveStrokeIfAny();
    setTimeout(connect, 1500);
  });

  socket.addEventListener('message', (event) => {
    // a malformed or unexpected message from the server shouldn't be able
    // to throw and break the whole page - anything unusual is just ignored
    try {
      handleServerMessage(JSON.parse(event.data));
    } catch (err) {
      console.warn('ignored malformed message from server:', err);
    }
  });
}

function handleServerMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'welcome') {
    myId = msg.you.id;
    currentColor = msg.you.color;
    isOwner = msg.ownerId === myId;
    document.querySelectorAll('.marker-swatch').forEach((s, i) => {
      s.classList.toggle('selected', MARKER_COLORS[i] === currentColor);
    });
    strokeHistory = Array.isArray(msg.strokeHistory) ? msg.strokeHistory : [];
    redrawAll();
    renderPresence(msg.presence || []);
    updateOwnerUI();
    flushOfflineQueue();

  } else if (msg.type === 'stroke-start') {
    remoteInProgress.set(`${msg.id}:${msg.strokeId}`, {
      color: msg.color, width: msg.width, isEraser: msg.isEraser, points: [msg.point],
    });
    // draw the initial point immediately, so a plain click from someone
    // else shows up right away rather than waiting on a stroke-point that
    // might never come (a click with no drag never sends one)
    drawStroke({ color: msg.color, width: msg.width, isEraser: msg.isEraser }, [msg.point]);

  } else if (msg.type === 'stroke-point') {
    const key = `${msg.id}:${msg.strokeId}`;
    const stroke = remoteInProgress.get(key);
    if (!stroke) return;
    stroke.points.push(msg.point);
    drawStroke(stroke, stroke.points.slice(-2));

  } else if (msg.type === 'stroke-end') {
    const key = `${msg.id}:${msg.strokeId}`;
    const stroke = remoteInProgress.get(key);
    if (stroke) {
      strokeHistory.push(stroke);
      remoteInProgress.delete(key);
    }

  } else if (msg.type === 'stroke-cancel') {
    // the person drawing this stroke disconnected before finishing it - the
    // server has already discarded its record, so remove our own in-progress
    // copy and redraw from finished history only. otherwise everyone else in
    // the room would be left looking at a line that can never complete.
    const key = `${msg.id}:${msg.strokeId}`;
    if (remoteInProgress.has(key)) {
      remoteInProgress.delete(key);
      redrawAll();
    }

  } else if (msg.type === 'stroke-complete') {
    strokeHistory.push(msg.stroke);
    drawStroke(msg.stroke, msg.stroke.points);

  } else if (msg.type === 'cursor') {
    updateRemoteCursor(msg);

  } else if (msg.type === 'cursor-leave') {
    removeRemoteCursor(msg.id);

  } else if (msg.type === 'clear') {
    strokeHistory = [];
    redrawAll();

  } else if (msg.type === 'presence') {
    const me = (msg.presence || []).find((p) => p.id === myId);
    if (me) isOwner = me.isOwner;
    renderPresence(msg.presence || []);
    updateOwnerUI();

  } else if (msg.type === 'error') {
    console.warn('server rejected an action:', msg.message);
  }
}

resizeCanvas();
connect();
