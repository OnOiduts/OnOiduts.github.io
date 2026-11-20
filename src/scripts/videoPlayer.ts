/**
 * 自定义视频播放器（数据感风格）
 *
 * 功能：播放/暂停、进度条拖拽、快进快退、逐帧前进后退、倍速、音量/静音、
 *       截图（弹窗选保存位置）、全屏。
 *
 * 只认「能拿到原始视频流」的地址（mp4 / webm / ogg…）。
 * B 站 / YouTube 这类平台不给原始流，倍速和逐帧会失效，所以由
 * remark 插件直接退化成外链卡片（见 src/plugins/remark-video.mjs）。
 */
export function initPlayers() {
  /* ⚠️ 必须排除音频容器：音频插件输出的是 `class="player audio-player"`，
     裸 `.player` 会把音频条也当成视频，在里面塞进一整个视频播放器
     （src 是 .mp3，video 元素加载失败 → 音频区出现一块坏掉的视频播放器）。 */
  document.querySelectorAll<HTMLElement>(
    '.player:not(.audio-player):not(.midi-player)'
  ).forEach((root) => {
    /* ⚠️ 幂等：同上，重复调用会多出一套控件条和一个 video 元素 */
    if (root.dataset.playerBuilt) return;
    root.dataset.playerBuilt = '1';
    buildPlayer(root);
  });
}

const fmt = (t: number) => {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

function buildPlayer(root: HTMLElement) {
  const src = root.dataset.src || '';
  if (!src) return;

  /* ---------- 骨架 ---------- */
  const stage = document.createElement('div');
  stage.className = 'player-stage';

  const video = document.createElement('video');
  video.className = 'player-video';
  video.src = src;
  video.preload = 'metadata';
  video.playsInline = true;
  /* ⚠️ 不要加 controls：目标是自定义播放器。
     但必须保留键盘可达性 —— 下面给控件都加了 aria-label。 */
  stage.appendChild(video);

  /* 中央大播放按钮（未播放时显示） */
  const big = document.createElement('button');
  big.className = 'player-big';
  big.type = 'button';
  big.setAttribute('aria-label', '播放');
  big.textContent = '▶';
  stage.appendChild(big);

  /* ---------- 控件条 ---------- */
  const bar = document.createElement('div');
  bar.className = 'player-bar';

  const mkBtn = (cls: string, label: string, text: string, title?: string) => {
    const b = document.createElement('button');
    b.className = `player-btn ${cls}`;
    b.type = 'button';
    b.setAttribute('aria-label', label);
    if (title) b.title = title;
    b.textContent = text;
    return b;
  };

  const btnPlay = mkBtn('player-play', '播放/暂停', '▶');
  const tCur = document.createElement('span');
  tCur.className = 'player-time player-time-cur';
  tCur.textContent = '00:00';
  const tSep = document.createElement('span');
  tSep.className = 'player-time-sep';
  tSep.textContent = '/';
  const tDur = document.createElement('span');
  tDur.className = 'player-time';
  tDur.textContent = '00:00';

  /* 进度：用 input[type=range] 而不是自己画 —— 自带键盘操作和无障碍 */
  const seek = document.createElement('input');
  seek.className = 'player-seek';
  seek.type = 'range';
  seek.min = '0';
  seek.max = '1000';
  seek.value = '0';
  seek.step = '1';
  seek.setAttribute('aria-label', '进度');

  const btnBack = mkBtn('player-back', '快退 5 秒', '«', '快退 5 秒 (←)');
  const btnFwd = mkBtn('player-fwd', '快进 5 秒', '»', '快进 5 秒 (→)');
  const btnPrevF = mkBtn('player-frame-prev', '上一帧', '◀|', '上一帧 (,)');
  const btnNextF = mkBtn('player-frame-next', '下一帧', '|▶', '下一帧 (.)');

  /* 倍速 */
  const rateWrap = document.createElement('label');
  rateWrap.className = 'player-rate';
  const rate = document.createElement('select');
  rate.className = 'player-select mono';
  rate.setAttribute('aria-label', '倍速');
  [0.5, 0.75, 1, 1.25, 1.5, 2].forEach((r) => {
    const o = document.createElement('option');
    o.value = String(r);
    o.textContent = `${r}x`;
    if (r === 1) o.selected = true;
    rate.appendChild(o);
  });
  rateWrap.appendChild(rate);

  /* 音量 */
  const volWrap = document.createElement('div');
  volWrap.className = 'player-vol';
  const btnMute = mkBtn('player-mute', '静音/取消静音', '♪');
  const vol = document.createElement('input');
  vol.className = 'player-vol-range';
  vol.type = 'range';
  vol.min = '0';
  vol.max = '100';
  vol.value = '100';
  vol.setAttribute('aria-label', '音量');
  volWrap.appendChild(btnMute);
  volWrap.appendChild(vol);

  const btnShot = mkBtn('player-shot', '截图', '⛶');
  btnShot.title = '截图并保存';
  const btnFull = mkBtn('player-full', '全屏', '⤢');

  const titleEl = document.createElement('span');
  titleEl.className = 'player-title mono';
  if (root.dataset.title) titleEl.textContent = root.dataset.title;

  bar.append(
    btnPlay, tCur, tSep, tDur, seek,
    btnBack, btnPrevF, btnNextF, btnFwd,
    rateWrap, volWrap, btnShot, btnFull,
  );

  /* ---------- range 填充 ----------
     ⚠️ CSS 读不到原生 range 的 value，必须把百分比写进 --fill，
        否则轨道永远是一条灰线 + 一个圆点，看不出播到哪儿 / 音量多大。 */
  const fillRange = (el: HTMLInputElement) => {
    const lo = Number(el.min) || 0;
    const hi = Number(el.max) || 100;
    const v = Number(el.value);
    const pct = hi > lo ? Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100)) : 0;
    el.style.setProperty('--fill', pct.toFixed(2) + '%');
    return pct;
  };
  /* 已缓冲段：--buf 必须 >= --fill，否则渐变 stop 顺序倒过来，CSS 整体失效 */
  const syncBuf = () => {
    if (!video.duration || !video.buffered.length) return;
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime + 0.25) {
        end = Math.max(end, video.buffered.end(i));
      }
    }
    const fill = Number.parseFloat(seek.style.getPropertyValue('--fill')) || 0;
    const buf = Math.min(100, (end / video.duration) * 100);
    seek.style.setProperty('--buf', Math.max(fill, buf).toFixed(2) + '%');
  };
  const syncMute = () => {
    const muted = video.muted || video.volume === 0;
    if (muted) vol.dataset.muted = '1'; else delete vol.dataset.muted;
    btnMute.textContent = muted ? '✕' : '♪';
  };
  fillRange(seek);
  fillRange(vol);
  syncMute();
  video.addEventListener('progress', syncBuf);

  root.appendChild(stage);
  root.appendChild(bar);
  if (root.dataset.title) root.appendChild(titleEl);

  /* ---------- 帧率测量 ----------
     ⚠️ 不能写死 30fps：24/25/30/60 都很常见，写死会让「逐帧」跳 1~2 帧。
     用 requestVideoFrameCallback 在播放时采样 mediaTime 差值取中位数；
     不支持该 API 的浏览器退回 30（Chrome/Edge/Safari 都支持）。 */
  let fpsSamples: number[] = [];
  let lastMedia: number | null = null;
  const rvfc = (video as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  }).requestVideoFrameCallback?.bind(video);
  if (rvfc) {
    const tick = (_now: number, meta: { mediaTime: number }) => {
      if (lastMedia !== null) {
        const d = meta.mediaTime - lastMedia;
        if (d > 0.001 && d < 0.2) {
          fpsSamples.push(d);
          if (fpsSamples.length > 30) fpsSamples.shift();
        }
      }
      lastMedia = meta.mediaTime;
      rvfc(tick);
    };
    rvfc(tick);
  }
  const fps = () => {
    if (fpsSamples.length < 3) return 30;
    const sorted = [...fpsSamples].sort((a, b) => a - b);
    return 1 / sorted[Math.floor(sorted.length / 2)];
  };

  /* ---------- 行为 ---------- */
  let seeking = false;

  const toggle = () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };
  btnPlay.addEventListener('click', toggle);
  big.addEventListener('click', toggle);
  video.addEventListener('click', toggle);

  const syncPlayIcon = () => {
    btnPlay.textContent = video.paused ? '▶' : '❚❚';
    btnPlay.setAttribute('aria-label', video.paused ? '播放' : '暂停');
    big.classList.toggle('is-hidden', !video.paused);
  };
  video.addEventListener('play', syncPlayIcon);
  video.addEventListener('pause', syncPlayIcon);

  video.addEventListener('loadedmetadata', () => {
    tDur.textContent = fmt(video.duration);
    syncBuf();
  });
  video.addEventListener('timeupdate', () => {
    tCur.textContent = fmt(video.currentTime);
    if (!seeking && video.duration) {
      seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
    }
    fillRange(seek);
    syncBuf();
  });
  /* 播完兜底：ended 时 timeupdate 不一定再来一次，别让填充停在半路 */
  video.addEventListener('ended', () => { fillRange(seek); });
  /* ⚠️ 拖动时**实时**跳转（原来只在 change 即松手时才跳）：
     拖的过程中画面不动，用户会以为进度条坏了。 */
  const scrub = () => {
    if (!video.duration) return;
    const t = (Number(seek.value) / 1000) * video.duration;
    tCur.textContent = fmt(t);
    video.currentTime = t;
  };
  seek.addEventListener('input', () => {
    seeking = true;
    fillRange(seek);
    scrub();
  });
  seek.addEventListener('change', () => {
    scrub();
    fillRange(seek);
    seeking = false;
  });
  /* ⚠️ 兜底：input 之后如果没等到 change（触摸取消、指针移出窗口、
     拖到一半松手在元素外），seeking 会永远卡在 true，
     之后 timeupdate 再也不更新滑块位置 —— 进度条彻底僵住。
     所以再挂 pointerup / pointercancel / blur 强制复位。 */
  const endScrub = () => { seeking = false; };
  seek.addEventListener('pointerup', endScrub);
  seek.addEventListener('pointercancel', endScrub);
  seek.addEventListener('blur', endScrub);

  const nudge = (d: number) => {
    if (!video.duration) return;
    video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + d));
  };
  btnBack.addEventListener('click', () => nudge(-5));
  btnFwd.addEventListener('click', () => nudge(5));

  /* 逐帧：暂停后按 1/fps 微调。先 pause 再改 currentTime，
     否则浏览器会在 seek 后继续播，看不出停在了哪一帧。 */
  const frameStep = (dir: number) => {
    video.pause();
    nudge(dir / fps());
  };
  btnPrevF.addEventListener('click', () => frameStep(-1));
  btnNextF.addEventListener('click', () => frameStep(1));

  rate.addEventListener('change', () => {
    video.playbackRate = Number(rate.value);
  });

  vol.addEventListener('input', () => {
    video.volume = Number(vol.value) / 100;
    video.muted = video.volume === 0;
    fillRange(vol);
    syncMute();
  });
  btnMute.addEventListener('click', () => {
    video.muted = !video.muted;
    syncMute();
  });

  /* ---------- 全屏 ----------
     ⚠️ 必须对 root 全屏，不能对 stage：
        控件条 bar 是 stage 的**兄弟节点**（root → [stage, bar]），
        对 stage 全屏的话只有画面进全屏，控件条全被留在屏幕外，
        全屏后就只剩 stage 里那个中央大播放按钮 —— 看起来像
        「除了播放和暂停就没别的东西了」。 */
  const FS: any = document;
  const fsElement = () => FS.fullscreenElement || FS.webkitFullscreenElement || null;
  const fsExit = () => (FS.exitFullscreen || FS.webkitExitFullscreen)?.call(document);

  btnFull.addEventListener('click', () => {
    if (fsElement()) { fsExit(); return; }
    const req = root.requestFullscreen || (root as any).webkitRequestFullscreen;
    if (req) { req.call(root)?.catch?.(() => {}); return; }
    /* iOS Safari：任意元素不允许全屏，只有 <video> 可以。
       走原生全屏会显示系统控件，这是该平台唯一可行的方案。 */
    (video as any).webkitEnterFullscreen?.();
  });

  /* 全屏状态变化时同步按钮图标（Esc 退出、系统手势退出都要跟上） */
  document.addEventListener('fullscreenchange', syncFsIcon);
  document.addEventListener('webkitfullscreenchange', syncFsIcon);
  function syncFsIcon() {
    const on = fsElement() === root;
    btnFull.textContent = on ? '⤡' : '⤢';
    btnFull.title = on ? '退出全屏' : '全屏';
    btnFull.setAttribute('aria-label', on ? '退出全屏' : '全屏');
    /* 进入全屏开始计时；退出全屏必须立刻恢复显示
       （否则回到页面里控件条是透明的，看着像坏了） */
    if (on) poke(); else setIdle(false);
  }

  /* ---------- 全屏时控件条自动隐藏 ----------
     鼠标静止 IDLE_MS 后淡出，一动就回来（YouTube 那套）。
     ⚠️ 只在「全屏 + 播放中」生效：
        - 非全屏时控件条本来就在页面里常驻，自动隐藏反而让人找不到
        - 暂停时必须保持显示，否则用户看不到任何控件、也点不到播放 */
  const IDLE_MS = 2500;
  let idleTimer: any = 0;
  const setIdle = (v: boolean) => {
    if (v === root.classList.contains('is-idle')) return;
    root.classList.toggle('is-idle', v);
  };
  /* 鼠标停在控件条上时重新计时而不是隐藏 ——
     否则正在拖音量 / 挑倍速时条会突然消失 */
  const hoveringBar = () => !!root.querySelector('.player-bar:hover');
  const schedule = () => {
    clearTimeout(idleTimer);
    if (fsElement() !== root || video.paused) { setIdle(false); return; }
    idleTimer = setTimeout(() => {
      if (hoveringBar()) { schedule(); return; }
      setIdle(true);
    }, IDLE_MS);
  };
  const poke = () => { setIdle(false); schedule(); };

  /* 触摸设备上 mousemove 不一定触发，所以 pointermove / touchstart 都要听 */
  ['mousemove', 'pointermove', 'pointerdown', 'touchstart', 'wheel'].forEach((ev) => {
    root.addEventListener(ev, poke, { passive: true });
  });
  root.addEventListener('keydown', poke);
  /* is-idle 时控件条 pointer-events:none，但键盘仍可达 —— Tab 进来要恢复显示 */
  root.addEventListener('focusin', poke);
  video.addEventListener('play', () => { setIdle(false); schedule(); });
  video.addEventListener('pause', () => setIdle(false));
  video.addEventListener('ended', () => setIdle(false));

  syncFsIcon();

  btnShot.addEventListener('click', () => capture(video, root));

  /* 键盘：← → 快退快进，, . 逐帧，空格播放暂停。
     ⚠️ 只在焦点在播放器内时生效，否则会抢走整页的滚动/翻页快捷键。 */
  root.tabIndex = 0;
  root.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'SELECT' || tag === 'INPUT') return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-5); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(5); }
    else if (e.key === ',') { e.preventDefault(); frameStep(-1); }
    else if (e.key === '.') { e.preventDefault(); frameStep(1); }
  });

  syncPlayIcon();
  if (!video.paused) big.classList.add('is-hidden');
}

/* ---------- 截图：弹窗预览 → 选保存位置 ---------- */
function capture(video: HTMLVideoElement, root: HTMLElement) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(video, 0, 0, w, h);

  canvas.toBlob((blob) => {
    if (!blob) return;
    showShotDialog(blob, canvas.toDataURL('image/png'), root, w, h);
  }, 'image/png');
}

function showShotDialog(blob: Blob, dataUrl: string, root: HTMLElement, w: number, h: number) {
  /* 复用已有的弹出层样式，避免再写一套 CSS */
  const mask = document.createElement('div');
  mask.className = 'shot-mask';
  const box = document.createElement('div');
  box.className = 'shot-box';

  const img = document.createElement('img');
  /* 用户主动导出的产物，不进资源防护层（见 assetGuard.ts 的 data-guard-off） */
  img.setAttribute('data-guard-off', '');
  img.src = dataUrl;
  img.alt = '截图预览';
  img.style.width = '100%';

  const info = document.createElement('div');
  info.className = 'shot-info mono';
  /* ⚠️ 用 video 的 videoWidth/Height，不要用 img.naturalWidth：
     img 刚插入 DOM 时还没 load 完，naturalWidth 是 0（实测显示「 × 」）。 */
  info.textContent = `${w} × ${h} · ${(blob.size / 1024).toFixed(0)} KB`;

  const row = document.createElement('div');
  row.className = 'shot-row';

  const save = document.createElement('button');
  save.className = 'term-btn';
  save.type = 'button';
  save.textContent = '> 选择保存位置_';

  const close = document.createElement('button');
  close.className = 'term-btn';
  close.type = 'button';
  close.textContent = '> 关闭_';

  row.append(save, close);
  box.append(img, info, row);
  mask.appendChild(box);
  document.body.appendChild(mask);

  const done = () => mask.remove();
  mask.addEventListener('click', (e) => e.target === mask && done());
  close.addEventListener('click', done);
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') {
      done();
      document.removeEventListener('keydown', esc);
    }
  });

  save.addEventListener('click', async () => {
    /* File System Access API：真正的「选择保存位置」对话框（Chrome / Edge）。
       ⚠️ 必须在用户手势里调用，所以不能提前 await。 */
    /* ⚠️ 这里的类型断言横跨 6 行、含两层嵌套 <>，
       TS→JS 的转换脚本很难正确剥离，所以改成先取到 any 再点属性。 */
    const picker = (window as unknown as Record<string, unknown>).showSaveFilePicker;

    if (picker) {
      try {
        const handle = await picker({
          suggestedName: `frame-${Date.now()}.png`,
          types: [{ description: 'PNG 图片', accept: { 'image/png': ['.png'] } }],
        });
        const wtr = await handle.createWritable();
        await wtr.write(blob);
        await wtr.close();
        done();
        flash(root, '已保存');
        return;
      } catch (e) {
        /* 用户取消（AbortError）就静默返回；其他错误退回下载 */
        if ((e as Error)?.name === 'AbortError') return;
      }
    }
    /* 兜底：不支持该 API 的浏览器直接下载到默认目录 */
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `frame-${Date.now()}.png`;
    a.click();
    done();
    flash(root, '已下载（浏览器不支持选择保存位置）');
  });
}

function flash(root: HTMLElement, text: string) {
  const el = document.createElement('div');
  el.className = 'player-flash mono';
  el.textContent = text;
  root.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}
