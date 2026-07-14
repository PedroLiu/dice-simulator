// 材质预设 + 骰面字体（烫金）绘制 + 每个 die 生成后的材质微调。
// 改颜色/贴图/字体，只需要动这个文件。

import { ui } from './state.js';

export const materialPresets = {
  // 偏金属 / 半透明；骰面统一烫金数字（见 drawGoldFoilLabel）。
  bronze: {
    label: 'Thylean 青铜',
    foreground: '#f6c85f',
    background: ['#705206', '#7A4E06', '#643100', '#7A2D06'],
    outline: ['#3D2D03', '#472D04', '#301700', '#471A04'],
    // 边棱略收敛，少一点霓虹橙
    edge: ['#c47820', '#d49030', '#b86818', '#e0a040'],
    texture: ['bronze01', 'bronze02', 'bronze03', 'bronze03a', 'bronze03b', 'bronze04'],
    material: 'metal',
    description: 'Thylean Bronze：多层青铜金属，烫金数字',
  },
  astralsea: {
    label: 'Astral Sea 星界海',
    foreground: '#f6c85f',
    background: ['#000000', '#400303', '#040404', '#001B32'],
    outline: ['#3D2D03', '#472D04', '#301700', '#471A04'],
    edge: ['#c47820', '#d49030', '#b86818', '#e0a040'],
    texture: ['bronze01', 'bronze02', 'bronze03', 'bronze03a', 'bronze03b', 'bronze04'],
    material: 'metal',
    description: '深色金属底 + 青铜纹理',
  },
  fire: {
    label: 'Fire 火焰',
    foreground: '#fff0a8',
    background: ['#f8d84f', '#f9b02d', '#f43c04', '#910200', '#4c1009'],
    outline: '#160600',
    texture: 'fire',
    material: 'metal',
    description: '火焰纹理 + 金属高光',
  },
  blackgold: {
    label: 'Black Gold 黑金',
    foreground: '#f6c85f',
    background: ['#080706', '#15120d', '#211b11', '#050505'],
    outline: '#000000',
    edge: ['#8e6b25', '#c99b3d', '#6c501c'],
    texture: 'metal',
    material: 'metal',
    description: '哑黑金属 + 暗金边棱，烫金数字',
  },
  silver: {
    label: 'Cast Silver 银铸',
    foreground: '#f6c85f',
    background: ['#aeb4b9', '#858d94', '#c4c8cb', '#737b82'],
    outline: '#24282c',
    edge: ['#d5d8da', '#9ba2a8', '#edf0f1'],
    texture: 'metal',
    material: 'metal',
    metalRoughness: 0.28,
    envMapIntensity: 1.35,
    description: '拉丝银色金属 + 金色数字',
  },
  moonstone: {
    label: 'Moonstone 月光石',
    foreground: '#f6c85f',
    background: ['#778491', '#667582', '#89949e', '#596976'],
    outline: '#242d35',
    edge: ['#9ca8b1', '#7f909d', '#b0b7bc'],
    texture: 'marble',
    material: 'glass',
    envMapIntensity: 1.05,
    description: '中灰蓝大理石纹 + 金色数字',
  },
};

export function getPreset(key = ui.preset) {
  return materialPresets[key] || materialPresets.bronze;
}

function hexToRgba(hex, alpha) {
  const normalized = hex.replace('#', '');
  const n = parseInt(normalized.length === 3
    ? normalized.split('').map((c) => c + c).join('')
    : normalized, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function buildColorSet(presetKey = ui.preset) {
  const preset = getPreset(presetKey);
  const rawBackground = preset.background ?? '#222222';
  const background = preset.transparent
    ? (Array.isArray(rawBackground)
      ? rawBackground.map((color) => hexToRgba(color, preset.alpha ?? 0.35))
      : hexToRgba(rawBackground, preset.alpha ?? 0.35))
    : rawBackground;
  const rawEdge = preset.edgeBoost || preset.edge || rawBackground;
  const edge = preset.edgeAlpha && typeof rawEdge === 'string' && rawEdge.startsWith('#')
    ? hexToRgba(rawEdge, preset.edgeAlpha)
    : rawEdge;

  return {
    name: `${presetKey}-${Date.now()}`,
    description: preset.description,
    category: 'community',
    foreground: preset.foreground || '#f6c85f',
    background,
    outline: preset.outline || '#160600',
    edge,
    texture: preset.texture,
    material: preset.material,
  };
}

// 在 dice-box 生成的骰面 Canvas 贴图上，重新绘制一层烫金/描边数字，让点数更醒目。
export function drawGoldFoilLabel(textureData, diceDef, labels, index, _size, margin) {
  const texture = textureData?.composite;
  const canvas = texture?.image;
  if (!canvas || !labels || labels[index] === undefined) return;

  const ctx = canvas.getContext('2d');
  const label = labels[index];
  const S = canvas.width;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  const drawOne = (text, x, y, fontSize) => {
    const value = String(text).trim();
    if (!value || value === '0') return;
    // Cinzel Decorative 400（Regular）：笔画瘦，配合更大的字号 + 黑底盘视觉更抢眼。
    ctx.font = `400 ${fontSize}px "Cinzel Decorative", "Cinzel", Georgia, serif`;

    // === 1. 字沿模糊黑晕：只沿着字的轮廓外扩一圈黑烟，不像"底盘"那样是个圆，
    //        既能压掉紧贴字的纹理、又保留了周围的骰面质感。 ===
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.98)';
    ctx.shadowBlur = Math.max(6, fontSize * 0.20);
    ctx.lineWidth = Math.max(2.5, fontSize * 0.08);
    ctx.strokeStyle = 'rgba(15, 5, 0, 0.98)';
    ctx.strokeText(value, x, y);
    // 再叠一次让黑晕更实、边界更清晰。
    ctx.shadowBlur = Math.max(3, fontSize * 0.10);
    ctx.strokeText(value, x, y);
    ctx.restore();

    // === 2. 深色硬描边：清晰硬边缘 ===
    ctx.lineWidth = Math.max(1.8, fontSize * 0.055);
    ctx.strokeStyle = 'rgba(28, 10, 0, 1)';
    ctx.strokeText(value, x, y);

    // === 4. 烫金主体：亮金渐变 ===
    const gold = ctx.createLinearGradient(0, y - fontSize * 0.55, 0, y + fontSize * 0.55);
    gold.addColorStop(0.00, '#ffffff');
    gold.addColorStop(0.12, '#fff2c2');
    gold.addColorStop(0.42, '#ffd85a');
    gold.addColorStop(0.72, '#b57018');
    gold.addColorStop(1.00, '#4b1f04');
    ctx.fillStyle = gold;
    ctx.fillText(value, x, y);

    // === 5. 顶部高光：白色描边只出现在字的上半部 ===
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y - fontSize, S, fontSize * 0.68);
    ctx.clip();
    ctx.lineWidth = Math.max(1, fontSize * 0.035);
    ctx.strokeStyle = 'rgba(255, 250, 220, 1)';
    ctx.strokeText(value, x, y);
    ctx.restore();
  };

  if (diceDef.shape !== 'd4') {
    const rotateMap = {
      d8: index > 0 && index % 2 !== 0 ? -127.5 : -7.5,
      d10: -6,
      d12: 5,
      d20: -7.5,
    };
    const rotation = rotateMap[diceDef.shape] || 0;
    if (rotation) {
      ctx.translate(S / 2, S / 2);
      ctx.rotate(rotation * Math.PI / 180);
      ctx.translate(-S / 2, -S / 2);
    }
    // 字号放大到 0.95：Cinzel Decorative 笔画细，需要更大字号视觉才够重。
    let fontSize = S / (1 + 2 * margin) * 0.95;
    let x = S / 2;
    let y = S / 2 + 10;
    if (diceDef.shape === 'd10') { fontSize *= 0.78; y = y * 1.15 - 10; }
    if (diceDef.shape === 'd20') x *= 0.98;
    String(label).split('\n').forEach((line, lineIndex, lines) => {
      drawOne(line, x, y + (lineIndex - (lines.length - 1) / 2) * fontSize * 0.72, fontSize);
    });
  } else if (Array.isArray(label)) {
    const fontSize = S * 0.20;
    for (const item of label) {
      drawOne(item, S / 2, S / 2 - S * 0.30, fontSize);
      ctx.translate(S / 2, S / 2);
      ctx.rotate(Math.PI * 2 / 3);
      ctx.translate(-S / 2, -S / 2);
    }
  }

  ctx.restore();
  texture.needsUpdate = true;
}

// 库生成的骰子材质是 MeshStandardMaterial；半透明预设才开 transparent / emissive。
export function tuneDieMaterials(die) {
  if (!die?.material) return;
  const preset = getPreset();
  const mats = Array.isArray(die.material) ? die.material : [die.material];
  for (const mat of mats) {
    if (!mat) continue;
    if (preset.transparent) {
      mat.transparent = true;
      mat.depthWrite = false;
      mat.alphaTest = 0.02;
      mat.roughness = preset.roughness ?? Math.min(mat.roughness ?? 0.1, 0.08);
      mat.metalness = 0;
      mat.envMapIntensity = preset.envMapIntensity ?? 1.4;
      if (preset.emissive && mat.emissive) {
        try {
          mat.emissive.set(preset.emissive);
          mat.emissiveIntensity = preset.emissiveIntensity ?? 0.4;
        } catch { /* ignore */ }
      }
    } else {
      // 金属等不透明：不要全局开 transparent，否则 depthWrite 关了容易发脏、穿模。
      mat.transparent = false;
      mat.depthWrite = true;
      mat.alphaTest = 0;
      if (preset.material === 'metal') {
        mat.roughness = preset.metalRoughness ?? Math.min(mat.roughness ?? 0.5, 0.36);
        mat.envMapIntensity = preset.envMapIntensity ?? 1.2;
      } else if (preset.envMapIntensity != null) {
        mat.envMapIntensity = preset.envMapIntensity;
      }
      if (mat.emissive?.setRGB) {
        mat.emissive.setRGB(0, 0, 0);
        mat.emissiveIntensity = 0;
      }
    }
    mat.needsUpdate = true;
  }
}
