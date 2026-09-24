const template = document.createElement("template");
template.innerHTML = `
  <canvas
    id="c"
    tabindex="0"
    style="
      display: block;
      width: 100%;
      height: 100%;
      image-rendering: pixelated;
    "
  ></canvas>
`;
  
  import {
    loadMap,
    buildStaticCanvases,
    buildCollisionGrid,
    getYSortTiles,
    drawTile,
    ySortDraw,
  } from "./map.js";

  import {
    loadImage,
    loadSprite,
    createSpriteFromTileIds,
    WIZARD_CONFIG,
  } from "./sprite.js";

  import { createAnimationSystem } from "./systems/animation.js";
  import { createInputSystem } from "./systems/input.js";
  import { createCollisionSystem } from "./systems/collision.js";
  import { createCameraSystem } from "./systems/camera.js";

  const SCALE = 1;
  const RUNTIME_VERSION = 1;

  async function createGame(canvas, options = {}) {
    const { level, atlas: atlasImg, wizard: wizardImg, networkRoom, runtimeBase } = options;

    const SPEED = 75.0;
    const ANIM_FPS = 5;
    const finalCtx = canvas.getContext("2d");
    finalCtx.imageSmoothingEnabled = false;

    const [map, atlas, sprite] = await Promise.all([
      loadMap(level),
      loadImage(atlasImg),
      loadSprite(wizardImg, WIZARD_CONFIG),
    ]);

    const animatedTileIds = new Set(
      Object.entries(map.animatedTiles).map(([k, v]) => v.tileIds[0]),
    );
    const [canvasBg, canvasFg] = buildStaticCanvases(
      map.layers,
      atlas,
      SCALE,
      animatedTileIds,
    );

    const pixelCanvas = new OffscreenCanvas(canvasBg.width, canvasBg.height);
    console.log(canvasBg.width, canvasBg.height);
    const ctx = pixelCanvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    const ySortItems = getYSortTiles(map.layers, map.tileHeights).map((t) => ({
      sortY: t.sortY,
      draw: () => drawTile(ctx, t, atlas, SCALE, animatedTileIds),
    }));

    const wizard = {
      pos: map.playerStart,
      vel: { x: 0, y: 0 },
      facing: "right",
      hitbox: { x: -5, y: -3, w: 10, h: 6 },
    };

    const collisionGrid = buildCollisionGrid(map.layers, map.collision);
    const animationSystem = createAnimationSystem(ctx, ANIM_FPS, SCALE);
    const inputSystem = createInputSystem(canvas, wizard, SPEED);
    const collisionSystem = createCollisionSystem(wizard, collisionGrid);
    const cameraSystem = createCameraSystem(pixelCanvas, canvas, {
      x: map.playerStart.x + 2,
      y: map.playerStart.y - 30,
    });

    var networkSystem;
    var wizardCh;
    async function asyncSetup() {
        if (networkRoom) {
            // network.js stays a separate file (it spawns a worker relative to
            // itself), so it's resolved against runtimeBase, not import.meta.url,
            // which points at the page once main.js is inlined.
            const networkUrl = new URL("systems/network.js", runtimeBase);
            networkUrl.searchParams.set("update", Date.now());
            const { createNetworkSystem, createRemoteCharacterEntity } = await import(networkUrl.href);
            networkSystem = createNetworkSystem(networkRoom, {
                onNewOwnedChannel(ch,) {
                    console.log("remote channel created", ch.id, ch);
                    createRemoteCharacterEntity(
                        ch, (state) => {return animationSystem.addCharacter(state, sprite)}
                    )
                },
            });

            wizardCh = networkSystem.ownedChannel({
                id: "p",
                m: {
                    x: wizard.pos.x,
                    y: wizard.pos.y,
                },
            });
        }
    }
    asyncSetup()

    animationSystem.addCharacter(wizard, sprite);

    for (const k in map.animatedTiles) {
      const sprite = createSpriteFromTileIds(
        atlas,
        map.animatedTiles[k].tileIds,
      );
      for (const inst of map.animatedTiles[k].instances) {
        animationSystem.addSprite(inst, sprite);
      }
    }

    let lastTimestamp = null;
    function update(timestamp) {
      if (lastTimestamp == null) lastTimestamp = timestamp;
      let delta = (timestamp - lastTimestamp) * 0.001;

      animationSystem.update(delta);
      inputSystem.update();
      collisionSystem.update(delta);
      cameraSystem.update(delta);

      if (networkSystem) {
          networkSystem.update();
          wizardCh.send({ x: wizard.pos.x, y: wizard.pos.y });
      }

      lastTimestamp = timestamp;
    }

    function draw() {
      ctx.clearRect(0, 0, canvasBg.width, canvasBg.height);
      ctx.drawImage(canvasBg, 0, 0);
      ySortDraw([...animationSystem.ySortItems(), ...ySortItems]);
      ctx.drawImage(canvasFg, 0, 0);

      finalCtx.fillStyle = "#008df0";
      finalCtx.fillRect(0, 0, canvas.width, canvas.height);

      cameraSystem.draw();
    }

    let rafId;
    function loop(timestamp) {
      update(timestamp);
      draw();
      rafId = requestAnimationFrame(loop);
    }

    return {
      start: loop,
      stop() {
        cancelAnimationFrame(rafId);
        inputSystem.destroy();
      },
      draw,
    };
  }

  customElements.define(
    "wizard-canvas",
    class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" }).appendChild(
          template.content.cloneNode(true),
        );
      }

      // Called by the page with the parsed json and img assets.
      init({ level, atlas, wizard }) {
        this._assets = { level, atlas, wizard };
        if (this.isConnected) this._start();
      }

      connectedCallback() {
        if (this._assets) this._start();
      }

      disconnectedCallback() {
        this._game?.stop();
        this._observer?.disconnect();
        this._game = this._observer = this._starting = null;
      }

      _start() {
        if (this._starting) return;
        const canvas = this.shadowRoot.getElementById("c");
        const networkRoom = this.dataset.networkRoom;
        const starting = (this._starting = createGame(canvas, {
          ...this._assets,
          networkRoom,
          runtimeBase: new URL(`../../runtime/${RUNTIME_VERSION}/`, document.baseURI),
        }));
        starting.then((game) => {
          if (this._starting !== starting) return;
          this._game = game;
          canvas.focus();

          const observer = new ResizeObserver(() => {
            const dpr = window.devicePixelRatio ?? 1;
            canvas.width = Math.round(canvas.clientWidth * dpr);
            canvas.height = Math.round(canvas.clientHeight * dpr);

            // imageSmoothingEnabled resets when the canvas is resized
            const ctx = canvas.getContext("2d");
            ctx.imageSmoothingEnabled = false;

            game.draw()
          });

          observer.observe(canvas);
          this._observer = observer;

          requestAnimationFrame(game.start);
        });
      }
    },
  );