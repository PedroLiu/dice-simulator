// 入口：初始化 DiceBox、hook 库函数（spawnDice/startClickThrow/getDiceResults/DiceFactory）、
// 绑定 UI 事件、驱动一次完整掷骰流程。功能性代码分散在 state / materials / physics / expression / results 中。
// DiceBox（Three + cannon）体积大，动态 import，让 HUD/背景先画出来。

import './style.css';
import { params, ui } from './state.js';
import { materialPresets, getPreset, buildColorSet, drawGoldFoilLabel, tuneDieMaterials } from './materials.js';
import {
  applyForceProfile, getSpinMultiplier, snapDieUpright,
  applyBodyParamsToDie, applyBodyParams, syncDiceMeshesToBodies,
  tuneWorldPhysics, startStableResultWatcher, clearStableResultWatcher,
} from './physics.js';
import { buildRollPlan, reconcilePlanWithLiveDice } from './expression.js';
import { renderResults, showResultSummary, clearResultSummary, setStatus } from './results.js';

// dice-box-threejs@0.0.12 的 updateConfig 内部误写了 Object.apply；这里兼容一下。
if (!Object.apply) Object.apply = Object.assign;

// ---- DOM refs ----
const formEl = document.querySelector('#roll-form');
const notationEl = document.querySelector('#notation');
const materialOptionEls = document.querySelectorAll('[data-material]');
const forceToggleEl = document.querySelector('#force-toggle');
const styleToggleEl = document.querySelector('#style-toggle');
const rollButtonEl = document.querySelector('#roll-button');
const bottomControlsEl = document.querySelector('.bottom-controls');
const forcePanelEl = document.querySelector('#force-panel');
const stylePanelEl = document.querySelector('#style-panel');
const expressionPanelEl = document.querySelector('#roll-form');
const paramInputs = document.querySelectorAll('[data-param]');

globalThis.__diceModelStyle = 'classic';
applyForceProfile();

const customSoundFiles = [
  new URL('../sounds/freesound_community-dice-95077.mp3', import.meta.url).href,
  new URL('../sounds/u_qpfzpydtro-dice-142528.mp3', import.meta.url).href,
];
let customThrowSounds = [];
let throwSoundTimer = null;

// 触控/窄屏/弱设备：关阴影、压 DPR，减轻 VRAM 与 WebGL context loss。
const preferLowGpu = (() => {
  try {
    if (window.matchMedia('(pointer: coarse)').matches) return true;
    if (window.matchMedia('(max-width: 900px)').matches) return true;
    if ((navigator.hardwareConcurrency || 8) <= 4) return true;
    if ((navigator.deviceMemory || 8) <= 4) return true;
  } catch { /* ignore */ }
  return false;
})();

/** @type {import('@3d-dice/dice-box-threejs').default | null} */
let box = null;

const SURFACE_SOUND_COUNTS = { 'green-felt': 7, felt: 7, wood_table: 7, wood_tray: 7, metal: 9 };
const DICE_SOUND_COUNTS = { coin: 6, metal: 12, plastic: 15, wood: 12 };

function createBox(DiceBox) {
  // dice-box 会在运行时用 assetPath 拼接贴图/音频 URL。
  // 用相对当前 document 的路径，这样 dev（根路径）和 GitHub Pages（/repo/ 子路径）都能命中。
  const instance = new DiceBox('#scene-container', {
    assetPath: new URL('assets/', document.baseURI).href,
    // 声音库自带的骰面/桌面碰撞音；配合下面的 loadAudio 超时补丁，即便某些 mp3 加载慢也不会卡死初始化。
    sounds: true,
    volume: params.volume,
    sound_dieMaterial: 'plastic',
    theme_surface: 'green-felt',
    theme_material: getPreset().material,
    theme_texture: getPreset().texture,
    theme_customColorset: buildColorSet(),
    shadows: !preferLowGpu,
    // 旧引擎的半球光和聚光灯共用该强度；原值在深色背景上会让 multiply 贴图明显发灰发暗。
    light_intensity: preferLowGpu ? 2.7 : 3.1,
    gravity_multiplier: params.gravity,
    baseScale: params.size,
    strength: params.strength,
    onRollComplete: (results) => {
      // dice-box 会先 simulateThrow（快速物理）在里面调 storeRolledValue，然后再 animateThrow 视觉动画，
      // 两次物理不完全一致，视觉最终停下的面往往跟 stored 不同。所以在动画结束、body 已停稳时，
      // 再扶正一次并把最新 face 覆盖到 result，保证显示与画面一致。
      for (const die of instance.diceList || []) {
        if (!die?.body || !die?.getFaceValue) continue;
        snapDieUpright(die);
        const face = die.getFaceValue();
        if (face && typeof face.value === 'number') {
          if (Array.isArray(die.result) && die.result.length > 0) die.result[die.result.length - 1] = face;
          else die.result = [face];
        }
      }
      if (ui.pendingRoll) reconcilePlanWithLiveDice(ui.pendingRoll, instance);
      ui.resultDisplayedForRoll = true;
      clearStableResultWatcher();
      renderResults(results, ui.pendingRoll);
    },
  });

  hookBoxBehaviors(instance);
  return instance;
}

function hookBoxBehaviors(instance) {
  // iOS Safari 上，无用户手势时 <audio> 的 canplaythrough 事件常常不触发（比 canplay 苛刻很多），
  // 会让 dice-box 的 loadAudio 永远挂起。这里改用 canplay + loadeddata 双重判定 + 超时兜底。
  instance.loadAudio = (src) => new Promise((resolve) => {
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    audio.addEventListener('canplaythrough', () => done(audio), { once: true });
    audio.addEventListener('canplay', () => done(audio), { once: true });
    audio.addEventListener('loadeddata', () => done(audio), { once: true });
    audio.addEventListener('error', () => done(null), { once: true });
    audio.src = src;
    audio.load();
    setTimeout(() => done(null), 4000);
  });

  // 覆盖 loadSounds：立刻 return，真实加载在后台并行，加载完自动生效。
  instance.loadSounds = async function () {
    const materialFromTexture = this.colorData?.texture?.material?.match(/wood|metal/g);
    this.sound_dieMaterial = materialFromTexture ? this.colorData.texture.material : 'plastic';
    scheduleBackgroundSoundLoad(this);
  };

  // 主题贴图数组（如 astralsea 6 张 bronze）默认串行 await，改成并行。
  if (instance.DiceColors?.ImageLoader) {
    const originalImageLoader = instance.DiceColors.ImageLoader.bind(instance.DiceColors);
    instance.DiceColors.ImageLoader = async function (entry) {
      if (Array.isArray(entry)) {
        return Promise.all(entry.map((item) => originalImageLoader(item)));
      }
      return originalImageLoader(entry);
    };
  }

  const originalMakeWorldBox = instance.makeWorldBox.bind(instance);
  instance.makeWorldBox = (...args) => {
    originalMakeWorldBox(...args);
    tuneWorldPhysics(instance, bottomControlsEl);
  };

  const originalCreateTextMaterial = instance.DiceFactory.createTextMaterial.bind(instance.DiceFactory);
  instance.DiceFactory.createTextMaterial = (...args) => {
    const textureData = originalCreateTextMaterial(...args);
    drawGoldFoilLabel(textureData, ...args);
    return textureData;
  };

  const originalDiceFactoryCreate = instance.DiceFactory.create.bind(instance.DiceFactory);
  instance.DiceFactory.create = (type, ...args) => {
    const diceDef = instance.DiceFactory.get(type);
    if (diceDef) diceDef.font = '"Cinzel Decorative", Georgia, serif';
    const die = originalDiceFactoryCreate(type, ...args);
    tuneDieMaterials(die);
    return die;
  };

  const originalGetDiceResults = instance.getDiceResults.bind(instance);
  instance.getDiceResults = (...args) => {
    const plan = ui.pendingRoll;
    if (plan) {
      return {
        notation: plan.input,
        sets: plan.groups.map((group) => ({
          num: group.dice.length,
          type: `d${group.term.sides}`,
          sides: group.term.sides,
          rolls: group.dice.map((die, index) => ({ id: index, type: `d${die.sides}`, sides: die.sides, value: die.value })),
          total: group.dice.filter((die) => die.kept).reduce((sum, die) => sum + die.value, 0),
        })),
        modifier: plan.constantTotal,
        total: plan.total,
      };
    }
    return originalGetDiceResults(...args);
  };

  const originalSpawnDice = instance.spawnDice.bind(instance);
  instance.spawnDice = (...args) => {
    originalSpawnDice(...args);
    const die = args[1] || instance.diceList.at(-1);
    syncDiceMeshesToBodies(instance);
    applyBodyParamsToDie(die, true);
  };

  const originalStartClickThrow = instance.startClickThrow.bind(instance);
  instance.startClickThrow = (notation) => {
    const notationVectors = originalStartClickThrow(notation);
    if (notationVectors?.vectors) {
      for (const vector of notationVectors.vectors) {
        const spinMultiplier = getSpinMultiplier();
        const horizontalBoost = 0.34 + params.force * 0.018;
        if (vector.pos) vector.pos.z = Math.min(vector.pos.z, 82 + Math.random() * 42);
        vector.velocity.x *= horizontalBoost;
        vector.velocity.y *= horizontalBoost;
        vector.velocity.z = Math.min(vector.velocity.z, -42);
        vector.angle.x *= spinMultiplier * 0.22;
        vector.angle.y *= spinMultiplier * 0.22;
        vector.angle.z = (Math.random() < 0.5 ? -1 : 1) * spinMultiplier * (3.0 + Math.random() * 1.8);
      }
    }
    return notationVectors;
  };
}

async function scheduleBackgroundSoundLoad(instance) {
  const loadBatch = async (baseUrl, count) => {
    if (!count) return [];
    const urls = Array.from({ length: count }, (_, i) => `${baseUrl}${i + 1}.mp3`);
    const audios = await Promise.all(urls.map((u) => instance.loadAudio(u)));
    return audios.filter(Boolean);
  };

  const surfaceCount = SURFACE_SOUND_COUNTS[instance.surface] ?? 0;
  const dieCount = DICE_SOUND_COUNTS[instance.sound_dieMaterial] || 0;
  try {
    const [surfaceAudios, coinAudios, dieAudios] = await Promise.all([
      instance.sounds_table[instance.surface]?.length ? Promise.resolve(instance.sounds_table[instance.surface])
        : loadBatch(`${instance.assetPath}sounds/surfaces/surface_${instance.surface}`, surfaceCount),
      instance.sounds_dice.coin?.length ? Promise.resolve(instance.sounds_dice.coin)
        : loadBatch(`${instance.assetPath}sounds/dicehit/dicehit_coin`, DICE_SOUND_COUNTS.coin),
      instance.sounds_dice[instance.sound_dieMaterial]?.length ? Promise.resolve(instance.sounds_dice[instance.sound_dieMaterial])
        : loadBatch(`${instance.assetPath}sounds/dicehit/dicehit_${instance.sound_dieMaterial}`, dieCount),
    ]);
    if (surfaceAudios.length) instance.sounds_table[instance.surface] = surfaceAudios;
    if (coinAudios.length) instance.sounds_dice.coin = coinAudios;
    if (dieAudios.length) instance.sounds_dice[instance.sound_dieMaterial] = dieAudios;
  } catch (err) {
    console.warn('后台音效加载失败', err);
  }
}

function tuneRenderer(instance) {
  const renderer = instance.renderer;
  if (!renderer?.setPixelRatio) return;
  const cap = preferLowGpu ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(cap, window.devicePixelRatio || 1));
  instance.onWindowResize?.();
}

async function loadCustomSounds() {
  if (!box) return;
  try {
    const sounds = await Promise.all(customSoundFiles.map((file) => box.loadAudio(file)));
    customThrowSounds = sounds.filter(Boolean);
  } catch (err) {
    console.warn('自定义音效加载失败', err);
  }
}

function playThrowSound(audio, volume = 0.42) {
  if (!audio) return;
  try {
    audio.pause();
    audio.currentTime = 0;
    audio.volume = Math.min(1, volume * params.volume / 100);
    audio.play().catch(() => {});
  } catch { /* 音效失败不影响掷骰 */ }
}

function playThrowSoundSequence() {
  clearTimeout(throwSoundTimer);
  if (customThrowSounds.length === 0) return;

  playThrowSound(customThrowSounds[0], 0.5);

  // 骰子飞行中间偶尔补一段，避免每次都完全相同。
  if (customThrowSounds.length > 1 && Math.random() < 0.58) {
    const middleAudio = customThrowSounds[1];
    // 在当前用户手势内静音解锁，确保 iOS 允许定时器稍后播放。
    middleAudio.muted = true;
    middleAudio.play().then(() => {
      middleAudio.pause();
      middleAudio.currentTime = 0;
      middleAudio.muted = false;
    }).catch(() => { middleAudio.muted = false; });
    throwSoundTimer = setTimeout(() => {
      playThrowSound(middleAudio, 0.34);
    }, 260 + Math.random() * 360);
  }
}

async function init() {
  try {
    setStatus('加载引擎中...');
    const { default: DiceBox } = await import('@3d-dice/dice-box-threejs');
    box = createBox(DiceBox);

    setStatus('加载素材中...');
    await box.initialize();
    tuneRenderer(box);
    applyAllParams();
    tuneWorldPhysics(box, bottomControlsEl);
    installContextLossHandler();
    setStatus('已加载，输入表达式后掷骰');
    loadCustomSounds();
  } catch (err) {
    console.error(err);
    setStatus(`初始化失败：${err?.message || err}`);
    showResultSummary('!', String(err?.message || err));
  }
}

// iOS Safari 会主动释放 WebGL context（切后台、GPU 抢占、内存吃紧都会触发），
// 恢复后如果不处理，画面永远白/黑。三层防线：
//   1) webglcontextlost/restored：能收到事件就走轻量恢复（清缓存 + 重 render）
//   2) visibilitychange：从后台回前台时主动检查 GL 是否还活着；死了就重建 renderer
//   3) 每次掷骰前也探测一次，兜底

let recovering = false;
let contextLost = false;

function isContextAlive() {
  try {
    const gl = box?.renderer?.getContext?.();
    return !!gl && !gl.isContextLost();
  } catch { return false; }
}

async function fullRebuildRenderer() {
  if (!box || recovering) return;
  recovering = true;
  setStatus('画面重建中...');
  try {
    box.clearDice?.();
    const oldCanvas = box.renderer?.domElement;
    if (oldCanvas?.parentNode) oldCanvas.parentNode.removeChild(oldCanvas);
    try { box.renderer?.dispose?.(); } catch {}
    box.renderer = null;
    if (box.DiceFactory) {
      box.DiceFactory.materials_cache = {};
      box.DiceFactory.geometries = {};
    }
    box.initialized = false;
    await box.initialize();
    tuneRenderer(box);
    installContextLossHandler();
    applyAllParams();
    tuneWorldPhysics(box, bottomControlsEl);
    contextLost = false;
    setStatus('画面已恢复，可继续掷骰');
  } catch (err) {
    console.error('重建 WebGL 失败', err);
    setStatus('画面恢复失败，请刷新页面');
  } finally {
    recovering = false;
  }
}

function installContextLossHandler() {
  const canvas = box?.renderer?.domElement;
  if (!canvas) return;
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    contextLost = true;
    console.warn('WebGL context lost');
    setStatus('画面被系统回收，切换到本页或点掷骰即恢复');
  }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    console.warn('WebGL context restored (native event)');
    fullRebuildRenderer();
  }, false);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && box?.initialized && !isContextAlive()) {
    fullRebuildRenderer();
  }
});

function ensureContextAlive() {
  if (box?.initialized && !isContextAlive() && !recovering) {
    fullRebuildRenderer();
    return false;
  }
  return true;
}

function applyAllParams() {
  if (!box) return;
  applyForceProfile();
  box.strength = params.strength;
  box.volume = params.volume;
  box.gravity_multiplier = params.gravity;
  box.baseScale = params.size;
  if (preferLowGpu && typeof box.disableShadows === 'function') box.disableShadows();
  else if (!preferLowGpu && typeof box.enableShadows === 'function') box.enableShadows();
  if (box.world) box.world.gravity.set(0, 0, -9.8 * params.gravity);
  if (box.DiceFactory) {
    box.DiceFactory.baseScale = params.size;
    box.DiceFactory.geometries = {};
    box.DiceFactory.materials_cache = {};
  }
  applyBodyParams(box);
}

function setParam(name, rawValue, { updateStatus = true } = {}) {
  const value = Number(rawValue);
  params[name] = value;
  const output = document.querySelector(`[data-value="${name}"]`);
  if (output) output.textContent = name === 'size' ? String(Math.round(value)) : value.toFixed(1);
  if (name === 'force') { applyAllParams(); if (updateStatus) setStatus(`力度 ${params.force.toFixed(1)}`); }
  else if (name === 'size') { applyAllParams(); if (updateStatus) setStatus(`骰子大小 ${Math.round(params.size)}`); }
}

async function roll(input) {
  const expr = input.trim();
  if (!expr || !box?.initialized) return;
  if (!ensureContextAlive()) {
    setStatus('画面恢复中，稍后请重试');
    return;
  }

  let plan;
  try {
    plan = buildRollPlan(expr);
  } catch (err) {
    setStatus('表达式错误');
    showResultSummary('!', String(err?.message || err));
    return;
  }

  ui.pendingRoll = plan;
  ui.resultDisplayedForRoll = false;
  clearStableResultWatcher();
  setStatus(`掷骰中：${expr}`);
  clearResultSummary();

  try {
    box.clearDice();
    box.rolling = false;
    box.notationVectors = null;

    if (!plan.libraryNotation) {
      renderResults({ total: plan.total }, plan);
      return;
    }

    playThrowSoundSequence();
    const rollPromise = box.roll(plan.libraryNotation);
    startStableResultWatcher(box, plan);
    await rollPromise;
    if (!ui.resultDisplayedForRoll) {
      reconcilePlanWithLiveDice(plan, box);
      renderResults({ total: plan.total }, plan);
    }
  } catch (err) {
    console.error(err);
    setStatus('掷骰失败，请看控制台');
    showResultSummary('!', String(err?.message || err));
  }
}

// ---- UI 事件 ----

let submitJustHandled = false;
function submitExpression() {
  if (submitJustHandled) return;
  submitJustHandled = true;
  setTimeout(() => { submitJustHandled = false; }, 400);
  hideTransientPanels();
  notationEl?.blur();
  roll(notationEl.value);
}

formEl?.addEventListener('submit', (event) => {
  event.preventDefault();
  submitExpression();
});

formEl?.querySelector('button[type="submit"]')?.addEventListener('click', (event) => {
  event.preventDefault();
  submitExpression();
});

paramInputs.forEach((input) => {
  setParam(input.dataset.param, input.value, { updateStatus: false });
  input.addEventListener('input', () => setParam(input.dataset.param, input.value));
});

let longPressTimer = null;
let longPressTriggered = false;
let shortPressJustHandled = false;

function showExpressionEditor() {
  hideTransientPanels('expression');
  setPanelVisible(expressionPanelEl, true);
  notationEl.focus();
  notationEl.select();
}

let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked || !box) return;
  audioUnlocked = true;
  const pool = [
    ...(box.sounds_dice?.[box.sound_dieMaterial] || []),
    ...(box.sounds_table?.[box.surface] || []),
  ];
  for (const audio of pool) {
    if (!audio) continue;
    const prevVolume = audio.volume;
    audio.volume = 0;
    audio.play().then(() => { audio.pause(); audio.currentTime = 0; audio.volume = prevVolume; })
      .catch(() => { audio.volume = prevVolume; });
  }
}

function triggerRoll() {
  if (shortPressJustHandled) return;
  shortPressJustHandled = true;
  setTimeout(() => { shortPressJustHandled = false; }, 400);
  unlockAudio();
  hideTransientPanels();
  roll(notationEl.value);
}

rollButtonEl?.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  longPressTriggered = false;
  clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    longPressTriggered = true;
    showExpressionEditor();
  }, 520);
});

rollButtonEl?.addEventListener('pointerup', () => {
  clearTimeout(longPressTimer);
  if (!longPressTriggered) triggerRoll();
});

rollButtonEl?.addEventListener('click', () => {
  clearTimeout(longPressTimer);
  if (!longPressTriggered) triggerRoll();
});

rollButtonEl?.addEventListener('pointercancel', () => clearTimeout(longPressTimer));
rollButtonEl?.addEventListener('contextmenu', (event) => event.preventDefault());

function bindTogglePanel(button, panel, onOpen) {
  let guard = false;
  const handler = () => {
    if (guard) return;
    guard = true;
    setTimeout(() => { guard = false; }, 400);
    const willShow = panel?.classList.contains('hidden');
    hideTransientPanels(willShow ? panel.id.replace('-panel', '') : null);
    setPanelVisible(panel, Boolean(willShow));
    if (willShow) onOpen?.();
  };
  button?.addEventListener('pointerup', handler);
  button?.addEventListener('click', handler);
}
bindTogglePanel(forceToggleEl, forcePanelEl);
bindTogglePanel(styleToggleEl, stylePanelEl);

function setPanelVisible(panel, visible) {
  panel?.classList.toggle('hidden', !visible);
}

function hideTransientPanels(except = null) {
  if (except !== 'force') setPanelVisible(forcePanelEl, false);
  if (except !== 'style') setPanelVisible(stylePanelEl, false);
  if (except !== 'expression') setPanelVisible(expressionPanelEl, false);
}

async function applyVisualPreset() {
  if (!box?.initialized) return;
  const preset = getPreset();
  disposeDiceFactoryCache();
  await box.updateConfig({
    theme_customColorset: buildColorSet(),
    theme_texture: preset.texture,
    theme_material: preset.material,
  });
  box.clearDice();
}

function disposeDiceFactoryCache() {
  if (!box?.DiceFactory) return;
  for (const materials of Object.values(box.DiceFactory.materials_cache || {})) {
    for (const mat of Array.isArray(materials) ? materials : [materials]) {
      if (!mat) continue;
      mat.map?.dispose?.();
      mat.bumpMap?.dispose?.();
      mat.normalMap?.dispose?.();
      mat.envMap?.dispose?.();
      mat.dispose?.();
    }
  }
  for (const geom of Object.values(box.DiceFactory.geometries || {})) {
    geom?.dispose?.();
  }
  box.DiceFactory.materials_cache = {};
  box.DiceFactory.geometries = {};
}

function syncMaterialOptions() {
  materialOptionEls.forEach((button) => {
    const active = button.dataset.material === ui.preset;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
}

let materialPressGuard = false;
async function pickMaterial(button) {
  if (materialPressGuard) return;
  materialPressGuard = true;
  setTimeout(() => { materialPressGuard = false; }, 400);
  const next = button.dataset.material;
  if (!next || next === ui.preset || !materialPresets[next]) return;
  ui.preset = next;
  syncMaterialOptions();
  await applyVisualPreset();
}

materialOptionEls.forEach((button) => {
  button.addEventListener('pointerup', () => pickMaterial(button));
  button.addEventListener('click', () => pickMaterial(button));
});

syncMaterialOptions();

window.addEventListener('resize', () => {
  if (box?.initialized) {
    box.onWindowResize?.();
    requestAnimationFrame(() => tuneWorldPhysics(box, bottomControlsEl));
  }
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).catch(() => {});
  });
}

init();
