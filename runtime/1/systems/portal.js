// Portals: walk through one portal's edge and come out of its destination's.
//
// A portal is an LDtk "Portal" entity: a rectangle with
//   Destination: EntityRef  -> the exit portal
//   Edge: Left|Right|Up|Down -> the side of the rectangle that is the actual
//                               portal border (the opening you walk through)
//
// Space on the far side of an entry edge is glued to the space in front of the
// exit edge: a point that is `d` px past the entry edge maps to the point `d`
// px out in front of the exit edge, at the same offset along the edge. So while
// the player is crossing, the part of the sprite past the entry edge is cut off
// there and drawn, pixel column by pixel column, coming out of the exit.
// Once the player's pivot (its feet) crosses the edge the player is moved to
// the exit, and the part still behind is drawn at the entry the same way.
//
// Portals must be paired: A's Destination is B and B's is A. A portal that
// isn't part of such a pair is reported and becomes a solid line.
//
// Collision (`blockers`, used with an entity's body box in collision.js):
// the edge is solid from behind, so it can only be entered from the front,
// and both ends of the edge are solid 0px points, so nothing can pass the
// frame of the portal sticking out past its ends.

const DIRS = {
    // inward normal: the direction you walk to go through that edge
    Left:  { x:  1, y:  0 },
    Right: { x: -1, y:  0 },
    Up:    { x:  0, y:  1 },
    Down:  { x:  0, y: -1 },
};

const BIG = 1 << 16;

// Read Portal entities from an LDtk level's layer instances.
export function loadPortals(layers) {
    const raw = (layers ?? [])
        .flatMap((layer) => layer.entityInstances ?? [])
        .filter((e) => e.__identifier === "Portal");

    const field = (e, name) => e.fieldInstances.find((f) => f.__identifier === name)?.__value;

    const byIid = new Map();
    for (const e of raw) {
        const [pivotX, pivotY] = e.__pivot ?? [0, 0];
        const edge = field(e, "Edge");
        if (!(edge in DIRS)) {
            console.warn("portal without a valid Edge:", e.iid, edge);
            continue;
        }
        byIid.set(e.iid, createPortal({
            id: e.iid,
            x: e.px[0] - pivotX * e.width,
            y: e.px[1] - pivotY * e.height,
            w: e.width,
            h: e.height,
            edge,
            destinationId: field(e, "Destination")?.entityIid ?? null,
        }));
    }

    for (const p of byIid.values()) {
        p.destination = byIid.get(p.destinationId) ?? null;
        if (p.destinationId && !p.destination) {
            console.warn("portal destination not found in this level:", p.id, p.destinationId);
        }
    }
    // Only mutual pairs link; anything else is a solid line.
    const paired = (p) => p.destination?.destination === p && p.destination !== p;
    const unpaired = [...byIid.values()].filter((p) => !paired(p));
    for (const p of unpaired) {
        console.warn("portal is not paired with a portal that leads back to it; it is solid:", p.id);
    }
    for (const p of unpaired) p.destination = null;
    return [...byIid.values()];
}

function createPortal({ id, x, y, w, h, edge, destinationId }) {
    const n = DIRS[edge];
    const vertical = n.x !== 0; // the edge line is vertical
    // Point on the edge line, and the edge's center
    const lineX = edge === "Right" ? x + w : x;
    const lineY = edge === "Down" ? y + h : y;
    return {
        id, edge, destinationId, destination: null,
        rect: { x, y, w, h },
        n,                                    // inward normal
        t: vertical ? { x: 0, y: 1 } : { x: 1, y: 0 }, // along the edge
        center: vertical ? { x: lineX, y: y + h / 2 } : { x: x + w / 2, y: lineY },
        halfLength: (vertical ? h : w) / 2,
    };
}

// The mapping from the space past `from`'s edge to the space in front of
// `to`'s edge. Portals are axis aligned, so this is a translation, a mirror
// (edges facing the same way) or a quarter turn (edges at right angles).
function createLink(from, to) {
    const out = { x: -to.n.x, y: -to.n.y }; // outward normal of the exit
    const sameAxis = (out.x !== 0) === (from.n.x !== 0);
    // Same axis: keep the along-edge direction so up stays up (a translation,
    // or a mirror when both edges face the same way). Otherwise it's the
    // quarter turn that takes the inward normal to the outward one.
    const m = sameAxis
        ? mat(from.n, from.t, out, from.t)
        : mat(from.n, perp(from.n), out, perp(out));

    function point(p) {
        const dx = p.x - from.center.x;
        const dy = p.y - from.center.y;
        return {
            x: to.center.x + m.xx * dx + m.xy * dy,
            y: to.center.y + m.yx * dx + m.yy * dy,
        };
    }
    function facing(f) {
        const fx = f === "left" ? -1 : 1;
        const x = m.xx * fx; // the y component of a facing vector is 0
        if (x > 0) return "right";
        if (x < 0) return "left";
        return f;
    }
    return { from, to, point, facing };
}

const perp = (v) => ({ x: -v.y, y: v.x });

// Matrix sending a -> c and b -> d, for orthonormal a, b.
function mat(a, b, c, d) {
    // M = [c d] * [a b]^T  (since [a b] is orthonormal its inverse is its transpose)
    return {
        xx: c.x * a.x + d.x * b.x,
        xy: c.x * a.y + d.x * b.y,
        yx: c.y * a.x + d.y * b.x,
        yy: c.y * a.y + d.y * b.y,
    };
}

// Signed distance past the portal's edge (> 0 means through it), and the
// offset along the edge from its center.
function local(portal, p) {
    const dx = p.x - portal.center.x;
    const dy = p.y - portal.center.y;
    return {
        depth: dx * portal.n.x + dy * portal.n.y,
        along: dx * portal.t.x + dy * portal.t.y,
    };
}

function inSpan(portal, along) {
    return along >= -portal.halfLength && along <= portal.halfLength;
}

// Clip to the side of a portal's edge line that is in front of it.
function clipFront(ctx, portal, scale) {
    const { n, center } = portal;
    ctx.beginPath();
    if (n.x !== 0) {
        const x = center.x * scale;
        if (n.x > 0) ctx.rect(x - BIG, -BIG, BIG, 2 * BIG);
        else ctx.rect(x, -BIG, BIG, 2 * BIG);
    } else {
        const y = center.y * scale;
        if (n.y > 0) ctx.rect(-BIG, y - BIG, 2 * BIG, BIG);
        else ctx.rect(-BIG, y, 2 * BIG, BIG);
    }
    ctx.clip();
}

// `reach` is how far (world px) a sprite extends from its pivot; within that
// distance of an edge the sprite is split between the two portals.
// The solid parts of portals, for collision.js.
//   segments: { vertical, c, lo, hi, blocks } the edge line at x (vertical)
//             or y = c, from lo to hi; `blocks` is the direction of motion
//             (+1 / -1 along the crossing axis) it stops, 0 for both.
//   points:   { x, y } the ends of every edge.
function createBlockers(portals) {
    const segments = [];
    const points = [];
    for (const p of portals) {
        const vertical = p.n.x !== 0;
        const { x, y, w, h } = p.rect;
        const c = vertical ? p.center.x : p.center.y;
        const [lo, hi] = vertical ? [y, y + h] : [x, x + w];
        // Walking from behind to the front is moving against the inward normal.
        const blocks = p.destination ? -(vertical ? p.n.x : p.n.y) : 0;
        segments.push({ vertical, c, lo, hi, blocks });
        if (vertical) points.push({ x: c, y: lo }, { x: c, y: hi });
        else points.push({ x: lo, y: c }, { x: hi, y: c });
    }
    return { segments, points };
}

export function createPortalSystem(portals, { reach = 32, onTeleport } = {}) {
    // Portals are paired (see loadPortals), so every link has its reverse.
    const links = portals.filter((p) => p.destination).map((p) => createLink(p, p.destination));
    const blockers = createBlockers(portals);

    // entity -> { teleport, side: Map(portal -> -1 front / 1 behind) }
    // `side` is the side of each portal's edge the entity was last strictly
    // on. Standing exactly on the line (e.g. stopped there from behind)
    // keeps the old side, so only crossings that start in front teleport.
    const entities = new Map();

    function sides(entity) {
        const side = new Map();
        for (const link of links) side.set(link.from, local(link.from, entity.pos).depth > 0 ? 1 : -1);
        return side;
    }

    function teleport(entity, link) {
        const p = link.point(entity.pos);
        // Mutate in place: other systems (camera) hold this object
        entity.pos.x = p.x;
        entity.pos.y = p.y;
        entity.facing = link.facing(entity.facing);
        onTeleport?.(entity, link);
    }

    // The sprite copies to draw for an entity: itself (clipped at the edge it
    // is next to) and its continuation at the other portal. Only from the
    // front: on the line itself, `side` says which side it came from.
    function views(entity, side) {
        const { pos, facing } = entity;
        for (const link of links) {
            if (side.get(link.from) > 0) continue;
            const { depth, along } = local(link.from, pos);
            if (depth > 0 || depth <= -reach || !inSpan(link.from, along)) continue;
            const ghost = link.point(pos);
            return [
                { x: pos.x, y: pos.y, facing, clip: (ctx, s) => clipFront(ctx, link.from, s) },
                { x: ghost.x, y: ghost.y, facing: link.facing(facing), clip: (ctx, s) => clipFront(ctx, link.to, s) },
            ];
        }
        return null;
    }

    return {
        portals,
        blockers,

        // `teleport: false` for entities that only need the drawing (e.g.
        // remote players whose position comes from the network).
        addEntity(entity, { teleport = true } = {}) {
            entities.set(entity, { teleport, side: sides(entity) });
            return {
                destroy() {
                    entities.delete(entity);
                    delete entity.views;
                },
            };
        },

        // Run after movement/collision.
        update() {
            for (const [entity, state] of entities) {
                let teleported = false;
                for (const link of links) {
                    const now = local(link.from, entity.pos);
                    if (now.depth === 0) continue;
                    const before = state.side.get(link.from);
                    state.side.set(link.from, now.depth > 0 ? 1 : -1);
                    if (state.teleport && before < 0 && now.depth > 0 && inSpan(link.from, now.along)) {
                        teleport(entity, link);
                        teleported = true;
                        break;
                    }
                }
                // Everything moved; start the sides over from the exit.
                if (teleported) state.side = sides(entity);
                entity.views = views(entity, state.side);
            }
        },

        // For the collision system: a solid overlap entirely inside a portal's
        // rectangle doesn't block, so portals can sit in walls.
        passable(box) {
            for (const p of portals) {
                const r = p.rect;
                if (box.l >= r.x && box.r <= r.x + r.w && box.t >= r.y && box.b <= r.y + r.h) return true;
            }
            return false;
        },
    };
}
