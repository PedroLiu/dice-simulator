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
  if (diceDef) diceDef.font = 'Cormorant Garamond, DNDOfficial, Cinzel, Georgia, serif';
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

async function init() {
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    await box.initialize();
    await loadCustomSounds();
    applyAllParams();
    tuneWorldPhysics(box, bottomControlsEl);
    setStatus('已加载，输入表达式后掷骰');
  } catch (err) {
    console.error(err);
    setStatus('初始化失败，请看控制台');
    showResultSummary('!', String(err?.message || err));
  }
}

async function loadCustomSounds() {
  try {
    const sounds = await Promise.all(customSoundFiles.map((file) => box.loadAudio(file)));
    const validSounds = sounds.filter(Boolean);
    if (validSounds.length === 0) return;
    // dice-box-threejs 会从数组中随机挑一个播放。骰子撞击 + 桌面撞击都替换为自定义音效。
    box.sounds_dice.plastic = validSounds;
    box.sounds_table[box.surface] = validSounds;
    box.sound_dieMaterial = 'plastic';
  } catch (err) {
    console.warn('自定义音效加载失败，继续使用官方音效', err);
  }
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

function setParam(name, rawValue) {
  const value = Number(rawValue);
  params[name] = value;
  const output = document.querySelector(`[data-value="${name}"]`);
  if (output) output.textContent = name === 'size' ? String(Math.round(value)) : value.toFixed(1);
  if (name === 'force') { applyAllParams(); setStatus(`力度 ${params.force.toFixed(1)}`); }
  else if (name === 'size') { applyAllParams(); setStatus(`骰子大小 ${Math.round(params.size)}`); }
}

// ---- 掷骰主流程 ----

async function roll(input) {
  const expr = input.trim();
  if (!expr || !box.initialized) return;

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
  setParam(input.dataset.param, input.value);
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

function triggerRoll() {
  if (shortPressJustHandled) return;
  shortPressJustHandled = true;
  setTimeout(() => { shortPressJustHandled = false; }, 400); // 防抖：pointerup 和 click 只处理一次
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

forceToggleEl?.addEventListener('click', () => {
  const willShow = forcePanelEl?.classList.contains('hidden');
  hideTransientPanels(willShow ? 'force' : null);
  setPanelVisible(forcePanelEl, Boolean(willShow));
});

styleToggleEl?.addEventListener('click', () => {
  const willShow = stylePanelEl?.classList.contains('hidden');
  hideTransientPanels(willShow ? 'style' : null);
  setPanelVisible(stylePanelEl, Boolean(willShow));
  if (willShow) showStyleSamples();
});

function setPanelVisible(panel, visible) {
  panel?.classList.toggle('hidden', !visible);
}

function hideTransientPanels(except = null) {
  if (except !== 'force') setPanelVisible(forcePanelEl, false);
  if (except !== 'style') setPanelVisible(stylePanelEl, false);
  if (except !== 'expression') setPanelVisible(expressionPanelEl, false);
}

// ---- 材质切换 ----

async function showStyleSamples() {
  if (!box.initialized) return;
  ui.pendingRoll = null;
  ui.resultDisplayedForRoll = false;
  clearStableResultWatcher();
  box.clearDice();
  box.rolling = false;
  box.notationVectors = null;
  setStatus('样式预览');
  clearResultSummary();
  try {
    await box.roll('1d4+1d6+1d8+1d10+1d12+1d20');
  } catch (err) {
    console.warn('样式预览失败', err);
  }
}

async function applyVisualPreset() {
  const preset = getPreset();
  setStatus(`切换材质：${preset.label}`);
  await box.updateConfig({
    theme_customColorset: buildColorSet(),
    theme_texture: preset.texture,
    theme_material: preset.material,
  });
  // 几何/材质缓存跟预设有关，切换后要清空并重掷。
  box.DiceFactory.materials_cache = {};
  box.DiceFactory.geometries = {};
  box.clearDice();
  setStatus(`材质已切换：${preset.label}`);
  if (!stylePanelEl?.classList.contains('hidden')) await showStyleSamples();
}

function syncMaterialOptions() {
  materialOptionEls.forEach((button) => {
    const active = button.dataset.material === ui.preset;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
}

materialOptionEls.forEach((button) => {
  button.addEventListener('click', async () => {
    const next = button.dataset.material;
    if (!next || next === ui.preset || !materialPresets[next]) return;
    ui.preset = next;
    syncMaterialOptions();
    await applyVisualPreset();
  });
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
