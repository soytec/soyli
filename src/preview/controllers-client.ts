import {
  createGamepadInput,
  type Controller,
  type GamepadBindings,
} from '../../packages/input/src/gamepad';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
};
const status = document.querySelector<HTMLElement>('#state')!;
const pads = document.querySelector<HTMLElement>('#pads')!;
const empty = document.querySelector<HTMLElement>('#empty')!;
const select = document.querySelector<HTMLSelectElement>('#player')!;
const deadZone = document.querySelector<HTMLInputElement>('#dead-zone')!;
const applyMapping = document.querySelector<HTMLButtonElement>('#apply-mapping')!;
const mappingResult = document.querySelector<HTMLElement>('#mapping-result')!;
const canvas = document.querySelector('canvas')!;
const ctx = canvas.getContext('2d')!;
let input = createGamepadInput(),
  current: Controller[] = [],
  shape = '',
  frameId = 0,
  stopped = false;
let x = 280,
  y = 110,
  lastTime = 0,
  lastPaint = 0,
  paused = false,
  flashUntil = 0,
  jumpUntil = 0;
const mappingControls = new Map<
  string,
  { type: HTMLSelectElement; index: HTMLInputElement; scale: HTMLSelectElement }
>();
for (const [name, type, index] of [
  ['moveX', 'axis', 0],
  ['moveY', 'axis', 1],
  ['jump', 'button', 0],
  ['fire', 'button', 7],
  ['pause', 'button', 9],
] as const) {
  const row = el('div', '', 'mapping-row'),
    kind = el('select'),
    number = el('input'),
    scale = el('select');
  kind.append(new Option('Axis', 'axis'), new Option('Button', 'button'));
  kind.value = type;
  number.type = 'number';
  number.min = '0';
  number.max = '255';
  number.step = '1';
  number.value = String(index);
  number.required = true;
  scale.append(new Option('Normal', '1'), new Option('Invert', '-1'));
  kind.setAttribute('aria-label', `${name} source`);
  number.setAttribute('aria-label', `${name} index`);
  scale.setAttribute('aria-label', `${name} direction`);
  row.append(el('span', name), kind, number, scale);
  document.querySelector('#mapping-fields')!.append(row);
  mappingControls.set(name, { type: kind, index: number, scale });
}
applyMapping.onclick = () => {
  try {
    if (select.value === '') throw new Error('Connect a controller first.');
    const bindings: GamepadBindings = {};
    for (const [name, controls] of mappingControls) {
      const index = Number(controls.index.value),
        scale = Number(controls.scale.value) as 1 | -1;
      if (!controls.index.reportValidity()) return;
      bindings[name] = [
        controls.type.value === 'axis' ? { axis: index, scale } : { button: index, scale },
      ];
    }
    input.remap(Number(select.value), bindings);
    mappingResult.textContent = 'Mapping applied to this controller for this session.';
  } catch (error) {
    mappingResult.textContent = (error as Error).message;
  }
};
deadZone.oninput = () => {
  input.dispose();
  input = createGamepadInput(undefined, { deadZone: Number(deadZone.value) });
  document.querySelector('#dead-value')!.textContent = Number(deadZone.value).toFixed(2);
  mappingResult.textContent = 'Dead zone updated. Any test remapping was reset.';
};
const views = new Map<
  number,
  {
    axes: { meter: HTMLMeterElement; text: HTMLElement }[];
    buttons: HTMLElement[];
    actions: HTMLElement;
  }
>();
function paint(players: Controller[]) {
  const key = JSON.stringify(
    players.map((p) => [p.index, p.id, p.mapping, p.axes.length, p.buttons.length]),
  );
  if (key !== shape) {
    shape = key;
    pads.replaceChildren();
    views.clear();
    const selected = select.value;
    select.replaceChildren(
      ...players.map((p) => new Option(`Slot ${p.index + 1} · ${p.id}`, String(p.index))),
    );
    if (players.some((p) => String(p.index) === selected)) select.value = selected;
    if (!players.length) select.append(new Option('Waiting for a controller', ''));
    empty.hidden = players.length > 0;
    for (const p of players) {
      const card = el('section', '', 'card'),
        axisRows = el('div', '', 'readings'),
        buttonRows = el('div', '', 'readings buttons');
      card.append(
        el('p', `Slot ${p.index + 1} / ${p.mapping || 'nonstandard layout'}`, 'eyebrow'),
        el('h2', p.id),
      );
      const axes = p.axes.map((_, i) => {
        const label = el('label', '', 'reading'),
          text = el('span'),
          meter = el('meter');
        meter.min = -1;
        meter.max = 1;
        meter.setAttribute('aria-label', `Axis ${i}`);
        label.append(text, meter);
        axisRows.append(label);
        return { text, meter };
      });
      const buttons = p.buttons.map((_, i) => {
        const b = el('span', `B${i}`, 'pad-button');
        buttonRows.append(b);
        return b;
      });
      const actions = el('div', '', 'action');
      card.append(axisRows, buttonRows, actions);
      pads.append(card);
      views.set(p.index, { axes, buttons, actions });
    }
  }
  for (const p of players) {
    const view = views.get(p.index)!;
    p.axes.forEach((value, i) => {
      view.axes[i].meter.value = value;
      view.axes[i].text.textContent = `A${i} ${value.toFixed(2)}`;
    });
    p.buttons.forEach((value, i) => {
      view.buttons[i].textContent = `B${i} ${value.toFixed(2)}`;
      view.buttons[i].dataset.down = String(value >= 0.5);
    });
    view.actions.textContent = p.mapped
      ? Object.entries(p.actions)
          .map(([name, a]) => `${name}: ${a.value.toFixed(2)}`)
          .join(' · ')
      : 'Raw input is available. Map this controller to test game actions.';
  }
}
function tick(now: number) {
  if (stopped) return;
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  const result = input.poll();
  current = result.players;
  const messages = {
    ready: `${current.length} controller${current.length === 1 ? '' : 's'} connected · input stays local`,
    waiting: 'Press a controller button to find your signal.',
    inactive: 'Input paused · click inside this panel to test controls.',
    unavailable: 'Gamepad API unavailable. Try a supported browser on HTTPS or localhost.',
    blocked: 'This browser or host policy blocks Gamepad access. Try another supported browser.',
    closed: 'Controller test closed.',
  };
  if (status.textContent !== messages[result.status]) status.textContent = messages[result.status];
  if (now - lastPaint > 100 || !shape) {
    paint(current);
    lastPaint = now;
  }
  const controller = current.find((p) => String(p.index) === select.value);
  if (controller && result.status === 'ready') {
    const a = controller.actions;
    if (a.pause?.pressed) paused = !paused;
    if (!paused) {
      x = Math.max(15, Math.min(545, x + (a.moveX?.value ?? 0) * dt * 180));
      y = Math.max(15, Math.min(205, y + (a.moveY?.value ?? 0) * dt * 180));
      if (a.fire?.pressed) flashUntil = now + 180;
      if (a.jump?.pressed) jumpUntil = now + 250;
    }
  }
  ctx.clearRect(0, 0, 560, 220);
  ctx.strokeStyle = '#48533b';
  ctx.lineWidth = 1;
  for (let xx = 20; xx < 560; xx += 40) {
    ctx.beginPath();
    ctx.moveTo(xx, 0);
    ctx.lineTo(xx, 220);
    ctx.stroke();
  }
  for (let yy = 20; yy < 220; yy += 40) {
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(560, yy);
    ctx.stroke();
  }
  ctx.fillStyle = now < flashUntil ? '#f2775e' : '#d5e79c';
  ctx.beginPath();
  ctx.arc(x, y, now < jumpUntil ? 20 : 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f8f6ed';
  ctx.font = '12px monospace';
  ctx.fillText(paused ? 'PAUSED · START TO RESUME' : 'MOVE / JUMP / FIRE', 16, 24);
  frameId = requestAnimationFrame(tick);
}
window.addEventListener(
  'pagehide',
  () => {
    stopped = true;
    cancelAnimationFrame(frameId);
    input.dispose();
  },
  { once: true },
);
frameId = requestAnimationFrame(tick);
