export async function loadMap(src) {
  const data = await fetch(src).then((r) => r.json());
  const level = data.levels[0];

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

  return {
    bgColor: level.__bgColor,
    layers: level.layerInstances,
    tileHeights,
  };
}

export function drawTile(ctx, tile, atlas, scale) {
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

export function drawTiles(ctx, tiles, atlas, scale) {
  for (const tile of tiles) drawTile(ctx, tile, atlas, scale);
}

export function buildStaticCanvas(layers, atlas, scale) {
  const ref = layers.find((l) => l.__cWid > 0);
  const canvas = new OffscreenCanvas(ref.__cWid * 16 * scale, ref.__cHei * 16 * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const bgAuto = layers.find((l) => l.__identifier === "BackgroundAuto");
  const bgTiles = layers.find((l) => l.__identifier === "BackgroundTiles");

  if (bgAuto) drawTiles(ctx, bgAuto.autoLayerTiles, atlas, scale);
  if (bgTiles) drawTiles(ctx, bgTiles.gridTiles, atlas, scale);

  return canvas;
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
