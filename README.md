# Collaborative Whiteboard

draw together in real time - every stroke and every cursor streams live to everyone connected, not just once someone lifts the pen.

*(a screenshot or short GIF goes here - grab one once it's running, and see "demonstration" below for what's worth showing)*

## features

- freehand drawing with adjustable colour and stroke width, plus a real eraser (destination-out compositing, not a same-colour-as-background trick)
- strokes stream point-by-point as they're drawn, not as one blob once you lift the pen
- live cursors for everyone connected, each with a randomly assigned name
- a browser joining mid-session is caught up on everything already drawn
- the first person in a session owns clear-board rights
- automatic reconnection, with anything drawn while offline preserved and synced once back online

## architecture

a Node server (`server.js`) holds a WebSocket connection open to every browser tab and is the single source of truth for the board's state. a stroke is sent as three message types rather than one: `stroke-start` on press, throttled `stroke-point` messages (~35ms) while moving, and `stroke-end` on release - each broadcast immediately so other clients draw it live rather than waiting for the finished result.

coordinates are transmitted as proportions of the canvas (0-1), not raw pixels, and converted to pixels using each browser's own canvas size at draw time - this is what keeps the board looking the same across differently sized screens.

a disconnect mid-stroke is handled explicitly: the server cancels the abandoned stroke (`stroke-cancel`, removed from `inProgressStrokes`) rather than leaving other clients looking at a line that can never finish. a reconnecting client gets a new client ID, so a stroke touched by a disconnect - whether it started offline or was interrupted mid-draw - is resent whole as a single `stroke-complete` message once back online, rather than trying to resume the old, now-orphaned strokeId.

## validation & security

the server treats every incoming message as untrusted:

- only a fixed set of message types is accepted; anything else is dropped
- coordinates must be finite numbers in range (no `NaN`, `Infinity`, or wild values); width and colour are checked against the actual toolbar's ranges/palette
- a single stroke is capped at a maximum point count; any message over 64KB is rejected outright
- each connection is rate-limited (a sliding window); repeated violations disconnect the client rather than just throttling forever
- history is capped at 500 strokes so a new joiner's payload and server memory both stay bounded

## testing

```bash
npm install
npm test
```

real WebSocket clients against the actual running server (not mocks) - stroke broadcasting, sender exclusion, late-join history, owner-only clear, presence updates, malformed-message rejection, reconnection, mid-stroke disconnect cancellation, offline stroke replay, exact history trimming (500 kept, oldest dropped first - verified precisely, not just "500 or fewer"), oversized-message handling, and rate-limit enforcement.

not covered: anything actually rendered on screen. these tests exercise the server and protocol thoroughly, but there's no browser-automation test of the canvas itself (pixel output, compositing) - a reasonable next step, not attempted here.

## setup

**locally:**
```bash
npm install
npm start
```
then open `http://localhost:3000` in two browser tabs (or two devices on the same network, using your machine's local IP) to see collaboration happen between them.

**deploying it live:** this needs somewhere that keeps a Node process running continuously - **not** a static host like GitHub Pages, which can only serve files. Render, Railway, Fly.io, and Glitch all support an always-on Node server, usually with a free tier. pushing this to GitHub alone doesn't make it work live on the internet; it just makes the code (and local-run instructions) available - the two are separate steps.

## demonstration

the clearest way to show this actually works: open it on two differently sized devices (e.g. a laptop and a phone) at once, draw on both simultaneously and watch each stroke appear live on the other, then disconnect one (close the tab, or turn off wifi briefly) and reconnect it - confirming it rejoins with the board fully intact and picks back up seamlessly.

## known limitations

- board contents live in memory only - restarting the server clears everything; no persistent database
- everyone connected shares a single room - no separate/private boards
- no undo/redo, only a full (owner-only) clear
- "ownership" is soft (whoever connected first) with no real authentication - fine for a casual demo, not for anything needing genuine access control
- no canvas/browser-automation tests (see "testing" above)
- the offline queue isn't durable across a page refresh, and a message could theoretically still be lost if the connection drops again while that queue is mid-flush

## built with

- Node's built-in `http` module for serving the frontend, no framework needed at this size
- [`ws`](https://github.com/websockets/ws) for the WebSocket server
- plain HTML5 canvas and vanilla JavaScript on the frontend, no build step

## license

MIT - see [LICENSE](LICENSE).
