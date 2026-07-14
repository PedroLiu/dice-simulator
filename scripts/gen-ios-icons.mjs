// 一次性脚本：把 SVG icon 栅格化为 iOS 主屏图标 + PWA 通用 png。
// 生成完可以从 devDependencies 移除 sharp；产物 checked in 到 public/icons/。
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(here, '../public/icons/dice-icon.svg');
const outDir = resolve(here, '../public/icons');

const svg = await readFile(svgPath);

// iOS 主屏图标 180×180；PWA manifest 常用 192/512。iOS 不接受 SVG 也不用 maskable。
const targets = [
  { size: 180, name: 'apple-touch-icon.png' },
  { size: 192, name: 'icon-192.png' },
  { size: 512, name: 'icon-512.png' },
  { size: 512, name: 'icon-512-maskable.png' }, // Android maskable 用同一张
];

for (const t of targets) {
  const buf = await sharp(svg, { density: 512 }).resize(t.size, t.size).png().toBuffer();
  await sharp(buf).toFile(resolve(outDir, t.name));
  console.log(`wrote ${t.name} (${t.size}x${t.size})`);
}
