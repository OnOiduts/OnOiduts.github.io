/**
 * remark 插件：给正文里「独立成段的单张图片」补一行可见的图片说明。
 *
 * 背景：markdown 的 `![说明](...)` 里那句话是 alt（替代文字），浏览器只在
 * 图片加载失败时把它显示出来，正常加载时页面上一句都看不到。相册走
 * remark-gallery + ui.ts 会把 alt 写进 .gallery-caption，所以只有单张便签
 * 插图缺这一行。
 *
 * 做法：把「root 直接子节点、且只有一个 image 的 paragraph」换成一段 raw
 * html —— 仍是 <p><img …><span class="note-cap">说明</span></p>，
 * 图片依旧是 p 的直接子元素，`.prose p > img` 那套便签样式不会失效。
 *
 * ⚠️ 只认 alt 非空的图片；没写说明就保持原样，别留一行空说明。
 * ⚠️ 只处理 root 直属段落：相册 / 引用 / 列表里的图片各有自己的排版，
 *    不能在这里塞一个块级说明进去。
 * ⚠️ 运行时还有一层兜底（ui.ts 的 initNoteCaptions）：改了插件但 markdown
 *    没重新编译、旧 dist、缓存 HTML 都能补出来，两层幂等不重复。
 */
import { visit, SKIP } from 'unist-util-visit';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export default function remarkNoteImage() {
  return (tree) => {
    visit(tree, (node, index, parent) => {
      if (node.type !== 'paragraph' || !parent || parent.type !== 'root') return;
      if (node.children.length !== 1 || node.children[0].type !== 'image') return;
      const img = node.children[0];
      const alt = String(img.alt ?? '').trim();
      if (!alt) return;

      const title = img.title ? ` title="${esc(img.title)}"` : '';
      parent.children[index] = {
        type: 'html',
        value: `<p class="has-note-cap" data-note-cap="1">`
          + `<img src="${esc(img.url)}" alt="${esc(alt)}"${title} loading="lazy" decoding="async">`
          + `<span class="note-cap">${esc(alt)}</span></p>`,
      };
      return [SKIP, index];
    });
  };
}
