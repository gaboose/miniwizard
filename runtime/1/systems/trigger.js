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

// `entities`: flat LDtk entity instances. `tileSet`: see createTileSet in map.js.
export function createTriggerSystem({ player, entities }, { ctx, tileSet }) {
  const solidsOf = (e, parts) =>
    parts.flatMap(({ tile, x, y }) => tileSet.solids(tile, e.px[0] + x, e.px[1] + y));

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
    for (const { tile, x, y } of parts) tileSet.draw(ctx, tile, e.px[0] + x, e.px[1] + y);
  }

  // Sort items for a door, one per 16px row of each tile so every row sorts
  // by its own Height tag, like getYSortTiles does for ordinary tiles.
  function doorItems(e, parts) {
    const items = [];
    for (const { tile: t, x, y } of parts) {
      for (let cy = 0; cy < t.h; cy += CELL) {
        const rowH = Math.min(CELL, t.h - cy);
        items.push({
          sortY: e.px[1] + y + cy + CELL * tileSet.heightAt(t, cy),
          draw: () => tileSet.draw(ctx, t, e.px[0] + x, e.px[1] + y + cy, cy, rowH),
        });
      }
    }
    return items;
  }

  return {
    // `others`: extra entities (remote players) that can press buttons too.
    update(_delta, others = []) {
      for (const d of doors.values()) d.open = false;
      for (const btn of buttons) {
        const q = btn.rect;
        btn.on = false;
        for (const p of [player, ...others]) {
          const hb = p.hitbox;
          const l = p.pos.x + hb.x, t = p.pos.y + hb.y;
          const r = l + hb.w, b = t + hb.h;
          if (l < q.x + q.w && r > q.x && t < q.y + q.h && b > q.y) { btn.on = true; break; }
        }
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
        items.push(...doorItems(d.e, d.open ? d.parts.open : d.parts.closed));
      }
      return items;
    },
  };
}
