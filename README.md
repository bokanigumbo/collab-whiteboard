# collaborative whiteboard

a real-time whiteboard where multiple people can draw together and see each other’s cursors.

![collaborative whiteboard](screenshots/collaborative-whiteboard.gif)

## features

* real-time collaborative drawing
* live cursor positions and user presence
* adjustable marker colours and widths
* eraser tool
* responsive canvas
* automatic reconnection
* offline strokes synchronised after reconnecting
* existing drawings sent to users who join late
* owner-controlled board clearing

## how it works

the project uses a Node.js server and WebSockets to keep every connected browser synchronised.

strokes are sent as they are drawn using separate start, point and end messages. this allows other users to see a line appear live instead of waiting until it is complete.

coordinates are stored as proportions of the canvas rather than fixed pixels, helping drawings remain aligned across different screen sizes.

the server keeps the latest 500 completed strokes in memory. when somebody joins or reconnects, this history is sent to their browser so they receive the current board.

## validation and security

the server treats every incoming message as untrusted.

* message types and drawing values are validated
* coordinates must remain within the canvas
* colours and marker widths are restricted to supported values
* individual strokes have a maximum number of points
* messages are limited to 64 KB
* each connection is rate-limited
* repeated rate-limit violations disconnect the client
* only the current board owner can clear the board

## run locally

install the dependencies:

```bash
npm install
```

start the server:

```bash
npm start
```

then open `http://localhost:3000` in two browser tabs.

to test it across devices on the same network, open the application using the host computer’s local IP address.

## tests

run the integration tests with:

```bash
npm test
```

12 tests use real WebSocket clients against the running server. they cover stroke broadcasting, late joining, presence, reconnection, offline drawing, abandoned strokes, board ownership, history limits, malformed messages, payload limits and rate limiting.

## limitations

* everyone currently shares one board
* drawings are cleared when the server restarts
* no accounts or authentication
* no undo or redo
* offline drawings are not preserved after refreshing the page
* canvas rendering is manually tested

this project is intended as a local or controlled demonstration. authentication, private rooms and origin checking should be added before deploying it as a public service.

## built with

* Node.js
* WebSockets using `ws`
* HTML canvas
* vanilla JavaScript

## licence

MIT — see [LICENSE](LICENSE).
