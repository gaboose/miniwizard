export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export async function loadSprite(src, config) {
  const img = await loadImage(src);
  return {
    draw: (ctx, label, frameN, x, y, scale) => {
      const anim = config.animations[label];
      const frameRC = anim[frameN % anim.length];
      const frame = config.frames[frameRC[0]][frameRC[1]];
      ctx.drawImage(
        img,
        frame[4], frame[5], frame[0], frame[1],
        Math.round(x - frame[2]) * scale,
        Math.round(y - frame[3]) * scale,
        frame[0] * scale,
        frame[1] * scale,
      );
    },
  };
}

export const WIZARD_CONFIG = {
  frames: [
    [
      [16, 23, 8, 23, 0, 0],
      [16, 23, 8, 23, 16, 0],
      [16, 23, 8, 23, 32, 0],
      [16, 23, 8, 23, 48, 0],
    ],
    [
      [16, 23, 8, 23, 0, 23],
      [16, 23, 8, 23, 16, 23],
      [16, 23, 8, 23, 32, 23],
      [16, 23, 8, 23, 48, 23],
    ],
    [
      [32, 24, 8, 24, 0, 46],
      [32, 24, 8, 24, 32, 46],
      [32, 24, 8, 24, 64, 46],
      [32, 24, 8, 24, 96, 46],
    ],
    [
      [32, 24, 24, 24, 0, 70],
      [32, 24, 24, 24, 32, 70],
      [32, 24, 24, 24, 64, 70],
      [32, 24, 24, 24, 96, 70],
    ],
  ],
  animations: {
    idleR: [[0, 0], [0, 1]],
    idleL: [[0, 2], [0, 3]],
    walkR: [[1, 0], [1, 1]],
    walkL: [[1, 2], [1, 3]],
    castR: [[0, 0], [2, 0], [2, 1], [2, 2], [2, 3]],
    castL: [[0, 2], [3, 0], [3, 1], [3, 2], [3, 3]],
  },
};
