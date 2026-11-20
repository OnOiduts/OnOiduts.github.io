import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import remarkDirective from 'remark-directive';
import remarkGallery from './src/plugins/remark-gallery.mjs';
import remarkVideo from './src/plugins/remark-video.mjs';
import remarkEmbed from './src/plugins/remark-embed.mjs';
import remarkAudio from './src/plugins/remark-audio.mjs';
import remarkNoteImage from './src/plugins/remark-note-image.mjs';

export default defineConfig({
  site: 'https://onoiduts.github.io',
  base: '/',
  integrations: [react()],
  markdown: {
    /* ⚠️ 顺序有讲究：remarkDirective 必须**先**把 :::gallery 解析成
       containerDirective 节点，remarkGallery 才能识别它。
       反过来的话节点还是普通文本，指令会原样输出成字面量。 */
    /* ⚠️ 顺序有讲究：
       1. remarkDirective 必须最前 —— 先把 :::xxx 解析成 containerDirective
       2. remarkEmbed 必须在 remarkVideo **之前** —— 否则 :::embed 会被
          video 那遍的 containerDirective 遍历漏掉（两者互不冲突但分工不同）
       gallery / video 之间顺序无所谓 */
    /* ⚠️ remarkNoteImage 放最后：它只认 root 直属的「单图段落」，
       前面几个指令插件已经把容器换成 html 节点，不会被误判成正文插图。 */
    remarkPlugins: [remarkDirective, remarkEmbed, remarkAudio, remarkGallery, remarkVideo, remarkNoteImage],
    shikiConfig: {
      theme: 'github-dark-default',
      wrap: false,
    },
  },
});
