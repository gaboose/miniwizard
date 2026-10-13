// Movement and collision for one entity.
//
// Two boxes move together with the entity's position:
//   entity.hitbox      (feet)  collides with wall solids from the grid
//   entity.bodyHitbox  (body)  collides only with portal geometry (`blockers`)
//
// Each axis is swept separately: the box stops at the nearest blocking face in
// the direction of motion. Solids the box already overlaps are ignored (never
// snapped to), so an overlap can't push the entity anywhere.
//
// Deflection: when a move is blocked and shifting up to 1px sideways frees it
// in exactly one direction (stair steps, a corner clipped by <= 1px), the move
// is treated as pushing against a 45° slope: only its component along the
// slope is kept (so pressing → against it moves at 1/√2 speed, pressing
// straight into it stops, and moving along it keeps full speed).
//
// `passable(overlap)` may return true to ignore a wall solid (portals use it so
// they can sit inside walls). `blockers` is { segments, points } of portal
// geometry, see portal.js.

const EPS = 1e-6;
const NUDGE = 1; // px tried sideways when blocked
const STEP = 0.25; // max px per axis per sub-step

export function createCollisionSystem(entity, grid, { passable, blockers } = {}) {
  const { cellSize: C, width, height, cells } = grid;

  const boxAt = (pos, hb) => {
    const l = pos.x + hb.x;
    const t = pos.y + hb.y;
    return { l, t, r: l + hb.w, b: t + hb.h };
  };

  // Along-axis interval [lo, hi] and perpendicular interval [plo, phi].
  const split = (box, axis) =>
    axis === "x"
      ? [box.l, box.r, box.t, box.b]
      : [box.t, box.b, box.l, box.r];

  // How far a face at `face` moving by `d` may go before hitting a wall at
  // `wall`; returns `allowed` reduced if the wall is in the way.
  function limit(allowed, d, face, wall) {
    if (d > 0) {
      if (face > wall + EPS) return allowed; // already past it
      const lim = wall - face;
      return lim < allowed ? Math.max(0, lim) : allowed;
    } else {
      if (face < wall - EPS) return allowed;
      const lim = wall - face;
      return lim > allowed ? Math.min(0, lim) : allowed;
    }
  }

  function sweepWalls(box, axis, d) {
    const [lo, hi, plo, phi] = split(box, axis);
    const face = d > 0 ? hi : lo;
    // Cells touched by the swept box
    const sl = axis === "x" ? Math.min(box.l, box.l + d) : box.l;
    const sr = axis === "x" ? Math.max(box.r, box.r + d) : box.r;
    const st = axis === "y" ? Math.min(box.t, box.t + d) : box.t;
    const sb = axis === "y" ? Math.max(box.b, box.b + d) : box.b;
    const x0 = Math.max(0, Math.floor(sl / C));
    const y0 = Math.max(0, Math.floor(st / C));
    const x1 = Math.min(width - 1, Math.floor((sr - EPS) / C));
    const y1 = Math.min(height - 1, Math.floor((sb - EPS) / C));

    let allowed = d;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        for (const s of cells[gy * width + gx] ?? []) {
          const [slo, shi, splo, sphi] =
            axis === "x"
              ? [s.x, s.x + s.w, s.y, s.y + s.h]
              : [s.y, s.y + s.h, s.x, s.x + s.w];
          if (Math.min(phi, sphi) - Math.max(plo, splo) <= EPS) continue;
          const next = limit(allowed, d, face, d > 0 ? slo : shi);
          if (next === allowed) continue;
          if (passable) {
            // The part of the solid the unblocked move would enter
            const end = axis === "x"
              ? { l: box.l + d, r: box.r + d, t: box.t, b: box.b }
              : { l: box.l, r: box.r, t: box.t + d, b: box.b + d };
            const overlap = {
              l: Math.max(end.l, s.x),
              t: Math.max(end.t, s.y),
              r: Math.min(end.r, s.x + s.w),
              b: Math.min(end.b, s.y + s.h),
            };
            if (passable(overlap)) continue;
          }
          allowed = next;
        }
      }
    }
    return allowed;
  }

  function sweepPortals(box, axis, d) {
    if (!blockers) return d;
    const [lo, hi, plo, phi] = split(box, axis);
    const face = d > 0 ? hi : lo;
    let allowed = d;
    // Segments only block movement across them (posts cover their ends).
    for (const seg of blockers.segments) {
      if (seg.vertical !== (axis === "x")) continue;
      // `blocks`: the direction of motion that is stopped; 0 = both.
      if (seg.blocks !== 0 && seg.blocks !== Math.sign(d)) continue;
      if (Math.min(phi, seg.hi) - Math.max(plo, seg.lo) <= EPS) continue;
      allowed = limit(allowed, d, face, seg.c);
    }
    // 0px points: block when strictly inside the box's perpendicular extent.
    for (const p of blockers.points) {
      const [pc, pp] = axis === "x" ? [p.x, p.y] : [p.y, p.x];
      if (pp <= plo + EPS || pp >= phi - EPS) continue;
      allowed = limit(allowed, d, face, pc);
    }
    return allowed;
  }

  // How far the entity at `pos` may move by `d` along `axis`.
  function sweep(pos, axis, d) {
    if (d === 0) return 0;
    let a = sweepWalls(boxAt(pos, entity.hitbox), axis, d);
    if (entity.bodyHitbox && a !== 0) {
      a = sweepPortals(boxAt(pos, entity.bodyHitbox), axis, a);
    }
    return a;
  }

  // Move by up to `d`; returns the blocked remainder.
  function move(axis, d) {
    const a = sweep(entity.pos, axis, d);
    entity.pos[axis] += a;
    return Math.abs(d - a) <= EPS ? 0 : d - a;
  }

  // If moving by `d` along `axis` is blocked, and a sideways shift of up to
  // 1px frees it in exactly one direction, return that direction (-1 / 1).
  function nudgeSide(axis, d) {
    const other = axis === "x" ? "y" : "x";
    const free = Math.abs(sweep(entity.pos, axis, d));
    if (free >= Math.abs(d) - EPS) return 0;
    const sides = [];
    for (const s of [-1, 1]) {
      const q = sweep(entity.pos, other, s * NUDGE);
      if (Math.abs(q) <= EPS) continue;
      const shifted = { ...entity.pos, [other]: entity.pos[other] + q };
      if (Math.abs(sweep(shifted, axis, d)) > free + EPS) sides.push(s);
    }
    return sides.length === 1 ? sides[0] : 0;
  }

  // The 45° slope the move (vx, vy) is pushing into, as an unnormalized
  // tangent { x, y, axis } (axis: the blocked one), or null.
  function findSlope(vx, vy) {
    for (const [axis, d] of [["x", vx], ["y", vy]]) {
      if (d === 0) continue;
      const s = nudgeSide(axis, d);
      if (s === 0) continue;
      const sign = Math.sign(d);
      return axis === "x" ? { x: sign, y: s, axis } : { x: s, y: sign, axis };
    }
    return null;
  }

  return {
    update(delta) {
      // A long frame gap (background tab) shouldn't turn into a huge sweep.
      delta = Math.min(delta, 0.25);
      const { movementSource, speed } = entity;
      const dir = movementSource.direction;
      const mag = Math.hypot(dir.x, dir.y);
      if (mag > 1.0) {
        const f = 1.0 / mag;
        dir.x *= f;
        dir.y *= f;
      }
      if (dir.x > 0) entity.facing = "right";
      else if (dir.x < 0) entity.facing = "left";
      const dx = dir.x * speed * delta;
      const dy = dir.y * speed * delta;

      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / STEP));
      const sx = dx / steps;
      const sy = dy / steps;

      const stepLen = Math.hypot(sx, sy);
      for (let i = 0; i < steps; i++) {
        const t = findSlope(sx, sy);
        if (!t) {
          const r = move("x", sx);
          move("y", sy);
          // y may have opened the way for x
          if (r !== 0) move("x", r);
          continue;
        }
        // Keep only the part of the move along the slope; pushing straight
        // into it leaves nothing.
        const k = (sx * t.x + sy * t.y) / 2; // |t|² = 2
        if (k <= EPS) continue;
        const axis = t.axis;
        const other = axis === "x" ? "y" : "x";
        // Sideways (away from the slope) first, so the blocked axis has room.
        move(other, k * t[other]);
        // On 1px stairs the blocked axis can't advance until the sideways
        // move reaches the next step; spend what it loses sideways instead,
        // as long as the sub-step stays no longer than the input's. On a 45°
        // staircase that nets out to 1/√2 speed.
        const lost = Math.abs(move(axis, k * t[axis]));
        const along = k - lost;
        const extra = Math.min(lost, Math.sqrt(Math.max(0, stepLen * stepLen - along * along)) - k);
        if (extra > EPS) move(other, extra * t[other]);
      }
    },
  };
}
