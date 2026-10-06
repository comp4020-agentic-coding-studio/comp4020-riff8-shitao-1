// Captures one pointer gesture on the wall's SVG and posts it as a mark,
// streams it as a live preview while it's being drawn, and listens over SSE
// for everyone's previews and finished marks so the wall updates with no
// reload. No frameworks: this is the whole client.
(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const script = document.currentScript;
  const svg = document.getElementById("wall");
  const status = document.getElementById("status");
  const connection = document.getElementById("connection");
  const handColour = script.dataset.handColour;
  const previewLease = Number(script.dataset.previewLease ?? 5000);
  let canDraw = script.dataset.canDraw === "true";
  let points = [];
  let live = null;
  let drawing = false;
  // True from the moment a finished gesture's POST goes out until it
  // settles, so a second gesture can't start (and post) while the first is
  // still in flight.
  let submitting = false;
  // Every gesture gets a fresh random id, chosen here before anything is
  // sent. It names the gesture's live preview, and the server tags the
  // committed mark's broadcast with it, so this tab recognises its own
  // preview and mark coming back over SSE --- whichever of that echo and its
  // own POST response arrives first --- and other tabs can swap the preview
  // for the finished stroke in place. It's never reused and never stored.
  let gesture = null;
  const ownGestures = new Set();

  const toViewBox = (evt) => {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const x = ((evt.clientX - rect.left) / rect.width) * vb.width + vb.x;
    const y = ((evt.clientY - rect.top) / rect.height) * vb.height + vb.y;
    return [Math.round(x), Math.round(y)];
  };

  const pathFrom = (pts) => pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");

  const makePath = (attrs) => {
    const p = document.createElementNS(SVG_NS, "path");
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined) p.setAttribute(k, v);
    return p;
  };

  // Everyone else's strokes, finished or in progress, go under this hand's
  // own strokes and the one it's drawing right now, which stay on top.
  const insertUnderOwn = (el) => svg.insertBefore(el, svg.querySelector(".halo, .mine"));

  const appendStroke = (path, colour, id) =>
    insertUnderOwn(makePath({ d: path, stroke: colour, "data-id": id }));

  // The stroke being drawn, over its halo, mirroring what the server renders
  // for a hand's own marks.
  let halo = null;

  // --- Sending this hand's preview -------------------------------------
  //
  // At most one update in flight, the next one coalescing every point drawn
  // meanwhile, and never more often than SEND_INTERVAL: a fast pointer fires
  // far more pointermoves than are worth a request each. A heartbeat keeps
  // the server's lease alive while the hand pauses mid-stroke (a keyboard
  // gesture can sit still for seconds); a closed tab stops heartbeating and
  // the server sweeps its preview away within the lease.
  const SEND_INTERVAL = 50;
  const HEARTBEAT = Math.max(200, Math.floor(previewLease / 3));
  const MAX_POINTS_PER_UPDATE = 200;
  let sender = null;

  const send = async (s) => {
    s.timer = null;
    if (s.stopped || s.inFlight) return;
    const pts = s.points.slice(s.sent, s.sent + MAX_POINTS_PER_UPDATE);
    if (pts.length === 0 && s.sent > 0 && !s.beat) return;
    s.beat = false;
    s.inFlight = true;
    s.lastSentAt = Date.now();
    try {
      const res = await fetch("/api/strokes/live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gesture: s.id, from: s.sent, points: pts }),
      });
      const body = await res.json().catch(() => ({}));
      if (typeof body.count === "number") s.sent = body.count;
      // Gone, refused or not ours: stop streaming this gesture. The mark
      // itself can still be posted; it just won't have been watched.
      if (!res.ok && res.status !== 409 && res.status !== 429) s.stopped = true;
    } catch {
      // A dropped request: the next send resumes from the last count the
      // server confirmed, so nothing is skipped or doubled.
    } finally {
      s.inFlight = false;
      if (!s.stopped && s.sent < s.points.length) schedule(s);
    }
  };

  const schedule = (s) => {
    if (!s || s.stopped || s.inFlight || s.timer) return;
    const wait = Math.max(0, s.lastSentAt + SEND_INTERVAL - Date.now());
    s.timer = setTimeout(() => send(s), wait);
  };

  const startSender = (id, pts) => {
    const s = { id, points: pts, sent: 0, inFlight: false, timer: null, lastSentAt: 0, stopped: false, beat: false };
    s.heartbeat = setInterval(() => {
      s.beat = true;
      schedule(s);
    }, HEARTBEAT);
    sender = s;
    schedule(s);
  };

  const cancelBody = (id) => JSON.stringify({ gesture: id });
  const cancelPreview = (id) =>
    fetch("/api/strokes/live/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: cancelBody(id),
      keepalive: true,
    }).catch(() => {});

  // `cancel` is false when the gesture is being committed: the mark's own
  // POST ends the preview on the server, atomically with persisting it.
  const stopSender = (cancel) => {
    const s = sender;
    if (!s) return;
    sender = null;
    s.stopped = true;
    clearInterval(s.heartbeat);
    clearTimeout(s.timer);
    if (cancel && s.lastSentAt > 0) cancelPreview(s.id);
  };

  // Best effort only: the lease is what actually guarantees a closed tab's
  // preview disappears, since unload delivery is never certain.
  window.addEventListener("pagehide", () => {
    if (sender && sender.lastSentAt > 0) {
      navigator.sendBeacon?.(
        "/api/strokes/live/cancel",
        new Blob([cancelBody(sender.id)], { type: "application/json" }),
      );
    }
  });

  // --- Drawing ------------------------------------------------------------

  const beginGesture = (point) => {
    drawing = true;
    points = [point];
    gesture = crypto.randomUUID();
    ownGestures.add(gesture);
    halo = makePath({ class: "halo" });
    live = makePath({ stroke: handColour, class: "mine" });
    svg.append(halo, live);
    startSender(gesture, points);
  };

  const addPoint = (point) => {
    points.push(point);
    halo.setAttribute("d", pathFrom(points));
    live.setAttribute("d", pathFrom(points));
    schedule(sender);
  };

  const dropLive = () => {
    halo?.remove();
    live?.remove();
  };

  const cancelGesture = () => {
    drawing = false;
    stopSender(true);
    dropLive();
  };

  if (canDraw) {
    svg.addEventListener("pointerdown", (evt) => {
      if (!canDraw || submitting) return;
      beginGesture(toViewBox(evt));
      svg.setPointerCapture(evt.pointerId);
    });

    svg.addEventListener("pointermove", (evt) => {
      if (!drawing) return;
      addPoint(toViewBox(evt));
    });

    const finish = async () => {
      if (!drawing) return;
      drawing = false;
      if (points.length < 2) {
        cancelGesture();
        return;
      }
      const path = pathFrom(points);
      const committing = gesture;
      stopSender(false);
      submitting = true;
      status.textContent = "Adding your mark…";
      try {
        const res = await fetch("/api/marks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, gesture: committing }),
        });
        if (!res.ok) {
          const text = await res.text();
          status.textContent = text || "That mark wasn't accepted.";
          dropLive();
          return;
        }
        canDraw = false;
        status.textContent =
          "Your mark is on the wall: the thicker stroke, on top. You can add another in 24 hours.";
      } catch {
        // The server never answered, so it may or may not have the preview:
        // cancel it explicitly rather than leave it to the lease.
        status.textContent = "Couldn't reach the wall --- try again.";
        cancelPreview(committing);
        dropLive();
      } finally {
        submitting = false;
      }
    };

    svg.addEventListener("pointerup", finish);
    // The system took the pointer away (a scroll, a palm, a notification):
    // that's not the hand choosing to finish, so nothing is posted.
    svg.addEventListener("pointercancel", () => {
      if (drawing) cancelGesture();
    });

    // A pointer is the only way to draw unless this exists: Enter/Space
    // starts a gesture at the wall's centre, the arrow keys add a point each
    // in that direction (mirroring pointermove), and Enter/Space again hands
    // off to the same finish() a pointer gesture uses. Escape cancels, the
    // same way lifting a pointer after barely moving does.
    const STEP = 30;
    const ARROW_DELTAS = {
      ArrowUp: [0, -STEP],
      ArrowDown: [0, STEP],
      ArrowLeft: [-STEP, 0],
      ArrowRight: [STEP, 0],
    };
    svg.addEventListener("keydown", (evt) => {
      if (!canDraw || submitting) return;
      if (!drawing) {
        if (evt.key !== "Enter" && evt.key !== " ") return;
        evt.preventDefault();
        const vb = svg.viewBox.baseVal;
        beginGesture([Math.round(vb.x + vb.width / 2), Math.round(vb.y + vb.height / 2)]);
        return;
      }
      if (evt.key in ARROW_DELTAS) {
        evt.preventDefault();
        const [dx, dy] = ARROW_DELTAS[evt.key];
        const [x, y] = points[points.length - 1];
        addPoint([x + dx, y + dy]);
        return;
      }
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        finish();
        return;
      }
      if (evt.key === "Escape") {
        evt.preventDefault();
        cancelGesture();
      }
    });
  }

  // --- Watching everyone else ---------------------------------------------

  // Previews from other hands (and other tabs of this one), by gesture id.
  // Ended ids are remembered so a late event can't bring a preview back.
  const remote = new Map();
  const endedRemote = new Set();

  const describeLive = () => {
    if (!connection) return;
    const n = remote.size;
    connection.textContent = !streamOpen
      ? "Reconnecting to the wall…"
      : n === 0
        ? "Live: new marks appear as they're made."
        : `Live: ${n === 1 ? "someone is" : `${n} people are`} drawing right now.`;
  };

  const endPreview = (id) => {
    const r = remote.get(id);
    endedRemote.add(id);
    if (!r) return;
    clearTimeout(r.timer);
    r.el.remove();
    remote.delete(id);
    describeLive();
  };

  const showPreview = ({ gesture: id, colour, from, points: pts, held }) => {
    if (ownGestures.has(id) || endedRemote.has(id)) return;
    let r = remote.get(id);
    if (!r) {
      r = { el: makePath({ stroke: colour, class: "preview" }), points: [], timer: null };
      insertUnderOwn(r.el);
      remote.set(id, r);
      describeLive();
    }
    // Overlap from a retried update is dropped; a gap (an update this tab
    // somehow missed) still draws, joined straight across.
    r.points.push(...(from <= r.points.length ? pts.slice(r.points.length - from) : pts));
    r.el.setAttribute("d", pathFrom(r.points));
    r.el.classList.toggle("held", Boolean(held));
    // The server sweeps abandoned previews and says so; this is the backstop
    // if that event itself never arrives.
    clearTimeout(r.timer);
    r.timer = setTimeout(() => endPreview(id), previewLease * 2);
  };

  const showMark = (mark) => {
    if (mark.gesture && ownGestures.has(mark.gesture)) {
      // This tab's own stroke, already drawn as `live`: just name it.
      if (mark.gesture === gesture) {
        live?.setAttribute("data-id", mark.id);
        halo?.setAttribute("data-id", mark.id);
      }
      return;
    }
    if (svg.querySelector(`[data-id="${mark.id}"]`)) return;
    const r = mark.gesture && remote.get(mark.gesture);
    if (r) {
      // The preview becomes the mark where it stands: same element, same
      // place in the stack, now with the full committed path.
      clearTimeout(r.timer);
      remote.delete(mark.gesture);
      r.el.classList.remove("preview", "held");
      r.el.setAttribute("d", mark.path);
      r.el.setAttribute("data-id", mark.id);
      describeLive();
    } else {
      appendStroke(mark.path, mark.colour, mark.id);
    }
    if (mark.gesture) endedRemote.add(mark.gesture);
  };

  // After a reconnect: add any marks missed while away, drop any no longer
  // on the wall. Elements without an id (this tab's stroke in progress,
  // previews) are left alone.
  const refreshMarks = async () => {
    let marks;
    try {
      const res = await fetch("/api/marks");
      if (!res.ok) return;
      marks = await res.json();
    } catch {
      return;
    }
    const ids = new Set(marks.map((m) => String(m.id)));
    for (const el of svg.querySelectorAll("path[data-id]")) {
      if (!ids.has(el.getAttribute("data-id"))) el.remove();
    }
    for (const m of marks) {
      if (svg.querySelector(`[data-id="${m.id}"]`)) continue;
      if (m.mine) {
        // On top of everyone else's, but still under a stroke in progress.
        const inProgress = halo?.isConnected && !halo.hasAttribute("data-id") ? halo : null;
        for (const el of [
          makePath({ d: m.path, class: "halo", "data-id": m.id }),
          makePath({ d: m.path, stroke: m.colour, class: "mine", "data-id": m.id }),
        ]) {
          svg.insertBefore(el, inProgress);
        }
      } else {
        appendStroke(m.path, m.colour, m.id);
      }
    }
  };

  let streamOpen = false;
  let opened = false;
  const connect = () => {
    const stream = new EventSource("/api/marks/stream");
    stream.addEventListener("open", () => {
      streamOpen = true;
      if (opened) refreshMarks();
      opened = true;
      describeLive();
    });
    stream.addEventListener("error", () => {
      streamOpen = false;
      describeLive();
      // Chrome gives up for good when the server itself goes away (a
      // redeploy does exactly that), so reopen by hand once it's closed.
      if (stream.readyState === 2) setTimeout(connect, 2000);
    });
    // Every connection opens with what's being drawn right now.
    stream.addEventListener("previews", (evt) => {
      const snapshot = JSON.parse(evt.data);
      const current = new Set(snapshot.map((p) => p.gesture));
      for (const id of [...remote.keys()]) if (!current.has(id)) endPreview(id);
      for (const p of snapshot) {
        const r = remote.get(p.gesture);
        if (r) r.points = [];
        showPreview({ ...p, from: 0 });
      }
    });
    stream.addEventListener("preview", (evt) => showPreview(JSON.parse(evt.data)));
    stream.addEventListener("preview-end", (evt) => endPreview(JSON.parse(evt.data).gesture));
    stream.addEventListener("mark", (evt) => showMark(JSON.parse(evt.data)));
  };
  connect();
})();
