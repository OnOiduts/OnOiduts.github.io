/**
 * remark 插件：识别 `:::gallery` 容器指令，渲染成「左右小图 + 中间大图」的相册。
 *
 * 用法（文章和项目正文通用）：
 *
 *   :::gallery
 *   ![说明一](/img/1.png)
 *   ![说明二](/img/2.png)
 *   :::
 *
 * 实现要点：
 *  - 递归收集容器内的**所有** image 节点 —— 因为 markdown 会把连续几行
 *    图片解析成「一个 paragraph 里有多个 image + 软换行文本节点」，
 *    只遍历直接子节点会漏。
 *  - 产出 mdast 的 `html` 节点。remark 之后的 rehype 会把它变成 raw 节点，
 *    Astro 直接输出，不会被转义。
 *  - 交互（翻页 / 灯箱）全部由 ui.ts 的 initGalleries() 接管，这里只出结构。
 *
 * ⚠️ 指令名必须小写匹配：remark-directive 会保留原始大小写，
 *    写 `:::Gallery` 不会命中。
 */
import { visit, SKIP } from 'unist-util-visit';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/* ── 快捷下载按钮（默认关闭，作者显式放行才给） ───────────────────
   站内本地文件默认**不给**按钮：防护层已经挡着右键 / 拖拽 / 中键另开，
   作者想让读者拿原文件时，再写 dl 单独开一个正经入口。
   外链平台没有本站文件可下；跨域图床的 <a download> 会被浏览器忽略
   （点了变成新标签页打开），这两类一律不渲染按钮。
     不写 dl / dl="0" / dl="off"  → 不给按钮（默认）
     dl / dl="1"                  → 给按钮，用 src 里的文件名
     dl="练习曲.mid"              → 给按钮，并自定义下载名
   ⚠️ 只输出 download，不加 target="_blank" —— 避免任何情况下变成另开窗口。 */
function dlInfo(attrs, url) {
  /* 绝对外链 / 协议相对 URL：点了只会另开窗口，不给按钮 */
  if (/^(https?:)?\/\//i.test(url)) return null;
  const raw = attrs.dl ?? attrs.download;
  /* 关键：没写就是默认关闭。上一版「不写也开」会让所有老文章凭空冒出按钮。 */
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  if (/^(0|false|no|off|none)$/i.test(v)) return null;
  const base = url.split(/[?#]/)[0].split('/').pop() || 'download';
  const name = (!v || /^(1|true|yes|on)$/i.test(v)) ? base : v;
  return { url, name };
}
/* 作者显式放行时，在容器上留个授权标记：运行时兜底（assetDownload.ts）
   只给带这个标记的容器补按钮 —— 默认关闭时，旧 HTML / 缓存页面不会被误补。
   自定义下载名一起带上，兜底补出来的按钮名字得和构建期完全一致。 */
const dlOnFlag = (attrs, d) => d
  ? ' data-dl-on="1"' + (d.name ? ' data-dl-name="' + esc(d.name) + '"' : '')
  : '';
/* 显式写 dl="0" 也留标记，双保险（防旧 HTML 里混进 data-dl-on） */
const dlOffFlag = (attrs) =>
  /^(0|false|no|off|none)$/i.test(String((attrs.dl ?? attrs.download) ?? '').trim())
    ? ' data-dl-off="1"' : '';

const dlGalleryBtn = (d, items) => d
  ? `<a class="asset-dl" href="${esc(items[0].url)}" download="${esc(d.name)}" data-guard-off`
    + ` data-dl-list="${esc(JSON.stringify(items.map((i) => i.url)))}"`
    + ` title="下载 ${esc(d.name)}"`
    + ` aria-label="下载 ${esc(d.name)}"><span aria-hidden="true">↓</span>`
    + `<span class="asset-dl-t">图片</span></a>`
  : '';

export default function remarkGallery() {
  return (tree) => {
    visit(tree, (node, index, parent) => {
      if (node.type !== 'containerDirective') return;
      if (node.name !== 'gallery') return;

      const items = [];
      visit(node, 'image', (img) => {
        items.push({ url: img.url, alt: img.alt ?? '' });
        return SKIP;
      });

      /* 整组开关：默认每张图都可下载当前显示的那一原图。
         只要有一张是跨域外链就不给按钮 —— 否则翻到那张时点按钮会变成另开窗口。 */
      const d = items.every((it) => !/^(https?:)?\/\//i.test(it.url))
        ? dlInfo(node.attributes || {}, items.length ? items[0].url : '')
        : null;

      if (!items.length) {
        // 空的 :::gallery —— 直接移除，别在页面上留个空壳
        parent.children.splice(index, 1);
        return [SKIP, index];
      }

      const imgs = items
        .map(
          (it, i) =>
            `<img class="gallery-img${i === 0 ? ' is-cur' : ''}" src="${esc(it.url)}" alt="${esc(it.alt)}" loading="${i === 0 ? 'eager' : 'lazy'}" data-i="${i}">`
        )
        .join('');

      const html = [
        `<div class="gallery" data-count="${items.length}" data-i="0"${dlOffFlag(node.attributes || {})}${dlOnFlag(node.attributes || {}, d)}>`,
        `<div class="gallery-row">`,
        /* 左小图：上一张。第一页没有上一张 → 用 is-void 隐藏但**保留占位**，
           这样中间大图始终居中，不会左右跳。 */
        `<button class="gallery-side gallery-prev is-void" type="button" aria-label="上一张" tabindex="-1">`,
        `<img src="" alt="" aria-hidden="true">`,
        `</button>`,
        `<div class="gallery-main">${imgs}`,
        `<button class="gallery-arrow gallery-arrow-prev is-void" type="button" aria-label="上一张">‹</button>`,
        `<button class="gallery-arrow gallery-arrow-next" type="button" aria-label="下一张">›</button>`,
        `<span class="gallery-count mono">1 / ${items.length}</span>`,
        `</div>`,
        /* 右小图：下一张 */
        `<button class="gallery-side gallery-next" type="button" aria-label="下一张">`,
        `<img src="" alt="" aria-hidden="true">`,
        `</button>`,
        `</div>`,
        /* ⚠️ 说明文字必须单独包一层：ui.ts 翻页时会写 caption 的文本，
           直接 textContent 会把同一个 caption 里的下载按钮整个冲掉。 */
        `<div class="gallery-caption"><span class="gallery-cap-t"></span>${dlGalleryBtn(d, items)}</div>`,
        `</div>`,
      ].join('');

      parent.children[index] = { type: 'html', value: html };
      return [SKIP, index];
    });
  };
}
