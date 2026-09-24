const TILE_SIZE = 16;

// `data` is an already-parsed LDtk JSON project.
export async function loadMap(data) {
  const level = data.levels[0];

  // Build tileId → height (0, 1, 2) from enumTags on each tileset.
  // Height h means the tile's visual top is h tiles above its ground-plane base,
  // so its base row is at px[1] + 16 * (h + 1).
  const tileHeights = new Map();
  const collision = {
    solid: new Set(),
    bottom: new Set(),
  };
  for (const tileset of data.defs.tilesets) {
    for (const tag of tileset.enumTags) {
      if (tag.enumValueId === "Collision") {
        for (const id of tag.tileIds) collision.solid.add(id);
      } else if (tag.enumValueId === "CollisionBottom") {
        for (const id of tag.tileIds) collision.bottom.add(id);
      } else {
        const h = tag.enumValueId === "Height2" ? 2 : tag.enumValueId === "Height1" ? 1 : 0;
        for (const id of tag.tileIds) tileHeights.set(id, h);
      }
    }
  }

  const playerEntity = data.levels
  .flatMap(level => level.layerInstances)
  .flatMap(layer => layer.entityInstances)
  .find(e => e.__identifier === "Player");
  const playerStart = {x: playerEntity.px[0], y: playerEntity.px[1]};

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
    collision,
    playerStart,
    animatedTiles,
  };
}

export function buildCollisionGrid(layers, collisionTileIds) {
  const ref = layers.find((l) => l.__cWid > 0);
  const width = ref.__cWid;
  const height = ref.__cHei;
  const solid = new Uint8Array(width * height);
  const bottom = new Uint8Array(width * height);

  const tileLayerIds = ["BackgroundTiles", "YSort", "BackgroundAuto"];
  for (const id of tileLayerIds) {
    const layer = layers.find((l) => l.__identifier === id);
    if (!layer) continue;
    for (const tile of [...(layer.gridTiles ?? []), ...(layer.autoLayerTiles ?? [])]) {
      if (collisionTileIds.solid.has(tile.t)) {
        const gx = tile.px[0] / 16;
        const gy = tile.px[1] / 16;
        solid[gy * width + gx] = 1;
      }
      if (collisionTileIds.bottom.has(tile.t)) {
        const gx = tile.px[0] / 16;
        const gy = tile.px[1] / 16;
        bottom[gy * width + gx] = 1;
      }
    }
  }
  return { cellSize: 16, width, height, solid, bottom };
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
  const layer = layers.find((l) => l.__identifier === "YSort");
  if (!layer) return [];
  return layer.gridTiles.map((t) => {
    const h = tileHeights.get(t.t) ?? 0;
    return { ...t, sortY: t.px[1] + 16 * (h + 1) };
  });
}

// Sort and draw a mixed list of { sortY, draw } items.
export function ySortDraw(items) {
  items.sort((a, b) => a.sortY - b.sortY);
  for (const item of items) item.draw();
}
