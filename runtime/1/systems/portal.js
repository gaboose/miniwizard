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
export function createPortalSystem(portals, { reach = 32, onTeleport } = {}) {
    // Teleport links follow Destination. Drawing also uses the reverse
    // direction, so the trailing half shows even for one-way portals.
    const links = [];
    const viewLinks = [];
    for (const p of portals) {
        if (!p.destination) continue;
        const fwd = createLink(p, p.destination);
        links.push(fwd);
        viewLinks.push(fwd);
    }
    for (const l of links) {
        if (!viewLinks.some((v) => v.from === l.to)) viewLinks.push(createLink(l.to, l.from));
    }

    const entities = new Map(); // entity -> { prev: {x, y} }

    function teleport(entity, link) {
        const p = link.point(entity.pos);
        // Mutate in place: other systems (camera) hold this object
        entity.pos.x = p.x;
        entity.pos.y = p.y;
        entity.facing = link.facing(entity.facing);
        onTeleport?.(entity, link);
    }

    // The sprite copies to draw for an entity: itself (clipped at the edge it
    // is next to) and its continuation at the other portal.
    function views(entity) {
        const { pos, facing } = entity;
        for (const link of viewLinks) {
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

        // `teleport: false` for entities that only need the drawing (e.g.
        // remote players whose position comes from the network).
        addEntity(entity, { teleport = true } = {}) {
            entities.set(entity, { teleport, prev: { ...entity.pos } });
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
                if (state.teleport) {
                    for (const link of links) {
                        const before = local(link.from, state.prev).depth;
                        const now = local(link.from, entity.pos);
                        if (before <= 0 && now.depth > 0 && inSpan(link.from, now.along)) {
                            teleport(entity, link);
                            break;
                        }
                    }
                }
                state.prev.x = entity.pos.x;
                state.prev.y = entity.pos.y;
                entity.views = views(entity);
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
