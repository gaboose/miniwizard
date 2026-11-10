// Walk-triggered buttons and the doors they open.
//
// A "TriggerArea" entity (condition Walk) is a floor button: it is on while the
// player's feet box overlaps it. Each entity in its `onTrigger` list that is a
// "Door" is open exactly while a button targeting it is on.
//
// The Off/On (button) and Closed/Open (door) fields are arrays of tiles that
// are concatenated left to right starting at the entity's px; a null entry is
// an empty slot as wide as the first real tile.
//
// Door collision comes from the collision atlas, per 16x16 cell of each tile of
// the current state, and is exposed as `solids()` for collision.js.

import { createAtlasCollision } from "../map.js";
import { field } from "../ldtk.js";

const CELL = 16;

// Tiles laid out left to right: [{ tile, x, y }] with x/y relative to px.
function layout(tiles) {
  const slot = (tiles ?? []).find((t) => t)?.w ?? CELL;
  const out = [];
  let x = 0;
  for (const tile of tiles ?? []) {
    if (tile) out.push({ tile, x, y: 0 });
    x += tile?.w ?? slot;
  }
  return out;
}

export function createTriggerSystem(layers, { player, ctx, atlas, scale, collisionAtlas }) {
  const entities = (layers ?? []).flatMap((l) => l.entityInstances ?? []);
  const rectsAt = collisionAtlas ? createAtlasCollision(collisionAtlas) : () => [];

  const solidsOf = (e, parts) =>
    parts.flatMap(({ tile, x, y }) => {
      const out = [];
      for (let cy = 0; cy < tile.h; cy += CELL) {
        for (let cx = 0; cx < tile.w; cx += CELL) {
          for (const r of rectsAt(tile.x + cx, tile.y + cy)) {
            out.push({ x: e.px[0] + x + cx + r.x, y: e.px[1] + y + cy + r.y, w: r.w, h: r.h });
          }
        }
      }
      return out;
    });

  const doors = new Map(
    entities
      .filter((e) => e.__identifier === "Door")
      .map((e) => {
        const closed = layout(field(e, "Closed"));
        const open = layout(field(e, "Open"));
        return [e.iid, {
          e, open: false,
          parts: { closed, open },
          solids: { closed: solidsOf(e, closed), open: solidsOf(e, open) },
        }];
      }),
  );

  const buttons = entities
    .filter((e) => e.__identifier === "TriggerArea" && field(e, "condition") === "Walk")
    .map((e) => {
      const [pivotX, pivotY] = e.__pivot ?? [0, 0];
      const targets = (field(e, "onTrigger") ?? [])
        .map((r) => {
          const d = doors.get(r.entityIid);
          if (!d) console.warn("trigger target is not a Door:", r.entityIid);
          return d;
        })
        .filter(Boolean);
      return {
        e, targets, on: false,
        rect: { x: e.px[0] - pivotX * e.width, y: e.px[1] - pivotY * e.height, w: e.width, h: e.height },
        off: layout(field(e, "Off")),
        onTiles: layout(field(e, "On")),
      };
    });

  function drawParts(e, parts) {
    for (const { tile: t, x, y } of parts) {
      ctx.drawImage(
        atlas, t.x, t.y, t.w, t.h,
        (e.px[0] + x) * scale, (e.px[1] + y) * scale, t.w * scale, t.h * scale,
      );
    }
  }

  return {
    update() {
      const hb = player.hitbox;
      const l = player.pos.x + hb.x, t = player.pos.y + hb.y;
      const r = l + hb.w, b = t + hb.h;
      for (const d of doors.values()) d.open = false;
      for (const btn of buttons) {
        const q = btn.rect;
        btn.on = l < q.x + q.w && r > q.x && t < q.y + q.h && b > q.y;
        if (btn.on) for (const d of btn.targets) d.open = true;
      }
    },

    // Door solids for the current state, same {x, y, w, h} as grid rects.
    solids() {
      const out = [];
      for (const d of doors.values()) out.push(...(d.open ? d.solids.open : d.solids.closed));
      return out;
    },

    ySortItems() {
      const items = [];
      for (const btn of buttons) {
        items.push({
          sortY: btn.rect.y,
          draw: () => drawParts(btn.e, btn.on ? btn.onTiles : btn.off),
        });
      }
      for (const d of doors.values()) {
        items.push({
          sortY: d.e.px[1] + d.e.height,
          draw: () => drawParts(d.e, d.open ? d.parts.open : d.parts.closed),
        });
      }
      return items;
    },
  };
}
