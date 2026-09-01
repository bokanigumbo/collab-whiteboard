# collaborative whiteboard

draw together, in real time. anyone connected to the same server sees every stroke and every live cursor as it happens - genuinely as it happens, not just once someone lifts the pen.

*(a screenshot or short GIF of it in use goes here - I can't capture one from this environment since it needs an actual running browser session; worth adding once you've run it yourself)*

## what it does

- draw freehand with a set of marker colours and an adjustable stroke width
- every stroke streams to everyone else point by point while you're still drawing it, not as one blob after you finish
- a real eraser (destination-out compositing) that actually removes what's underneath, not a same-colour-as-the-background trick
- a plain click (no drag) leaves a dot, the same way pressing a real marker to a board without moving it does - rather than silently recording a stroke that's never actually visible
- see other people's cursors moving live, each labelled with a randomly assigned name
- a new browser joining partway through gets caught up on everything already drawn
- the first person in a session owns clear-board rights - nobody else can wipe it for everyone
- reconnects automatically if the connection drops, and doesn't lose whatever you drew while offline

## how the real-time part actually works

there's a real node server (`server.js`) running a websocket connection to every open browser tab. a stroke is sent as three kinds of message rather than one: `stroke-start` the moment you press down, throttled `stroke-point` messages every ~35ms while you're moving, and `stroke-end` when you lift the pen. every other connected browser draws each of those live, which is what makes it look like watching someone draw rather than watching a finished drawing appear.

coordinates are never sent as raw pixels. every point is stored and transmitted as a proportion of the canvas (0-1 on each axis), then converted back to actual pixels using each browser's own current canvas size when it's drawn. that's what stops the whiteboard looking different, or partly off-screen, for someone with a different window size than you.

## the server doesn't trust anything it's sent

every incoming message is validated before it's allowed to touch the shared state or reach anyone else:

- only a fixed set of message types is accepted - anything else is dropped
- points must be finite numbers in range, not `NaN`, `Infinity`, or wildly out-of-bounds values
- stroke width is clamped to a sane range
- colour must be one of the actual marker colours the toolbar offers - not an arbitrary string
- a single stroke is capped at a maximum number of points
- any single message over 64kb is rejected outright
- each connection is rate-limited (a sliding window per client); a client that keeps exceeding it gets disconnected rather than just endlessly throttled

worth calling out: testing this by actually flooding the server (not just reading the validation code) caught a real bug - the library-level oversized-message rejection was closing the *bad* connection correctly, but an unhandled `error` event from that would have crashed the *entire server process*, taking every other connected user down with it. that's fixed now (a per-connection `error` handler that just logs and lets the bad connection close), but it's a good example of why testing against the running thing matters more than reviewing the logic in isolation.

## disconnecting mid-stroke doesn't leave a permanent mess

if a client disconnects after sending `stroke-start` but before `stroke-end`, the server now immediately cancels that stroke: it's removed from `inProgressStrokes` and a `stroke-cancel` message is broadcast, so everyone else's browser drops their own in-progress copy of it and redraws from confirmed history only, rather than being stuck looking at a line that can never finish.

this matters because a reconnecting client is issued a brand new client id - there's no way to reliably reattach a queued "finish this stroke" message to a strokeId the server associated with a connection that no longer exists. rather than attempting that, a stroke touched by a disconnect (either it started while offline, or the connection dropped partway through it) is resent as a single, self-contained `stroke-complete` message once reconnected, the same mechanism already used for offline strokes drawn from scratch. this was caught by writing a test that actually disconnects a client mid-stroke and checks what every other client sees - the original reconnection test only checked that the reconnecting client itself got a clean welcome, which passed even with the bug in place.

## automated tests

```bash
npm install
npm test
```

runs real websocket clients against the actual server (not mocks). covers: stroke broadcasting, that a sender never receives its own broadcast back, that a late-joining client gets the existing history, that only the room owner can clear the board, presence updates on join/leave, malformed messages being dropped without affecting the connection, reconnection producing a clean fresh state, a client disconnecting mid-stroke correctly cancelling that stroke for everyone else, offline stroke replay via `stroke-complete`, history trimming once the cap is hit, oversized messages being rejected without taking the server down, and rate-limit violations eventually disconnecting a client.

what's **not** covered: anything actually rendered on screen. these tests exercise the server and the websocket protocol thoroughly, but there's no automated test of the canvas drawing itself (pixel output, the eraser's compositing, the dot rendered for a single click) - that would need a real browser automation tool like Playwright, which felt like a large enough addition to leave as a next step rather than bolt on quickly.

## offline drawing isn't silently lost

if your connection drops mid-drawing, the stroke still gets recorded locally and queued rather than discarded. the tricky part: when you reconnect, the server sends its own current history, which would otherwise just overwrite whatever you drew while offline. the fix redraws your queued strokes on top of the fresh server history immediately after reconnecting, and forwards them to the server so they're not lost for everyone else either.

## running it locally

```bash
npm install
npm start
```

then open `http://localhost:3000` in a couple of different browser tabs (or on a different device on the same network, using your computer's local IP instead of localhost) to see the collaboration actually happen between them.

## a deployment note

this needs somewhere that can keep a node process running continuously, since the whole thing depends on a live websocket connection - **not** a static host like GitHub Pages, which can only serve files and can't run server code at all. Render, Railway, Fly.io, and Glitch all support this kind of always-on node server, usually with a free tier.

## known limitations

- the whiteboard's contents live in memory on the server - restarting the server clears the board. adding a database (or even just writing strokes to a file) would fix this
- history is capped at 500 strokes to bound memory and the payload a new joiner receives; older strokes are dropped once that's exceeded on a long-running session
- everyone connected is in the same single room. multiple separate boards, or private rooms with a shareable link, would be a natural next step
- no undo - only a full clear, which affects everyone (and is now owner-only)
- "ownership" is just "whoever connected first, or the earliest still-connected person after that" - there's no real authentication, so it's a soft permission rather than a secure one. fine for a casual demo, not something to point at anything you'd want genuinely access-controlled

## built with

- node's built-in `http` module for serving the frontend files, no framework needed for something this small
- [`ws`](https://github.com/websockets/ws) for the websocket server
- plain HTML5 canvas and vanilla JavaScript on the frontend, no build step
