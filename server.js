// server.js
//
// a small node server that does two jobs:
//   1. serves the static frontend files in /public
//   2. runs a websocket server that keeps every connected browser in sync
//
// the server is the source of truth and trusts nothing from clients without
// checking it first - see validateMessage() below. every incoming message
// is validated for type, size, numeric ranges, and rate before it's allowed
// to touch strokeHistory or get broadcast to anyone else.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ===== tunable limits - all validation below is built from these =====
const LIMITS = {
  MAX_MESSAGE_BYTES: 64 * 1024,       // rejects absurdly large single messages outright
  MAX_POINTS_PER_STROKE: 3000,        // caps how long a single stroke's point list can get
  MAX_STROKE_ID_LENGTH: 100,
  MIN_WIDTH: 1,
  MAX_WIDTH: 40,
  MAX_STROKES_IN_HISTORY: 500,        // oldest strokes are dropped once this is exceeded
  RATE_LIMIT_WINDOW_MS: 1000,
  RATE_LIMIT_MAX_MESSAGES: 60,        // generous for legitimate throttled drawing+cursor traffic
  RATE_LIMIT_STRIKES_BEFORE_KICK: 5,  // repeated violations disconnect the client, not just drop messages
};

const MARKER_COLORS = ['#2b2b2e', '#e0483e', '#2f6fed', '#2f9e5c', '#ef8a2c', '#8b5cf6'];
const ALLOWED_TYPES = new Set(['stroke-start', 'stroke-point', 'stroke-end', 'stroke-complete', 'cursor', 'clear']);

// ===== static file server =====
const MIME_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(PUBLIC_DIR, filePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, maxPayload: LIMITS.MAX_MESSAGE_BYTES });

// strokeHistory holds only FINISHED strokes (after a valid stroke-end). in-
// progress strokes live in `inProgressStrokes` below until they're finished,
// keyed by "clientId:strokeId" so two different clients can never collide
// even if they coincidentally generate the same strokeId.
let strokeHistory = [];
const inProgressStrokes = new Map();

// whoever's currently first in the connection order owns clear-board rights.
// there's no login system here, so "owner" just means "the earliest still-
// connected client" - simple, but stops any random visitor wiping the board.
let ownerId = null;

const ADJECTIVES = ['Quick', 'Curious', 'Bright', 'Calm', 'Bold', 'Gentle', 'Sharp', 'Lucky'];
const ANIMALS = ['Otter', 'Falcon', 'Fox', 'Heron', 'Lynx', 'Robin', 'Badger', 'Wren'];

function randomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${a} ${b}`;
}

let nextClientId = 1;
let colorIndex = 0;

function broadcast(data, exceptWs) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client !== exceptWs && client.readyState === client.OPEN) {
      client.send(payload);
    }
  });
}

function currentPresenceList() {
  return Array.from(wss.clients)
    .filter((c) => c.readyState === c.OPEN)
    .map((c) => ({ id: c.clientId, name: c.clientName, color: c.clientColor, isOwner: c.clientId === ownerId }));
}

function trimHistory() {
  if (strokeHistory.length > LIMITS.MAX_STROKES_IN_HISTORY) {
    strokeHistory = strokeHistory.slice(strokeHistory.length - LIMITS.MAX_STROKES_IN_HISTORY);
  }
}

// ===== validation =====
// every one of these returns true/false rather than throwing, so a bad
// message just gets quietly dropped instead of taking the server down
function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function isValidPoint(p) {
  // coordinates are normalised (0-1 proportions of canvas size, see the
  // client), with a small margin for float rounding right at the edges
  return (
    p && typeof p === 'object' &&
    isFiniteNumber(p.x) && isFiniteNumber(p.y) &&
    p.x >= -0.05 && p.x <= 1.05 &&
    p.y >= -0.05 && p.y <= 1.05
  );
}

function isValidWidth(w) {
  return isFiniteNumber(w) && w >= LIMITS.MIN_WIDTH && w <= LIMITS.MAX_WIDTH;
}

function isValidColor(c) {
  return typeof c === 'string' && MARKER_COLORS.includes(c);
}

function isValidStrokeId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= LIMITS.MAX_STROKE_ID_LENGTH;
}

// checks the parts of a message that are common across the stroke-* types,
// returns false (reject) if anything is off
function validateMessage(msg) {
  if (!msg || typeof msg !== 'object' || !ALLOWED_TYPES.has(msg.type)) return false;

  switch (msg.type) {
    case 'stroke-start':
      return isValidStrokeId(msg.strokeId) && isValidColor(msg.color) && isValidWidth(msg.width) &&
             typeof msg.isEraser === 'boolean' && isValidPoint(msg.point);
    case 'stroke-point':
      return isValidStrokeId(msg.strokeId) && isValidPoint(msg.point);
    case 'stroke-end':
      return isValidStrokeId(msg.strokeId);
    case 'stroke-complete': {
      // used only to replay strokes a client drew while briefly offline -
      // still needs every point in the stroke validated, and the whole
      // stroke capped at the same max length as a live one
      const s = msg.stroke;
      return s && isValidColor(s.color) && isValidWidth(s.width) && typeof s.isEraser === 'boolean' &&
             Array.isArray(s.points) && s.points.length >= 1 &&
             s.points.length <= LIMITS.MAX_POINTS_PER_STROKE &&
             s.points.every(isValidPoint);
    }
    case 'cursor':
      return isValidPoint(msg.point);
    case 'clear':
      return true;
    default:
      return false;
  }
}

wss.on('connection', (ws) => {
  ws.clientId = nextClientId++;
  ws.clientName = randomName();
  ws.clientColor = MARKER_COLORS[colorIndex % MARKER_COLORS.length];
  colorIndex++;
  ws.rateLimitTimestamps = [];
  ws.rateLimitStrikes = 0;

  // without this, an oversized message (which ws's own maxPayload option
  // correctly rejects by closing the connection) emits an 'error' event
  // that, left unhandled, crashes the entire node process - taking down
  // every other connected user along with the one bad actor. this was
  // caught by actually flooding the server during testing, not by
  // inspection - worth remembering as a lesson in itself
  ws.on('error', (err) => {
    console.warn(`connection ${ws.clientId} error (closed):`, err.message);
  });

  if (ownerId === null) ownerId = ws.clientId;

  ws.send(JSON.stringify({
    type: 'welcome',
    you: { id: ws.clientId, name: ws.clientName, color: ws.clientColor },
    strokeHistory,
    presence: currentPresenceList(),
    ownerId,
  }));

  broadcast({ type: 'presence', presence: currentPresenceList() }, ws);

  ws.on('message', (raw) => {
    // reject oversized messages outright - `maxPayload` on the server
    // already enforces this at the protocol level, but checking here too
    // means the limit is explicit and testable rather than relying on ws's
    // default close-the-connection behaviour alone
    if (raw.length > LIMITS.MAX_MESSAGE_BYTES) return;

    // simple sliding-window rate limit per connection. legitimate use
    // (throttled drawing + cursor updates) sits well under this; a client
    // spamming messages gets dropped, then disconnected if it keeps going
    const now = Date.now();
    ws.rateLimitTimestamps = ws.rateLimitTimestamps.filter((t) => now - t < LIMITS.RATE_LIMIT_WINDOW_MS);
    ws.rateLimitTimestamps.push(now);
    if (ws.rateLimitTimestamps.length > LIMITS.RATE_LIMIT_MAX_MESSAGES) {
      ws.rateLimitStrikes++;
      if (ws.rateLimitStrikes >= LIMITS.RATE_LIMIT_STRIKES_BEFORE_KICK) {
        ws.close(1008, 'rate limit exceeded');
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // not valid json - ignore rather than crash
    }

    if (!validateMessage(msg)) return;

    if (msg.type === 'stroke-start') {
      const key = `${ws.clientId}:${msg.strokeId}`;
      inProgressStrokes.set(key, {
        clientId: ws.clientId, strokeId: msg.strokeId,
        color: msg.color, width: msg.width, isEraser: msg.isEraser, points: [msg.point],
      });
      broadcast({ type: 'stroke-start', id: ws.clientId, strokeId: msg.strokeId, color: msg.color, width: msg.width, isEraser: msg.isEraser, point: msg.point }, ws);

    } else if (msg.type === 'stroke-point') {
      const key = `${ws.clientId}:${msg.strokeId}`;
      const stroke = inProgressStrokes.get(key);
      if (!stroke) return; // point for a stroke that was never (validly) started
      if (stroke.points.length >= LIMITS.MAX_POINTS_PER_STROKE) return; // silently cap, don't grow forever
      stroke.points.push(msg.point);
      broadcast({ type: 'stroke-point', id: ws.clientId, strokeId: msg.strokeId, point: msg.point }, ws);

    } else if (msg.type === 'stroke-end') {
      const key = `${ws.clientId}:${msg.strokeId}`;
      const stroke = inProgressStrokes.get(key);
      inProgressStrokes.delete(key);
      if (stroke && stroke.points.length >= 1) {
        strokeHistory.push(stroke);
        trimHistory();
      }
      broadcast({ type: 'stroke-end', id: ws.clientId, strokeId: msg.strokeId }, ws);

    } else if (msg.type === 'stroke-complete') {
      // backfilling a stroke that was drawn while this client was offline
      strokeHistory.push(msg.stroke);
      trimHistory();
      broadcast({ type: 'stroke-complete', stroke: msg.stroke }, ws);

    } else if (msg.type === 'cursor') {
      broadcast({ type: 'cursor', id: ws.clientId, name: ws.clientName, color: ws.clientColor, point: msg.point }, ws);

    } else if (msg.type === 'clear') {
      // only the room owner can wipe it for everyone
      if (ws.clientId !== ownerId) {
        ws.send(JSON.stringify({ type: 'error', message: 'only the room owner can clear the board' }));
        return;
      }
      strokeHistory = [];
      inProgressStrokes.clear();
      broadcast({ type: 'clear' }, ws);
    }
  });

  ws.on('close', () => {
    // clean up any strokes this client never finished. without this, a
    // dropped connection mid-stroke leaves a permanent, growing entry in
    // inProgressStrokes that nothing ever removes - and every other client
    // is left looking at a half-drawn line that can never complete, since
    // the strokeId is now orphaned: if this client reconnects, it gets a
    // brand new clientId, so a queued "finish this stroke" message could
    // never be matched back up to the abandoned one anyway. cancelling it
    // outright, rather than trying to preserve or resume it, is what makes
    // this correct - the reconnecting client instead resends the whole
    // completed line in one piece via stroke-complete (see script.js)
    for (const [key, stroke] of inProgressStrokes.entries()) {
      if (stroke.clientId === ws.clientId) {
        inProgressStrokes.delete(key);
        broadcast({ type: 'stroke-cancel', id: ws.clientId, strokeId: stroke.strokeId });
      }
    }

    if (ws.clientId === ownerId) {
      // hand ownership to whoever's still connected and has been here
      // longest, or clear it if the room's now empty
      const remaining = Array.from(wss.clients).filter((c) => c !== ws && c.readyState === c.OPEN);
      ownerId = remaining.length ? Math.min(...remaining.map((c) => c.clientId)) : null;
    }
    broadcast({ type: 'presence', presence: currentPresenceList() });
    broadcast({ type: 'cursor-leave', id: ws.clientId });
  });
});

server.listen(PORT, () => {
  console.log(`whiteboard running at http://localhost:${PORT}`);
  console.log('open that url in a couple of different browser tabs to see the collaboration in action');
});

module.exports = { server, wss, LIMITS, MARKER_COLORS };
