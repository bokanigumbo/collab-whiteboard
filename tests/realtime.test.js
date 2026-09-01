// tests/realtime.test.js
//
// a small, dependency-free test runner (just node's built-in `assert` plus
// the `ws` client library already used elsewhere) that drives the actual
// server with real websocket connections - not mocks. run with `npm test`.

const assert = require('assert');
const WebSocket = require('ws');

process.env.PORT = 0; // let the os assign a free port, so tests never clash with anything else running

const { server, LIMITS } = require('../server.js');

let PORT;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function connectClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.messages = [];
    ws.on('message', (raw) => {
      try { ws.messages.push(JSON.parse(raw)); } catch { /* ignored on purpose in tests too */ }
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitFor(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      const found = ws.messages.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for a matching message. seen: ${JSON.stringify(ws.messages.map(m => m.type))}`));
      setTimeout(check, 15);
    })();
  });
}

function send(ws, msg) { ws.send(JSON.stringify(msg)); }

// ===== tests =====

test('stroke broadcasting: start/point/end all reach another client', async () => {
  const a = await connectClient();
  const b = await connectClient();
  await waitFor(a, (m) => m.type === 'welcome');
  await waitFor(b, (m) => m.type === 'welcome');

  const strokeId = 'test-stroke-1';
  send(a, { type: 'stroke-start', strokeId, color: '#2b2b2e', width: 4, isEraser: false, point: { x: 0.1, y: 0.1 } });
  send(a, { type: 'stroke-point', strokeId, point: { x: 0.2, y: 0.2 } });
  send(a, { type: 'stroke-end', strokeId });

  const start = await waitFor(b, (m) => m.type === 'stroke-start' && m.strokeId === strokeId);
  const point = await waitFor(b, (m) => m.type === 'stroke-point' && m.strokeId === strokeId);
  const end = await waitFor(b, (m) => m.type === 'stroke-end' && m.strokeId === strokeId);

  assert.strictEqual(start.color, '#2b2b2e');
  assert.strictEqual(point.point.x, 0.2);
  assert.strictEqual(end.strokeId, strokeId);

  a.close(); b.close();
});

test('sender exclusion: a client never receives its own broadcast stroke back', async () => {
  const a = await connectClient();
  await waitFor(a, (m) => m.type === 'welcome');
  const messagesBefore = a.messages.length;

  const strokeId = 'self-test-stroke';
  send(a, { type: 'stroke-start', strokeId, color: '#e0483e', width: 4, isEraser: false, point: { x: 0.5, y: 0.5 } });
  send(a, { type: 'stroke-end', strokeId });
  await delay(150);

  const echoedBack = a.messages.slice(messagesBefore).some((m) => m.type === 'stroke-start' && m.strokeId === strokeId);
  assert.strictEqual(echoedBack, false, 'sender should not receive its own stroke-start echoed back');

  a.close();
});

test('late-join history: a client joining after a stroke finishes receives it in strokeHistory', async () => {
  const a = await connectClient();
  await waitFor(a, (m) => m.type === 'welcome');

  const strokeId = 'history-test-stroke';
  send(a, { type: 'stroke-start', strokeId, color: '#2f6fed', width: 6, isEraser: false, point: { x: 0.3, y: 0.4 } });
  send(a, { type: 'stroke-end', strokeId });
  await delay(150);

  const c = await connectClient();
  const welcome = await waitFor(c, (m) => m.type === 'welcome');
  const found = welcome.strokeHistory.some((s) => s.color === '#2f6fed' && s.width === 6);
  assert.ok(found, 'late-joining client should see the already-finished stroke in its history');

  a.close(); c.close();
});

test('clear synchronisation and ownership: only the room owner can clear', async () => {
  const owner = await connectClient(); // first connection in this test = owner
  const welcomeOwner = await waitFor(owner, (m) => m.type === 'welcome');
  const other = await connectClient();
  await waitFor(other, (m) => m.type === 'welcome');

  // draw something first so there's something to clear
  send(owner, { type: 'stroke-start', strokeId: 'clear-test', color: '#2f9e5c', width: 4, isEraser: false, point: { x: 0.1, y: 0.1 } });
  send(owner, { type: 'stroke-end', strokeId: 'clear-test' });
  await delay(100);

  // non-owner tries to clear - should be rejected with an error, board untouched
  send(other, { type: 'clear' });
  const rejection = await waitFor(other, (m) => m.type === 'error');
  assert.ok(rejection.message.toLowerCase().includes('owner'));

  const stillHasStroke = await connectClient();
  const w1 = await waitFor(stillHasStroke, (m) => m.type === 'welcome');
  assert.ok(w1.strokeHistory.length >= 1, 'non-owner clear attempt should not have cleared the board');
  stillHasStroke.close();

  // the actual owner clears - should succeed and broadcast to everyone
  send(owner, { type: 'clear' });
  await waitFor(other, (m) => m.type === 'clear');

  const afterClear = await connectClient();
  const w2 = await waitFor(afterClear, (m) => m.type === 'welcome');
  assert.strictEqual(w2.strokeHistory.length, 0, 'owner clear should actually empty the history');

  owner.close(); other.close(); afterClear.close();
});

test('presence updates: connecting and disconnecting clients update everyone else\'s presence list', async () => {
  const a = await connectClient();
  await waitFor(a, (m) => m.type === 'welcome');

  const countBefore = (await waitFor(a, (m) => m.type === 'welcome')).presence.length;

  const b = await connectClient();
  const presenceAfterJoin = await waitFor(a, (m) => m.type === 'presence' && m.presence.length === countBefore + 1);
  assert.strictEqual(presenceAfterJoin.presence.length, countBefore + 1);

  b.close();
  await waitFor(a, (m) => m.type === 'presence' && m.presence.length === countBefore, 3000);

  a.close();
});

test('invalid message rejection: malformed messages are dropped, not broadcast, and don\'t kill the connection', async () => {
  const a = await connectClient();
  const b = await connectClient();
  await waitFor(a, (m) => m.type === 'welcome');
  await waitFor(b, (m) => m.type === 'welcome');

  // unknown message type
  send(a, { type: 'not-a-real-type', foo: 'bar' });
  // invalid colour (not in the permitted marker set)
  send(a, { type: 'stroke-start', strokeId: 'bad-1', color: '#ff00ff00', width: 4, isEraser: false, point: { x: 0.1, y: 0.1 } });
  // width way outside the allowed range
  send(a, { type: 'stroke-start', strokeId: 'bad-2', color: '#2b2b2e', width: 999, isEraser: false, point: { x: 0.1, y: 0.1 } });
  // non-numeric coordinates
  send(a, { type: 'stroke-start', strokeId: 'bad-3', color: '#2b2b2e', width: 4, isEraser: false, point: { x: 'nope', y: 0.1 } });
  // raw garbage, not even valid json
  a.send('this is not json{{{');

  await delay(200);
  const anyBadStrokeArrived = b.messages.some((m) => m.type === 'stroke-start' && ['bad-1', 'bad-2', 'bad-3'].includes(m.strokeId));
  assert.strictEqual(anyBadStrokeArrived, false, 'invalid stroke-start messages should never be broadcast');

  // connection should still be alive and working after all that garbage
  send(a, { type: 'stroke-start', strokeId: 'good-1', color: '#2b2b2e', width: 4, isEraser: false, point: { x: 0.2, y: 0.2 } });
  const goodOne = await waitFor(b, (m) => m.type === 'stroke-start' && m.strokeId === 'good-1');
  assert.strictEqual(goodOne.color, '#2b2b2e');

  a.close(); b.close();
});

test('reconnection: a client that disconnects and reconnects gets a fresh, correct welcome', async () => {
  const a = await connectClient();
  await waitFor(a, (m) => m.type === 'welcome');
  a.close();
  await delay(150);

  const a2 = await connectClient();
  const welcome2 = await waitFor(a2, (m) => m.type === 'welcome');
  assert.ok(welcome2.you.id, 'reconnected client should be issued a fresh identity');
  assert.ok(Array.isArray(welcome2.strokeHistory));
  assert.ok(Array.isArray(welcome2.presence));

  a2.close();
});

test('disconnect mid-stroke: an abandoned in-progress stroke is cancelled and cleaned up, not left in history', async () => {
  const a = await connectClient();
  const b = await connectClient();
  await waitFor(a, (m) => m.type === 'welcome');
  await waitFor(b, (m) => m.type === 'welcome');

  const strokeId = 'abandoned-stroke';
  send(a, { type: 'stroke-start', strokeId, color: '#8b5cf6', width: 4, isEraser: false, point: { x: 0.2, y: 0.2 } });
  await waitFor(b, (m) => m.type === 'stroke-start' && m.strokeId === strokeId);

  // a disconnects WITHOUT ever sending stroke-end - the exact scenario from
  // the bug report
  a.close();

  // b (who was watching the stroke live) should be told to cancel it
  const cancelMsg = await waitFor(b, (m) => m.type === 'stroke-cancel' && m.strokeId === strokeId);
  assert.ok(cancelMsg.id, 'stroke-cancel should identify which client abandoned the stroke');

  // and it should never show up in history for a fresh joiner either -
  // proving the server actually cleaned up inProgressStrokes, not just
  // notified other clients
  await delay(100);
  const c = await connectClient();
  const welcome = await waitFor(c, (m) => m.type === 'welcome');
  const leaked = welcome.strokeHistory.some((s) => s.color === '#8b5cf6' && s.width === 4);
  assert.strictEqual(leaked, false, 'an abandoned stroke should never make it into permanent history');

  b.close(); c.close();
});

test('offline stroke replay: a stroke-complete message is validated, stored whole, and broadcast', async () => {
  const a = await connectClient();
  const b = await connectClient();
  await waitFor(a, (m) => m.type === 'welcome');
  await waitFor(b, (m) => m.type === 'welcome');

  const stroke = { color: '#ef8a2c', width: 5, isEraser: false, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }, { x: 0.4, y: 0.5 }] };
  send(a, { type: 'stroke-complete', stroke });

  const received = await waitFor(b, (m) => m.type === 'stroke-complete' && m.stroke.color === '#ef8a2c');
  assert.strictEqual(received.stroke.points.length, 3, 'the whole stroke should arrive intact, not just fragments');

  const c = await connectClient();
  const welcome = await waitFor(c, (m) => m.type === 'welcome');
  assert.ok(welcome.strokeHistory.some((s) => s.color === '#ef8a2c'), 'a replayed offline stroke should persist into history for future joiners too');

  a.close(); b.close(); c.close();
});

test('history trimming: strokeHistory never grows past the configured maximum', async () => {
  const a = await connectClient();
  await waitFor(a, (m) => m.type === 'welcome');

  const totalToSend = LIMITS.MAX_STROKES_IN_HISTORY + 20;
  for (let i = 0; i < totalToSend; i++) {
    const strokeId = `trim-test-${i}`;
    send(a, { type: 'stroke-start', strokeId, color: '#2f9e5c', width: 2, isEraser: false, point: { x: 0.1, y: 0.1 } });
    send(a, { type: 'stroke-end', strokeId });
  }
  await delay(400);

  const b = await connectClient();
  const welcome = await waitFor(b, (m) => m.type === 'welcome');
  assert.ok(
    welcome.strokeHistory.length <= LIMITS.MAX_STROKES_IN_HISTORY,
    `history should be capped at ${LIMITS.MAX_STROKES_IN_HISTORY}, got ${welcome.strokeHistory.length}`
  );

  a.close(); b.close();
});

test('message size limit: an oversized message is rejected and does not affect other clients', async () => {
  const a = await connectClient();
  const b = await connectClient();
  await waitFor(a, (m) => m.type === 'welcome');
  await waitFor(b, (m) => m.type === 'welcome');

  // this is expected to get the sending connection closed by ws's own
  // maxPayload enforcement - that's fine and correct. what matters is that
  // it doesn't take the rest of the server down with it.
  a.on('error', () => {}); // expected for this test - avoid an unhandled client-side error too
  try {
    a.send(JSON.stringify({ type: 'stroke-point', strokeId: 'whatever', point: { x: 0.1, y: 0.1, junk: 'x'.repeat(LIMITS.MAX_MESSAGE_BYTES + 5000) } }));
  } catch { /* some environments throw synchronously on oversized sends - also fine */ }

  await delay(300);

  // b should be completely unaffected and the server should still be
  // accepting brand new connections normally
  send(b, { type: 'stroke-start', strokeId: 'still-fine', color: '#2b2b2e', width: 4, isEraser: false, point: { x: 0.5, y: 0.5 } });
  send(b, { type: 'stroke-end', strokeId: 'still-fine' });

  const c = await connectClient();
  await waitFor(c, (m) => m.type === 'welcome');

  b.close(); c.close();
});

test('rate limiting: a client that keeps exceeding the message rate gets disconnected', async () => {
  const a = await connectClient();
  await waitFor(a, (m) => m.type === 'welcome');

  let closed = false;
  a.on('close', () => { closed = true; });

  for (let round = 0; round < LIMITS.RATE_LIMIT_STRIKES_BEFORE_KICK + 1 && !closed; round++) {
    for (let i = 0; i < LIMITS.RATE_LIMIT_MAX_MESSAGES + 20; i++) {
      if (a.readyState === WebSocket.OPEN) a.send(JSON.stringify({ type: 'cursor', point: { x: 0.1, y: 0.1 } }));
    }
    await delay(LIMITS.RATE_LIMIT_WINDOW_MS + 100);
  }

  assert.strictEqual(closed, true, 'a client that repeatedly exceeds the rate limit should eventually be disconnected');
});

// ===== runner =====
async function run() {
  await delay(200); // give the server a moment to finish starting up
  PORT = server.address().port;
  console.log(`running tests against ws://localhost:${PORT}\n`);

  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

run();
