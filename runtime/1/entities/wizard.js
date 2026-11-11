// A wizard is a shared body (createWizard) plus a control part that decides how
// it moves: withLocalControl (input-driven) or withRemoteControl (network-driven).

export function createWizard({ pos }) {
  return {
    pos,
    vel: { x: 0, y: 0 },
    facing: "right",
    hitbox: { x: -8, y: -3, w: 16, h: 3 },
    bodyHitbox: { x: -8, y: -23, w: 16, h: 23 },
  };
}

export function withLocalControl(wizard, { movementSource, speed }) {
  wizard.speed = speed;
  wizard.movementSource = movementSource;
  return wizard;
}

export function withRemoteControl(wizard, ch, { onDestroy } = {}) {
  wizard.movementSource = { direction: { x: 0, y: 0 } };
  ch.onMessage = (m) => {
    wizard.vel.x = m.x - wizard.pos.x;
    wizard.vel.y = m.y - wizard.pos.y;
    if (wizard.vel.x > 0) wizard.facing = "right";
    else if (wizard.vel.x < 0) wizard.facing = "left";
    wizard.movementSource.direction = {
      x: Math.sign(wizard.vel.x),
      y: Math.sign(wizard.vel.y),
    };
    wizard.pos.x = m.x;
    wizard.pos.y = m.y;
  };
  ch.onClose = () => {
    onDestroy?.(wizard);
    console.log("ch.onClose:", ch.id);
  };
  return wizard;
}

export function createLocalWizard({ pos, movementSource, speed }) {
  return withLocalControl(createWizard({ pos }), { movementSource, speed });
}

export function createRemoteWizard(ch, { onDestroy } = {}) {
  const pos = { x: ch.lastMessage.x, y: ch.lastMessage.y };
  return withRemoteControl(createWizard({ pos }), ch, { onDestroy });
}
