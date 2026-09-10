export function createCameraSystem(pixelCanvas, canvas, centerPos) {
    var cam = {
        x: centerPos.x,
        y: centerPos.y,
        zoom: 1,
        minZoom: 1.0,
        maxZoom: 7.0,
        mode: "follow",       // "follow" | "drag"
        followSmoothing: 8,   // higher = snappier tracking (per second)
    }

    function worldToScreen(wx, wy) {
        return {
            x: (wx - cam.x) * cam.zoom + canvas.clientWidth/2,
            y: (wy - cam.y) * cam.zoom + canvas.clientHeight/2,
        };
    }

    function screenToWorld(sx, sy) {
        return {
            x: (sx-(canvas.clientWidth/2)) / cam.zoom + cam.x,
            y: (sy-(canvas.clientHeight/2)) / cam.zoom + cam.y,
        };
    }

    function zoomAt(screenX, screenY, factor) {
        screenX = canvas.clientWidth / 2;
        screenY = canvas.clientHeight / 2;
        const before = screenToWorld(screenX, screenY);
        cam.zoom = Math.min(cam.maxZoom, Math.max(cam.minZoom, cam.zoom * factor));
        const after = screenToWorld(screenX, screenY);
        cam.x += before.x - after.x;
        cam.y += before.y - after.y;
    }

    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0015);
        zoomAt(e.clientX, e.clientY, factor);
      },
      { passive: false },
    );

    const ctx = canvas.getContext("2d");
    return {
        cam: cam,
        update(delta) {
            
        },
        draw() {
            ctx.drawImage(
                pixelCanvas,
                0, 0,
                pixelCanvas.width,
                pixelCanvas.height,
                canvas.width/2-cam.x*cam.zoom,
                canvas.height/2-cam.y*cam.zoom,
                pixelCanvas.width * cam.zoom,
                pixelCanvas.height * cam.zoom,
            );
        }
    };
}