// Headless checks for movement, collision and portals in the Museum level.
// Run: npm run check
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadMap, buildCollisionGrid } from "../runtime/1/map.js";
import { createCollisionSystem } from "../runtime/1/systems/collision.js";
import { createPortalSystem, loadPortals } from "../runtime/1/systems/portal.js";

const ldtk = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../tests/3/ldtk.json", import.meta.url))));
const map = await loadMap(ldtk, "Museum");
const grid = buildCollisionGrid(map.layers, map.collision);
const SPEED = 75;

function world(x, y) {
  let dir = { x: 0, y: 0 };
  const wizard = {
    pos: { x, y },
    facing: "right",
    hitbox: { x: -8, y: -3, w: 16, h: 3 },
    bodyHitbox: { x: -8, y: -23, w: 16, h: 23 },
    speed: SPEED,
    movementSource: { get direction() { return { ...dir }; } },
  };
  let teleports = 0;
  const portals = createPortalSystem(loadPortals(map.layers), { onTeleport: () => teleports++ });
  const collision = createCollisionSystem(wizard, grid, { passable: portals.passable, blockers: portals.blockers });
  portals.addEntity(wizard);
  return {
    wizard,
    get teleports() { return teleports; },
    run(d, seconds, fps = 60, onFrame) {
      dir = d;
      const frames = Math.round(seconds * fps);
      for (let f = 0; f < frames; f++) {
        const before = { ...wizard.pos };
        const t0 = teleports;
        const dt = 1 / fps;
        collision.update(dt);
        portals.update(dt);
        onFrame?.(before, wizard.pos, dt, teleports !== t0);
      }
      return wizard.pos;
    },
  };
}

function overlapsWall(pos) {
  const l = pos.x - 8, r = pos.x + 8, t = pos.y - 3, b = pos.y;
  for (const cell of grid.cells) for (const s of cell ?? []) {
    if (Math.min(r, s.x + s.w) - Math.max(l, s.x) > 1e-6 && Math.min(b, s.y + s.h) - Math.max(t, s.y) > 1e-6) return s;
  }
  return null;
}

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failed++;
}
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const fmt = (p) => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`;

// --- Stairs (bottom-left triangle, hypotenuse x + y = 544, solid below-right)
{
  let rng = 1;
  const rand = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1], [-1, 1], [-1, 0], [0, -1], [-1, -1]].map(([x, y]) => ({ x, y }));
  let bad = null;
  for (let trial = 0; trial < 1500 && !bad; trial++) {
    const w = world(195 + rand() * 40, 280 + rand() * 40);
    if (overlapsWall(w.wizard.pos)) continue;
    for (let seg = 0; seg < 12 && !bad; seg++) {
      const fps = 30 + rand() * 114;
      w.run(dirs[Math.floor(rand() * dirs.length)], 0.25, fps, (before, now, dt) => {
        const jump = Math.hypot(now.x - before.x, now.y - before.y);
        if (bad) return;
        if (overlapsWall(now)) bad = `overlap at ${fmt(now)}`;
        else if (jump > SPEED * dt + 1e-6) bad = `jump ${jump.toFixed(2)}px from ${fmt(before)} to ${fmt(now)}`;
      });
    }
  }
  check("stairs: fuzzed movement never overlaps or jumps", !bad, bad ?? "");
}
function slide(d, label, expectDir, expectSpeed, start = { x: 200, y: 320 }) {
  const w = world(start.x, start.y);
  w.run(d, 0.4); // reach the slope
  const a = { ...w.wizard.pos };
  w.run(d, 0.3);
  const b = w.wizard.pos;
  const vx = (b.x - a.x) / 0.3, vy = (b.y - a.y) / 0.3;
  const speed = Math.hypot(vx, vy);
  const dirOk = expectDir ? Math.abs(vx / speed - expectDir.x) < 0.05 && Math.abs(vy / speed - expectDir.y) < 0.05 : true;
  check(`stairs: ${label}`, dirOk && Math.abs(speed - expectSpeed) <= expectSpeed * 0.06 + 0.5,
    `velocity (${vx.toFixed(1)}, ${vy.toFixed(1)}), ${speed.toFixed(1)} px/s`);
}
const D = Math.SQRT1_2;
slide({ x: 1, y: 0 }, "pressing → deflects up the slope at ~53 px/s", { x: D, y: -D }, SPEED * D);
slide({ x: 0, y: 1 }, "pressing ↓ deflects down the slope at ~53 px/s", { x: -D, y: D }, SPEED * D, { x: 240, y: 280 });
slide({ x: 1, y: 1 }, "pressing ↘ into the slope stops", null, 0);
{
  // Glide along the slope at full speed (↗ from a spot touching it)
  const w = world(200, 320);
  w.run({ x: 1, y: 0 }, 0.4);
  const a = { ...w.wizard.pos };
  w.run({ x: 1, y: -1 }, 0.2);
  const b = w.wizard.pos;
  const speed = Math.hypot(b.x - a.x, b.y - a.y) / 0.2;
  check("stairs: ↗ along the slope glides at full speed", Math.abs(speed - SPEED) < SPEED * 0.05, `${speed.toFixed(1)} px/s`);
}

// --- Portals
// Vertical pair: Right edge at x=433 and Left edge at x=511, both y 160..192.
// Horizontal pair: Down edge at y=225 and Up edge at y=271, both x 448..496.
function blocked(name, start, d, expect) {
  const w = world(start.x, start.y);
  const p = w.run(d, 1.5);
  const ok = w.teleports === 0 && (expect.x === undefined || near(p.x, expect.x)) && (expect.y === undefined || near(p.y, expect.y));
  check(name, ok, `ended at ${fmt(p)}, teleports ${w.teleports}`);
}
function passes(name, start, d) {
  const w = world(start.x, start.y);
  let split = false;
  w.run(d, 1.0, 60, () => { if (w.wizard.views) split = true; });
  check(name, w.teleports > 0 && split, `teleports ${w.teleports}, drawn split ${split}`);
}

blocked("back of Right portal (x=433) blocks walking →", { x: 400, y: 186 }, { x: 1, y: 0 }, { x: 425 });
blocked("back of Left portal (x=511) blocks walking ←", { x: 540, y: 186 }, { x: -1, y: 0 }, { x: 519 });
blocked("back of Down portal (y=225) blocks walking ↓", { x: 472, y: 195 }, { x: 0, y: 1 }, { y: 225 });
blocked("back of Up portal (y=271) blocks walking ↑ (head hits)", { x: 472, y: 320 }, { x: 0, y: -1 }, { y: 294 });

// After stopping against the back, moving away in any direction must not
// count as crossing (the feet can end up exactly on the line), and the sprite
// must never be drawn split into the other portal.
function backThenAway(name, start, d) {
  const all = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const bad = [];
  for (const [x, y] of all) {
    const w = world(start.x, start.y);
    let split = false;
    const watch = () => { if (w.wizard.views) split = true; };
    w.run(d, 1.0, 60, watch);
    w.run({ x, y }, 0.3, 60, watch);
    if (w.teleports) bad.push(`${x},${y} teleported`);
    if (split) bad.push(`${x},${y} drawn split`);
  }
  check(`${name}, then moving away doesn't teleport or draw split`, bad.length === 0, bad.join(", "));
}
backThenAway("back of Right portal", { x: 400, y: 186 }, { x: 1, y: 0 });
backThenAway("back of Left portal", { x: 540, y: 186 }, { x: -1, y: 0 });
backThenAway("back of Down portal", { x: 472, y: 195 }, { x: 0, y: 1 });
backThenAway("back of Up portal", { x: 472, y: 320 }, { x: 0, y: -1 });

passes("front of Right portal: walk ← through", { x: 470, y: 188 }, { x: -1, y: 0 });
passes("front of Left portal: walk → through", { x: 475, y: 188 }, { x: 1, y: 0 });
passes("front of Down portal: walk ↑ through", { x: 472, y: 252 }, { x: 0, y: -1 });
passes("front of Up portal: walk ↓ through", { x: 472, y: 244 }, { x: 0, y: 1 });

blocked("Down portal: sticking out past the left end stops", { x: 445, y: 252 }, { x: 0, y: -1 }, { x: 445, y: 248 });
blocked("Down portal: sticking out past the right end stops", { x: 492, y: 252 }, { x: 0, y: -1 }, { x: 492, y: 248 });
blocked("Right portal: feet below the bottom end stops", { x: 470, y: 200 }, { x: -1, y: 0 }, { x: 441, y: 200 });
blocked("Right portal: head above the top end stops", { x: 470, y: 178 }, { x: -1, y: 0 }, { x: 441, y: 178 });
blocked("Down portal: sliding → while halfway in stops at the end", { x: 472, y: 235 }, { x: 1, y: 0 }, { x: 488, y: 235 });
blocked("Down portal: sliding ← while halfway in stops at the end", { x: 472, y: 235 }, { x: -1, y: 0 }, { x: 456, y: 235 });
passes("Down portal: clipping an end by 0.5px deflects in", { x: 455.5, y: 252 }, { x: 0, y: -1 });
passes("Right portal: head clipping the top end by 0.5px deflects in", { x: 470, y: 182.5 }, { x: -1, y: 0 });

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
