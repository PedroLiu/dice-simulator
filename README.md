# 骰子模拟器

基于 [@3d-dice/dice-box-threejs](https://github.com/3d-dice/dice-box-threejs) 的移动端 3D 骰子 PWA。

## 本地开发

```bash
npm install
npm run dev        # 起 dev server
npm run build      # 打包到 dist/
npm run preview    # 本地预览打包产物
```

Dev 默认监听 `0.0.0.0:5173`，手机同网访问 `http://<电脑局域网 IP>:5173/` 就能实测。

## 部署到 GitHub Pages

1. 把 `dice_simulator/` 目录作为独立仓库推到 GitHub（或者把它当子目录，改一下 workflow 的路径）。
2. GitHub 仓库页 → **Settings → Pages → Source** 选 **GitHub Actions**。
3. `main` 分支上有 push，或在 Actions 面板手动 `Run workflow`，`.github/workflows/deploy.yml` 会自动构建并发布。
4. 发布完成后访问：`https://<用户名>.github.io/<仓库名>/`。

访问该 URL 即可扔骰子；在 iOS Safari 里点分享 → **添加到主屏幕** 就能以全屏 PWA 方式启动（无地址栏、无底栏）。

## 目录结构

```
src/
├── main.js          # 入口：DiceBox 装配、库函数 hook、UI 事件
├── state.js         # 跨模块共享状态 (params / ui)
├── materials.js     # 材质预设 + 烫金字体 + 材质微调
├── physics.js       # 力度曲线 + 骰子扶正 + 陀螺衰减 + 世界墙
├── expression.js    # 表达式解析 + 掷骰计划 + 结果核对
├── results.js       # 结果面板渲染
├── style.css
└── assets/
    └── abyss-bg.png # 背景图（走 Vite asset pipeline）

public/
├── manifest.webmanifest
├── sw.js            # Service Worker（cache-first）
├── icons/           # PWA 图标（含 iOS 180×180 apple-touch-icon）
└── assets/          # dice-box 官方贴图 / 音效（原样发布）

.github/workflows/deploy.yml   # GitHub Pages 自动部署
```

## 路径处理约定

所有静态资源引用都走**相对路径**，配合 `vite.config.js` 里的 `base: './'`，
可以直接部署到任何子路径（`https://user.github.io/repo/`）而无需改代码。

- 运行时用 `document.baseURI` 拼绝对 URL（见 `main.js` 里的 `assetPath`、`sw.js` 注册）
- SW 用 `self.registration.scope` 拿子路径，兼容各种部署位置
