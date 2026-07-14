// 入口：初始化 DiceBox、hook 库函数（spawnDice/startClickThrow/getDiceResults/DiceFactory）、
// 绑定 UI 事件、驱动一次完整掷骰流程。功能性代码分散在 state / materials / physics / expression / results 中。

import DiceBox from '@3d-dice/dice-box-threejs';
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

// ---- DiceBox 实例 ----
// dice-box 会在运行时用 assetPath 拼接贴图/音频 URL。
// 用相对当前 document 的路径，这样 dev（根路径）和 GitHub Pages（/repo/ 子路径）都能命中。
const box = new DiceBox('#scene-container', {
  assetPath: new URL('assets/', document.baseURI).href,
  // 声音库自带的骰面/桌面碰撞音；配合下面的 loadAudio 超时补丁，即便某些 mp3 加载慢也不会卡死初始化。
  sounds: true,
  volume: params.volume,
  sound_dieMaterial: 'plastic',
  theme_surface: 'green-felt',
  theme_material: getPreset().material,
  theme_texture: getPreset().texture,
  theme_customColorset: buildColorSet(),
  shadows: true,
  light_intensity: 2.4,
  gravity_multiplier: params.gravity,
  baseScale: params.size,
  strength: params.strength,
  onRollComplete: (results) => {
    // dice-box 会先 simulateThrow（快速物理）在里面调 storeRolledValue，然后再 animateThrow 视觉动画，
    // 两次物理不完全一致，视觉最终停下的面往往跟 stored 不同。所以在动画结束、body 已停稳时，
    // 再扶正一次并把最新 face 覆盖到 result，保证显示与画面一致。
    for (const die of box.diceList || []) {
      if (!die?.body || !die?.getFaceValue) continue;
      snapDieUpright(die);
      const face = die.getFaceValue();
      if (face && typeof face.value === 'number') {
        if (Array.isArray(die.result) && die.result.length > 0) die.result[die.result.length - 1] = face;
        else die.result = [face];
      }
    }
    if (ui.pendingRoll) reconcilePlanWithLiveDice(ui.pendingRoll, box);
    ui.resultDisplayedForRoll = true;
    clearStableResultWatcher();
    renderResults(results, ui.pendingRoll);
  },
});

// ---- Hook 库内部方法 ----

// iOS Safari 上，无用户手势时 <audio> 的 canplaythrough 事件常常不触发（比 canplay 苛刻很多），
// 会让 dice-box 的 loadAudio 永远挂起。这里改用 canplay + loadeddata 双重判定 + 超时兜底。
box.loadAudio = (src) => new Promise((resolve) => {
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
  audio.addEventListener('canplay', () => done(audio), { once: true });     // 比 canplaythrough 快得多
  audio.addEventListener('loadeddata', () => done(audio), { once: true }); // iOS 有时只到 loadeddata
  audio.addEventListener('error', () => done(null), { once: true });
  audio.src = src;
  audio.load(); // iOS 上必须显式调 load 才会开始下载
  setTimeout(() => done(null), 4000); // 4s 超时；音效非阻塞，慢一点没关系
});

// 库自带的 loadSounds 有两个问题：
//   1) 顺序 await，28 个 mp3 依次加载慢死；
//   2) counts 表用 'felt' 键但 surface 是 'green-felt'，桌面音永远加载失败（无声）。
// 全部替换成并行 + 名字修正版。
const SURFACE_SOUND_COUNTS = { 'green-felt': 7, felt: 7, wood_table: 7, wood_tray: 7, metal: 9 };
const DICE_SOUND_COUNTS = { coin: 6, metal: 12, plastic: 15, wood: 12 };

// 覆盖 loadSounds：立刻 return，真实加载在后台并行，加载完自动生效。
// 这样 initialize 不会被音效阻塞；用户刚打开就能扔骰子。
box.loadSounds = async function () {
  const materialFromTexture = this.colorData?.texture?.material?.match(/wood|metal/g);
  this.sound_dieMaterial = materialFromTexture ? this.colorData.texture.material : 'plastic';
  scheduleBackgroundSoundLoad(this);
};

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

// 世界墙每次重建后，都要重新调物理参数并把下墙抬到按钮上方。
const originalMakeWorldBox = box.makeWorldBox.bind(box);
box.makeWorldBox = (...args) => {
  originalMakeWorldBox(...args);
  tuneWorldPhysics(box, bottomControlsEl);
};

// 改骰面字体 + 烫金覆盖层。
const originalCreateTextMaterial = box.DiceFactory.createTextMaterial.bind(box.DiceFactory);
box.DiceFactory.createTextMaterial = (...args) => {
  const textureData = originalCreateTextMaterial(...args);
  drawGoldFoilLabel(textureData, ...args);
  return textureData;
};

const originalDiceFactoryCreate = box.DiceFactory.create.bind(box.DiceFactory);
box.DiceFactory.create = (type, ...args) => {
  const diceDef = box.DiceFactory.get(type);
  // Cinzel Decorative：瘦长笔画 + 古典装饰感，DND 圈流行；配合我们自己的黑底盘足以清晰可读。
  if (diceDef) diceDef.font = '"Cinzel Decorative", "Cinzel", Georgia, serif';
  const die = originalDiceFactoryCreate(type, ...args);
  tuneDieMaterials(die);
  return die;
};

// 库的 getDiceResults 对某些表达式/清空时机不够稳；有 pendingRoll 时用我们的数据。
const originalGetDiceResults = box.getDiceResults.bind(box);
box.getDiceResults = (...args) => {
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

// 库把 damping 固定写死在 spawnDice 里，这里包一层重写物理参数。
// 必须透传第二个参数：库在内部模拟后会调用 spawnDice(vector, existingDie) 复用骰子。
const originalSpawnDice = box.spawnDice.bind(box);
box.spawnDice = (...args) => {
  originalSpawnDice(...args);
  const die = args[1] || box.diceList.at(-1);
  syncDiceMeshesToBodies(box);
  applyBodyParamsToDie(die, true);
};

// 强化旋转戏剧性：减少横向乱飞，把力度更多转成陀螺式自旋。
const originalStartClickThrow = box.startClickThrow.bind(box);
box.startClickThrow = (notation) => {
  const notationVectors = originalStartClickThrow(notation);
  if (notationVectors?.vectors) {
    for (const vector of notationVectors.vectors) {
      const spinMultiplier = getSpinMultiplier();
      const horizontalBoost = 0.34 + params.force * 0.018;
      if (vector.pos) vector.pos.z = Math.min(vector.pos.z, 82 + Math.random() * 42);
      vector.velocity.x *= horizontalBoost;
      vector.velocity.y *= horizontalBoost;
      vector.velocity.z = Math.min(vector.velocity.z, -42); // 压低出生高度和垂直速度，避免看起来被抛飞。
      vector.angle.x *= spinMultiplier * 0.22;
      vector.angle.y *= spinMultiplier * 0.22;
      vector.angle.z = (Math.random() < 0.5 ? -1 : 1) * spinMultiplier * (3.0 + Math.random() * 1.8);
    }
  }
  return notationVectors;
};

// ---- 初始化 & 参数 ----

// 给可能卡住的 async 步骤一个超时兜底，超时后走 fallback，不阻塞初始化。
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function loadCustomSounds() {
  try {
    const sounds = await Promise.all(customSoundFiles.map((file) => box.loadAudio(file)));
    const validSounds = sounds.filter(Boolean);
    if (validSounds.length === 0) return;
    // 只覆盖骰子撞击音；桌面撞击音继续用官方 loadSounds 加载的 green-felt。
    box.sounds_dice.plastic = validSounds;
    box.sound_dieMaterial = 'plastic';
  } catch (err) {
    console.warn('自定义音效加载失败', err);
  }
}

async function init() {
  try {
    // 字体加载最多等 1.5s：iOS Safari 弱网/CORS/证书问题下 document.fonts.ready 可能永不 resolve。
    if (document.fonts?.ready) await withTimeout(document.fonts.ready, 1500);
    setStatus('加载素材中...');
    await box.initialize();
    applyAllParams();
    tuneWorldPhysics(box, bottomControlsEl);
    installContextLossHandler();
    setStatus('已加载，输入表达式后掷骰');
    // 官方音效由覆盖后的 loadSounds 后台并行加载；再叠一层自定义骰音（比官方 plastic 更好听）。
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
    const gl = box.renderer?.getContext?.();
    return !!gl && !gl.isContextLost();
  } catch { return false; }
}

// 完整重建 renderer 及场景绑定：把 dice-box 内部对 renderer/camera 的引用全部换成新的。
async function fullRebuildRenderer() {
  if (recovering) return;
  recovering = true;
  setStatus('画面重建中...');
  try {
    // 1. 清桌面骰子（mesh + body）
    box.clearDice?.();
    // 2. 干掉旧 canvas
    const oldCanvas = box.renderer?.domElement;
    if (oldCanvas?.parentNode) oldCanvas.parentNode.removeChild(oldCanvas);
    try { box.renderer?.dispose?.(); } catch {}
    box.renderer = null;
    // 3. 清各种 GL 资源缓存
    if (box.DiceFactory) {
      box.DiceFactory.materials_cache = {};
      box.DiceFactory.geometries = {};
    }
    box.initialized = false;
    // 4. 重跑一次 initialize（会 new 出全新的 WebGLRenderer 并 append）
    await box.initialize();
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
  const canvas = box.renderer?.domElement;
  if (!canvas) return;
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault(); // 必须调，否则浏览器不会尝试 restore
    contextLost = true;
    console.warn('WebGL context lost');
    setStatus('画面被系统回收，切换到本页或点掷骰即恢复');
  }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    console.warn('WebGL context restored (native event)');
    fullRebuildRenderer(); // 事件触发到了也走完整重建最稳
  }, false);
}

// 从后台回到前台时主动检查；iOS 常常不派发 webglcontextrestored 事件，靠这条兜底。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && box.initialized && !isContextAlive()) {
    fullRebuildRenderer();
  }
});

// 每次点掷骰前也探测一次，最保底。
function ensureContextAlive() {
  if (box.initialized && !isContextAlive() && !recovering) {
    fullRebuildRenderer();
    return false;
  }
  return true;
}

function applyAllParams() {
  applyForceProfile();
  box.strength = params.strength;
  box.volume = params.volume;
  box.gravity_multiplier = params.gravity;
  box.baseScale = params.size;
  if (box.world) box.world.gravity.set(0, 0, -9.8 * params.gravity);
  if (box.DiceFactory) {
    box.DiceFactory.baseScale = params.size;
    // 几何/材质缓存跟尺寸有关，改大小后要清空。
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

// ---- 掷骰主流程 ----

async function roll(input) {
  const expr = input.trim();
  if (!expr || !box.initialized) return;
  // 探测 WebGL context 是否还活着；死了先重建再掷。iOS 切后台回来常会走到这里。
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
    // 新掷骰前清空桌面旧骰子，避免越堆越多。
    box.clearDice();
    box.rolling = false;
    box.notationVectors = null;

    if (!plan.libraryNotation) {
      renderResults({ total: plan.total }, plan);
      return;
    }

    const rollPromise = box.roll(plan.libraryNotation);
    startStableResultWatcher(box, plan);
    await rollPromise;
    // 结果展示由 onRollComplete 触发；这里仅兜底：如果异常没触发到就补一次。
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
  setTimeout(() => { submitJustHandled = false; }, 400); // 防止 click + submit 双触发
  hideTransientPanels();
  notationEl?.blur(); // iOS 上收键盘，避免视口回弹与画布位置错乱
  roll(notationEl.value);
}

formEl?.addEventListener('submit', (event) => {
  event.preventDefault();
  submitExpression();
});

// iOS 兜底：虚拟键盘打开时，点击表单里的 button 有时不会派发 submit（尤其 pointer 被打断的情况）。
// 直接监听按钮 click 也走同一份逻辑，防抖由 submitJustHandled 保证只执行一次。
formEl?.querySelector('button[type="submit"]')?.addEventListener('click', (event) => {
  event.preventDefault();
  submitExpression();
});

paramInputs.forEach((input) => {
  // 初始化不写 status，避免刚加载完就把"已加载..."文字盖掉。
  setParam(input.dataset.param, input.value, { updateStatus: false });
  input.addEventListener('input', () => setParam(input.dataset.param, input.value));
});

// 长按打开表达式编辑器，短按掷骰。
// iOS Safari 特殊性：长按按钮会触发 haptic touch / callout 菜单，把 pointerup 吞成 pointercancel，
// 导致"点了没反应"。所以：
//   1) pointerdown 里 preventDefault，避免 iOS 触发触觉反馈选择菜单；
//   2) 用 click 事件作为掷骰兜底 —— pointer 序列被打断后浏览器还会派发 click；
//   3) 加一层短按标志，防止 pointerup 和 click 重复触发。
let longPressTimer = null;
let longPressTriggered = false;
let shortPressJustHandled = false;

function showExpressionEditor() {
  hideTransientPanels('expression');
  setPanelVisible(expressionPanelEl, true);
  notationEl.focus();
  notationEl.select();
}

// iOS Safari 要求音频必须在用户手势 stack 内首次调用 play()，之后才允许在异步回调里自动播放。
// 所以第一次点掷骰时预热一次：静音 play+pause，解锁自动播放限制。
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  const pool = [
    ...(box.sounds_dice?.plastic || []),
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
  setTimeout(() => { shortPressJustHandled = false; }, 400); // 防抖：pointerup 和 click 只处理一次
  unlockAudio();
  hideTransientPanels();
  roll(notationEl.value);
}

rollButtonEl?.addEventListener('pointerdown', (event) => {
  event.preventDefault(); // 阻止 iOS 长按弹选择菜单/触觉反馈，避免 pointerup 被 cancel
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

// iOS 上 pointer 序列可能被系统打断（比如触觉反馈生效），但 click 事件依然会派发，这里兜底。
rollButtonEl?.addEventListener('click', () => {
  clearTimeout(longPressTimer);
  if (!longPressTriggered) triggerRoll();
});

rollButtonEl?.addEventListener('pointercancel', () => clearTimeout(longPressTimer));
rollButtonEl?.addEventListener('contextmenu', (event) => event.preventDefault());

// iOS 26 上侧边按钮 click 有时被 haptic touch 吞，用防抖后同时监听 pointerup + click 兜底。
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

// ---- 材质切换 ----

async function applyVisualPreset() {
  const preset = getPreset();
  // 切材质前先释放旧的纹理/几何 GPU 资源，避免手机上显存累积导致白屏。
  disposeDiceFactoryCache();
  await box.updateConfig({
    theme_customColorset: buildColorSet(),
    theme_texture: preset.texture,
    theme_material: preset.material,
  });
  // 只清桌面，不再扔样例骰子——手机上重复加载 6 种模型 + 展示动画极易撑爆显存。
  // 用户下一次点掷骰时才会看到新材质。
  box.clearDice();
}

function disposeDiceFactoryCache() {
  if (!box.DiceFactory) return;
  // materials_cache 里是 { key: [material...] } 结构；每个 material 可能包含 map、bumpMap 等纹理。
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

// iOS 26 上普通 click 偶尔被 haptic touch 吞掉；用 pointerup 触发 + 防抖，比 click 更可靠。
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
  // 两个都监听，谁先触发用谁；防抖保证只执行一次。
  button.addEventListener('pointerup', () => pickMaterial(button));
  button.addEventListener('click', () => pickMaterial(button));
});

syncMaterialOptions();

// ---- 生命周期 ----

window.addEventListener('resize', () => {
  if (box.initialized) {
    box.onWindowResize?.();
    requestAnimationFrame(() => tuneWorldPhysics(box, bottomControlsEl));
  }
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    // 用相对路径注册，让 SW scope 自动继承页面所在子路径（GitHub Pages 的 /<repo>/）。
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).catch(() => {});
  });
}

init();
