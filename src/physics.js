// 力度曲线 + cannon.js 物理调优（每个 body 阻尼、世界墙、陀螺衰减、扶正）。
// 想改「甩得多远/多凶、转多久、什么时候拉停」，都在这个文件。

import { params, ui } from './state.js';

// 力度滑块 → 具体物理参数。size 由样式面板控制，这里不动。
export function applyForceProfile() {
  const t = Math.max(0, Math.min(1, (params.force - 1) / 9));
  // 单一“力度”现在主要控制陀螺式旋转，水平位移只小幅增加。
  // 重力降低，让骰子更容易靠边旋转起来；角阻尼收紧，避免过久。
  params.strength = 0.42 + t * 1.85;
  params.spin = 18 + t * 130;
  params.gravity = 300;
  params.linearDamping = Math.max(0.030, 0.082 - t * 0.052);
  params.angularDamping = Math.max(0.0032, 0.014 - t * 0.0108);
}

export function getSpinMultiplier() {
  // 力度主要转化为自旋角速度，水平位移保持克制。
  return Math.min(360, params.spin * (1 + Math.min(params.strength, 4) * 0.36));
}

// 找到当前朝上（世界 +z）的面的局部法线；用于把骰子扶正，让视觉朝上面等于 getFaceValue。
// 注意：索引方式必须跟库里的 getFaceValue 完全一致 —— 按 groups 数组下标 p 直接读 p*9，
// 而不是按 group.start * 3。否则我们扶正的面 A 和库最终读到的面 B 会不是同一个，导致读数错乱。
function getTopFaceLocalNormal(die) {
  const q = die.body.quaternion;
  const geom = die.geometry;
  const attr = geom?.getAttribute?.('normal');
  if (!attr || !geom.groups) return null;
  const target = die.shape === 'd4' ? -1 : 1;
  let bestNormal = null;
  let bestDot = -Infinity;
  const groups = geom.groups;
  for (let p = 0; p < groups.length; p++) {
    const group = groups[p];
    if (group.materialIndex === 0) continue;
    const i = p * 9;
    const nx = attr.array[i];
    const ny = attr.array[i + 1];
    const nz = attr.array[i + 2];
    // 用 cannon 四元数把局部法线旋到世界。
    const wx = (1 - 2 * (q.y * q.y + q.z * q.z)) * nx + 2 * (q.x * q.y - q.w * q.z) * ny + 2 * (q.x * q.z + q.w * q.y) * nz;
    const wy = 2 * (q.x * q.y + q.w * q.z) * nx + (1 - 2 * (q.x * q.x + q.z * q.z)) * ny + 2 * (q.y * q.z - q.w * q.x) * nz;
    const wz = 2 * (q.x * q.z - q.w * q.y) * nx + 2 * (q.y * q.z + q.w * q.x) * ny + (1 - 2 * (q.x * q.x + q.y * q.y)) * nz;
    const dot = wz * target;
    if (dot > bestDot) {
      bestDot = dot;
      bestNormal = { x: nx, y: ny, z: nz };
    }
  }
  return bestNormal;
}

// 把骰子扶正：让当前"最靠上"的面完全朝 +z（d4 朝 -z），消除棱立、卡边等模糊姿态。
// 在 onRollComplete（视觉动画结束时）调用，此时 body 位姿就是玩家看到的最终位姿。
export function snapDieUpright(die) {
  if (!die?.body || !die?.geometry) return;
  const normal = getTopFaceLocalNormal(die);
  if (!normal) return;
  const target = die.shape === 'd4' ? -1 : 1;
  const q = die.body.quaternion;
  const wx = (1 - 2 * (q.y * q.y + q.z * q.z)) * normal.x + 2 * (q.x * q.y - q.w * q.z) * normal.y + 2 * (q.x * q.z + q.w * q.y) * normal.z;
  const wy = 2 * (q.x * q.y + q.w * q.z) * normal.x + (1 - 2 * (q.x * q.x + q.z * q.z)) * normal.y + 2 * (q.y * q.z - q.w * q.x) * normal.z;
  const wz = 2 * (q.x * q.z - q.w * q.y) * normal.x + 2 * (q.y * q.z + q.w * q.x) * normal.y + (1 - 2 * (q.x * q.x + q.y * q.y)) * normal.z;
  // 注意：setFromVectors 内部会调用 Vec3.isAntiparallelTo，必须传真正的 Vec3 实例。
  const Q = die.body.quaternion.constructor;
  const V = die.body.position.constructor;
  const rot = new Q();
  rot.setFromVectors(new V(wx, wy, wz), new V(0, 0, target));
  const nq = new Q();
  rot.mult(die.body.quaternion, nq);
  die.body.quaternion.copy(nq);
  die.body.velocity.setZero();
  die.body.angularVelocity.setZero();
  die.body.sleepState = 2; // SLEEPING
  die.position.copy(die.body.position);
  die.quaternion.copy(die.body.quaternion);
  die.result = [];
}

export function applyBodyParamsToDie(die, boostSpin = false) {
  if (!die?.body) return;
  die.body.linearDamping = params.linearDamping;
  die.body.angularDamping = Math.max(0.00018, params.angularDamping / Math.sqrt(Math.max(1, params.spin)));
  // 骰子视觉上"看起来停了"到实际判定 sleep 之间的等待，直接决定"停下-出结果"的间隔。
  // 之前 sleepTimeLimit=0.9 秒偏保守；收紧到 0.25 秒 + 稍大的 sleepSpeedLimit 让结果更快弹出。
  die.body.sleepSpeedLimit = 3.4;
  die.body.sleepTimeLimit = 0.25;
  die.__spawnedAt = performance.now();
  if (boostSpin && !die.body.__spinBoosted) {
    // 主要补竖直轴角速度，让骰子更像陀螺一样原地转，而不是被甩飞。
    const t = Math.max(0, Math.min(1, (params.force - 1) / 9));
    die.body.angularVelocity.x *= 1.05 + t * 0.55;
    die.body.angularVelocity.y *= 1.05 + t * 0.55;
    die.body.angularVelocity.z += (Math.random() < 0.5 ? -1 : 1) * (50 + t * 170);
    die.body.__spinBoosted = true;
  }
}

export function applyBodyParams(box) {
  if (!box.diceList) return;
  for (const die of box.diceList) applyBodyParamsToDie(die, false);
}

export function syncDiceMeshesToBodies(box) {
  if (!box.diceList) return;
  for (const die of box.diceList) {
    if (!die?.body) continue;
    die.position.copy(die.body.position);
    die.quaternion.copy(die.body.quaternion);
  }
}

// 降低边界弹性/摩擦并略微内缩墙体，减少高速撞边时卡住。同时把下墙抬到底部按钮上方。
// 额外：在相机视野前加一个透明"天花板"，防止骰子飞出视野看不见。
export function tuneWorldPhysics(box, bottomControlsEl) {
  if (!box.world) return;
  box.world.solver.iterations = 22;

  // 接触材质顺序由库内部创建：桌面/骰子、墙/骰子、骰子/骰子。
  // 原本墙体 restitution=1 非常弹，棱角高速撞墙时容易在墙/地之间抖动。
  for (const cm of box.world.contactmaterials || []) {
    if (cm.restitution >= 0.95) {
      cm.restitution = 0.50;
      cm.friction = 0.06;
    } else {
      cm.restitution = Math.min(cm.restitution ?? 0.5, 0.36);
      cm.friction = Math.min(cm.friction ?? 0.6, 0.24);
    }
  }

  // 手机全屏画布下，左右/上边界贴近浏览器边缘；下边界抬到按钮上方，避免骰子被按钮挡住。
  const inset = 0.96;
  const controlsRect = bottomControlsEl?.getBoundingClientRect();
  const bottomClearance = controlsRect
    ? Math.max(0, window.innerHeight - controlsRect.top + 10)
    : 0;
  if (box.box_body?.topWall) box.box_body.topWall.position.y = box.display.containerHeight * inset;
  if (box.box_body?.bottomWall) box.box_body.bottomWall.position.y = -box.display.containerHeight * inset + bottomClearance;
  if (box.box_body?.leftWall) box.box_body.leftWall.position.x = box.display.containerWidth * inset;
  if (box.box_body?.rightWall) box.box_body.rightWall.position.x = -box.display.containerWidth * inset;

  installCeiling(box);
}

// 在骰子上方加一个不可见的物理天花板。dice-box 库没有这一层，
// 骰子被大力抛出时会飞出摄像机上方（越过 z 轴顶端）造成"骰子消失"。
function installCeiling(box) {
  // Plane 的世界墙对象都是 cannon.Body；从已有的 topWall 拿构造函数以避免直接依赖 cannon 模块。
  const template = box.box_body?.topWall;
  if (!template?.constructor || !template.material) return;
  const BodyCtor = template.constructor;
  const Vec3Ctor = template.position.constructor;
  const QuatCtor = template.quaternion.constructor;
  const ShapeCtor = template.shapes?.[0]?.constructor;
  if (!ShapeCtor) return;

  // 相机在 +z 高处朝下看；天花板放在 cameraHeight.max 附近，留一点余量避免视觉上压太低。
  const cameraMax = box.cameraHeight?.max ?? 300;
  const ceilingZ = cameraMax * 0.72;

  // makeWorldBox 每次会重建 4 堵墙但不会碰 ceiling；如果我们之前加过的还残留，先移除再重加，避免重复。
  if (box.box_body.ceiling) {
    try { box.world.removeBody(box.box_body.ceiling); } catch {}
  }
  box.box_body.ceiling = new BodyCtor({
    allowSleep: false,
    mass: 0,
    shape: new ShapeCtor(),
    material: template.material,
  });
  // Plane 默认法向 +z；我们要让"下方"（-z）是碰撞面，绕 x 轴翻 180°。
  box.box_body.ceiling.quaternion = new QuatCtor();
  box.box_body.ceiling.quaternion.setFromAxisAngle(new Vec3Ctor(1, 0, 0), Math.PI);
  box.box_body.ceiling.position.set(0, 0, ceilingZ);
  box.world.addBody(box.box_body.ceiling);
}

// 分阶段陀螺衰减：让骰子看起来"转累了慢慢停"，同时兜底避免转 10 秒以上。
let stableResultTimer = null;

export function clearStableResultWatcher() {
  if (stableResultTimer) {
    clearInterval(stableResultTimer);
    stableResultTimer = null;
  }
}

export function startStableResultWatcher(box, plan) {
  clearStableResultWatcher();
  const watcherStart = performance.now();
  // 收紧整体时间线：先让骰子自由转 1.4s（表现足够精彩），之后阶梯性收紧衰减，最迟 4s 硬停。
  const spinAllow = 1400;   // 允许自由转多久
  const gentleUntil = 2400; // 温和衰减
  const firmUntil = 3200;   // 收紧衰减
  const hardStop = 4000;    // 硬停

  stableResultTimer = setInterval(() => {
    if (ui.pendingRoll !== plan || ui.resultDisplayedForRoll) {
      clearStableResultWatcher();
      return;
    }

    const dice = (box.diceList || []).filter((die) => die?.body);
    if (dice.length === 0) return;
    const now = performance.now();

    for (const die of dice) {
      const spawnedAt = die.__spawnedAt ?? watcherStart;
      const age = now - spawnedAt;
      if (age <= spinAllow) continue;

      const spinning = Math.abs(die.body.angularVelocity.z) > 4;
      const almostStill = die.body.velocity.length() < 12
        && Math.hypot(die.body.angularVelocity.x, die.body.angularVelocity.y) < 6;
      if (!(spinning && almostStill)) continue;

      if (age < gentleUntil) {
        // 阶段一：轻度衰减，看起来只是自然"转累了"。
        die.body.angularVelocity.scale(0.985, die.body.angularVelocity);
        die.body.angularDamping = Math.max(die.body.angularDamping, 0.08);
      } else if (age < firmUntil) {
        // 阶段二：明显减速，但仍有转动惯性。
        die.body.angularVelocity.scale(0.955, die.body.angularVelocity);
        die.body.angularDamping = Math.max(die.body.angularDamping, 0.18);
      } else if (age < hardStop) {
        // 阶段三：最后一小段拉停。
        die.body.angularVelocity.scale(0.90, die.body.angularVelocity);
        die.body.angularDamping = Math.max(die.body.angularDamping, 0.35);
      }
    }

    // 硬兜底：超过 hardStop 仍不稳，把速度平滑归零，让 dice-box 走完 throwFinished。
    if (now - watcherStart >= hardStop) {
      for (const die of dice) {
        die.body.velocity.scale(0.4, die.body.velocity);
        die.body.angularVelocity.scale(0.4, die.body.angularVelocity);
      }
      setTimeout(() => {
        for (const die of dice) {
          die.body.velocity.setZero();
          die.body.angularVelocity.setZero();
        }
      }, 120);
      clearStableResultWatcher();
    }
  }, 80);
}
