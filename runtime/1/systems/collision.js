// `passable(overlap)` may return true to ignore an overlap with a solid rect
// (portals use it so they can sit inside walls).
export function createCollisionSystem(entity, grid, { passable } = {}) {
  const { cellSize, width, height, solid, bottom } = grid;

function overlapsSolid(grid, box) {
  const { cellSize: C, width, height, cells } = grid;
  const x0 = Math.max(0, Math.floor(box.l / C));
  const y0 = Math.max(0, Math.floor(box.t / C));
  const x1 = Math.min(width - 1, Math.floor((box.r - 1) / C));
  const y1 = Math.min(height - 1, Math.floor((box.b - 1) / C));
  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      for (const s of cells[gy * width + gx] ?? []) {
        const l = Math.max(box.l, s.x);
        const t = Math.max(box.t, s.y);
        const r = Math.min(box.r, s.x + s.w);
        const b = Math.min(box.b, s.y + s.h);
        if (r > l && b > t && !passable?.({ l, t, r, b })) return { l, t, r, b };
      }
    }
  }
  return null;
}

  return {
    update(delta) {
      const { pos, movementSource, hitbox: hb, speed } = entity;
      const dir = movementSource.direction;
      const mag = Math.hypot(dir.x, dir.y);
      if (mag > 1.0) {
        const f = 1.0 / mag;
        dir.x *= f;
        dir.y *= f;
      }
      if (dir.x > 0) entity.facing = "right"
      else if (dir.x < 0) entity.facing = "left"
      const dx = dir.x * speed * delta;
      const dy = dir.y * speed * delta;

      // Sub-step so neither axis advances more than one cell at a time —
      // prevents tunneling on tab-return / frame-drop / speed boosts.
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / Math.min(hb.w, hb.h, cellSize)));
      const sx = dx / steps;
      const sy = dy / steps;

      for (let i = 0; i < steps; i++) {
        // X axis: move, then resolve the leading edge against its column.
        pos.x += sx;
        let t = pos.y + hb.y;
        let b = t + hb.h;
        let l = pos.x + hb.x;
        let r = l + hb.w;

        let intersection = overlapsSolid(grid, {t, b, l, r});
        if (intersection) {
          if (sx > 0) pos.x = intersection.l - hb.x - hb.w;
          if (sx < 0) pos.x = intersection.r - hb.x;
        }

        pos.y += sy;
        t = pos.y + hb.y;
        b = t + hb.h;
        l = pos.x + hb.x;
        r = l + hb.w;
        
        intersection = overlapsSolid(grid, {t, b, l, r});
        if (intersection) {
          if (sy > 0) pos.y = intersection.t - hb.y - hb.h;
          if (sy < 0) pos.y = intersection.b - hb.y;
        }
      }
    },
  };
}