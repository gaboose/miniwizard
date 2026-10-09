export function createCharacterAnimator(entity, sprite) {
  const getLabel = (facing) => {
    const dir = entity.movementSource.direction;
    const motion = dir.x != 0 || dir.y != 0 ? "walk" : "idle";
    return motion + (facing === "right" ? "R" : "L");
  }

  return {
    ySortItem: (ctx, scale, frame) => {
      // `entity.views` (set by e.g. the portal system) draws the character as
      // several clipped copies instead of once at its position.
      if (entity.views) {
        return entity.views.map((v) => ({
          sortY: v.y,
          draw: () => {
            ctx.save();
            v.clip?.(ctx, scale);
            sprite.draw(ctx, getLabel(v.facing), frame, v.x, v.y, scale);
            ctx.restore();
          },
        }));
      }
      return {
        sortY: entity.pos.y,
        draw: () => sprite.draw(ctx,  getLabel(entity.facing), frame, entity.pos.x, entity.pos.y, scale),
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
      return animators.flatMap((a) => {
        return a.ySortItem(ctx, scale, frame)
      })
    }
  }
}
