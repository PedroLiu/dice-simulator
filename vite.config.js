// GitHub Pages 项目页面部署在 https://<user>.github.io/<repo>/，不是根路径。
// base: './' 会让 Vite 把所有 index.html/js/css 里的绝对资源引用转成相对路径，
// 这样无论子路径叫什么、以后要不要挪到自定义域，产物都能用。
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
});
