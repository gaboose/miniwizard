export function createCollisionSystem(entity, grid) {
  const { cellSize, width, height, solid, bottom } = grid;

  function isSolid(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= width || gy >= height) return true;
    return solid[gy * width + gx] !== 0;
  }

  function isBottom(gx, gy) {
    return bottom[gy * width + gx] !== 0;
  }

  function isBlocked(t, r, b, l) {
    for (let gx = Math.floor(l / cellSize); gx * cellSize < r; gx++) {
      for (let gy = Math.floor(t / cellSize); gy * cellSize < b; gy++) {
        if (isSolid(gx, gy)) return {
          t: Math.max(t, gy*cellSize),
          r: Math.min(r, (gx+1)*cellSize),
          b: Math.min(b, (gy+1)*cellSize),
          l: Math.max(l, gx*cellSize)
        };
        if (isBottom(gx, gy) && (gy + 1) * cellSize < b) return {
          t: Math.max(t, (gy+1)*cellSize),
          r: Math.min(r, (gx+1)*cellSize),
          b: Math.min(b, (gy+1)*cellSize),
          l: Math.max(l, gx*cellSize)
        };
      }
    }
    return false;
  }

  return {
    update(delta) {
      const { pos, vel, hitbox: hb } = entity;
      const dx = vel.x * delta;
      const dy = vel.y * delta;

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

        let intersection = isBlocked(t, r, b, l)
        if (intersection) {
          if (sx > 0) pos.x = intersection.l - hb.x - hb.w;
          if (sx < 0) pos.x = intersection.r - hb.x;
        }

        pos.y += sy;
        t = pos.y + hb.y;
        b = t + hb.h;
        l = pos.x + hb.x;
        r = l + hb.w;
        
        intersection = isBlocked(t, r, b, l)
        if (intersection) {
          if (sy > 0) pos.y = intersection.t - hb.y - hb.h;
          if (sy < 0) pos.y = intersection.b - hb.y;
        }
      }
    },
  };
}