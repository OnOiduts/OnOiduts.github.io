/**
 * remark 插件：识别 `:::audio` 指令 —— 音频 / MIDI / 外链音乐平台。
 *
 * ── 三种输入 ────────────────────────────────────────────
 *
 *   ① 本地音频文件（mp3 / wav / ogg / flac / m4a）
 *      :::audio{src="/audio/bgm.mp3" title="背景音乐"}
 *      :::
 *      → 自定义播放器（播放/暂停、进度、音量、倍速）
 *
 *   ② MIDI 文件（.mid / .midi）
 *      :::audio{src="/audio/demo.mid" title="练习曲"}
 *      :::
 *      → MIDI 播放器。浏览器**没有**原生 MIDI 播放能力，
 *        这里用 Web Audio 实时合成：解析 MIDI 事件 → 振荡器发声。
 *
 *   ③ 外链音乐平台（网易云 / QQ音乐 / Spotify / Apple Music / SoundCloud…）
 *      :::audio{src="https://music.163.com/song?id=123456"}
 *      :::
 *      → 能解析出嵌入 ID 就用官方 iframe，否则退化成外链卡片
 *
 * ── 关于外链嵌入的三条硬规矩 ────────────────────────────
 * 和 `:::embed`（视频）完全一样，踩过坑才有的：
 *   1. 一律输出 `https://`，绝不保留 `//`（协议相对 → Mixed Content 被拦）
 *   2. 不加 loading="lazy" / allow="..." / referrerpolicy="no-referrer"
 *   3. 其余属性照抄平台官方给的那份
 *
 * ⚠️ 外链 iframe **音量无法从本页控制** —— 跨域，JS 进不去。
 *    平台播放器自带音量条，所以 figcaption 里提示用播放器内的控件。
 *    别想着自己加一个滑块，加了也只是摆设。
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

/** 指令名：audio 为主，music / midi 作别名 */
const NAMES = new Set(['audio', 'music', 'midi']);

/* 扩展名判定 */
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|webm)$/i;
const MIDI_EXT = /\.(mid|midi|smf)$/i;

/**
 * 外链音乐平台 → 官方嵌入地址。
 * 返回 { src, label, h }（h = 建议高度，不同平台播放器高度差很多）。
 */
function musicEmbed(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = (u.hostname || '').replace(/^www\./, '').replace(/^m\./, '');
  const path = u.pathname || '';
  const q = (k) => u.searchParams.get(k);
  const H = 'https:';

  /* 返回值额外带 bg：iframe 内容透明时的背板色。
     ⚠️ 音乐平台（尤其网易云）的 iframe 页面**没有背景色**，
        父级若沿用视频那套 #000，白色播放器周围就会露出一圈黑。
        所以这里按平台给：浅色播放器白、Spotify 深色。 */

  /* ---- 网易云音乐 ---- */
  /* 官方外链播放器：https://music.163.com/outchain/player?type=<类型>&id=<ID>
     ⚠️ type 对照表（网易云官方外链页 + 萌娘百科 Music163 模板，两边互相印证）：
          0 = 歌单      1 = 专辑      2 = 单曲
          3 = 电台节目（program）     4 = 电台（djradio）
       早前这里注释写的是「0=单曲 1=歌单 2=专辑」，是错的，实际完全对不上。
     尺寸：官方说「歌单和专辑可选大中小，单曲和电台节目可选中小」——
           即歌单/专辑/电台给大尺寸（height=430），单曲/电台节目给小（height=66）。 */
  const NE = {
    playlist: { t: 0, ih: 430, label: '网易云音乐' },
    album:    { t: 1, ih: 430, label: '网易云音乐' },
    song:     { t: 2, ih: 66,  label: '网易云音乐' },
    program:  { t: 3, ih: 66,  label: '网易云电台' },
    djradio:  { t: 4, ih: 430, label: '网易云电台' },
  };

  if (host.endsWith('music.163.com') || host.endsWith('163cn.tv')) {
    /* ⚠️ 网易云是 SPA，从网页复制的链接有两种形态，都必须支持：
         hash 形式：https://music.163.com/#/song?id=123   ← 最常见
         路径形式：https://music.163.com/program/123456
       hash 里的参数 searchParams **读不到**（实测返回 null → 退化成外链卡片），
       路径形式的 id 也不在 ?id= 里。所以两种都要兜底取。 */
    const idFromQuery = q('id') || (/[#?&]id=(\d+)/.exec(raw) || [])[1] || null;
    /* 路径形式：/program/123、/#/djradio/123 */
    const seg = /[#/](?:song|playlist|album|program|djradio)\/(?:\?id=)?(\d+)/.exec(raw);
    const id = idFromQuery || (seg ? seg[1] : null);

    /* 先定类型再取 id —— 反过来（先判 id 再判类型）会让 playlist 之外的分支
       全部被「有 id 就是单曲」吃掉（这是歌单分支变成死代码的根因）。 */
    const kind = /playlist/i.test(raw) ? 'playlist'
      : /program/i.test(raw) ? 'program'
      : /djradio|\/radio/i.test(raw) ? 'djradio'
      : /album/i.test(raw) ? 'album'
      : 'song';

    if (id && /^\d+$/.test(id)) {
      const c = NE[kind];
      /* iframe 高度 = 内部播放器高度 + 上下留白（单曲 66→86，列表 430→450） */
      return {
        src: `${H}//music.163.com/outchain/player?type=${c.t}&id=${id}&auto=0&height=${c.ih}`,
        label: c.label,
        h: c.ih + 20,
        bg: '#fff',
      };
    }
    return null;
  }

  /* ---- QQ 音乐 ---- */
  if (host.endsWith('y.qq.com') || host.endsWith('qq.com') && /music|i\.y/.test(host)) {
    const sid = q('songid') || q('id');
    if (sid && /^\d+$/.test(sid)) {
      return { src: `${H}//i.y.qq.com/n2/m/outchain/player/index.html?songid=${sid}`, label: 'QQ 音乐', h: 110, bg: '#fff' };
    }
    return null;
  }

  /* ---- Spotify ---- */
  if (host.endsWith('spotify.com')) {
    const m = /\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/.exec(path);
    if (m) return { src: `${H}//open.spotify.com/embed/${m[1]}/${m[2]}`, label: 'Spotify', h: m[1] === 'track' ? 152 : 380, bg: '#121212', allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture' };
    return null;
  }

  /* ---- Apple Music ---- */
  if (host.endsWith('apple.com')) {
    const m = /\/(album|playlist|song)\/[^/]*\/([^?]+)/.exec(path);
    if (m) return { src: `${H}//embed.music.apple.com/${m[1]}/${m[2]}`, label: 'Apple Music', h: 175, bg: '#fff', allow: 'autoplay *; encrypted-media *;' };
    return null;
  }

  /* ---- SoundCloud ---- */
  if (host.endsWith('soundcloud.com')) {
    const u2 = encodeURIComponent(raw);
    return { src: `${H}//w.soundcloud.com/player/?url=${u2}&color=%23ff5500&auto_play=false&hide_related=true&show_comments=false`, label: 'SoundCloud', h: 166, bg: '#fff' };
  }

  /* ---- 喜马拉雅 / 荔枝 等：无公开静态嵌入 → null ---- */
  return null;
}

/** 外链音乐平台域名（用来判断要不要走嵌入） */
const MUSIC_HOSTS = ['music.163.com', '163cn.tv', 'y.qq.com', 'spotify.com', 'apple.com', 'soundcloud.com', 'kugou.com', 'kuwo.cn', 'ximalaya.com'];

function isMusicExternal(url) {
  if (/^https?:\/\//i.test(url)) {
    try { return MUSIC_HOSTS.some((h) => new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, '').endsWith(h)); }
    catch { return true; }
  }
  return false;
}

export default function remarkAudio() {
  return (tree) => {
    visit(tree, (node, index, parent) => {
      if (node.type !== 'containerDirective') return;
      if (!NAMES.has(node.name)) return;

      const attrs = node.attributes || {};
      let url = (attrs.src || attrs.url || '').trim();
      let title = (attrs.title || '').trim();

      // 无键属性：:::audio{/audio/bgm.mp3}
      // ⚠️ 和 remark-embed 同一个 bug：remark-directive 把裸属性解析成
      //    **键=内容、值=''**，只取值会全部跳过 → 整段指令被静默删除。
      if (!url) {
        for (const k of Object.keys(attrs)) {
          const v = String(attrs[k] ?? '').trim();
          if (!/^(src|url|title|class|id)$/i.test(k)) { url = v || k; break; }
        }
      }

      // 正文里写的一行 URL / ![](url)
      if (!url) {
        const txt = [];
        visit(node, 'text', (t) => txt.push(t.value || ''));
        const cand = txt.join('\n').split(/\s+/).map((s) => s.trim()).filter(Boolean)
          .find((s) => /^https?:\/\//i.test(s) || /\.(mp3|wav|ogg|flac|m4a|mid|midi)$/i.test(s));
        if (cand) url = cand;
        if (!url) visit(node, 'image', (img) => { url = img.url; if (!title) title = img.alt || ''; return SKIP; });
      }

      /* 同上：不再静默删除，输出可见提示 */
      if (!url) {
        parent.children[index] = {
          type: 'html',
          value: [
            `<div class="player-ext">`,
            `<span class="player-ext-note mono">:::audio 未解析出音频链接 —— 请在 { } 里写 src="..." 或音频路径，`,
            ` 或在指令正文里写一行链接</span>`,
            `</div>`,
          ].join(''),
        };
        return [SKIP, index];
      }
      if (/^\/\//.test(url)) url = 'https:' + url;

      /* ---- 分流 ---- */
      let html;
      if (MIDI_EXT.test(url)) {
        /* dl 只对本地文件有意义；MIDI 正是最常被要原文件的一种 */
        const d = dlInfo(attrs, url);
        html = `<div class="player midi-player" data-src="${esc(url)}"${title ? ` data-title="${esc(title)}"` : ''}${dlOffFlag(attrs)}${dlOnFlag(attrs, d)}>${dlBtn(d, 'MIDI')}</div>`;
      } else if (!isMusicExternal(url)) {
        /* 站内音频文件 → 自定义播放器 */
        const d = dlInfo(attrs, url);
        html = `<div class="player audio-player" data-src="${esc(url)}"${title ? ` data-title="${esc(title)}"` : ''}${dlOffFlag(attrs)}${dlOnFlag(attrs, d)}>${dlBtn(d, '音频')}</div>`;
      } else {
        /* 外链平台：没有本地文件可下载，dl 一律忽略（不产生按钮） */
        const em = musicEmbed(url);
        html = em
          ? [
              /* --embed-bg：iframe 透明时的背板色，见 musicEmbed 里的 bg 字段。
                 不给的话 CSS 默认 #fff，深色平台（Spotify）会露白边。 */
              `<figure class="player-embed music-embed" style="--embed-h:${em.h}px${em.bg ? `;--embed-bg:${em.bg}` : ''}">`,
              `<iframe src="${esc(em.src)}" title="${esc(title || em.label + ' 播放器')}"`,
              ` scrolling="no" border="0" frameborder="no" framespacing="0"`,
              `${em.allow ? ` allow="${esc(em.allow)}"` : ''} allowfullscreen="true"></iframe>`,
              `<figcaption class="player-embed-note mono">${esc(em.label)} 嵌入播放器 · 音量 / 倍速请用播放器内的控件`,
              ` <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">打不开？前往${esc(em.label)} →</a></figcaption>`,
              `</figure>`,
            ].join('')
          : [
              `<div class="player-ext">`,
              `<a class="term-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">`,
              `&gt; ${esc(title || '外部音频')}_`,
              `</a>`,
              `<span class="player-ext-note mono">该链接无法内嵌播放（短链或平台限制），请前往原站收听</span>`,
              `</div>`,
            ].join('');
      }

      parent.children[index] = { type: 'html', value: html };
      return [SKIP, index];
    });
  };
}
