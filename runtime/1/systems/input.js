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
  const onBlur = () => keys.clear();

  canvas.addEventListener("click",   onClick);
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("keyup",   onKeyUp);
  canvas.addEventListener("blur",    onBlur);

  return {
    get left()  { return keys.has("ArrowLeft");  },
    get right() { return keys.has("ArrowRight"); },
    get up()    { return keys.has("ArrowUp");    },
    get down()  { return keys.has("ArrowDown");  },
    destroy() {
      canvas.removeEventListener("click",   onClick);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("keyup",   onKeyUp);
      canvas.removeEventListener("blur",    onBlur);
    },
  };
}

export function createInputSystem(canvas) {
  const input = createInput(canvas);

  // Unit-length direction from the arrow keys ({0, 0} when idle).
  function newMovementSource() {
    return {
      get direction() {
        const x = input.right ? 1 : input.left ? -1 : 0;
        const y = input.down ? 1 : input.up ? -1 : 0;
        if (x !== 0 && y !== 0) return { x: x * Math.SQRT1_2, y: y * Math.SQRT1_2 };
        return { x, y };
      },
    };
  }

  return {
    newMovementSource,
    destroy() {
      input.destroy();
    },
  };
}