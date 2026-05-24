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

export function createMovementSystem(entity) {
  return {
    update: (delta) => {
      entity.pos.x += entity.vel.x*delta;
      entity.pos.y += entity.vel.y*delta;
    }
  }
}

export function createAnimator(entity, sprite) {
  const getLabel = (vx, vy, facing) => {
    const motion = vx !== 0 || vy !== 0 ? "walk" : "idle";
    return motion + (facing === "right" ? "R" : "L");
  }

  return {
    ySortItem: (ctx, scale, frame) => {
      const label = getLabel(entity.vel.x, entity.vel.y, entity.facing);
      return {
        sortY: entity.pos.y,
        draw: () => sprite.draw(ctx, label, frame, entity.pos.x, entity.pos.y, scale),
      };
    }
  };
}

export function createAnimationSystem(ctx, fps, scale) {
  let frame = 0;
  let time = 0;
  const interval = 1.0 / fps;
  let animators = [];

  return  {
    addCharacter: (entity, sprite, fps) => {
      animators.push(createAnimator(entity, sprite, fps))
    },
    update: (delta) => {
      time += delta;
      while (time >= interval) {
        frame++;
        time -= interval;
      }
    },
    ySortItems: () => {
      return animators.map((a) => {
        return a.ySortItem(ctx, scale, frame)
      })
    }
  }
}
