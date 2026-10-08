export function createDebugSystem({canvas, collision}) {
    const ctx = canvas.getContext("2d");
    return {
        draw() {
            if (collision) {
                const { cellSize, width, cells } = collision;
                const seen = new Set();

                // ctx.save();

                // Occupied cells (faint)
                ctx.fillStyle = "rgba(255, 200, 0, 0.12)";
                for (let i = 0; i < cells.length; i++) {
                    const list = cells[i];
                    if (!list) continue;
                    const gx = i % width;
                    const gy = Math.floor(i / width);
                    ctx.fillRect(gx * cellSize, gy * cellSize, cellSize, cellSize);
                    for (const r of list) seen.add(r);
                }

                // Collision rects, each drawn once
                ctx.fillStyle = "rgba(255, 0, 0, 0.35)";
                ctx.strokeStyle = "rgba(255, 0, 0, 0.9)";
                ctx.lineWidth = 1;
                for (const r of seen) {
                    ctx.fillRect(r.x, r.y, r.w, r.h);
                    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
                }

                // ctx.restore();
            }
        }
    }
}