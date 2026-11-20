/**
 * 快捷下载按钮 —— 把插件输出的 <a class="asset-dl"> 摆到正确位置，
 * 并在「HTML 是旧的」时按授权标记自己把按钮补出来。
 *
 * 为什么需要搬：播放器的控件树是 JS 运行时 append 出来的，
 * 插件在容器里预置的按钮会停在 DOM 最前面（视频播放器会浮到画面上、
 * 音频条会跑到播放键左边）。构建期没法知道控件条长什么样，所以由这里搬。
 *
 * ⚠️ 默认关闭（这一轮改回来的）：
 *   下载按钮只在作者显式写了 dl / dl="1" / dl="文件名" 时才存在。
 *   构建期插件会给这类容器打 data-dl-on="1"；本文件只认这个标记：
 *     · 没标记 → 不补按钮
 *     · 有标记但按钮丢了（旧 HTML、缓存、View Transitions）→ 补回来
 *     · 旧版「默认开启」生成的按钮（容器无标记）→ 主动移除
 *   第三条很重要：只更新这份 JS、不重新构建 markdown，也能立刻变成默认关闭，
 *   不用等 Astro 重编（改 remark 插件不会热更新已编译的 markdown）。
 *
 * ⚠️ 调用顺序：必须在 initPlayers() / initAudios() 之后（此时 .player-bar 已存在），
 *    在 initAssetGuard() 之前（那时 data-src 还没被擦掉）。按钮自带 data-guard-off，
 *    防护层会整体放行。
 *
 * 不碰 href / download，也不新增任何请求。
 */

/* 插件只给站内本地文件输出按钮（跨域的 <a download> 会被浏览器忽略、变成
   新标签页打开），所以这里拿到的 href 一定是同源可下载的。 */
function dlFileName(u) {
  const clean = String(u).split(/[?#]/)[0];
  return clean.split('/').pop() || 'download';
}

/** 只有同源本地路径才给按钮；绝对外链 / 协议相对 / data: / blob: 一律不给 */
function isLocalAsset(u) {
  const s = String(u || '').trim();
  if (!s) return false;
  if (/^(https?:)?\/\//i.test(s)) return false;
  if (/^(data|blob|javascript):/i.test(s)) return false;
  return true;
}

/** 作者显式放行（dl / dl="1" / dl="文件名"）时构建期打上的授权标记 */
function isOn(host) {
  return host.getAttribute('data-dl-on') === '1';
}

/** 作者显式关掉 dl="0" —— 双保险，任何时候都不该补 */
function isOff(host) {
  return host.getAttribute('data-dl-off') === '1';
}

/** 容器上写了自定义下载名就沿用，否则用文件名 */
function dlName(host, url) {
  return host.getAttribute('data-dl-name') || dlFileName(url);
}

function makeBtn(url, name, kind, list) {
  const a = document.createElement('a');
  a.className = 'asset-dl';
  a.setAttribute('href', url);
  a.setAttribute('download', name);
  a.setAttribute('data-guard-off', '');
  a.setAttribute('data-dl-auto', '1');
  a.setAttribute('title', '下载 ' + name);
  a.setAttribute('aria-label', '下载 ' + name);
  if (list && list.length) a.setAttribute('data-dl-list', JSON.stringify(list));
  const arrow = document.createElement('span');
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '↓';
  const text = document.createElement('span');
  text.className = 'asset-dl-t';
  text.textContent = kind;
  a.append(arrow, text);
  return a;
}

/**
 * 清理旧版残留：上一版「默认开启」给所有本地资源都渲染了按钮，
 * 容器上没有 data-dl-on。新版构建期输出的按钮一定带授权标记，
 * 所以「无标记却有按钮」只可能是旧 HTML / 缓存 / 没重编的 markdown。
 * 删掉它，让默认关闭立刻生效，不依赖重新构建。
 * （选择器写在函数内，不占顶层词法环境：同一页重复注入这份 JS 也不会冲突。）
 */
function stripUnauthorized() {
  document.querySelectorAll('.player, .audio-player, .midi-player, .gallery').forEach((host) => {
    if (isOn(host)) return;
    host.querySelectorAll('.asset-dl').forEach((a) => a.remove());
  });
}

/**
 * 兜底：容器授权了、但按钮不在时补一个。
 * 数据来源优先级：容器 data-src → 内部 audio/video 的 src → source src。
 * 相册特殊：从 .gallery-main 里的图取一组，翻页交给后面的 MutationObserver 同步。
 */
function ensureButtons() {
  /* ① 音频 / MIDI / 视频：单个文件 */
  /* 不用 [data-src] 收窄：View Transitions / 老 DOM / 已擦过属性的容器可能
     没有 data-src，但内部 <audio>/<video> 还在，照样能补出来。 */
  document.querySelectorAll('.player, .audio-player, .midi-player').forEach((host) => {
    if (host.querySelector('.asset-dl') || !isOn(host) || isOff(host)) return;
    const url = host.getAttribute('data-src')
      || host.querySelector('audio[src], video[src]')?.getAttribute('src')
      || host.querySelector('source[src]')?.getAttribute('src')
      || '';
    if (!isLocalAsset(url)) return;
    const kind = host.classList.contains('midi-player') ? 'MIDI'
      : host.classList.contains('audio-player') ? '音频' : '视频';
    host.appendChild(makeBtn(url, dlName(host, url), kind));
  });

  /* ② 相册：整组一个按钮，指向当前那张 */
  document.querySelectorAll('.gallery').forEach((g) => {
    if (g.querySelector('.asset-dl') || !isOn(g) || isOff(g)) return;
    const urls = Array.from(g.querySelectorAll('.gallery-main img.gallery-img'))
      .map((img) => img.getAttribute('src') || '')
      .filter(Boolean);
    if (!urls.length || !urls.every(isLocalAsset)) return;
    const cap = g.querySelector('.gallery-caption') || g;
    cap.appendChild(makeBtn(urls[0], dlName(g, urls[0]), '图片', urls));
  });
}

export function initAssetDownload() {
  stripUnauthorized();
  ensureButtons();

  /* ① 搬按钮 */
  document.querySelectorAll('.asset-dl').forEach((a) => {
    if (a.getAttribute('data-dl-placed')) return;   // 幂等（View Transitions 会重跑）
    a.setAttribute('data-dl-placed', '1');
    const host = a.parentElement;
    if (!host) return;

    const isAudio = host.classList.contains('audio-player') || host.classList.contains('midi-player');
    const isGallery = host.classList.contains('gallery');
    const bar = host.querySelector('.player-bar');
    const cap = host.querySelector('.gallery-caption');

    if (isAudio) {
      /* 音频 / MIDI：root 本身就是单行 flex 控件条，放末尾 */
      host.appendChild(a);
    } else if (isGallery) {
      (cap || host).appendChild(a);
    } else {
      /* 视频：进控件条 → 全屏时跟着浮层一起淡入淡出 */
      (bar || host).appendChild(a);
    }
  });

  /* ② 相册翻页时，按钮跟着指向当前那张原图。
       用 MutationObserver 观察 data-i，不必改动 ui.ts 里已有的翻页逻辑。 */
  document.querySelectorAll('.gallery').forEach((g) => {
    const btn = g.querySelector('.asset-dl[data-dl-list]');
    if (!btn || btn.getAttribute('data-dl-follow')) return;
    btn.setAttribute('data-dl-follow', '1');
    let list;
    try { list = JSON.parse(btn.getAttribute('data-dl-list') || '[]'); }
    catch (e) { return; }
    if (!list || !list.length) return;

    const sync = () => {
      const i = Math.max(0, Math.min(list.length - 1, Number(g.getAttribute('data-i')) || 0));
      const u = String(list[i] || list[0]);
      const name = dlFileName(u);
      btn.setAttribute('href', u);
      btn.setAttribute('download', name);
      btn.setAttribute('title', '下载 ' + name);
      btn.setAttribute('aria-label', '下载 ' + name);
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(g, { attributes: true, attributeFilter: ['data-i'] });
  });
}
