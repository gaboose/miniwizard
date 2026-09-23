export function createCharacterAnimator(entity, sprite) {
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

export function createSpriteAnimator(placement, sprite) {
  return {
    ySortItem: (ctx, scale, frame) => {
      return {
        sortY: placement.sortY,
        draw: () => sprite.draw(ctx, "default", frame, placement.px, placement.py, scale)
      }
    }
  }
}

export function createAnimationSystem(ctx, fps, scale) {
  let frame = 0;
  let time = 0;
  const interval = 1.0 / fps;
  let animators = [];

  return  {
    addCharacter: (entity, sprite) => {
      const a = createCharacterAnimator(entity, sprite, fps)
      animators.push(a)
      return {
        destroy() {
          var i = animators.indexOf(a);
          if (i >= 0) animators.splice(i, 1);
        }
      }
    },
    addSprite: (placement, sprite) => {
      animators.push(createSpriteAnimator(placement, sprite))
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
