/**
 * remark 插件：识别 `:::video` 指令，渲染成自定义播放器（或外链兜底）。
 *
 * 四种写法都可以：
 *
 *   :::video{src="/videos/demo.mp4"}
 *   :::
 *
 *   :::video{src="https://www.bilibili.com/video/BV1DyuF6yEC5"}
 *   :::                              ← 自动转成官方嵌入
 *
 *   :::video
 *   <iframe src="//player.bilibili.com/player.html?isOutside=true&aid=...&bvid=...&cid=...&p=1"
 *     scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>
 *   :::                              ← 直接贴官方代码，aid/cid 全都保留（推荐）
 *
 *   :::video
 *   ![](/videos/demo.mp4)
 *   :::
 *
 * B 站优先用「直接贴官方 iframe 代码」这种写法：aid / cid 是分 P 标识，
 * 静态解析推不出来（要调 API），贴整段才能精确定位到某一 P。
 * 只用 bvid 也能播（B 站会自己解析），但指定不了 cid。
 *
 * 外链平台（B 站 / YouTube / Vimeo…）**不用自定义播放器** —— 它们不给
 * 原始视频流，倍速 / 逐帧 / 截图这些功能都会失效。这种情况退化成一个
 * 「前往观看」的外链卡片，也就是「平台限制 → 不管」。
 *
 * ⚠️ 只输出一个空的 <div class="player" data-src=...>：
 *    控件全部由 ui.ts 的 initPlayers() 在运行时建。
 *    把整棵控件树写成 HTML 字符串既难维护，又没法做事件绑定。
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

const dlBtn = (d, kind) => d
  ? `<a class="asset-dl" href="${esc(d.url)}" download="${esc(d.name)}" data-guard-off`
    + ` title="下载 ${esc(d.name)}"`
    + ` aria-label="下载 ${esc(d.name)}"><span aria-hidden="true">↓</span>`
    + `<span class="asset-dl-t">${esc(kind)}</span></a>`
  : '';

/**
 * 外链平台：拿不到原始视频流，自定义播放器（倍速 / 逐帧 / 截图）用不了。
 *
 * 但这**不等于**只能给个外链按钮 —— 主流平台都提供官方 iframe 嵌入，
 * 能嵌就嵌（观感远好于跳走），只有解析不出嵌入 ID 时才退化成外链卡片。
 *
 * ⚠️ 这里是**构建时**静态解析：短链（b23.tv / youtu.be 之外的跳转链）
 *    拿不到目标 ID，只能走外链兜底 —— 想要嵌入就把完整链接贴进来。
 */
const EXTERNAL = [
  'bilibili.com', 'b23.tv',
  'youtube.com', 'youtu.be',
  'vimeo.com',
  'douyu.com', 'huya.com', 'twitch.tv',
  'iqiyi.com', 'youku.com',
  'v.qq.com', // 腾讯视频（域名是 v.qq.com，不是 tencent.com）
  'acfun.cn',
  'douyin.com', 'ixigua.com',
];

export function isExternal(url) {
  if (/^https?:\/\//i.test(url)) {
    try {
      return EXTERNAL.some((h) => new URL(url).hostname.endsWith(h));
    } catch {
      return true; // 解析不了的绝对地址，保守当外链
    }
  }
  return false;
}

/**
 * 尝试把平台链接转成官方 iframe 嵌入地址。
 * 返回 { src, label } —— 解析不出来返回 null（→ 退化成外链卡片）。
 *
 * ⚠️ B 站的 aid 现在是超大整数（如 117035090578245），且 cid 是分 P 标识，
 *    两者都无法从网页 URL 静态推出（要调 API）。好消息是**只用 bvid 就能播**，
 *    B 站会自己解析。想要精确指定分 P，用 `p=` 或手动带 `cid=`。
 */
export function embedFor(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = (u.hostname || '').replace(/^www\./, '').replace(/^m\./, '');
  const path = u.pathname || '';
  const q = (k) => u.searchParams.get(k);

  /* ---- B 站 ---- */
  /* 官方外链嵌入代码长这样（b23.tv 短链解析不出这些 ID，只能走外链兜底）：
     <iframe src="//player.bilibili.com/player.html?isOutside=true&aid=...&bvid=...&cid=...&p=1">
     ⚠️ isOutside=true 不能少 —— 这是「站外嵌入」的标志，缺了它会走站内播放器，
        在未登录 /  Referrer 不对的情况下容易被拦。 */
  if (host.endsWith('bilibili.com') || host.endsWith('b23.tv')) {
    /* ① 已经是官方嵌入地址（用户把 player.html 那段直接贴进来了）→ 原样用，
          只补协议和 isOutside。这样 aid / cid / p 全都保留，最保险。 */
    if (host === 'player.bilibili.com') {
      u.protocol = 'https:';
      if (!u.searchParams.get('isOutside')) u.searchParams.set('isOutside', 'true');
      return { src: u.href, label: '哔哩哔哩' };
    }
    const bv = /\/(BV[0-9A-Za-z]+)/.exec(path);
    if (bv) {
      /* ⚠️ 参数也照抄官方：只有 isOutside / bvid / p。
         不要加 autoplay=0 / danmaku=0 —— 官方没有，多传会让播放器走另一条逻辑。 */
      const ps = new URLSearchParams();
      ps.set('isOutside', 'true');
      ps.set('bvid', bv[1]);
      const page = q('p');
      if (page) ps.set('p', page);
      return { src: `https://player.bilibili.com/player.html?${ps}`, label: '哔哩哔哩' };
    }
    const av = /\/av(\d+)/i.exec(path);
    if (av) {
      const ps = new URLSearchParams();
      ps.set('isOutside', 'true');
      ps.set('aid', av[1]);
      const page = q('p');
      if (page) ps.set('p', page);
      return { src: `https://player.bilibili.com/player.html?${ps}`, label: '哔哩哔哩' };
    }
    return null; // 番剧 / 直播间 / b23 短链
  }

  /* ---- YouTube ---- */
  if (host.endsWith('youtube.com')) {
    const v = q('v');
    if (v && /^[\w-]{6,}$/.test(v)) return { src: `https://www.youtube-nocookie.com/embed/${v}`, label: 'YouTube' };
    const em = /^\/(?:embed|shorts|live)\/([\w-]+)/.exec(path);
    if (em) return { src: `https://www.youtube-nocookie.com/embed/${em[1]}`, label: 'YouTube' };
    return null;
  }
  if (host.endsWith('youtu.be')) {
    const id = path.replace(/^\//, '').split(/[/?#]/)[0];
    if (/^[\w-]{6,}$/.test(id)) return { src: `https://www.youtube-nocookie.com/embed/${id}`, label: 'YouTube' };
    return null;
  }

  /* ---- Vimeo ---- */
  if (host.endsWith('vimeo.com')) {
    const m = /\/(\d{5,})/.exec(path);
    if (m) return { src: `https://player.vimeo.com/video/${m[1]}`, label: 'Vimeo' };
    return null;
  }

  /* ---- 腾讯视频 ---- */
  if (host === 'v.qq.com' || host.endsWith('.v.qq.com')) {
    const vid = q('vid') || (() => {
      const m = /\/([a-zA-Z0-9]{11,})\.html$/.exec(path);
      return m ? m[1] : '';
    })();
    if (vid) return { src: `https://v.qq.com/txp/iframe/player.html?vid=${vid}`, label: '腾讯视频' };
    return null;
  }

  /* ---- 优酷 ---- */
  if (host.endsWith('youku.com')) {
    const m = /id_([A-Za-z0-9=]+)/.exec(path);
    if (m) return { src: `https://player.youku.com/embed/${m[1]}`, label: '优酷' };
    return null;
  }

  /* ---- AcFun ---- */
  if (host.endsWith('acfun.cn')) {
    const m = /\/(ac\d+)/i.exec(path);
    if (m) return { src: `https://www.acfun.cn/player/${m[1]}`, label: 'AcFun' };
    return null;
  }

  /* 其余（斗鱼 / 虎牙 / 抖音 / 西瓜 / 爱奇艺 / Twitch…）：
     要么没有公开静态嵌入，要么要带 parent 域名参数（本地 dev 域名不固定） */
  return null;
}

export default function remarkVideo() {
  return (tree) => {
    visit(tree, (node, index, parent) => {
      if (node.type !== 'containerDirective') return;
      if (node.name !== 'video') return;

      // ① 显式属性优先
      const attrs = node.attributes || {};
      let url = (attrs.src || attrs.url || '').trim();
      let title = (attrs.title || '').trim();

      // ①-a 直接把官方给的 <iframe ...> 整段贴进来 —— 最省事，
      //     也能保住 aid / cid 这类静态解析不出来的参数。
      const rawHtml = [];
      visit(node, 'html', (h) => { rawHtml.push(h.value || ''); });
      // 裸文本里写的 iframe（markdown 会把没闭合标签的那段当 text）
      const rawText = [];
      visit(node, 'text', (t) => { rawText.push(t.value || ''); });
      const blob = rawHtml.join('\n') + '\n' + rawText.join('\n');
      const iframeSrc = /<iframe[^>]*\ssrc\s*=\s*["\']([^"\']+)["\']/i.exec(blob);
      if (iframeSrc) url = iframeSrc[1].trim();
      // 也可能只贴了嵌入地址本身（//player.bilibili.com/player.html?...）
      if (!/^\w+:/.test(url) && /^\/\/player\./.test(url)) url = 'https:' + url;

      if (!url) {
        visit(node, 'image', (img) => {
          url = img.url;
          if (!title) title = img.alt ?? '';
          return SKIP;
        });
      }

      // ③ 最后：裸路径（一行纯文本）
      if (!url) {
        const txt = [];
        visit(node, 'text', (t) => {
          txt.push(t.value);
        });
        const cand = txt.join('').trim().split(/\s+/).find((t) => /\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(t) || /^https?:\/\//i.test(t));
        if (cand) url = cand;
      }

      if (!url) {
        parent.children.splice(index, 1);
        return [SKIP, index];
      }

      /* 站内视频 → 自定义播放器；外链平台 → 优先官方 iframe，不行才外链卡片 */
      let html;
      if (!isExternal(url)) {
        const d = dlInfo(attrs, url);
        html = `<div class="player" data-src="${esc(url)}"${title ? ` data-title="${esc(title)}"` : ''}${dlOffFlag(attrs)}${dlOnFlag(attrs, d)}>${dlBtn(d, '视频')}</div>`;
      } else {
        const em = embedFor(url);
        html = em
          ? [
              `<figure class="player-embed">`,
              /* ⚠️ 属性严格照抄 B 站官方给的那份，不要自作主张加东西：
                 - 不加 loading="lazy"：B 站播放器在 lazy iframe 里初始化会卡住
                 - 不加 allow="..."：allow 是 Permissions Policy 白名单，
                   一旦声明，没写进去的特性（如 autoplay / storage-access）
                   全部被禁用 → 播放器拿不到数据，一直「正在缓冲…」
                 官方原版就只有 src + scrolling/border/frameborder/framespacing/allowfullscreen */
              `<iframe src="${esc(em.src)}" title="${esc(title || em.label + ' 播放器')}"`,
              ` scrolling="no" border="0" frameborder="no" framespacing="0"`,
              ` allowfullscreen="true"`,
              /* ⚠️ 不能写 referrerpolicy="no-referrer"！
                 B 站 / YouTube 会校验 Referrer，不发来源会被判为盗链 → 黑屏。
                 官方给的嵌入代码里也没有这个属性，是我自己多加的。 */
              `></iframe>`,
              `<figcaption class="player-embed-note mono">${esc(em.label)} 嵌入播放器 · 倍速 / 逐帧 / 截图需前往原站`,
              /* 兜底入口：作者可能设了「禁止站外播放」，此时播放器会一直「正在缓冲…」。
                 给一个明确的跳转，避免读者对着一个死播放器干等。 */
              ` <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">打不开？前往${esc(em.label)}观看 →</a></figcaption>`,
              `</figure>`,
            ].join('')
          : [
              `<div class="player-ext">`,
              `<a class="term-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">`,
              `&gt; ${esc(title || '外部平台视频')}_`,
              `</a>`,
              `<span class="player-ext-note mono">该链接无法内嵌播放（短链或平台限制），倍速 / 逐帧 / 截图不可用</span>`,
              `</div>`,
            ].join('');
      }

      parent.children[index] = { type: 'html', value: html };
      return [SKIP, index];
    });

    /* ============================================================
       第二遍：正文里**直接贴**的裸 <iframe>
       ------------------------------------------------------------
       B 站的「复制嵌入代码」给的就是一整段 <iframe>，很多人会直接
       粘进 markdown —— 它不会落在 :::video 里，上面那一遍抓不到。
       裸 iframe 没有容器约束，浏览器会给默认 150px 高，看起来就是
       「一条扁扁的、比例不对的东西」。
       这里把它包进 .player-embed（16:9），并顺手补平台缺失的属性。
       ⚠️ 必须跳过自己刚生成的节点，否则会无限套娃。
       ============================================================ */
    visit(tree, 'html', (node, index, parent) => {
      if (!parent || !node.value) return;
      if (node.value.includes('player-embed')) return; // 自己产出的，跳过

      const m = /<iframe\b[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*>/i.exec(node.value);
      if (!m) return;

      let src = m[1].trim();
      if (/^\/\//.test(src)) src = 'https:' + src;
      const em = embedFor(src);
      if (!em) {
        /* 不认识的平台：不动结构，但 **一定要把 // 补成 https**。
           协议相对地址在 file:// 下会解析成 file://player.xxx（必挂），
           在 https 页面下会被判 Mixed Content。补 https 是纯收益。 */
        /* ⚠️ 判断要用**原始抓取值** m[1]，不能用 src —— src 在上面已经
           被规范化成 https 了，拿它判断永远为 false（我刚踩了这个坑）。 */
        if (/^\/\//.test(m[1].trim())) {
          /* 必须吃掉**两个**斜杠：只替换一个会得到 https:///example.com */
          const fixed = node.value.replace(
            /(<iframe\b[^>]*\ssrc\s*=\s*["'])\/\//i,
            '$1https://'
          );
          parent.children[index] = { type: 'html', value: fixed };
        }
        return;
      }

      /* ⚠️ 用 em.src 重新生成标签，而不是复用贴进来的原标签：
         原标签里 src 可能是 `//` 协议相对（file:// 下会解析成
         file://player.bilibili.com），也可能缺 isOutside。 */
      const titleAttr = (/<iframe\b[^>]*\stitle\s*=\s*["']([^"']+)["']/i.exec(node.value) || [, ''])[1];

      parent.children[index] = {
        type: 'html',
        value: [
          `<figure class="player-embed">`,
          `<iframe src="${esc(em.src)}"${titleAttr ? ` title="${esc(titleAttr)}"` : ` title="${esc(em.label + ' 播放器')}"`}`,
          ` scrolling="no" border="0" frameborder="no" framespacing="0"`,
          ` allowfullscreen="true"></iframe>`,
          `<figcaption class="player-embed-note mono">${esc(em.label)} 嵌入播放器 · 倍速 / 逐帧 / 截图需前往原站`,
          ` <a href="${esc(src)}" target="_blank" rel="noopener noreferrer">打不开？前往${esc(em.label)}观看 →</a></figcaption>`,
          `</figure>`,
        ].join(''),
      };
      return [SKIP, index];
    });
  };
}
