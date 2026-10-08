// dt is expected in seconds.
export function createCameraSystem({ worldCanvas, outCanvas, pos, boxes = [], handoffRate = 10 }) {
    const wc = worldCanvas.getContext("2d");
    const cam = { x: pos.x, y: pos.y, zoom: 1.0 };

    const box = createGuideBox({ pos, boxes });
    const gesture = createGuideGesture({ canvas: outCanvas, cam, pos });
    const move = createGuideMove();

    cam.zoom = gesture.level();

    const startBox = box.box();
    if (startBox != null) {
        const t = move.snapBox(startBox, outCanvas);
        cam.x = t.x;
        cam.y = t.y;
        cam.zoom = t.zoom;
        gesture.setLevel(cam.zoom);
    }

    // When fingers take over the camera (e.g. the player walks out of a box
    // mid-drag), the view on screen and the gesture's view can differ. Instead
    // of snapping, keep that difference as an offset and shrink it to zero.
    let handoff = null;       // { x, y, lz }: displayed minus gesture view
    let wasLive = false;

    const ctx = outCanvas.getContext("2d");

    var boxIsActive = false;

    return {
        cam,

        update(dt) {
            gesture.update(dt);

            const b = box.box();
            const live = b == null && gesture.isLive();

            if (live && !wasLive) {
                const t = gesture.pos();
                handoff = {
                    x: cam.x - t.x,
                    y: cam.y - t.y,
                    lz: Math.log(cam.zoom) - Math.log(gesture.level()),
                };
            }
            if (!live) handoff = null;
            wasLive = live;

            boxIsActive = b != null;
            if (boxIsActive) {
                move.easeBox(dt, cam, b, outCanvas);
                gesture.setLevel(cam.zoom);
            } else if (live) {
                // Track the gesture exactly, plus whatever is left of the offset
                const t = gesture.pos();
                const z = gesture.level();
                if (handoff) {
                    const k = Math.exp(-handoffRate * dt);
                    handoff.x *= k;
                    handoff.y *= k;
                    handoff.lz *= k;
                    // Done once it's under half a canvas pixel
                    if (Math.hypot(handoff.x, handoff.y) * z < 0.5 && Math.abs(handoff.lz) < 1e-3) {
                        handoff = null;
                    }
                }
                cam.x = t.x + (handoff?.x ?? 0);
                cam.y = t.y + (handoff?.y ?? 0);
                cam.zoom = z * Math.exp(handoff?.lz ?? 0);
                return;
            } else {
                if (gesture.instantZoom()) cam.zoom = gesture.level();
                else move.easeZoom(dt, cam, gesture.level());

                move.easePos(dt, cam, gesture.pos() ?? pos);
            }

            // A finger that is down but hasn't moved yet must grab what is
            // on screen now, not where the camera was when it touched
            gesture.sync();
        },

        draw() {
            ctx.clearRect(0, 0, outCanvas.width, outCanvas.height);
            ctx.drawImage(
                worldCanvas,
                0, 0,
                worldCanvas.width,
                worldCanvas.height,
                Math.round(outCanvas.width / 2 - cam.x * cam.zoom),
                Math.round(outCanvas.height / 2 - cam.y * cam.zoom),
                worldCanvas.width * cam.zoom,
                worldCanvas.height * cam.zoom,
            );
        },

        // Direction toward the pending drag target ({0, 0} when there is none).
        // Same shape as the input system's movement source, so it plugs into
        // combineMovementSources as `cameraDrag`.
        newMovementSource({ arriveRadius = 8 } = {}) {
            return {
                get direction() {
                    const t = gesture.pos();
                    if (!t) return { x: 0, y: 0 };
                    const dx = t.x - pos.x;
                    const dy = t.y - pos.y;
                    const d = Math.hypot(dx, dy);
                    if (d <= gesture.epsilon) return { x: 0, y: 0 };
                    // Unit length when far away, shrinking inside arriveRadius
                    // so the player slows down instead of overshooting
                    const s = Math.min(1, d / arriveRadius) / d;
                    return { x: dx * s, y: dy * s };
                },
            };
        },

        target() {
            return boxIsActive ? { ...gesture.pos() } : null;
        },

        destroy() {
            gesture.destroy();
        },
    };
}

function createGuideBox({ pos, boxes = [] }) {
    return {
        box() {
            for (const b of boxes) {
                if (
                    pos.x > b.x &&
                    pos.x < b.x + b.width &&
                    pos.y > b.y &&
                    pos.y < b.y + b.height
                ) {
                    return b;
                }
            }
            return null;
        },
    };
}

// One model for every pointer gesture, like a map: whatever world point is
// under the fingers when they go down stays under them. One finger pans,
// two fingers pan and zoom at the same time around their midpoint.
//
// The resulting view position is the drag target: the camera looks at it and
// the player walks to it; it clears once the player arrives (or gets stuck).
function createGuideGesture({
    canvas,
    cam,
    pos,
    min = 1.0,            // zoom limits in CSS px per world px
    max = 4,
    wheelSpeed = 0.0015,  // mouse wheel
    pinchWheelSpeed = 0.01, // trackpad pinch (wheel + ctrlKey) sends small deltas
    slop = 4,             // CSS px a single finger must move before it pans
    friction = 6,         // fling decay per second (higher stops sooner)
    minFlingSpeed = 150,  // CSS px/s needed to start a fling
    epsilon = 0.5,
    minProgress = 0.1,    // world px the player must close to count as progress
    stuckTimeout = 0.3,   // seconds without progress before giving up
}) {
    const dpr = () => window.devicePixelRatio ?? 1;
    const lo = () => min * dpr();
    const hi = () => max * dpr();

    let level = lo();
    let instant = false;      // last zoom came from a continuous gesture
    let target = null;        // world-space view position / walk target
    let velocity = null;      // world px/s while flinging
    let moved = false;        // the current gesture has changed the view
    let anchor = null;        // { world, dist, level, down }
    let samples = [];         // recent target positions for fling velocity
    const pointers = new Map(); // pointerId -> canvas px

    let bestDist = Infinity;
    let stuckTime = 0;
    function resetProgress() {
        bestDist = Infinity;
        stuckTime = 0;
    }

    // Clamp to [lo, hi], but if the level is already outside that range
    // (a camera box put it there), allow moving back toward it, never further.
    function softClamp(z, from) {
        const floor = Math.min(lo(), from);
        const ceil = Math.max(hi(), from);
        return Math.min(ceil, Math.max(floor, z));
    }

    // Convert client (CSS px) coordinates to canvas pixel coordinates
    function toCanvas(e) {
        const r = canvas.getBoundingClientRect();
        return {
            x: (e.clientX - r.left) * (canvas.width / r.width),
            y: (e.clientY - r.top) * (canvas.height / r.height),
        };
    }

    function centroid() {
        let x = 0, y = 0;
        for (const p of pointers.values()) {
            x += p.x;
            y += p.y;
        }
        return { x: x / pointers.size, y: y / pointers.size };
    }

    function spread() {
        if (pointers.size < 2) return 0;
        const [a, b] = pointers.values();
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    // What is on screen right now. While a gesture or fling owns the view the
    // camera matches it exactly, so use the gesture's own (newer) values.
    function view() {
        if (target && (moved || velocity)) return { x: target.x, y: target.y, zoom: level };
        return { x: pos.x, y: pos.y, zoom: cam.zoom };
    }

    // Pin the world point under the fingers. Called whenever the number of
    // fingers changes, so adding or lifting a finger never makes the view jump.
    function rebase(keepDown = false) {
        if (pointers.size === 0) {
            anchor = null;
            return;
        }
        const v = view();
        const c = centroid();
        anchor = {
            world: {
                x: v.x + (c.x - canvas.width / 2) / v.zoom,
                y: v.y + (c.y - canvas.height / 2) / v.zoom,
            },
            dist: spread(),
            level: v.zoom,
            // Where the touch started, for the slop check
            down: keepDown && anchor ? anchor.down : c,
        };
        level = v.zoom;
    }

    function apply() {
        const c = centroid();
        const d = spread();
        level = anchor.dist > 0 && d > 0
            ? softClamp(anchor.level * (d / anchor.dist), anchor.level)
            : anchor.level;
        instant = true;
        // Keep anchor.world under the centroid at the new zoom
        target = {
            x: anchor.world.x - (c.x - canvas.width / 2) / level,
            y: anchor.world.y - (c.y - canvas.height / 2) / level,
        };
        moved = true;

        // Only one-finger pans fling. During a pinch the target also moves
        // because of the zoom, and flinging that sends the view sliding off.
        if (pointers.size !== 1) return;
        const now = performance.now();
        samples.push({ t: now, x: target.x, y: target.y });
        while (samples.length && now - samples[0].t > 100) samples.shift();
    }

    function startFling() {
        const now = performance.now();
        samples = samples.filter((s) => now - s.t <= 100);
        if (samples.length < 2) return;
        const a = samples[0];
        const b = samples[samples.length - 1];
        if (now - b.t > 50) return; // the finger had stopped before lifting
        const dt = (b.t - a.t) / 1000;
        if (dt <= 0) return;
        const v = { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
        // Compare in CSS px/s so it feels the same at every zoom and screen
        if (Math.hypot(v.x, v.y) * level / dpr() < minFlingSpeed) return;
        velocity = v;
    }

    const onPointerDown = (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        // Touching during a fling catches it, like a map
        if (velocity) moved = true;
        velocity = null;
        pointers.set(e.pointerId, toCanvas(e));
        rebase();
        samples = [];
        resetProgress();
    };

    const onPointerMove = (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, toCanvas(e));
        // Ignore tiny single-finger jitter so a tap doesn't set a walk target
        if (!moved && pointers.size === 1) {
            const c = centroid();
            if (Math.hypot(c.x - anchor.down.x, c.y - anchor.down.y) < slop * dpr()) return;
        }
        apply();
    };

    const onPointerEnd = (e) => {
        if (!pointers.delete(e.pointerId)) return;
        if (pointers.size > 0) {
            rebase();
            // Lifting one finger of a pinch shouldn't fling with the other
            samples = [];
            return;
        }
        if (moved) startFling();
        moved = false;
        anchor = null;
        resetProgress();
    };

    const onWheel = (e) => {
        e.preventDefault();
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;                       // lines
        else if (e.deltaMode === 2) dy *= canvas.clientHeight; // pages
        const speed = e.ctrlKey ? pinchWheelSpeed : wheelSpeed;
        level = softClamp(level * Math.exp(-dy * speed), level);
        // Trackpad pinch is continuous: apply directly. Mouse notches get a
        // short ease so each step glides instead of jumping.
        instant = e.ctrlKey;
    };

    // Safari trackpad pinch (non-standard gesture events). iOS also sends
    // these for touch pinches, which the pointer handlers already cover.
    let gestureStartLevel = level;
    const onGestureStart = (e) => {
        e.preventDefault();
        gestureStartLevel = level;
    };
    const onGestureChange = (e) => {
        e.preventDefault();
        if (pointers.size > 0) return;
        level = softClamp(gestureStartLevel * e.scale, gestureStartLevel);
        instant = true;
    };

    // Stop the browser from scrolling or zooming the page on the canvas
    const prevTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = "none";

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerEnd);
    canvas.addEventListener("pointercancel", onPointerEnd);
    canvas.addEventListener("lostpointercapture", onPointerEnd);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("gesturestart", onGestureStart);
    canvas.addEventListener("gesturechange", onGestureChange);

    return {
        epsilon,

        update(dt) {
            if (velocity) {
                target.x += velocity.x * dt;
                target.y += velocity.y * dt;
                const k = Math.exp(-friction * dt);
                velocity.x *= k;
                velocity.y *= k;
                if (Math.hypot(velocity.x, velocity.y) * level / dpr() < 10) velocity = null;
                resetProgress();
                return;
            }

            if (!target || pointers.size > 0) return;
            const d = Math.hypot(pos.x - target.x, pos.y - target.y);
            if (d <= epsilon) {
                target = null; // player arrived
                return;
            }
            // Give up if the player stops closing in: blocked by a wall,
            // or the keyboard took over and walked somewhere else
            if (d < bestDist - minProgress) {
                bestDist = d;
                stuckTime = 0;
            } else if ((stuckTime += dt) > stuckTimeout) {
                target = null;
            }
        },

        // Called by the camera after it moves: until a touch changes the view,
        // keep its anchor on what is actually displayed
        sync() {
            if (pointers.size > 0 && !moved) rebase(true);
        },

        // True while fingers or a fling own the view
        isLive() {
            return target !== null && ((pointers.size > 0 && moved) || velocity !== null);
        },
        pos() {
            return target ? { ...target } : null;
        },
        level() {
            return level;
        },
        instantZoom() {
            return instant;
        },
        // Boxes set the level directly; no clamping, so leaving a box keeps its zoom
        setLevel(z) {
            level = z;
        },
        isDragging() {
            return pointers.size > 0;
        },
        isPinching() {
            return pointers.size >= 2;
        },
        destroy() {
            canvas.removeEventListener("pointerdown", onPointerDown);
            canvas.removeEventListener("pointermove", onPointerMove);
            canvas.removeEventListener("pointerup", onPointerEnd);
            canvas.removeEventListener("pointercancel", onPointerEnd);
            canvas.removeEventListener("lostpointercapture", onPointerEnd);
            canvas.removeEventListener("wheel", onWheel);
            canvas.removeEventListener("gesturestart", onGestureStart);
            canvas.removeEventListener("gesturechange", onGestureChange);
            canvas.style.touchAction = prevTouchAction;
        },
    };
}

function createGuideMove({ posRate = 10, zoomRate = 20 } = {}) {
    // Frame-rate independent exponential smoothing factor
    const factor = (rate, dt) => 1 - Math.exp(-rate * dt);

    function easePos(dt, cam, t) {
        const a = factor(posRate, dt);
        cam.x += (t.x - cam.x) * a;
        cam.y += (t.y - cam.y) * a;
    }

    function easeZoom(dt, cam, z) {
        // Ease in log space so zooming in and out feel symmetric
        const a = factor(zoomRate, dt);
        const lz = Math.log(cam.zoom);
        cam.zoom = Math.exp(lz + (Math.log(z) - lz) * a);
    }

    function easeBox(dt, cam, b, view) {
        const t = snapBox(b, view);
        easePos(dt, cam, { x: t.x, y: t.y });
        easeZoom(dt, cam, t.zoom);
    }

    function snapBox(b, view) {
        return {
            x: b.x + b.width / 2,
            y: b.y + b.height / 2,
            zoom: Math.min(view.width / b.width, view.height / b.height),
        };
    }

    return { easePos, easeZoom, easeBox, snapBox };
}