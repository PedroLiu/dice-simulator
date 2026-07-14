// 材质预设 + 骰面字体（烫金）绘制 + 每个 die 生成后的材质微调。
// 改颜色/贴图/字体，只需要动这个文件。

import { ui } from './state.js';

export const materialPresets = {
  // 保留稳定的社区预设，并加入红/蓝/紫宝石风格；骰面统一用烫金字体。
  astralsea: {
    label: 'Astral Sea 星界海',
    foreground: '#f6c85f',
    background: ['#000000', '#400303', '#040404', '#001B32'],
    outline: ['#3D2D03', '#472D04', '#301700', '#471A04'],
    edge: ['#FF5D0D', '#FF7B00', '#FFA20D', '#FFBA0D'],
    texture: ['bronze01', 'bronze02', 'bronze03', 'bronze03a', 'bronze03b', 'bronze04'],
    material: 'metal',
    description: '社区内置 Astral Sea：深色金属 + 青铜纹理，整体最稳',
  },
  bloodmoon: {
    label: 'Blood Moon 血月',
    foreground: '#f6c85f',
    background: '#6F0000',
    outline: '#160000',
    texture: 'marble',
    material: 'plastic',
    description: '社区内置 Blood Moon：红黑大理石，暗黑风格',
  },
  fire: {
    label: 'Fire 火焰',
    foreground: '#fff0a8',
    background: ['#f8d84f', '#f9b02d', '#f43c04', '#910200', '#4c1009'],
    outline: '#160600',
    texture: 'fire',
    material: 'metal',
    description: '社区内置 Fire：火焰纹理 + 金属高光',
  },
  ruby: {
    label: 'Ruby 红宝石',
    foreground: '#fff2b8',
    background: '#c81a36',
    outline: 'none',
    edge: '#ff8892',
    edgeAlpha: 0.18,
    texture: 'water',
    material: 'glass',
    transparent: true,
    alpha: 0.34,
    emissive: '#a0142c',
    emissiveIntensity: 0.75,
    description: 'Ruby：water + glass 半透明 + 强红光',
  },
  sapphire: {
    label: 'Sapphire 蓝宝石',
    foreground: '#fff2b8',
    background: '#2555c8',
    outline: 'none',
    edge: '#7fa6f4',
    edgeAlpha: 0.18,
    texture: 'water',
    material: 'glass',
    transparent: true,
    alpha: 0.34,
    emissive: '#1a3fb0',
    emissiveIntensity: 0.75,
    description: 'Sapphire：water + glass 半透明 + 强蓝光',
  },
  amethyst: {
    label: 'Amethyst 紫水晶',
    foreground: '#fff2b8',
    background: '#8a3ec2',
    outline: 'none',
    edge: '#d4a4ee',
    edgeAlpha: 0.16,
    texture: 'water',
    material: 'glass',
    transparent: true,
    alpha: 0.34,
    emissive: '#6a1fa0',
    emissiveIntensity: 0.68,
    description: 'Amethyst：water + glass 半透明 + 紫光',
  },
};

export function getPreset(key = ui.preset) {
  return materialPresets[key] || materialPresets.astralsea;
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
    // 用粗一号的字重，保证在深色/花纹面上也能一眼看清。
    ctx.font = `600 ${fontSize}px "Cormorant Garamond", "DNDOfficial", "Cinzel", Georgia, serif`;

    // 外层柔和黑晕：先大范围模糊阴影铺一层深色底，把复杂纹理挤开。
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = Math.max(4, fontSize * 0.14);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = Math.max(3, fontSize * 0.11);
    ctx.strokeStyle = 'rgba(20, 8, 0, 0.92)';
    ctx.strokeText(value, x, y);
    ctx.restore();

    // 深色刻槽描边，让数字有清晰硬边缘，字号视觉更“重”。
    ctx.lineWidth = Math.max(2, fontSize * 0.075);
    ctx.strokeStyle = 'rgba(35, 14, 0, 0.95)';
    ctx.strokeText(value, x, y);

    // 烫金主体：更亮、更饱和，中段留一段亮金。
    const gold = ctx.createLinearGradient(0, y - fontSize * 0.55, 0, y + fontSize * 0.55);
    gold.addColorStop(0.00, '#ffffff');
    gold.addColorStop(0.14, '#fff2c2');
    gold.addColorStop(0.40, '#ffcc4a');
    gold.addColorStop(0.72, '#a86215');
    gold.addColorStop(1.00, '#4b1f04');
    ctx.fillStyle = gold;
    ctx.fillText(value, x, y);

    // 顶部高光：更强的白色描边，仅出现在字的上半部。
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y - fontSize, S, fontSize * 0.72);
    ctx.clip();
    ctx.lineWidth = Math.max(1, fontSize * 0.028);
    ctx.strokeStyle = 'rgba(255, 250, 220, 0.95)';
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
    let fontSize = S / (1 + 2 * margin) * 0.72;
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

// 库生成的骰子材质是 MeshStandardMaterial；对于半透明宝石，我们额外调 emissive 和粗糙度。
export function tuneDieMaterials(die) {
  if (!die?.material) return;
  const preset = getPreset();
  const mats = Array.isArray(die.material) ? die.material : [die.material];
  for (const mat of mats) {
    if (!mat) continue;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.alphaTest = preset.transparent ? 0.02 : 0;
    // 官方 glass 是 MeshStandardMaterial，透明度主要来自 Canvas 贴图 alpha。
    // 磨砂玻璃感靠：高粗糙度 + 半透明 + 自发光让内部“透出对应颜色的光”。
    if (preset.transparent) {
      mat.roughness = preset.roughness ?? Math.min(mat.roughness ?? 0.1, 0.08);
      mat.metalness = 0;
      mat.envMapIntensity = preset.envMapIntensity ?? 1.4;
      if (preset.emissive && mat.emissive) {
        try {
          mat.emissive.set(preset.emissive);
          mat.emissiveIntensity = preset.emissiveIntensity ?? 0.4;
        } catch { /* 某些自定义材质没有 emissive.set，忽略即可 */ }
      } else if (mat.emissive?.setRGB) {
        mat.emissive.setRGB(0, 0, 0);
        mat.emissiveIntensity = 0;
      }
    } else if (mat.emissive?.setRGB) {
      mat.emissive.setRGB(0, 0, 0);
      mat.emissiveIntensity = 0;
    }
    mat.needsUpdate = true;
  }
}
