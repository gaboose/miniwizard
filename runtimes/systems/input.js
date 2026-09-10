const ARROW_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

export function createInput(canvas) {
  const keys = new Set();

  const onClick  = () => canvas.focus();
  const onKeyDown = (e) => {
    if (ARROW_KEYS.includes(e.key)) {
      e.preventDefault();
      keys.add(e.key);
    }
  };
  const onKeyUp = (e) => keys.delete(e.key);

  canvas.addEventListener("click",   onClick);
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("keyup",   onKeyUp);

  return {
    get left()  { return keys.has("ArrowLeft");  },
    get right() { return keys.has("ArrowRight"); },
    get up()    { return keys.has("ArrowUp");    },
    get down()  { return keys.has("ArrowDown");  },
    destroy() {
      canvas.removeEventListener("click",   onClick);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("keyup",   onKeyUp);
    },
  };
}

export function createInputSystem(canvas, entity, speed) {
  const input = createInput(canvas)
  return {
    update() {
      entity.vel.x = 0;
      entity.vel.y = 0;
      if (input.left)  { entity.vel.x = -speed; entity.facing = "left"; }
      if (input.right) { entity.vel.x =  speed; entity.facing = "right"; }
      if (input.up)    { entity.vel.y = -speed; }
      if (input.down)  { entity.vel.y =  speed; }
      if (entity.vel.x !== 0 && entity.vel.y !== 0) {
        entity.vel.x *= 0.707;
        entity.vel.y *= 0.707;
      }
    },
    destroy() {
      input.destroy()
    }
  }
}