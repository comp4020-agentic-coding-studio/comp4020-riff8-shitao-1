// Captures a gesture on the wall's SVG as a private draft, adds it to the
// wall only when the hand says so, streams it as a live preview while it's
// drawn if (and only if) the hand turned Draw live on, and listens over SSE
// for everyone's previews and finished marks so the wall updates with no
// reload. No frameworks: this is the whole client.
(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const script = document.currentScript;
  const svg = document.getElementById("wall");
  const status = document.getElementById("status");
  const connection = document.getElementById("connection");
  const draftForm = document.getElementById("draft");
  const publishButton = document.getElementById("publish");
  const retryButton = document.getElementById("retry");
  const answers = document.getElementById("answers");
  const note = document.getElementById("note");
  const modeButton = document.getElementById("mode");
  const modeNote = document.getElementById("mode-note");
  const onlyPrompt = document.getElementById("only-prompt");
  const fresh = document.getElementById("fresh");
  const handColour = script.dataset.handColour;
  const previewLease = Number(script.dataset.previewLease ?? 5000);
  const todayPrompt = script.dataset.prompt ?? "";
  // Whether this hand can add a mark right now. Drawing itself is always
  // open: during the cooldown it's private practice that can't be added.
  let canPublish = script.dataset.canDraw === "true";
  // Off by default, and off again after every mark: nobody streams their
  // drawing without having just chosen to.
  let liveMode = false;
  // The finished gesture waiting for Add to the wall or Try again.
  let draft = null;
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
  // The gesture this tab last submitted, with its elements: the only mark
  // echo it treats as its own. Any other mark is drawn, even one claiming
  // an id this tab once used.
  let published = null;

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

  const appendStroke = (path, colour, id, prompt) => {
    const el = makePath({ d: path, stroke: colour, "data-id": id, "data-prompt": prompt ?? undefined });
    insertUnderOwn(el);
    applyFilter(el);
  };

  // "Only today's prompt" dims every committed stroke that answered
  // something else (or nothing), so a hand can see how others answered.
  const applyFilter = (el) =>
    el.classList.toggle(
      "off-prompt",
      Boolean(onlyPrompt?.checked) && el.getAttribute("data-prompt") !== todayPrompt,
    );
  const filterAll = () => {
    for (const el of svg.querySelectorAll("path[data-id]:not(.halo)")) applyFilter(el);
  };
  onlyPrompt?.addEventListener("change", filterAll);
  // A reload can restore the box already ticked.
  filterAll();

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
        body: JSON.stringify({ gesture: s.id, from: s.sent, points: pts, held: s.held }),
      });
      const body = await res.json().catch(() => ({}));
      if (typeof body.count === "number") s.sent = body.count;
      // Gone, refused or not ours: stop streaming this gesture, and say so
      // rather than keep claiming it's live. The mark itself can still be
      // added; it just won't have been watched.
      if (!res.ok && res.status !== 409 && res.status !== 429) {
        s.stopped = true;
        if (sender === s) describeAudience();
        if (res.status !== 410 && modeNote && sender === s) {
          modeNote.textContent =
            res.status === 503
              ? "Too many people are drawing live right now, so this line is only on your screen."
              : "Live drawing isn't reaching anyone (reload the page to try again), so this line is only on your screen.";
        }
      }
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
    const s = { id, points: pts, sent: 0, inFlight: false, timer: null, lastSentAt: 0, stopped: false, beat: false, held: false };
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

  const nextAtPhrase = (at) =>
    `from ${new Date(at).toLocaleString([], { weekday: "long", hour: "numeric", minute: "2-digit" })}`;

  const describeMode = () => {
    if (!modeButton) return;
    if (!canPublish) liveMode = false;
    modeButton.disabled = !canPublish;
    modeButton.setAttribute("aria-pressed", String(liveMode));
    modeButton.textContent = liveMode ? "Draw live: on" : "Draw live";
    modeNote.textContent = !canPublish
      ? "Live drawing opens again when you can add your next mark."
      : liveMode
        ? "On: everyone on the wall watches your line as you draw it, before you decide whether to add it."
        : "Off: you're practising privately. Turn it on to let everyone here watch your line as you draw it.";
  };

  const describeAudience = () => {
    const audience = document.getElementById("draft-audience");
    if (audience) {
      audience.textContent =
        sender && !sender.stopped
          ? "Everyone watching the wall sees it dashed until you add it or try again."
          : "Only you can see it.";
    }
  };

  const showDraft = (show) => {
    if (draftForm) draftForm.hidden = !show;
    if (publishButton) publishButton.disabled = !canPublish;
  };

  const beginGesture = (point) => {
    if (draft) discardDraft();
    drawing = true;
    points = [point];
    gesture = crypto.randomUUID();
    ownGestures.add(gesture);
    halo = makePath({ class: "halo" });
    live = makePath({ stroke: handColour, class: "mine draft" });
    svg.append(halo, live);
    if (liveMode && canPublish) startSender(gesture, points);
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

  function discardDraft() {
    draft = null;
    showDraft(false);
    stopSender(true);
    dropLive();
  }

  const finish = () => {
    if (!drawing) return;
    drawing = false;
    if (points.length < 2) {
      cancelGesture();
      return;
    }
    // Chosen once per draft, so a retry after a lost response is
    // recognised by the server as the same submission, not a second mark.
    draft = { gesture, points, nonce: crypto.randomUUID() };
    if (sender) {
      sender.held = true;
      sender.beat = true;
      schedule(sender);
    }
    showDraft(true);
    describeAudience();
    status.textContent = canPublish
      ? `Not on the wall yet${sender ? " (people watching see it dashed, waiting)" : ""}: add it, or try again. Escape discards it.`
      : "That one's just for practice: you can add your next mark once the day is up.";
  };

  const publish = async () => {
    if (!draft || submitting || !canPublish) return;
    const { gesture: committing, points: pts, nonce } = draft;
    published = { gesture: committing, live, halo };
    stopSender(false);
    submitting = true;
    publishButton.disabled = true;
    status.textContent = "Adding your mark…";
    try {
      const res = await fetch("/api/marks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: pathFrom(pts),
          gesture: committing,
          nonce,
          prompt: answers?.checked ? todayPrompt : undefined,
          note: note?.value.trim() ? note.value.trim() : undefined,
        }),
      });
      if (!res.ok) {
        // Refused (already marked today, or a bad stroke): the server has
        // ended the preview, but the drawing stays here as practice.
        const text = await res.text();
        status.textContent = text || "That mark wasn't accepted.";
        if (res.status === 429) {
          canPublish = false;
          describeMode();
        }
        return;
      }
      const body = await res.json().catch(() => ({}));
      const keptNote = Boolean(note?.value.trim());
      if (body.id !== undefined) {
        // If the echo arrived without our gesture id and was drawn as a
        // separate stroke, this is where that duplicate goes.
        for (const el of svg.querySelectorAll(`[data-id="${body.id}"]`)) {
          if (el !== live && el !== halo) el.remove();
        }
        live.setAttribute("data-id", body.id);
        halo.setAttribute("data-id", body.id);
      }
      if (answers?.checked) live.setAttribute("data-prompt", todayPrompt);
      live.classList.remove("draft");
      draft = null;
      if (note) note.value = "";
      canPublish = false;
      describeMode();
      showDraft(false);
      status.textContent = `Your mark is on the wall: the thicker stroke, on top. My traces keeps it${keptNote ? " with your note" : ""}. You can add your next one ${body.nextAt ? nextAtPhrase(body.nextAt) : "in 24 hours"}.`;
    } catch {
      // The server never answered. Cancel the preview rather than leave it
      // to the lease; the draft stays, and adding it again reuses its nonce.
      cancelPreview(committing);
      status.textContent = "Couldn't reach the wall. Your drawing is still here: try adding it again.";
    } finally {
      submitting = false;
      if (publishButton) publishButton.disabled = !canPublish;
    }
  };

  svg.addEventListener("pointerdown", (evt) => {
    // A second finger mid-stroke is ignored rather than orphaning the first.
    if (submitting || drawing) return;
    beginGesture(toViewBox(evt));
    svg.setPointerCapture(evt.pointerId);
  });

  svg.addEventListener("pointermove", (evt) => {
    if (!drawing) return;
    addPoint(toViewBox(evt));
  });

  svg.addEventListener("pointerup", finish);
  // The system took the pointer away (a scroll, a palm, a notification):
  // that's not the hand choosing to finish, so nothing is kept.
  svg.addEventListener("pointercancel", () => {
    if (drawing) cancelGesture();
  });

  // A pointer is the only way to draw unless this exists: Enter/Space
  // starts a gesture at the wall's centre, the arrow keys add a point each
  // in that direction (mirroring pointermove), and Enter/Space again
  // finishes it into a draft, the same as lifting a pointer. Escape cancels
  // a gesture or discards a draft.
  const STEP = 30;
  const ARROW_DELTAS = {
    ArrowUp: [0, -STEP],
    ArrowDown: [0, STEP],
    ArrowLeft: [-STEP, 0],
    ArrowRight: [STEP, 0],
  };
  svg.addEventListener("keydown", (evt) => {
    if (submitting) return;
    if (evt.key === "Escape" && (drawing || draft)) {
      evt.preventDefault();
      if (drawing) cancelGesture();
      else discardDraft();
      status.textContent = "Discarded. Nothing was added.";
      return;
    }
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
    }
  });

  draftForm?.addEventListener("submit", (evt) => {
    evt.preventDefault();
    publish();
  });
  retryButton?.addEventListener("click", () => {
    discardDraft();
    status.textContent = "Cleared. Draw again whenever you're ready.";
    svg.focus();
  });
  modeButton?.addEventListener("click", () => {
    liveMode = !liveMode;
    // Turning live off mid-stroke takes the stroke off everyone else's
    // screen; turning it on never reaches back to share a stroke already
    // drawn in private.
    if (!liveMode) stopSender(true);
    describeMode();
    describeAudience();
  });
  describeMode();

  const nextAt = document.getElementById("next-at");
  if (nextAt) {
    const hours = nextAt.textContent.match(/\(([^)]*)\)/)?.[1];
    nextAt.textContent = `${nextAtPhrase(nextAt.getAttribute("datetime"))}${hours ? ` (${hours})` : ""}`;
  }

  // --- Watching everyone else ---------------------------------------------

  // Previews from other hands (and other tabs of this one), by gesture id.
  // Ended ids are remembered so a late event can't bring a preview back.
  const remote = new Map();
  // id -> when it ended. Forgotten after a while: by then the server has
  // refused any late update itself, and snapshots are authoritative.
  const endedRemote = new Map();
  const forgetAfter = previewLease * 4 + 10_000;
  const markEnded = (id) => {
    const now = Date.now();
    endedRemote.set(id, now);
    if (endedRemote.size > 200) {
      for (const [old, at] of endedRemote) {
        if (now - at > forgetAfter) endedRemote.delete(old);
        else break;
      }
    }
  };

  const describeLive = () => {
    if (!connection) return;
    const n = remote.size;
    connection.textContent = !streamOpen
      ? "Reconnecting to the wall…"
      : n === 0
        ? "Live: new marks appear as they're made."
        : `Live: ${n === 1 ? "someone is" : `${n} people are`} drawing right now.`;
  };

  const endPreview = (id, remember = true) => {
    const r = remote.get(id);
    if (remember) markEnded(id);
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
    if (published && mark.gesture === published.gesture) {
      // This tab's own stroke, already drawn: just name it.
      published.live?.setAttribute("data-id", mark.id);
      published.halo?.setAttribute("data-id", mark.id);
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
      if (mark.prompt) r.el.setAttribute("data-prompt", mark.prompt);
      applyFilter(r.el);
      describeLive();
    } else {
      appendStroke(mark.path, mark.colour, mark.id, mark.prompt);
    }
    rememberSeen(mark.id);
    if (mark.gesture) markEnded(mark.gesture);
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
    // Anything newer than the response arrived over SSE meanwhile: keep it.
    const ids = new Set(marks.map((m) => String(m.id)));
    const newest = Math.max(0, ...marks.map((m) => m.id));
    for (const el of svg.querySelectorAll("path[data-id]")) {
      const id = el.getAttribute("data-id");
      if (Number(id) <= newest && !ids.has(id)) el.remove();
    }
    for (const m of marks) {
      if (svg.querySelector(`[data-id="${m.id}"]`)) continue;
      if (m.mine) {
        // On top of everyone else's, but still under a stroke in progress.
        const inProgress = halo?.isConnected && !halo.hasAttribute("data-id") ? halo : null;
        const stroke = makePath({
          d: m.path,
          stroke: m.colour,
          class: "mine",
          "data-id": m.id,
          "data-prompt": m.prompt ?? undefined,
        });
        svg.insertBefore(makePath({ d: m.path, class: "halo", "data-id": m.id }), inProgress);
        svg.insertBefore(stroke, inProgress);
        applyFilter(stroke);
      } else {
        appendStroke(m.path, m.colour, m.id, m.prompt);
      }
    }
  };

  // --- What changed since the last visit ---------------------------------
  //
  // The highest mark id this browser has seen, kept only in this browser:
  // the server never learns when anyone looked.
  const SEEN_KEY = "trace:last-seen";
  const storage = (() => {
    try {
      return window.localStorage;
    } catch {
      return null; // storage blocked: just skip the highlight
    }
  })();
  const readSeen = () => {
    try {
      return Number(storage?.getItem(SEEN_KEY) ?? NaN);
    } catch {
      return NaN;
    }
  };
  function rememberSeen(id) {
    try {
      if (!(readSeen() >= Number(id))) storage?.setItem(SEEN_KEY, String(id));
    } catch {
      // storage full or blocked
    }
  }
  const committed = [...svg.querySelectorAll("path[data-id]:not(.halo)")];
  const lastSeen = readSeen();
  if (Number.isFinite(lastSeen)) {
    const unseen = committed.filter(
      (el) => Number(el.getAttribute("data-id")) > lastSeen && !el.classList.contains("mine"),
    );
    for (const el of unseen) el.classList.add("fresh");
    if (fresh && unseen.length > 0) {
      fresh.hidden = false;
      fresh.textContent = `${unseen.length === 1 ? "One mark is" : `${unseen.length} marks are`} new since you were last here, drawn wider.`;
    }
  }
  rememberSeen(Math.max(0, ...committed.map((el) => Number(el.getAttribute("data-id")))));

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
      // Not remembered as ended: after a server restart the drawer's tab
      // recreates its preview under the same id, and it should reappear.
      for (const id of [...remote.keys()]) if (!current.has(id)) endPreview(id, false);
      for (const p of snapshot) {
        const r = remote.get(p.gesture);
        if (r) r.points = [];
        showPreview({ ...p, from: 0 });
      }
    });
    stream.addEventListener("preview", (evt) => showPreview(JSON.parse(evt.data)));
    stream.addEventListener("preview-end", (evt) => endPreview(JSON.parse(evt.data).gesture));
    stream.addEventListener("mark", (evt) => showMark(JSON.parse(evt.data)));
    // A hand deleted one of its marks from My traces.
    stream.addEventListener("unmark", (evt) => {
      const { id } = JSON.parse(evt.data);
      for (const el of svg.querySelectorAll(`[data-id="${id}"]`)) el.remove();
    });
  };
  connect();
})();
