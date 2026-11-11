const TILE_SIZE = 16;

// `data` is an already-parsed LDtk JSON project.
export async function loadMap(data, levelName) {
  const level = levelName === undefined ? data.levels[0] : data.levels.find((l) => l.identifier === levelName)

  // Build tileId → height (0, 1, 2) from enumTags on each tileset.
  // Height h means the tile's visual top is h tiles above its ground-plane base,
  // so its base row is at px[1] + 16 * (h + 1).
  const tileHeights = new Map();
  for (const tileset of data.defs.tilesets) {
    for (const tag of tileset.enumTags) {
        const h = tag.enumValueId === "Height2" ? 2 : tag.enumValueId === "Height1" ? 1 : 0;
        for (const id of tag.tileIds) tileHeights.set(id, h);
    }
  }

  // tileset uid -> tiles per row, to turn atlas x/y into a tile id.
  const tilesetCols = new Map(data.defs.tilesets.map((t) => [t.uid, t.__cWid]));

  const playerEntity = level.layerInstances
  .flatMap(layer => layer.entityInstances)
  .find(e => e.__identifier === "Player");
  const playerStart = {x: playerEntity.px[0], y: playerEntity.px[1]};

  const cameraBoxes = (level.layerInstances ?? [])
    .flatMap((layer) => layer.entityInstances ?? [])
    .filter((e) => e.__identifier === "CameraArea")
    .map((e) => {
      const [pivotX, pivotY] = e.__pivot ?? [0, 0];
      const priority = e.fieldInstances?.find((f) => f.__identifier === "Priority")?.__value ?? 0;
      return {
        x: e.px[0] - pivotX * e.width,
        y: e.px[1] - pivotY * e.height,
        width: e.width,
        height: e.height,
        priority,
      };
    });

  const animatedTiles = {}
  for (const tileset of data?.defs?.tilesets ?? []) {
    const gridWidth = Math.floor(tileset.pxWid / tileset.tileGridSize);
 
    for (const { tileId, data } of tileset.customData ?? []) {
      const offsets = parseAnimationOffsets(data);
      if (offsets) {
        animatedTiles[tileId] = {tileIds: [tileId, ...offsets.map((offset) =>
            offsetToTileId(tileId, offset, gridWidth)
        )], instances: []};
      }
    }
  }

  for (const layer of level.layerInstances ?? []) {
    const tiles = [...(layer.gridTiles ?? []), ...(layer.autoLayerTiles ?? [])];
 
    for (const tile of tiles) {
      if (tile.t in animatedTiles) {
        animatedTiles[tile.t].instances.push({
          px: tile.px[0],
          py: tile.px[1],
          sortY:tile.px[1]+TILE_SIZE,
          layerIdentifier: layer.__identifier,
        });
      }
    }
  }

  return {
    bgColor: level.__bgColor,
    layers: level.layerInstances,
    tileHeights,
    tilesetCols,
    playerStart,
    cameraBoxes,
    animatedTiles,
  };
}

// Solid rects (tile-local px) for each 16x16 cell of the collision atlas.
// A pixel is solid when its alpha > 0. Cells are computed lazily and cached.
export function createAtlasCollision(img) {
  const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data, width } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const cache = new Map();

  return (sx, sy) => {
    const key = sx + "," + sy;
    let rects = cache.get(key);
    if (rects) return rects;
    rects = [];
    let open = []; // rects still growing downward
    for (let y = 0; y <= TILE_SIZE; y++) {
      const runs = [];
      if (y < TILE_SIZE) {
        let start = -1;
        for (let x = 0; x <= TILE_SIZE; x++) {
          const solid = x < TILE_SIZE && data[((sy + y) * width + sx + x) * 4 + 3] > 0;
          if (solid && start < 0) start = x;
          else if (!solid && start >= 0) { runs.push([start, x - start]); start = -1; }
        }
      }
      const next = [];
      for (const r of open) {
        const i = runs.findIndex(([x, w]) => x === r.x && w === r.w);
        if (i >= 0) { r.h++; next.push(r); runs.splice(i, 1); }
        else rects.push(r);
      }
      for (const [x, w] of runs) next.push({ x, y, w, h: 1 });
      open = next;
    }
    cache.set(key, rects);
    return rects;
  };
}

// Atlas-rect tiles (LDtk tile refs { x, y, w, h, tilesetUid }) used by
// entities: drawing, y-sort height and collision, in one place.
export function createTileSet({ tileHeights, tilesetCols }, { atlas, collisionAtlas }) {
  const rectsAt = collisionAtlas ? createAtlasCollision(collisionAtlas) : () => [];
  return {
    // Draw `h` rows of `tile` starting `cy` px down it, at level px (dx, dy).
    draw(ctx, tile, dx, dy, cy = 0, h = tile.h - cy) {
      ctx.drawImage(atlas, tile.x, tile.y + cy, tile.w, h, dx, dy, tile.w, h);
    },
    // Height tag (0-2) of the 16px row `cy` px down `tile`.
    heightAt(tile, cy = 0) {
      const cols = tilesetCols?.get(tile.tilesetUid);
      if (!cols) return 0;
      return tileHeights?.get(((tile.y + cy) / TILE_SIZE) * cols + tile.x / TILE_SIZE) ?? 0;
    },
    // Solid rects in level px for `tile` placed at (dx, dy).
    solids(tile, dx, dy) {
      const out = [];
      for (let cy = 0; cy < tile.h; cy += TILE_SIZE) {
        for (let cx = 0; cx < tile.w; cx += TILE_SIZE) {
          for (const r of rectsAt(tile.x + cx, tile.y + cy)) {
            out.push({ x: dx + cx + r.x, y: dy + cy + r.y, w: r.w, h: r.h });
          }
        }
      }
      return out;
    },
  };
}

export function buildCollisionGrid(layers, collisionAtlas) {
  const CELL = 16;
  const ref = layers.find((l) => l.__gridSize === CELL);
  const width = ref.__cWid;
  const height = ref.__cHei;
  const cells = new Array(width * height).fill(null); // index -> [{ x, y, w, h }] in level px

  const addRect = (r) => {
    const x0 = Math.max(0, Math.floor(r.x / CELL));
    const y0 = Math.max(0, Math.floor(r.y / CELL));
    const x1 = Math.min(width - 1, Math.floor((r.x + r.w - 1) / CELL));
    const y1 = Math.min(height - 1, Math.floor((r.y + r.h - 1) / CELL));
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const i = gy * width + gx;
        (cells[i] ??= []).push(r);
      }
    }
  };

  if (collisionAtlas) {
    const rectsAt = createAtlasCollision(collisionAtlas);
    for (const layer of layers) {
      for (const tile of [...(layer.gridTiles ?? []), ...(layer.autoLayerTiles ?? [])]) {
        for (const r of rectsAt(tile.src[0], tile.src[1])) {
          addRect({ x: tile.px[0] + r.x, y: tile.px[1] + r.y, w: r.w, h: r.h });
        }
      }
    }
  }

  return { cellSize: CELL, width, height, cells };
}

function parseAnimationOffsets(data) {
  if (!data.startsWith("animationOffsets ")) return null;
 
  const raw = data.slice("animationOffsets ".length);
  const matches = [...raw.matchAll(/\[(-?\d+),(-?\d+)\]/g)];
 
  return matches.map(([, x, y]) => ({ x: Number(x), y: Number(y) }));
}

function offsetToTileId(tileId, { x, y }, gridWidth) {
  const col = tileId % gridWidth;
  const row = Math.floor(tileId / gridWidth);
  return (row + y) * gridWidth + (col + x);
}

export function drawTile(ctx, tile, atlas, scale, ignoreTileIds = new Set()) {
  if (ignoreTileIds.has(tile.t)) return;
  const [dx, dy] = tile.px;
  const [sx, sy] = tile.src;
  if (tile.f === 0) {
    ctx.drawImage(atlas, sx, sy, 16, 16, dx * scale, dy * scale, 16 * scale, 16 * scale);
  } else {
    ctx.save();
    ctx.translate(
      (tile.f & 1) ? (dx + 16) * scale : dx * scale,
      (tile.f & 2) ? (dy + 16) * scale : dy * scale,
    );
    ctx.scale((tile.f & 1) ? -1 : 1, (tile.f & 2) ? -1 : 1);
    ctx.drawImage(atlas, sx, sy, 16, 16, 0, 0, 16 * scale, 16 * scale);
    ctx.restore();
  }
}

export function drawTiles(ctx, tiles, atlas, scale, ignoreTileIds = new Set()) {
  for (const tile of tiles) drawTile(ctx, tile, atlas, scale, ignoreTileIds);
}

function newCanvasCtx(width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  return [canvas, ctx]
}

export function buildStaticCanvases(layers, atlas, scale, ignoreTileIds = new Set()) {
  const ref = layers.find((l) => l.__cWid > 0);
  const canvas = new OffscreenCanvas(ref.__cWid * TILE_SIZE * scale, ref.__cHei * TILE_SIZE * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const width = ref.__cWid * 16 * scale;
  const height = ref.__cHei * 16 * scale;

  const [canvasBg, ctxBg] = newCanvasCtx(width, height);
  const [canvasFg, ctxFg] = newCanvasCtx(width, height);

  const bgAuto = layers.find((l) => l.__identifier === "BackgroundAuto");
  const bgTiles = layers.find((l) => l.__identifier === "BackgroundTiles");
  const fgTiles = layers.find((l) => l.__identifier === "Foreground");

  if (bgAuto) drawTiles(ctxBg, bgAuto.autoLayerTiles, atlas, scale, ignoreTileIds);
  if (bgTiles) drawTiles(ctxBg, bgTiles.gridTiles, atlas, scale, ignoreTileIds);
  if (fgTiles) drawTiles(ctxFg, fgTiles.gridTiles, atlas, scale, ignoreTileIds);

  return [canvasBg, canvasFg];
}

export function getYSortTiles(layers, tileHeights) {
  return layers.flatMap((layer) =>
    layer.gridTiles
      .filter((t) => tileHeights.has(t.t))
      .map((t) => {
        const h = tileHeights.get(t.t);
        return { ...t, sortY: t.px[1] + 16 * (h) };
      })
  );
}

// Sort and draw a mixed list of { sortY, draw } items.
export function ySortDraw(items) {
  items.sort((a, b) => a.sortY - b.sortY);
  for (const item of items) item.draw();
}