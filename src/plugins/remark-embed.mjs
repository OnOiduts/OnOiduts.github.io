/**
 * remark 插件：识别 `:::embed` 指令 —— **专管外链平台嵌入**。
 *
 * 和 `:::video` 的分工：
 *
 * | 指令 | 用途 | 输出 |
 * |---|---|---|
 * | `:::video` | **本地视频** | 自定义播放器（倍速 / 逐帧 / 截图） |
 * | `:::embed` | **外链平台**（B站 / YouTube…） | 官方 iframe |
 *
 * 为什么要分开？
 *   `:::video` 里塞外链链接时，要先判断「是站内还是外链」再分流，容易混淆。
 *   独立成 `:::embed` 后意图明确：看到它就一定是外链嵌入。
 *
 * ── 写法（越简单越好）────────────────────────────────
 *
 *   :::embed{BV1DyuF6yEC5}                       ← 直接写 BV 号
 *   :::
 *
 *   :::embed{src="BV1DyuF6yEC5"}                 ← 或 src 属性
 *   :::
 *
 *   :::embed{src="https://www.bilibili.com/video/BV1DyuF6yEC5" title="过程录屏"}
 *   :::                                          ← 完整链接也认
 *
 *   :::embed
 *   https://www.youtube.com/watch?v=dQw4w9WgXcQ  ← 正文里写一行 URL
 *   :::
 *
 *   :::embed
 *   av170001                                     ← av 号也认
 *   :::
 *
 * ── 关于 `//` 协议 ─────────────────────────────────
 * B 站「分享 → 嵌入代码」给的 src 是 `//player.bilibili.com/...`（协议相对）。
 * 在 https 页面下会被判 Mixed Content 拦截 → 播放器永远缓冲。
 * 所以这里一律输出明确的 `https://`，绝不保留 `//`。
 */
import { visit, SKIP } from 'unist-util-visit';
import { embedFor } from './remark-video.mjs';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 指令名：embed 为主，bili / yt 作别名（写起来更短） */
const NAMES = new Set(['embed', 'bili', 'yt', 'youtube']);

/** BV 号 / av 号 / YouTube 11 位 ID 的裸写法 */
const BV = /^(BV[0-9A-Za-z]{8,})$/;
const AV = /^av(\d+)$/i;
const YT_ID = /^[\w-]{11}$/;

/** 把「裸 ID」补成可解析的完整链接 */
function expand(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (BV.test(t)) return `https://www.bilibili.com/video/${t}`;
  if (AV.test(t)) return `https://www.bilibili.com/video/${t.toLowerCase()}`;
  if (YT_ID.test(t)) return `https://www.youtube.com/watch?v=${t}`;
  // 已经是链接 / 协议相对地址
  if (/^https?:\/\//i.test(t)) return t;
  if (/^\/\//.test(t)) return 'https:' + t;
  // 带 p 参数的 BV（比如 BV1xxx?p=2）
  if (/^BV[0-9A-Za-z]+[?&]p=/i.test(t)) return `https://www.bilibili.com/video/${t}`;
  return t;
}

export default function remarkEmbed() {
  return (tree) => {
    visit(tree, (node, index, parent) => {
      if (node.type !== 'containerDirective') return;
      if (!NAMES.has(node.name)) return;

      const attrs = node.attributes || {};

      // ① src / url 属性
      let url = (attrs.src || attrs.url || '').trim();

      // ② 指令名后面直接跟 ID：:::embed{BV1DyuF6yEC5}
      //    ⚠️ 真 bug（修过）：remark-directive 把「裸属性」解析成 **键=ID、值=''**，
      //    不是 值=ID。原来只取值（`if (!v) continue`），空串被跳过 → url 始终为空
      //    → 命中下面的「解析不出就删节点」，整段指令被静默删除，页面上什么都没有。
      //    所以**键和值都要检查**。
      /* ⚠️ 解析器把「裸属性」放哪儿，不同版本不一致：
           有的 { 'BV1DyuF6yEC5': '' }（键是 ID，值是空串）
           有的 { '': 'BV1DyuF6yEC5' }（键是空串，值是 ID）
         所以**键和值都要检查**，而且要遍历全部而不是只看第一个。 */
      if (!url) {
        for (const k of Object.keys(attrs)) {
          const v = String(attrs[k] ?? '').trim();
          if (/^(src|url|title|class|id)$/i.test(k)) continue;
          const cand = v || k;
          if (BV.test(cand) || AV.test(cand) || YT_ID.test(cand) || /^https?:\/\//i.test(cand) || /^\/\//.test(cand)) { url = cand; break; }
        }
      }
      /* 键里也可能带 ID / 值被收进别的字段 */
      if (!url) {
        for (const c of [attrs.id, attrs.value, attrs.label, attrs['']]) {
          const v = String(c ?? '').trim();
          if (v && (BV.test(v) || AV.test(v) || YT_ID.test(v))) { url = v; break; }
        }
      }
      // 兜底：有些版本放在 node.data / node.attributes 之外
      if (!url) {
        const d = node.data || {};
        const cands = [d.id, d.value, d.label, node.value, node.label];
        for (const c of cands) {
          const v = String(c ?? '').trim();
          if (v && BV.test(v)) { url = v; break; }
        }
      }

      let title = (attrs.title || '').trim();

      // ③ 正文里写的 URL / 官方 iframe 代码
      if (!url) {
        const txt = [];
        const htmls = [];
        visit(node, 'text', (t) => txt.push(t.value || ''));
        visit(node, 'html', (h) => htmls.push(h.value || ''));
        const blob = htmls.join('\n') + '\n' + txt.join('\n');

        // 官方 iframe 整段：抠 src（能保住 aid / cid / p）
        const m = /<iframe\b[^>]*\ssrc\s*=\s*["']([^"']+)["']/i.exec(blob);
        if (m) {
          url = m[1].trim();
          if (!title) title = (/<iframe\b[^>]*\stitle\s*=\s*["']([^"']+)["']/i.exec(blob) || [, ''])[1];
        } else {
          // 一行 URL 或裸 ID
          const line = blob.split(/\s+/).map((s) => s.trim()).filter(Boolean)
            .find((s) => /^https?:\/\//i.test(s) || /^\/\//.test(s) || BV.test(s) || AV.test(s) || YT_ID.test(s));
          if (line) url = line;
        }
      }

      /* ⚠️ 原来这里是「静默删掉整个节点」——
         用户看到的就是「写了但页面上什么都没有」，完全没法排查。
         改成输出一个可见的提示块，至少能看出指令被识别了、只是没解析出内容。 */
      if (!url) {
        parent.children[index] = {
          type: 'html',
          value: [
            `<div class="player-ext">`,
            `<span class="player-ext-note mono">:::embed 未解析出视频链接 —— 请在 { } 里写 src="..." 或 BV 号 / av 号 / YouTube ID，`,
            ` 或在指令正文里写一行完整链接</span>`,
            `</div>`,
          ].join(''),
        };
        return [SKIP, index];
      }

      const full = expand(url);
      const em = embedFor(full);

      if (!em) {
        // 解析不出嵌入 ID（短链 / 无静态嵌入的平台）→ 外链卡片
        parent.children[index] = {
          type: 'html',
          value: [
            `<div class="player-ext">`,
            `<a class="term-btn" href="${esc(full)}" target="_blank" rel="noopener noreferrer">`,
            `&gt; ${esc(title || '外部平台视频')}_`,
            `</a>`,
            `<span class="player-ext-note mono">该链接无法内嵌播放（短链或平台限制），倍速 / 逐帧 / 截图不可用</span>`,
            `</div>`,
          ].join(''),
        };
        return [SKIP, index];
      }

      /* 属性严格照抄官方：
         - 不加 loading="lazy"：播放器在 lazy iframe 里初始化会卡住
         - 不加 allow="..."：Permissions Policy 白名单会禁掉未列出的特性
         - 不写 referrerpolicy="no-referrer"：会被判盗链
         - 一律 https://，绝不输出协议相对的 // */
      parent.children[index] = {
        type: 'html',
        value: [
          `<figure class="player-embed">`,
          `<iframe src="${esc(em.src)}" title="${esc(title || em.label + ' 播放器')}"`,
          ` scrolling="no" border="0" frameborder="no" framespacing="0"`,
          ` allowfullscreen="true"></iframe>`,
          `<figcaption class="player-embed-note mono">${esc(em.label)} 嵌入播放器 · 倍速 / 逐帧 / 截图需前往原站`,
          ` <a href="${esc(full)}" target="_blank" rel="noopener noreferrer">打不开？前往${esc(em.label)}观看 →</a></figcaption>`,
          `</figure>`,
        ].join(''),
      };
      return [SKIP, index];
    });
  };
}
