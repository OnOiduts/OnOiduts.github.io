/**
 * 自定义音频播放器  +  MIDI 播放器（数据感风格）
 *
 * 两种：
 *   ① 音频文件（mp3 / wav / ogg / flac…）→ 直接给 <audio>，套自定义控件
 *   ② MIDI（.mid / .midi）→ 浏览器**没有**原生 MIDI 播放能力，
 *      这里解析 MIDI 文件后用 Web Audio 实时合成发声。
 *
 * MIDI 部分的实现取舍（重要）：
 *   - 解析标准 MIDI 文件（format 0/1）：VLQ、tempo map、running status、
 *     note on/off 配对算时长、program change 决定音色
 *   - **旋律：三个振荡器叠加谐波**（基频 + 2 次 + 3 次），各带失谐 cents，
 *     再过低通 + ADSR + release。单振荡器太干瘪，这是 v2 的主要改动。
 *   - **打击乐（channel 9）：白噪声 + 带通 + 基频正弦**，按音高区分
 *     底鼓 / 军鼓 / 嗵鼓 / 闭镲 / 开镲 / 吊镲。纯噪声的鼓没有音高感，
 *     所以额外叠一个低频正弦（底鼓尤其明显）。
 *   - **混响**：算法生成脉冲响应（指数衰减噪声 + 12ms 预延迟）走 ConvolverNode
 *   - **压缩器**：和弦叠起来容易削波爆音，必须加
 *   - 力度走指数曲线（1.5 次幂），线性会让轻音太响、响音不突出
 *
 * 仍然是近似模拟，不是真实音源 —— 但比 v1（单振荡器、无混响）厚实得多。
 * 不处理 pitch bend / aftertouch / 复杂 controller（影响很小）。
 */

/* 原生 range 的 CSS 读不到 value，把「已填充」百分比写进 --fill。
   用 function 声明而不是 const：本文件很大，避免调用点早于定义触发 TDZ。 */
function fillAudioRange(el: HTMLInputElement): void {
  const lo = Number(el.min) || 0;
  const hi = Number(el.max) || 1;
  const v = Number(el.value);
  const pct = hi > lo ? Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100)) : 0;
  el.style.setProperty('--fill', pct.toFixed(2) + '%');
}

const fmt = (t: number) => {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/* ══════════════════════════════════════════════════════════════
   频谱可视化（本轮新增）
   ══════════════════════════════════════════════════════════════
   音频条里插一块 canvas，播放时实时画柱状频谱。
   本地音频和 MIDI 共用同一套绘制逻辑，只是取数路径不同：

     · 本地音频：<audio> → MediaElementSource → analyser → destination
       ⚠️ 这条路会把声音接管到 Web Audio，若 ctx 没 resume 成功就会**完全没声**，
       所以做了兜底（见 attachSpec 里的 setTimeout）。
     · MIDI：outTrim → analyser（旁路，不改变信号，不影响音质）

   性能：fftSize 128（64 bin）只画 24 根柱；只在**播放时**跑 rAF，
   暂停立刻 cancel，不空转；log 分组（低频窄高频宽）符合听感。
   ══════════════════════════════════════════════════════════════ */
const SPEC_BARS = 24;

/** MIDI 输出取样点（outTrim），供频谱旁路挂载 */
let midiTap: AudioNode | null = null;

function makeSpectrum(root: HTMLElement) {
  const cv = document.createElement('canvas');
  cv.className = 'audio-spec';
  cv.width = SPEC_BARS * 4;
  cv.height = 26;
  cv.setAttribute('aria-hidden', 'true');
  const g = cv.getContext('2d');
  let analyser: AnalyserNode | null = null;
  let buf: Uint8Array | null = null;
  let raf = 0;
  /* ⚠️ 本轮修：频谱绘制原来是**每帧 getComputedStyle** —— 这是强制样式重算，
     在 CPU 被其它软件占用时很贵。实测 profiling 里 draw 的自身耗时
     是 pump 的 2.5 倍（18 vs 7 个采样），频谱反而成了主线程最大的一块。
     主题色几乎不变，缓存起来即可（start 时读一次，主题切换由 CSS 变量驱动
     的重绘另行触发）。 */
  let acc = '#7cc4ff';
  /* ⚠️ 本轮新增：频谱降到 ~30fps。它是装饰，60fps 毫无必要，
     省下的主线程时间直接让给真正影响听感的 pump。 */
  let frame = 0;

  /* ══════════════════════════════════════════════════════════
     ⚠️ 本轮新增：暂停时频谱「过渡下落」，不再瞬间蒸发
     ══════════════════════════════════════════════════════════
     原来 stop() = cancelAnimationFrame + clearRect → 柱子**一帧内消失**，
     视觉上很「干」，像被硬切掉。

     ⚠️ 关键：**不能靠继续读 analyser 来做衰减**。
     暂停后信号中断，getByteFrequencyData 立刻返回全 0，
     柱子会「啪」一下掉到底 —— 和 clearRect 一样干，只是晚一帧。
     （实测：暂停后第一帧数据就是全 0。）

     所以自己维护一份柱高快照 levels[]，stop 时以它为基准做时间插值衰减。

     另外每根柱**独立衰减速度**：低频拖尾长、高频掉得快。
     真实频谱的能量释放就是这样（低频共鸣持续、高频瞬态先衰减），
     统一速度会看着像「整体平移」，不像自然下落。 */
  const SPEC_FADE_MS = 460;
  /* ⚠️ 淡入比淡出短：起来要跟手（260ms），落下才需要拖尾。
     和淡出共用 fadeBase 做插值起点 —— 淡出中途又点播放时，
     从**当前残留高度**接着升，不会先掉下去再起来（那样会闪一下）。 */
  const SPEC_RISE_MS = 260;
  const levels = new Float32Array(SPEC_BARS);
  const fadeBase = new Float32Array(SPEC_BARS);
  let mode = 0;            // 0 = 停  1 = 实时  2 = 淡出
  let fadeT0 = 0;

  const paint = () => {
    if (!g) return;
    const H = cv.height;
    g.clearRect(0, 0, cv.width, H);
    g.fillStyle = acc;
    for (let i = 0; i < SPEC_BARS; i++) {
      const m = levels[i];
      if (m <= 0.006) continue;      // 低于阈值就不画，避免残留 1px 底
      const h = Math.max(1, m * H);
      g.globalAlpha = 0.30 + 0.70 * m;
      g.fillRect(i * 4, H - h, 3, h);
    }
    g.globalAlpha = 1;
  };

  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (++frame & 1) return;
    if (mode === 1) {
      if (!analyser || !buf || !g) return;
      analyser.getByteFrequencyData(buf);
      const n = buf.length;
      /* 淡入进度：smoothstep，起点是 fadeBase（start 那一刻的柱高） */
      const el = performance.now() - fadeT0;
      const p = Math.min(1, el / SPEC_RISE_MS);
      const e = p * p * (3 - 2 * p);
      for (let i = 0; i < SPEC_BARS; i++) {
        const lo = Math.floor(Math.pow(n, i / SPEC_BARS)) - 1;
        const hi = Math.max(lo + 1, Math.floor(Math.pow(n, (i + 1) / SPEC_BARS)) - 1);
        let m = 0;
        for (let k = Math.max(0, lo); k < Math.min(n, hi); k++) if (buf[k] > m) m = buf[k];
        const tgt = m / 255;
        /* ⚠️ 恢复播放的开头，解码缓冲还没吐出声音 → tgt 接近 0。
           若照常插值，柱子会**先猛掉再升**，看着闪一下。
           所以「往下走」只给 12% 的速度（上升到正常速度），
           等声音出来 tgt 抬上去，自然跟着升。 */
        const step = tgt >= fadeBase[i] ? e : e * 0.12;
        levels[i] = p >= 1 ? tgt : fadeBase[i] + (tgt - fadeBase[i]) * step;
      }
      paint();
    } else if (mode === 2) {
      const el = performance.now() - fadeT0;
      let alive = false;
      for (let i = 0; i < SPEC_BARS; i++) {
        /* 低频 0.55×时长起步（掉得快、收得早）…… 实际反过来：
           i 越大频率越高 → 让它**先落**，低频拖到最后 */
        const dur = SPEC_FADE_MS * (1.0 - 0.45 * (i / (SPEC_BARS - 1)));
        const p = Math.min(1, el / dur);
        levels[i] = fadeBase[i] * Math.pow(1 - p, 1.6);
        if (levels[i] > 0.006) alive = true;
      }
      paint();
      if (!alive || el > SPEC_FADE_MS * 1.4) {
        mode = 0;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        levels.fill(0);
        if (g) g.clearRect(0, 0, cv.width, cv.height);
      }
    }
  };

  const startLoop = () => { if (!raf) { frame = 0; raf = requestAnimationFrame(loop); } };

  return {
    canvas: cv,
    attach: (ctx: AudioContext, node: AudioNode, passthrough: boolean) => {
      if (analyser) return;
      analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.72;
      buf = new Uint8Array(analyser.frequencyBinCount);
      node.connect(analyser);
      if (passthrough) analyser.connect(ctx.destination);
    },
    /** 兜底：把已接管的音频直接接回 destination（放弃频谱，保住声音） */
    bypass: (ctx: AudioContext, node: AudioNode) => {
      try { node.disconnect(); node.connect(ctx.destination); } catch (e) { /* 忽略 */ }
    },
    start() {
      if (!analyser) return;
      /* ⚠️ 已经在播：不要重置淡入计时，否则每帧调用都会「从头再长一遍」 */
      if (mode === 1) return;
      /* 主题色在这里读一次（而不是每帧） */
      const st = getComputedStyle(root);
      acc = (st.getPropertyValue('--accent') || '').trim() || '#7cc4ff';
      /* 起点 = 当前柱高：淡出中途恢复播放时接着升，不闪 */
      fadeBase.set(levels);
      fadeT0 = performance.now();
      mode = 1;
      startLoop();
    },
    /* ⚠️ 停的时候走淡出，不再一帧清空：
       淡出期间 rAF 继续跑（约 460ms），落完自动停并 clear。
       从未播过 / 柱子本来就空 → 直接清，不空转。 */
    stop() {
      if (mode === 0) { if (g) g.clearRect(0, 0, cv.width, cv.height); return; }
      let any = false;
      for (let i = 0; i < SPEC_BARS; i++) if (levels[i] > 0.006) { any = true; break; }
      if (!any) {
        mode = 0;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (g) g.clearRect(0, 0, cv.width, cv.height);
        return;
      }
      fadeBase.set(levels);
      fadeT0 = performance.now();
      mode = 2;
      startLoop();
    },
  };
}

export function initAudios() {
  /* ⚠️ 幂等：initUI() 若被重复调用（页面切换 / View Transitions），
     没有这个标记会在同一个容器里再塞一整套控件。
     实测重复调用 3 次 → 音频条子元素从 7 个变成 28 个（4 套控件叠在一起）。 */
  document.querySelectorAll<HTMLElement>('.audio-player').forEach((el) => {
    if (el.dataset.audioBuilt) return;
    el.dataset.audioBuilt = '1';
    buildAudio(el);
  });
  /* ⚠️ 顺序：先 audio-player 再 midi-player。
     反过来会漏 —— 因为 midi 容器 class 是 "player midi-player"，
     如果先跑 midi 分支，buildMidi 里若改了 class 就会影响后续匹配。 */
  document.querySelectorAll<HTMLElement>('.midi-player').forEach((el) => {
    if (el.dataset.audioBuilt) return;
    el.dataset.audioBuilt = '1';
    buildMidi(el);
  });
}

/* ══════════════════════════════════════════════════════════
   ① 音频文件播放器
   ══════════════════════════════════════════════════════════ */
function buildAudio(root: HTMLElement) {
  const src = root.dataset.src || '';
  if (!src) return;
  const title = root.dataset.title || '';

  const audio = document.createElement('audio');
  audio.src = src;
  audio.preload = 'metadata';

  /* ⚠️ 音频是**一条播放条**，不是视频播放器那种大块：
     单行 flex，所有控件横排，高度固定 40px。
     之前做成 head + bar 两行（像视频播放器），太重了。 */
  const play = document.createElement('button');
  play.className = 'audio-btn audio-play';
  play.type = 'button';
  play.setAttribute('aria-label', '播放');
  play.textContent = '\u25b6';

  const t = document.createElement('span');
  t.className = 'audio-title';
  t.textContent = title || src.split('/').pop() || '音频';

  const seek = document.createElement('span');
  seek.className = 'audio-seek';
  const fill = document.createElement('i');
  seek.appendChild(fill);

  /* 时间合并成一个 0:00 / 3:00，比两个独立 span 省一半宽度 */
  /* ⚠️ 时间拆成 <b>当前</b> + <i>/ 总时长</i> 两段：
     完整形态太占宽度（实测 94px），窄容器会把标题挤成「背..」。
     窄屏 CSS 里把 i 隐藏，省下的宽度给标题。 */
  const time = document.createElement('span');
  time.className = 'mono audio-time';
  const tCur = document.createElement('b');
  tCur.textContent = '0:00';
  const tDur = document.createElement('i');
  tDur.textContent = ' / 0:00';
  time.append(tCur, tDur);

  const rate = document.createElement('button');
  rate.className = 'mono audio-btn audio-rate';
  rate.type = 'button';
  rate.textContent = '1\u00d7';
  rate.title = '倍速';
  rate.setAttribute('aria-label', '倍速');
  const RATES = [0.75, 1, 1.25, 1.5, 2];
  let ri = 1;
  rate.onclick = () => {
    ri = (ri + 1) % RATES.length;
    audio.playbackRate = RATES[ri];
    rate.textContent = `${RATES[ri]}\u00d7`;
  };

  const vol = document.createElement('input');
  vol.type = 'range';
  vol.className = 'audio-vol';
  vol.min = '0';
  vol.max = '1';
  vol.step = '0.01';
  vol.value = '1';
  vol.setAttribute('aria-label', '音量');
  vol.oninput = () => { audio.volume = Number(vol.value); fillAudioRange(vol); };
  fillAudioRange(vol);

  /* 单行横排：播放 · 标题 · 进度 · 频谱 · 时间 · 倍速 · 音量 */
  const spec = makeSpectrum(root);

  root.className = 'audio-player';
  /* 频谱放在**时间码前面**（紧跟其后形成「动态 + 时间」一组）：
     原来夹在标题和进度条之间，离时间码太远，视觉上像独立浮块。
     放这里还顺带不挤标题（标题 flex 0 0 auto），窄屏 CSS 里整块隐藏。 */
  root.append(play, t, seek, spec.canvas, time, rate, vol, audio);

  /* 本地音频必须走 Web Audio 才能取频谱。懒创建（首个用户手势里建）。 */
  let sctx: AudioContext | null = null;
  let msrc: MediaElementAudioSourceNode | null = null;
  const attachSpec = () => {
    if (sctx) return;
    try {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      sctx = new AC();
      msrc = sctx.createMediaElementSource(audio);
      spec.attach(sctx, msrc, true);
    } catch (e) { sctx = null; msrc = null; }
  };

  /* ── 事件 ── */
  const setPlayIcon = () => { play.textContent = audio.paused ? '\u25b6' : '\u275a\u275a'; play.setAttribute('aria-label', audio.paused ? '播放' : '暂停'); };

  play.onclick = () => {
    if (audio.paused) {
      attachSpec();
      if (sctx && sctx.state === 'suspended') sctx.resume().catch(() => {});
      audio.play().catch(() => flash(root, '播放失败'));
      spec.start();
      /* 兜底：300ms 后 ctx 还没跑起来 → 被自动播放策略挡了。
         此时音频经 Web Audio 会**完全无声**，直接接回 destination 保住声音，
         代价是频谱不显示。宁可没频谱，也不能没声音。 */
      setTimeout(() => {
        if (sctx && sctx.state !== 'running' && msrc) { spec.bypass(sctx, msrc); spec.stop(); }
      }, 300);
    } else { audio.pause(); spec.stop(); }
  };

  audio.addEventListener('play', setPlayIcon);
  audio.addEventListener('pause', setPlayIcon);
  /* ⚠️ 自然播放结束也要淡出：原来只复位图标和时间，
     频谱会停在最后一帧（rAF 还在跑但信号已是 0），看着像卡住。 */
  audio.addEventListener('ended', () => { setPlayIcon(); audio.currentTime = 0; spec.stop(); });

  let dur = 0;
  const syncTime = () => {
    tCur.textContent = fmt(audio.currentTime);
    tDur.textContent = ` / ${fmt(dur)}`;
    if (dur) fill.style.width = `${(audio.currentTime / dur) * 100}%`;
  };
  audio.addEventListener('loadedmetadata', () => {
    dur = audio.duration || 0;
    syncTime();
  });
  audio.addEventListener('timeupdate', syncTime);

  const toTime = (e: PointerEvent) => {
    const r = seek.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (audio.duration) audio.currentTime = p * audio.duration;
  };
  let dragging = false;
  /* ⚠️ setPointerCapture 在「非真实指针」场景下会抛 NotFoundError
     （合成事件、部分浏览器、指针已释放）。抛错会让后面的 toTime(e) **不执行**
     → 进度条点了没反应。用 try/catch 兜住，保证定位一定发生。 */
  seek.addEventListener('pointerdown', (e) => { dragging = true; try { seek.setPointerCapture(e.pointerId); } catch (_) {} toTime(e); });
  seek.addEventListener('pointermove', (e) => { if (dragging) toTime(e); });
  seek.addEventListener('pointerup', (e) => { dragging = false; try { seek.releasePointerCapture(e.pointerId); } catch (_) {} });

  /* 空格键：只在焦点落在本播放器内时生效，避免抢页面滚动 */
  root.tabIndex = 0;
  root.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); play.click(); }
  });
}

function flash(root: HTMLElement, text: string) {
  const el = document.createElement('span');
  el.className = 'player-flash mono';
  el.textContent = text;
  root.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}

/* ══════════════════════════════════════════════════════════
   ② MIDI：解析 + Web Audio 合成
   ══════════════════════════════════════════════════════════ */

interface Note {
  time: number;      // 秒
  note: number;      // 0-127
  vel: number;       // 0-127
  dur: number;       // 秒
  ch: number;
  prog: number;
  /* ── 表情（从 CC / pitch bend 采样而来） ── */
  vol: number;       // 通道音量 × 表情，0~1
  pan: number;       // 声像 -1(左) ~ 1(右)
  bend: number;      // 弯音，半音数（可为负）
  mod: number;       // 调制轮 0~1 → 颤音深度
  pedal: boolean;    // 是否被延音踏板延长
  /* ── 本轮新增的表情（原先解析器收了却没用） ── */
  bright: number;    // CC74 滤波截止（0~1，默认 .5）→ 音色明暗
  reso: number;      // CC71 谐振（0~1）→ 低通 Q
  revSend: number;   // CC91 混响送出（0~1，默认 .5）
  choSend: number;   // CC93 合唱送出（0~1，默认 .5）
  aft: number;       // 触后压力 0~1（复音 0xA0 / 通道 0xD0）→ 颤音 + 亮度
  glide: number;     // 滑音时长（秒，CC5 × CC65）→ 起音端口amento
  bendRange: number; // RPN 弯音音域（半音，默认 2）
  /** 起音瞬间同时发声的音符数（和弦补偿用，解析期静态算出）。
      可选：音符创建处不填，由 assignConcurrency 统一赋值。 */
  /** ⚠️ 声部角色（本轮新增）：同一「同时发声组」内按音高从高到低排序的序号。
      0 = 组内最高音 → 旋律；1..n = 内声部（和弦音 / 低音）。
      grp = 该组的大小。由 assignConcurrency 统一赋值。 */
  rank?: number;
  grp?: number;
  conc?: number;
  /** 同通道内同时发声的音符数（用于和弦角色判定） */
  voices?: number;
  /** ⚠️ 打击乐时间密度（本轮新增）：最近 1 秒内**同鼓件组**的击打数。
      由 smoothDrumRate 解析期赋值。 */
  drate?: number;
  /** ★ 声部角色（本轮新增）：由 assignRoles 按「轨道名 → GM 约定 → 音色族
      → 音高启发式」投票判定，代表**原作者写这条轨时的意图**。
      ROLE_MEL / ROLE_BASS / ROLE_DRUM / ROLE_CHORD / ROLE_PAD。 */
  role?: number;
}

interface CCEv { t: number; v: number }
/* ⚠️ 必须保持**单行**：strip_ts 的多行 interface 删除正则是
   `^interface \w+ \{.*?^\}`（非贪婪跨行）。一旦写成多行，且最后一行不是
   顶格 `}`，它会一直吃到**后面第一个顶格 `}`** —— 实测把 readVLQ 整个函数
   一起删掉了（报 readVLQ is not defined），且没有语法错误提示。 */
interface MidiData { notes: Note[]; duration: number; bpm: number; bpmVaries: boolean; roles: { ch: number; role: number; name: string }[] }
interface PedEv { t: number; on: boolean }

/** 读变长量（VLQ）
    ⚠️ 不写返回类型注解 `[number, number]`：strip_ts 处理不了元组返回类型，
       会把整个函数定义**删掉**（实测报 readVLQ is not defined）。 */
function readVLQ(d: Uint8Array, p: number) {
  let v = 0, i = p;
  for (;;) {
    const b = d[i++];
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return [v, i];
}

/**
 * 解析标准 MIDI 文件（format 0 / 1）
 * 返回 { notes, duration, programs }
 */
function parseMidi(buf: ArrayBuffer) {
  const d = new Uint8Array(buf);
  const str = (p: number) => String.fromCharCode(d[p], d[p + 1], d[p + 2], d[p + 3]);
  const u32 = (p: number) => (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
  const u16 = (p: number) => (d[p] << 8) | d[p + 1];

  if (str(0) !== 'MThd') throw new Error('不是 MIDI 文件（缺 MThd）');
  const hlen = u32(4);
  const division = u16(12);
  const isSMPTE = !!(division & 0x8000);
  const ppq = isSMPTE ? 480 : division & 0x7fff;   // 每四分音符的 tick 数

  /* 把所有轨道的绝对 tick 事件并到一起，按时间排序后再算 tempo */
  type Ev = { t: number; type: number; a: number; b: number; ch: number; meta?: number; data?: number[] };
  const evs: Ev[] = [];

  /* ══════════════════════════════════════════════════════════════
     ⚠️ 本轮新增：轨道元信息（作者意图的第一手证据）
     ══════════════════════════════════════════════════════════════
     原来所有轨道的事件被**并进一个 evs 数组**，轨道归属彻底丢失——
     于是只能靠「通道号 = 9 就是鼓」这类 GM 约定来猜声部。

     真实文件里这不够用：
       · 鼓不一定在 9 轨（XG/GS、部分游戏 MIDI、手机铃声转制）
       · 贝斯可能用非贝斯音色（合成器 Bass、甚至钢琴低音区）
       · 一条轨道里可能同时有和弦和旋律
     作者**写在轨道名里**（FF 03 / FF 04）的意图，是最可靠的信号，
     比任何音高启发式都准。所以这里先把轨道名和该轨道用到的通道记下来。 */
  const tracks: { name: string; chans: Set<number> }[] = [];

  let p = 8 + hlen;
  while (p + 8 <= d.length) {
    const id = str(p);
    if (id !== 'MTrk') { p += 8 + u32(p + 4); continue; }
    const len = u32(p + 4);
    const end = p + 8 + len;
    let q = p + 8;
    let abs = 0;
    let running = 0;
    /* 本轨道：名字（FF03 轨道名 / FF04 乐器名）+ 用到的通道 */
    const trk = { name: '', chans: new Set<number>() };
    tracks.push(trk);

    while (q < end) {
      let [dt, i] = readVLQ(d, q);
      abs += dt;
      q = i;
      let st = d[q];
      if (st & 0x80) { running = st; q++; } else { st = running; }

      if (st === 0xff) {
        const meta = d[q++];
        const [ml, mi] = readVLQ(d, q);
        const data = Array.from(d.slice(mi, mi + ml));
        evs.push({ t: abs, type: 0xff, a: 0, b: 0, ch: 0, meta, data });
        /* 轨道名（0x03）优先；没有就用乐器名（0x04）。
           两者都可能有，取先到的那个（轨道名通常在最前面）。 */
        if ((meta === 0x03 || meta === 0x04) && !trk.name) {
          /* ⚠️ 真 bug（修过）：原来用 String.fromCharCode(...data) ——
             那是把**每个字节当成一个 Unicode 码点**，中文轨道名会变成
             「å å¼¦」这种乱码，于是中文关键词（和弦/主旋律/贝斯）
             **永远匹配不上**，判定静默退回默认（旋律）。
             实测 role_pad_chord.mid 的「和弦」轨就被判成了旋律。
             必须用 TextDecoder 按 UTF-8 解码；出现替换字符再退回 Latin-1
             （老 MIDI 常用 Latin-1 / Shift-JIS，UTF-8 解不开时别丢掉名字）。 */
          const bytes = Uint8Array.from(data);
          let nm = '';
          try { nm = new TextDecoder('utf-8').decode(bytes); } catch (e) { nm = ''; }
          if (nm.indexOf('\ufffd') >= 0) nm = String.fromCharCode(...data);
          nm = nm.replace(/\0/g, '').trim();
          if (nm) trk.name = nm;
        }
        q = mi + ml;
      } else if (st === 0xf0 || st === 0xf7) {
        const [sl, si] = readVLQ(d, q + 1);
        q = si + sl;
      } else {
        const hi = st & 0xf0;
        const ch = st & 0x0f;
        /* 只记真正发声的通道（note-on 且力度 > 0），
           避免把「只改了音色/音量」的通道也算进该轨道 */
        if (hi === 0x90 && d[q + 1] > 0) trk.chans.add(ch);
        if (hi === 0xc0 || hi === 0xd0) {
          const a = d[q++];
          evs.push({ t: abs, type: hi, a, b: 0, ch });
        } else {
          const a = d[q++], b = d[q++];
          evs.push({ t: abs, type: hi, a, b, ch });
        }
      }
    }
    p = end;
  }

  /* ── SMPTE 时基（division 高位为 1）：时间不受 tempo 影响 ── */
  let smpteRate = 0;   // 秒 / tick，>0 表示 SMPTE
  if (isSMPTE) {
    const fps = 256 - ((division >> 8) & 0xff);   // 24 / 25 / 29 / 30
    const tpf = division & 0xff;
    if (fps > 0 && tpf > 0) smpteRate = 1 / (fps * tpf);
  }

  /* tempo map
     ⚠️ 致命 bug（修过）：原来写死 `[{ t: 0, uspq: 500000 }]` 再 push 文件的 tempo。
     而**绝大多数 MIDI 的 tempo 事件就在 tick 0**，于是列表变成
     [{t:0, 默认120BPM}, {t:0, 真实BPM}]，预计算循环里 `if (tp.t <= 0) continue`
     **把真实 tempo 也一起跳过了** → 所有曲子一律按 120 BPM 播放。

     实测：160 BPM 的曲子会被按 120 播放（慢 25%），时长也全错。 */
  const rawTempos: { t: number; uspq: number }[] = [];
  for (const e of evs) if (e.type === 0xff && e.meta === 0x51 && e.data?.length === 3) {
    rawTempos.push({ t: e.t, uspq: (e.data[0] << 16) | (e.data[1] << 8) | e.data[2] });
  }
  rawTempos.sort((a, b) => a.t - b.t);
  /* 同一 tick 保留**最后**一个（后写的覆盖先写的） */
  const tempos: { t: number; uspq: number }[] = [];
  for (const tp of rawTempos) {
    const last = tempos[tempos.length - 1];
    if (last && last.t === tp.t) tempos[tempos.length - 1] = tp; else tempos.push(tp);
  }
  /* 没有 tempo 事件 → 用标准 120 BPM；第一个 tempo 不在 0 → 从 0 补一段默认 */
  if (!tempos.length) tempos.push({ t: 0, uspq: 500000 });
  else if (tempos[0].t > 0) tempos.unshift({ t: 0, uspq: 500000 });

  /* ⚠️ 性能 bug（修过）：原来每个音符都从头遍历一遍 tempo 列表 → O(音符数 × tempo 数)。
     长曲（上万音符 + 若干 tempo）解析会明显卡顿，甚至让页面假死。
     改成**预计算每个 tempo 起点对应的累计秒数**，查询时二分 —— O(log n)。 */
  const tpTick: number[] = [];
  const tpSec: number[] = [];
  const tpRate: number[] = [];
  {
    let sec = 0;
    for (let i = 0; i < tempos.length; i++) {
      const tp = tempos[i];
      if (i > 0) {
        const prev = tempos[i - 1];
        sec += ((tp.t - prev.t) / ppq) * (prev.uspq / 1e6);
      }
      tpTick.push(tp.t); tpSec.push(sec);
      tpRate.push((tp.uspq / 1e6) / ppq);   // 段 i 起用 tempo[i]
    }
  }

  /** tick → 秒（二分 + 段内线性插值） */
  const tickToSec = (tick: number) => {
    if (tick <= 0) return 0;
    if (smpteRate) return tick * smpteRate;   // SMPTE：与 tempo 无关
    let lo = 0, hi = tpTick.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tpTick[mid] <= tick) lo = mid; else hi = mid - 1;
    }
    return tpSec[lo] + (tick - tpTick[lo]) * tpRate[lo];
  };

  /** BPM（用于显示）：多 tempo 时取第一个 */
  const bpm = Math.round(60e6 / tempos[0].uspq);
  const bpmVaries = tempos.length > 1;

  /* program per channel */
  const prog = new Array(16).fill(0);
  /* ⚠️ 原来的排序 `(a.type === 0xc0 ? -1 : 0)` 只判断了 a 没判断 b，
     同一 tick 上 program change 和 note-on 谁先**不确定**（不稳定排序）。
     长曲里 program 排错 → 整段音色不对。
     现在按明确优先级：program change(0) < note-on(1) < note-off(2)，
     保证「先设音色，再发音；同刻先关后开」。 */
  const rank = (e: Ev) => (e.type === 0xc0 ? 0 : (e.type === 0x90 && e.b > 0) ? 1 : 2);
  const evsS = [...evs].sort((a, b) => a.t - b.t || rank(a) - rank(b));

  /* note on → 配对 note off
     ⚠️ 真 bug（修过）：原来用 Map<"ch:note", Note>，同一个音在没收到
        note-off 时又来一个 note-on（真实 MIDI 很常见：延音踏板、缺失
        note-off、同一音重叠），前一个会被**直接覆盖丢弃**，永远进不了 notes。
        短曲看不出来，长曲音符多 → 大量音符凭空消失，听起来断断续续。
        改成**数组栈**，每个 note-on 独立入栈，note-off 弹出最早的那个。 */
  const open = new Map<string, Note[]>();
  const notes: Note[] = [];
  let maxT = 0;

  for (const e of evsS) {
    if (e.type === 0xc0) { prog[e.ch] = e.a; continue; }
    if (e.type === 0x90 && e.b > 0) {
      const n: Note = { time: tickToSec(e.t), note: e.a, vel: e.b, dur: 0.25, ch: e.ch, prog: prog[e.ch],
                        vol: 1, pan: 0, bend: 0, mod: 0, pedal: false };
      const k = `${e.ch}:${e.a}`;
      const arr = open.get(k);
      if (arr) arr.push(n); else open.set(k, [n]);
    } else if (e.type === 0x80 || (e.type === 0x90 && e.b === 0)) {
      const k = `${e.ch}:${e.a}`;
      const arr = open.get(k);
      if (arr && arr.length) {
        /* 弹出最早的（FIFO）—— 与 note-on 顺序一致 */
        const n = arr.shift() as Note;
        n.dur = Math.max(0.03, tickToSec(e.t) - n.time);
        notes.push(n);
        if (!arr.length) open.delete(k);
      }
    }
  }
  /* 没配到 note off 的补一个默认时长（栈里可能有多个）
     ⚠️ 原来写死 0.25 秒。慢曲（60 BPM 一拍 1 秒）上所有丢 off 的音符
     都变成**短促的断音**，和正常音符完全不是一个织体，听起来像随机漏音。
     改成按该音符所在时刻的**一拍**时长（用 tempo 反推），与周围音符一致。 */
  for (const arr of open.values()) for (const n of arr) {
    n.dur = Math.max(0.12, Math.min(2, (tempos[0].uspq / 1e6)));
    notes.push(n);
  }


  notes.sort((a, b) => a.time - b.time);

  /* ══════════════════════════════════════════════════════════
     表情后处理：CC 与 pitch bend
     ⚠️ 这些数据解析器**一直都收集了**（evs 里有 0xb0 / 0xe0），
     但从来没被使用 —— 所以所有通道音量一样、没有声像、
     没有弯音和颤音，听起来非常机械、扁平。
     ══════════════════════════════════════════════════════════ */

  /** 通道控制器时间线：cc[ch][ctrl] = [{t, v}] */
  const ccMap: Record<number, Record<number, CCEv[]>> = {};
  const bend: CCEv[][] = Array.from({ length: 16 }, () => []);
  const pedalEv: PedEv[][] = Array.from({ length: 16 }, () => []);

  for (const e of evs) {
    if (e.type === 0xb0) {
      const ch = e.ch, ctrl = e.a, v = e.b;
      (ccMap[ch] || (ccMap[ch] = {}))[ctrl] ||= [];
      ccMap[ch][ctrl].push({ t: tickToSec(e.t), v });
      if (ctrl === 64) pedalEv[ch].push({ t: tickToSec(e.t), on: v >= 64 });
    } else if (e.type === 0xe0) {
      /* pitch bend：a=LSB, b=MSB，中心 8192。
         ⚠️ 原来写死 ±2 半音。真实 MIDI 常用 RPN 把音域设成 ±12（GS 默认就是 2，
         但大量 XG/GS 曲会通过 RPN 0 改），写死 2 会让所有滑音幅度缩水 6 倍。
         这里先存 **归一化值 -1~1**，真正乘音域时再乘该时刻的 bendRange。 */
      const raw = ((e.b & 0x7f) << 7) | (e.a & 0x7f);
      bend[e.ch].push({ t: tickToSec(e.t), v: (raw - 8192) / 8192 });
    }
  }

  /* ══════════════════════════════════════════════════════════════
     本轮解析增强：RPN 弯音音域 / 通道模式消息 / 触后
     ══════════════════════════════════════════════════════════════ */

  /** RPN 0 = pitch bend range。写法：CC101(MSB) CC100(LSB) 选参数 → CC6 写入 / CC38 微调
      ⚠️ 必须**按顺序**扫描（不能用 sampleAt 倒查），否则同一时刻的
      CC101/100/6 谁先谁后不确定，音域会读到上一个参数的值。 */
  const bendRange: CCEv[][] = Array.from({ length: 16 }, () => []);
  {
    const cur = new Array(16).fill(0);       // 当前选中的 RPN 编号
    const msb = new Array(16).fill(0);       // 已写入的 MSB
    for (const e of evs) {
      if (e.type !== 0xb0) continue;
      const ch = e.ch, ctrl = e.a, v = e.b;
      if (ctrl === 101) { cur[ch] = (cur[ch] & 0x7f) | (v << 7); continue; }
      if (ctrl === 100) { cur[ch] = (cur[ch] & 0x3f80) | v; continue; }
      /* ⚠️ 真 bug：原来 push 的是 msb[ch]（初值 0，且从未被赋值），
         于是 CC6 写的半音数被丢掉、音域恒为 0 —— 弯音完全失效。
         RPN 0 的语义：CC6(数据项 MSB) = 半音数，CC38(LSB) = 音分。 */
      if (ctrl === 6 && cur[ch] === 0) {
        msb[ch] = v;                                               // 半音数
        bendRange[ch].push({ t: tickToSec(e.t), v });
        continue;
      }
      if (ctrl === 38 && cur[ch] === 0) {                          // LSB = 音分
        const b = bendRange[ch];
        const last = b.length ? b[b.length - 1].v : msb[ch];
        b.push({ t: tickToSec(e.t), v: last + v / 100 });
        continue;
      }
    }
    for (const a of bendRange) a.sort((x, y) => x.t - y.t);
  }

  /** CC120/123：all sound off / all notes off。
      ⚠️ 真 bug：原来**完全不处理** → 曲子发过这两条之后，
      该通道所有正在响的音符**永不停止**，一直叠到曲末，
      听起来是「越来越糊、越来越响」，密集曲尤其明显。 */
  const cutoff: CCEv[][] = Array.from({ length: 16 }, () => []);
  for (const e of evs) {
    if (e.type === 0xb0 && (e.a === 120 || e.a === 123)) cutoff[e.ch].push({ t: tickToSec(e.t), v: 1 });
  }
  for (const a of cutoff) a.sort((x, y) => x.t - y.t);

  /* 通道模式消息截断：CC120/123 之后的音符最多响到该时刻 */
  if (cutoff.some(a => a.length)) {
    for (const n of notes) {
      const arr = cutoff[n.ch];
      if (!arr || !arr.length) continue;
      /* 取 n.time **之后**第一条 cutoff。
         ⚠️ 这里不能用 sampleAt：它在下面才用 const 定义（TDZ），
         在这里调用会抛 ReferenceError，整首曲子解析失败。
         实测：只要 MIDI 里出现 CC123（很多曲子结尾都有），播放器直接不响。 */
      for (const e of arr) if (e.t > n.time) { n.dur = Math.min(n.dur, Math.max(0.02, e.t - n.time)); break; }
    }
  }

  for (const a of bend) a.sort((x, y) => x.t - y.t);
  for (const a of pedalEv) a.sort((x, y) => x.t - y.t);

  /* 触后压力：复音 0xA0（a=音高, b=压力）与通道 0xD0（a=压力）。
     原来两者都进了 evs 但从未使用 → 真实演奏里的「按下去继续使劲」
     这个最有表现力的维度完全丢失。 */
  const aftPoly: Record<number, Record<number, CCEv[]>> = {};   // ch → note → 时间线
  const aftCh: CCEv[][] = Array.from({ length: 16 }, () => []);
  for (const e of evs) {
    if (e.type === 0xa0 && e.b > 0) {
      const m = aftPoly[e.ch] || (aftPoly[e.ch] = {});
      (m[e.a] || (m[e.a] = [])).push({ t: tickToSec(e.t), v: e.b / 127 });
    } else if (e.type === 0xd0) {
      aftCh[e.ch].push({ t: tickToSec(e.t), v: e.a / 127 });
    }
  }
  for (const a of aftCh) a.sort((x, y) => x.t - y.t);
  for (const m of Object.values(aftPoly)) for (const a of Object.values(m)) a.sort((x, y) => x.t - y.t);

  /** 触后采样：复音优先，没有则退回通道压力 */
  const aftAt = (ch: number, note: number, t: number) => {
    const m = aftPoly[ch];
    if (m && m[note] && m[note].length) return sampleAt(m[note], t, 0);
    return sampleAt(aftCh[ch], t, 0);
  };
  for (const m of Object.values(ccMap)) for (const a of Object.values(m)) a.sort((x, y) => x.t - y.t);

  /** 在时间线里取 t 时刻的值（二分，取最后一个 t' <= t） */
  const sampleAt = (arr: CCEv[], t: number, dflt: number) => {
    if (!arr || !arr.length) return dflt;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].t <= t) lo = mid; else hi = mid - 1; }
    return arr[lo].t <= t ? arr[lo].v : dflt;
  };
  const ccAt = (ch: number, ctrl: number, t: number, dflt: number) =>
    sampleAt(ccMap[ch] ? ccMap[ch][ctrl] : undefined, t, dflt);
  /** 踏板在 t 时刻是否踩着 */
  const pedalAt = (ch: number, t: number) => {
    const arr = pedalEv[ch];
    if (!arr || !arr.length) return false;
    let lo = -1, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].t <= t) lo = mid; else hi = mid - 1; }
    return lo >= 0 ? arr[lo].on : false;
  };
  /** t 之后第一次抬踏板的时间（找不到返回 -1） */
  const nextPedalUp = (ch: number, t: number) => {
    const arr = pedalEv[ch];
    if (!arr) return -1;
    for (const e of arr) if (e.t > t && !e.on) return e.t;
    return -1;
  };

  for (const n of notes) {
    const ch = n.ch;
    /* CC7 通道音量（默认 100） × CC11 表情（默认 127） */
    const v7 = ccAt(ch, 7, n.time, 100) / 127;
    const v11 = ccAt(ch, 11, n.time, 127) / 127;
    n.vol = Math.min(1.5, Math.max(0, v7 * v11));
    /* CC10 声像：64 居中 */
    n.pan = (ccAt(ch, 10, n.time, 64) - 64) / 64;
    /* CC1 调制轮 → 颤音 */
    n.mod = ccAt(ch, 1, n.time, 0) / 127;
    n.bend = sampleAt(bend[ch], n.time, 0) * sampleAt(bendRange[ch], n.time, 2);
    /* CC74 亮度（默认 64）/ CC71 谐振（默认 64）：XG 曲大量使用，
       原来忽略 → 滤波器和弯音一样对所有通道一视同仁 */
    n.bright = ccAt(ch, 74, n.time, 64) / 127;
    n.reso = ccAt(ch, 71, n.time, 64) / 127;
    /* CC91 混响 / CC93 合唱送出（默认均为 64） */
    n.revSend = ccAt(ch, 91, n.time, 40) / 127;
    n.choSend = ccAt(ch, 93, n.time, 40) / 127;
    /* 触后：复音 0xA0（该音键的压力）优先，否则用通道压力 0xD0 */
    n.aft = aftAt(ch, n.note, n.time);
    /* 滑音：CC65 开关（≥64 开）× CC5 时间（0~127 映射 0~0.12 秒） */
    const sw = ccAt(ch, 65, n.time, 0);
    n.glide = sw >= 64 ? (ccAt(ch, 5, n.time, 0) / 127) * 0.12 : 0;

    /* 延音踏板：note-off 时踏板踩着 → 延长到抬踏板。
       ⚠️ 性能（修过）：原来一律延长到「最多 4 秒」，而真实钢琴 MIDI 里
       踏板经常整段踩着 → **每个音都多响 4 秒** → 同时在响的音符数量翻几倍
       （48 音/秒 × 4 秒 = 近 200 个声部），撞上 64 的声部上限后被大量丢弃，
       听感就是「一顿一顿」。
       改成：① 上限 2.5 秒 ② 遇到同一音高的重击就截断（真钢琴重击会止音）。 */
    const endT = n.time + n.dur;
    if (pedalAt(ch, endT - 0.01)) {
      const up = nextPedalUp(ch, endT);
      let to = up > 0 ? Math.min(up, endT + 2.5) : endT + 2.5;
      /* 同音高下一个 note-on：真钢琴上重击会把前一音止住 */
      for (let k = notes.indexOf(n) + 1; k < notes.length; k++) {
        const m = notes[k];
        if (m.time > to) break;
        if (m.ch === ch && m.note === n.note && !m.pedal) { to = Math.min(to, m.time + 0.02); break; }
      }
      if (to > endT + 0.02) { n.dur = to - n.time; n.pedal = true; }
    }
  }

  for (const n of notes) maxT = Math.max(maxT, n.time + n.dur);

  /* ── 静态并发度：每个音符发声期间同时有多少音符在响 ──
     ⚠️ 真 bug（修过）：和弦补偿原来只靠**总线上的动态 polyGain**，
     按「当前正在响的音符数」每 180ms 更新一次。
     实测和弦 16 音时 target 确实算对了（0.3121），但峰值仍冲到 0.75 ——
     因为**峰值出现在起音瞬间**，而那一刻补偿还没生效：
     pump 预排的音符都在未来（activeVoices 还是 0），等音符真开始响
     再统计、再 setTargetAtTime（时间常数 60ms），滞后约 240ms，
     和弦只有 500ms，峰值早就过去了。等于补偿了个寂寞。

     改成**解析期静态计算**：并发度在拿到音符表时就能算出来，
     预排时直接写进每个音符的增益，起音那一刻就已经是补偿后的值。
     顺带去掉总线 polyGain（少一个节点，也避免双重补偿把和弦压太扁）。 */
  /* ★ 声部角色判定：必须在 assignConcurrency **之前** ——
     assignConcurrency 里用 isDrum(n) 区分鼓（鼓不参与和弦排名/琶音错位）。 */
  const roles = assignRoles(notes, tracks);
  assignConcurrency(notes);
  /* 并发数时间平滑：消除 arp 这类错开起音声部的响度跳变（见 smoothConcurrency 注释）。
     必须在 applyStrum **之前** —— 两者都按原始起音时刻计算。 */
  smoothConcurrency(notes);
  /* 打击乐时间密度：必须在 applyStrum 之前（同 conc，按原始起音时刻统计） */
  smoothDrumRate(notes);

  /* ══════════════════════════════════════════════════════════
     和弦琶音错位（strum）—— 解决「和弦太响」的关键
     ══════════════════════════════════════════════════════════
     ⚠️ 真 bug：和弦里所有音符在**同一瞬间**起音，各自的 attack 峰
     完全重合 → 瞬态是**相干叠加（幅度相加）**，而 polyComp 按非相干
     （功率相加，√n）补偿 → 16 音和弦的瞬态超出约 12dB。
     压缩器 attack 4ms 抓不住这么快的瞬态（峰值在 tb.atk 内就到了），
     所以 RMS 拉平了、听感还是「冲」。

     修法就是真实演奏本身的样子：钢琴/吉他弹和弦时各指**不是绝对同时**
     下键，有 10~30ms 的错位。把瞬态在时间上摊开，就从「相干」变成
     「近似非相干」，polyComp 的 √n 才成立。

     ⚠️ 必须在 assignConcurrency 之后：conc 要按**原始**同时性计算，
     如果先错位再算 conc，同一和弦的音符会被判成不同时刻 →
     conc 变小 → 补偿变弱 → 正好抵消掉 strum 的效果。

     跨度上限 30ms：人耳把 30ms 内的音感知为「同时」（哈斯效应），
     所以听起来仍是一个和弦，只是不再「砸」在一起。 */
  applyStrum(notes);

  return { notes, duration: maxT || 1, bpm, bpmVaries, roles };
}

/**
 * GM program → 音色参数
 *
 * v2（这次重做）：从「一个振荡器」改成「三个振荡器叠加谐波」+ 混响 + 压缩。
 * 之前用单振荡器，音色干瘪像电子表，这是「差点意思」的主因。
 *
 * 每个音色 = 基频 osc + 两个谐波 osc（各自独立 gain / 波形 / 失谐），
 * 再统一走 ADSR + 混响送出。三个振荡器带 ±cents 失谐，避免机械感。
 *
 * 仍然是近似模拟，不是真实音源 —— 但比之前厚实、有空间感得多。
 */
/** 按 timbre 缓存 PeriodicWave（谐波合成进单个振荡器）
    ⚠️ 真 bug（修过）：PeriodicWave **绑定创建它的 AudioContext**，
       跨 context 使用会抛错或不发声。而同一页面可能有多个 MIDI 播放器，
       每个 buildMidi 建自己的 ctx —— 用模块级 Map 缓存会让第二个播放器
       拿到第一个 ctx 的波形。改成按 ctx 分桶（WeakMap，随 ctx 一起回收）。 */
const waveCache = new WeakMap<AudioContext, Map<number, PeriodicWave>>();
function toneWave(ctx: AudioContext, tb: Timbre): PeriodicWave {
  let m = waveCache.get(ctx);
  if (!m) { m = new Map(); waveCache.set(ctx, m); }
  /* ⚠️ 性能（修过）：原来每个音符建 **3 个振荡器 + 3 个 gain**（基频/2次/3次）。
     密集段落（比如 16 分音符连奏）一次 pump 就要几百个节点 →
     主线程卡住，声音断断续续 —— 这正是「放着放着会卡」的主因。

     PeriodicWave 把谐波比例**编进波形本身**，1 个振荡器就能出同样的频谱，
     节点数从 10 降到 4。谐波比例是常数（tb.h2/h3 固定），完全适用。 */
  /* key 要能区分所有谐波值：原来只用 h2/h3 两位，加了 h4~h6 后会撞车
     （两个不同音色拿到同一个波形）。用字符串拼接。 */
  const key = `${tb.wave}|${tb.h2w || ''}|${[tb.h2, tb.h3, tb.h4, tb.h5, tb.h6].map((v) => Math.round(v * 100)).join(',')}`;
  const hit = m.get(key);
  if (hit) return hit;
  /* 虚部 = 正弦分量幅度。2~6 次谐波按音色表给的值，7~12 次是衰减尾巴
     （让高频不是硬截断，更接近真实乐器的频谱）。
     ⚠️ 全部编进波形 → **加谐波不增加任何音频节点**。 */
  const N = 13;
  const real = new Float32Array(N);
  const imag = new Float32Array(N);
  imag[1] = 1;
  imag[2] = tb.h2;
  imag[3] = tb.h3;
  imag[4] = tb.h4;
  imag[5] = tb.h5;
  imag[6] = tb.h6;
  const t6 = tb.h6 || 0.04;
  imag[7]  = t6 * 0.70;
  imag[8]  = t6 * 0.52;
  imag[9]  = t6 * 0.38;
  imag[10] = t6 * 0.27;
  imag[11] = t6 * 0.18;
  imag[12] = t6 * 0.11;
  /* 亮度：轻微倾斜整个高频尾巴（>1 更亮，<1 更暗）。
     用指数让越高的谐波倾斜越多，比整体乘一个常数自然。 */
  const br = Math.log2(Math.max(0.4, tb.bright)) * 0.5;
  for (let i = 2; i < N; i++) imag[i] *= Math.pow(2, br * (i - 1) / 4);
  const w = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  m.set(key, w);
  return w;
}

interface Timbre {
  wave: OscillatorType;   // 基频波形
  /* 谐波 2~6 次。⚠️ 全部编进 PeriodicWave 的傅里叶系数，
     **不增加任何音频节点** —— 想让音色更厚更亮，加谐波是最便宜的做法。 */
  h2: number;
  h3: number;
  h4: number;
  h5: number;
  h6: number;
  h2w?: OscillatorType;   // 2 次谐波波形（默认同基频）
  det: number;            // 失谐 cents
  atk: number; dec: number; sus: number; rel: number;
  gain: number;
  rev: number;            // 送混响的量 0~1
  /** 起音瞬态强度（噪声 burst），0 = 不叠。拨弦/敲击类音色需要 */
  click: number;
  /** 低通截止（相对基频倍数），0 = 不加滤波 */
  lp?: number;
  /* ⚠️ 高通（**绝对 Hz**，不是倍数）。
     低频乐器的能量几乎全在 <250Hz：实测原声贝斯低频 -22.8dB、中频 -79dB，
     差 56dB。这些低频吃掉了绝大部分动态余量（**总能量比萨克斯还高 7dB**），
     不断触发宽带压缩器把其他音色一起压下去 —— 这就是「bass 太响、听不到别的」。
     但人耳对低频不敏感（A 计权下贝斯反而是最轻的，-46dB）。
     所以：**切掉听不见的超低频，把省下的动态还给中频**。 */
  hp?: number;
  /* ── 以下都是**总线效果**的送出量：总线只建一次，每音符只连一个
       复用的 send gain，所以**几乎不增加 per-note 节点**。 ── */
  /** 合唱（厚度、宽度） */
  cho: number;
  /** 延迟/回声（空间） */
  dly: number;
  /** 过载/失真（力量感）。0 = 不过 drive 总线 */
  drv: number;
  /** 滤波包络强度：起音时把低通打开再收回，「哇」的动态。0 = 不做 */
  fenv: number;
  /** 亮度微调（1 = 不调）。用来区分同族音色 */
  bright: number;
  /* ── 共振峰（formant）：模拟声道 / 管腔的共鸣 ──
     真实乐器之所以「像某种乐器」，很大程度靠这两个固定频率的共振峰
     （不随音高变）。少了它，人声/管乐/簧片听起来都是同一个「电子音」。
     ⚠️ 做成**按 program 缓存的共享滤波器链**，每音符只是一次 connect，
     **0 新增 per-note 节点**。 */
  f1?: number;   // 第一共振峰 Hz
  f2?: number;   // 第二共振峰 Hz
  fq?: number;   // 共振强度 dB（默认 8）
}

/** 由「基础组参数 + 覆盖项」拼一个 Timbre，避免 128 行全写一遍 */
/* ⚠️ 用独立接口而不是内联对象类型 —— 内联的会干扰 TS→JS 转换脚本 */
interface TimbreSeed extends Partial<Timbre> { wave: OscillatorType; gain: number; rev: number }

/* ══════════════════════════════════════════════════════════════
   响度规则（「bass 太响、听不到其他音色」的修法）
   ══════════════════════════════════════════════════════════════
   实测（单音、同力度、渲染到最终输出）暴露的真问题：

     贝斯  总能量 -20.3dB（低频 -21.5，**全场最高**）/ A 计权 -33dB（**全场最轻**）
     小号  总能量 -19.2dB / A 计权 -18dB（最响）

   贝斯占着最大的一份动态余量，听感上却最轻。它会 ① 吃掉总电平
   ② 反复触发宽带压缩器把中频声部一起压下去 ③ 低频掩蔽中频。
   —— 这才是「bass 太响、听不到别的」的真正机制。

   所以规则不是「把贝斯调小」，而是**按角色分层的目标响度**：

     角色                              A 计权目标    说明
     ─────────────────────────────────────────────────────────────
     独奏旋律（小号/萨克斯/长笛/吉他/钢琴）  基准 0 dB    要能穿透
     弦乐 / 合奏 / 人声                     -2 dB      垫在中层
     持续垫（pad）                          -6 dB      背景，不能盖旋律
     贝斯                                  -6 dB      托底；低频要压、中频要够
     打击乐                                +2 dB      节奏骨架

   贝斯的特殊处理（关键）：不能只压 gain —— 那样在小喇叭上就完全消失了。
   正确做法是**改变频谱分布而不是只改总量**：
     ① 提高 4~6 次谐波（h4/h5/h6）→ 能量从 <250Hz 移到 250~500Hz
     ② 放开 lp（7 → 10）让这些谐波真的出来
     ③ 略提 hp（46 → 50）切掉最底下那层听不见的
     ④ 再小幅降 gain 收总电平
   PeriodicWave 是**归一化**的，提高谐波会自动稀释基频 ——
   一步同时做到「低频降、中频升」，不用两处调。 */
function mk(b: TimbreSeed): Timbre {
  return {
    h2: 0.28, h3: 0.18, h4: 0.10, h5: 0.06, h6: 0.04,
    det: 5, atk: 0.006, dec: 0.35, sus: 0.35, rel: 0.26,
    click: 0.05, lp: 6, cho: 0.18, dly: 0, drv: 0, fenv: 0, bright: 1,
    f1: 0, f2: 0, fq: 8,
    ...b,
  } as Timbre;
}

/* GM program → 音色。
   ⚠️ 原来只有 13 组（prog/8），**同组 8 个音色听起来完全一样**
   —— 大钢琴和电钢琴、清音吉他和失真吉他都是同一个声。
   现在：16 个基础组 + 对辨识度高的具体音色做单独覆盖。 */
function timbreRaw(prog: number): Timbre {
  /* ── 具体音色特例（辨识度最高、最容易被听出「不像」的那几个） ── */
  switch (prog) {
    case 0: return mk({ wave:'triangle', h2:0.34, h3:0.24, h4:0.14, h5:0.08, h6:0.05, det:3,  atk:0.003, dec:0.60, sus:0.10, rel:0.30, click:0.06, gain:0.471, rev:0.24, lp:7,  cho:0.12, fenv:0.45, bright:1.0}); // 大钢琴
    case 1: return mk({ wave:'triangle', h2:0.30, h3:0.26, h4:0.18, h5:0.10, h6:0.06, det:3,  atk:0.003, dec:0.55, sus:0.12, rel:0.30, click:0.06, gain:0.465, rev:0.22, lp:9,  cho:0.12, fenv:0.45, bright:1.25}); // 亮钢琴
    case 2: return mk({ wave:'sine',     h2:0.42, h3:0.14, h4:0.22, h5:0.06, h6:0.03, det:2,  atk:0.002, dec:0.75, sus:0.10, rel:0.35, click:0.04, gain:0.512, rev:0.22, lp:6,  cho:0.16, fenv:0.55, bright:1.1}); // 电钢琴
    case 4: return mk({ wave:'sine',     h2:0.40, h3:0.20, h4:0.24, h5:0.10, h6:0.06, det:4,  atk:0.002, dec:0.80, sus:0.08, rel:0.40, click:0.05, gain:0.537, rev:0.20, lp:5,  cho:0.22, fenv:0.6, bright:1.15}); // 电钢琴2（铃铛感）
    case 6: return mk({ wave:'square',   h2:0.22, h3:0.34, h4:0.16, h5:0.22, h6:0.08, det:0,  atk:0.001, dec:0.30, sus:0.06, rel:0.14, click:0.10, gain:0.776, rev:0.18, lp:12, cho:0.06, fenv:0.7, bright:1.4}); // 羽管键琴（极亮）
    case 7: return mk({ wave:'sawtooth', h2:0.30, h3:0.30, h4:0.20, h5:0.16, h6:0.10, det:6,  atk:0.001, dec:0.35, sus:0.08, rel:0.16, click:0.12, gain:0.773, rev:0.16, lp:10, cho:0.10, drv:0.25, fenv:0.75, bright:1.3}); // 克拉维内特（放克）
    case 24: return mk({ wave:'triangle', h2:0.26, h3:0.18, h4:0.09, h5:0.05, h6:0.03, det:4,  atk:0.002, dec:0.85, sus:0.10, rel:0.40, click:0.16, gain:0.59, rev:0.22, lp:7,  cho:0.14, fenv:0.5, bright:0.95}); // 尼龙弦吉他
    case 25: return mk({ wave:'sawtooth', h2:0.28, h3:0.22, h4:0.14, h5:0.08, h6:0.05, det:5,  atk:0.002, dec:0.90, sus:0.10, rel:0.45, click:0.16, gain:0.544, rev:0.24, lp:8,  cho:0.16, fenv:0.5, bright:1.1}); // 钢弦吉他
    case 28: return mk({ wave:'sawtooth', h2:0.30, h3:0.26, h4:0.18, h5:0.12, h6:0.08, det:7,  atk:0.002, dec:0.60, sus:0.14, rel:0.30, click:0.12, gain:0.454, rev:0.20, lp:6,  cho:0.14, drv:0.45, fenv:0.6, bright:1.15}); // 清音吉他（电）
    case 29: return mk({ wave:'sawtooth', h2:0.32, h3:0.30, h4:0.22, h5:0.18, h6:0.14, det:8,  atk:0.002, dec:0.45, sus:0.22, rel:0.28, click:0.10, gain:0.421, rev:0.22, lp:5,  cho:0.12, drv:0.8, fenv:0.65, bright:1.2}); // 过载吉他
    case 30: return mk({ wave:'sawtooth', h2:0.34, h3:0.34, h4:0.28, h5:0.24, h6:0.20, det:10, atk:0.001, dec:0.35, sus:0.30, rel:0.24, click:0.08, gain:0.405, rev:0.26, lp:4,  cho:0.10, drv:1.0, fenv:0.7, bright:1.25}); // 失真吉他（最有力）
    case 32: return mk({ wave:'sine',     h2:0.12, h3:0.2, h4:0.56, h5:0.5, h6:0.42, det:2,  atk:0.010, dec:0.42, sus:0.34, rel:0.20, click:0.03, gain:0.25, rev:0.08, lp:5,   cho:0.06, fenv:0.15, bright:1.62, hp:55}); // 原声贝斯
    case 33: return mk({ wave:'sawtooth', h2:0.12, h3:0.2, h4:0.56, h5:0.5, h6:0.42, det:3,  atk:0.010, dec:0.34, sus:0.34, rel:0.18, click:0.03, gain:0.255, rev:0.08, lp:5,   cho:0.08, drv:0.15, fenv:0.15, bright:1.66,  hp:55}); // 指弹贝斯
    case 38: return mk({ wave:'sawtooth', h2:0.12, h3:0.2, h4:0.56, h5:0.5, h6:0.42, det:4,  atk:0.008, dec:0.30, sus:0.34, rel:0.16, click:0.03, gain:0.262, rev:0.10, lp:5,   cho:0.08, drv:0.25, fenv:0.15, bright:1.7,  hp:55}); // 合成贝斯1
    case 40: return mk({ wave:'sawtooth', h2:0.26, h3:0.14, h4:0.08, h5:0.05, h6:0.03, det:9,  atk:0.075, dec:0.16, sus:0.74, rel:0.42, click:0.03, gain:0.184, rev:0.36, lp:5,  cho:0.30, dly:0.10, fenv:0.25, bright:1.0}); // 小提琴
    case 42: return mk({ wave:'sawtooth', h2:0.28, h3:0.16, h4:0.10, h5:0.06, h6:0.04, det:9,  atk:0.090, dec:0.18, sus:0.70, rel:0.50, click:0.03, gain:0.177, rev:0.38, lp:5,  cho:0.30, dly:0.10, fenv:0.25, bright:0.9,  hp:70}); // 大提琴
    case 45: return mk({ wave:'triangle', h2:0.24, h3:0.16, h4:0.10, h5:0.06, h6:0.04, det:4,  atk:0.002, dec:1.10, sus:0.04, rel:0.55, click:0.08, gain:0.348, rev:0.34, lp:8,  cho:0.20, dly:0.14, fenv:0.5, bright:1.2}); // 竖琴
    case 48: return mk({ wave:'sawtooth', h2:0.30, h3:0.18, h4:0.10, h5:0.06, h6:0.04, det:14, atk:0.060, dec:0.18, sus:0.70, rel:0.46, click:0.03, gain:0.34, rev:0.40, lp:5,  cho:0.36, dly:0.12, fenv:0.2, bright:1.0}); // 弦乐合奏
    case 52: return mk({ wave:'sawtooth', h2:0.34, h3:0.22, h4:0.14, h5:0.08, h6:0.05, det:16, atk:0.140, dec:0.22, sus:0.66, rel:0.55, click:0.0,  f1:700, f2:1200, fq:9, gain:0.268, rev:0.46, lp:4,  cho:0.40, dly:0.16, fenv:0.15, bright:0.95}); // 人声「啊」
    case 56: return mk({ wave:'sawtooth', h2:0.38, h3:0.28, h4:0.18, h5:0.12, h6:0.08, det:7,  atk:0.028, dec:0.22, sus:0.62, rel:0.30, click:0.05, f1:520, f2:1500, fq:7, gain:0.285, rev:0.28, lp:8,  cho:0.16, dly:0.08, fenv:0.6, bright:1.2}); // 小号
    case 60: return mk({ wave:'sawtooth', h2:0.34, h3:0.24, h4:0.14, h5:0.09, h6:0.06, det:6,  atk:0.035, dec:0.24, sus:0.58, rel:0.34, click:0.04, f1:350, f2:900, fq:7, gain:0.274, rev:0.32, lp:6,  cho:0.20, dly:0.10, fenv:0.45, bright:0.95}); // 圆号
    case 61: return mk({ wave:'sawtooth', h2:0.38, h3:0.30, h4:0.20, h5:0.14, h6:0.10, det:12, atk:0.030, dec:0.20, sus:0.66, rel:0.32, click:0.04, f1:480, f2:1300, fq:7, gain:0.27, rev:0.30, lp:7,  cho:0.28, dly:0.10, fenv:0.55, bright:1.15}); // 铜管合奏
    case 64: return mk({ wave:'square',   h2:0.14, h3:0.34, h4:0.08, h5:0.20, h6:0.05, det:5,  atk:0.022, dec:0.20, sus:0.55, rel:0.24, click:0.05, f1:620, f2:1450, fq:8, gain:0.423, rev:0.24, lp:7,  cho:0.14, dly:0.06, fenv:0.65, bright:1.25}); // 高音萨克斯
    case 65: return mk({ wave:'square',   h2:0.16, h3:0.32, h4:0.10, h5:0.18, h6:0.06, det:5,  atk:0.024, dec:0.22, sus:0.52, rel:0.24, click:0.05, f1:560, f2:1300, fq:8, gain:0.466, rev:0.24, lp:6,  cho:0.14, dly:0.06, fenv:0.65, bright:1.1}); // 中音萨克斯
    case 73: return mk({ wave:'sine',     h2:0.30, h3:0.10, h4:0.04, h5:0.02, h6:0.01, det:3,  atk:0.045, dec:0.16, sus:0.74, rel:0.26, click:0.10, f1:820, f2:2100, fq:6, gain:0.298, rev:0.30, lp:6,  cho:0.20, dly:0.08, fenv:0.3, bright:1.15}); // 长笛
    case 80: return mk({ wave:'square',   h2:0.24, h3:0.16, h4:0.12, h5:0.06, h6:0.04, det:11, atk:0.004, dec:0.28, sus:0.44, rel:0.20, click:0.03, gain:0.498, rev:0.26, lp:9,  cho:0.26, dly:0.18, fenv:0.5, bright:1.3}); // 合成主音（方波）
    case 81: return mk({ wave:'sawtooth', h2:0.30, h3:0.22, h4:0.16, h5:0.10, h6:0.07, det:13, atk:0.006, dec:0.24, sus:0.50, rel:0.22, click:0.03, gain:0.519, rev:0.26, lp:7,  cho:0.30, dly:0.18, fenv:0.6, bright:1.25}); // 合成主音（锯齿）
    case 88: return mk({ wave:'sine',     h2:0.30, h3:0.16, h4:0.10, h5:0.05, h6:0.03, det:16, atk:0.150, dec:0.30, sus:0.60, rel:0.70, click:0.0,  gain:0.164, rev:0.50, lp:5,  cho:0.42, dly:0.20, fenv:0.15, bright:1.0}); // 新世纪垫
    case 89: return mk({ wave:'sawtooth', h2:0.32, h3:0.20, h4:0.12, h5:0.07, h6:0.04, det:20, atk:0.220, dec:0.32, sus:0.62, rel:0.85, click:0.0,  gain:0.144, rev:0.54, lp:4,  cho:0.44, dly:0.22, fenv:0.1, bright:0.95}); // 温暖垫
    case 18: return mk({ wave:'sawtooth', h2:0.42, h3:0.30, h4:0.22, h5:0.14, h6:0.10, det:6,  atk:0.004, dec:0.06, sus:0.86, rel:0.12, click:0.0,  gain:0.574, rev:0.20, lp:9,  cho:0.24, dly:0.05, fenv:0.35, bright:1.3, drv:0.5}); // 摇滚风琴
    case 19: return mk({ wave:'sine',     h2:0.60, h3:0.40, h4:0.30, h5:0.18, h6:0.12, det:0,  atk:0.030, dec:0.10, sus:0.88, rel:0.28, click:0.0,  gain:0.306, rev:0.54, lp:10, cho:0.20, dly:0.22, fenv:0.2,  bright:1.05}); // 教堂风琴
    case 21: return mk({ wave:'square',   h2:0.30, h3:0.34, h4:0.18, h5:0.20, h6:0.10, det:8,  atk:0.020, dec:0.12, sus:0.80, rel:0.20, click:0.02, gain:0.428, rev:0.24, lp:8,  cho:0.30, dly:0.06, fenv:0.5,  bright:1.15}); // 手风琴
    case 22: return mk({ wave:'square',   h2:0.20, h3:0.40, h4:0.12, h5:0.24, h6:0.08, det:10, atk:0.014, dec:0.14, sus:0.72, rel:0.18, click:0.03, gain:0.424, rev:0.30, lp:9,  cho:0.32, dly:0.08, fenv:0.6,  bright:1.35, f1:900, f2:1900, fq:7}); // 口琴
    case 77: return mk({ wave:'sine',     h2:0.26, h3:0.14, h4:0.07, h5:0.03, h6:0.02, det:6,  atk:0.060, dec:0.20, sus:0.70, rel:0.30, click:0.16, gain:0.266, rev:0.40, lp:6,  cho:0.22, dly:0.14, fenv:0.3,  bright:1.1,  f1:760, f2:1500, fq:8}); // 尺八（气声重）
    case 104: return mk({ wave:'sawtooth', h2:0.34, h3:0.26, h4:0.20, h5:0.14, h6:0.10, det:12, atk:0.002, dec:0.80, sus:0.12, rel:0.60, click:0.14, gain:0.558, rev:0.38, lp:7,  cho:0.26, dly:0.16, fenv:0.45, bright:1.2}); // 西塔（共鸣弦）
    case 105: return mk({ wave:'triangle', h2:0.32, h3:0.24, h4:0.16, h5:0.10, h6:0.07, det:4,  atk:0.001, dec:0.50, sus:0.06, rel:0.24, click:0.20, gain:0.731, rev:0.26, lp:9,  cho:0.16, dly:0.10, fenv:0.55, bright:1.35}); // 班卓（极亮）
    case 109: return mk({ wave:'sawtooth', h2:0.44, h3:0.32, h4:0.22, h5:0.16, h6:0.12, det:16, atk:0.050, dec:0.10, sus:0.82, rel:0.30, click:0.06, gain:0.467, rev:0.42, lp:8,  cho:0.34, dly:0.14, fenv:0.4,  bright:1.3, f1:520, f2:1250, fq:8}); // 风笛（持续音+共鸣）
    case 95: return mk({ wave:'sawtooth', h2:0.36, h3:0.26, h4:0.18, h5:0.12, h6:0.08, det:22, atk:0.300, dec:0.40, sus:0.58, rel:1.00, click:0.0,  gain:0.142, rev:0.58, lp:6,  cho:0.46, dly:0.24, fenv:0.3, bright:1.15}); // 扫频垫
  }

  /* ── 16 个基础组 ── */
  const g = Math.floor(prog / 8);
  switch (g) {
    case 0: return mk({ wave:'triangle', h2:0.34, h3:0.22, h4:0.13, h5:0.08, h6:0.05, det:3,  atk:0.003, dec:0.58, sus:0.11, rel:0.30, click:0.06, gain:0.51, rev:0.23, lp:7,  cho:0.12, fenv:0.45}); // 钢琴
    case 1: return mk({ wave:'sine',     h2:0.16, h3:0.30, h4:0.14, h5:0.20, h6:0.08, det:2,  atk:0.002, dec:0.90, sus:0.08, rel:0.50, click:0.07, gain:1.609, rev:0.34, lp:11, cho:0.10, dly:0.10, fenv:0.3, bright:1.2}); // 打击性
    case 2: return mk({ wave:'sine',     h2:0.55, h3:0.34, h4:0.26, h5:0.14, h6:0.10, det:0,  atk:0.012, dec:0.05, sus:0.85, rel:0.10, click:0.0,  gain:0.688, rev:0.18, lp:8,  cho:0.24, fenv:0.2}); // 风琴
    case 3: return mk({ wave:'triangle', h2:0.30, h3:0.24, h4:0.15, h5:0.09, h6:0.06, h2w:'sawtooth', det:6, atk:0.003, dec:0.72, sus:0.13, rel:0.36, click:0.17, gain:1.327, rev:0.24, lp:7, cho:0.15, drv:0.2, fenv:0.5}); // 吉他
    case 4: return mk({ wave:'sawtooth', h2:0.55, h3:0.26, h4:0.08, h5:0.04, h6:0.02, det:3,  atk:0.010, dec:0.34, sus:0.34, rel:0.18, click:0.03, gain:0.178, rev:0.09, lp:5,   cho:0.08, drv:0.15, fenv:0.15, hp:55}); // 贝斯
    case 5: return mk({ wave:'sawtooth', h2:0.27, h3:0.15, h4:0.09, h5:0.05, h6:0.03, det:9,  atk:0.078, dec:0.17, sus:0.73, rel:0.44, click:0.03, gain:0.278, rev:0.37, lp:5,  cho:0.30, dly:0.10, fenv:0.25}); // 弦乐
    case 6: return mk({ wave:'sawtooth', h2:0.31, h3:0.19, h4:0.11, h5:0.07, h6:0.04, det:15, atk:0.065, dec:0.19, sus:0.69, rel:0.48, click:0.03, gain:0.296, rev:0.42, lp:5,  cho:0.38, dly:0.13, fenv:0.18}); // 合奏
    case 7: return mk({ wave:'sawtooth', h2:0.38, h3:0.27, h4:0.17, h5:0.11, h6:0.07, det:8,  atk:0.030, dec:0.22, sus:0.62, rel:0.31, click:0.05, gain:0.409, rev:0.29, lp:7,  cho:0.20, dly:0.09, fenv:0.55}); // 铜管
    case 8: return mk({ wave:'square',   h2:0.15, h3:0.33, h4:0.09, h5:0.19, h6:0.05, det:5,  atk:0.022, dec:0.21, sus:0.54, rel:0.24, click:0.05, f1:450, f2:1200, fq:7, gain:0.442, rev:0.23, lp:7,  cho:0.15, dly:0.07, fenv:0.65}); // 簧片
    case 9: return mk({ wave:'sine',     h2:0.32, h3:0.12, h4:0.05, h5:0.02, h6:0.01, det:3,  atk:0.042, dec:0.17, sus:0.73, rel:0.27, click:0.09, f1:700, f2:1800, fq:6, gain:0.425, rev:0.31, lp:6,  cho:0.20, dly:0.08, fenv:0.3}); // 管乐
    case 10: return mk({ wave:'square',   h2:0.25, h3:0.17, h4:0.13, h5:0.07, h6:0.05, det:12, atk:0.005, dec:0.27, sus:0.45, rel:0.21, click:0.03, gain:0.424, rev:0.27, lp:9,  cho:0.28, dly:0.19, fenv:0.55, bright:1.3}); // 合成主音
    case 11: return mk({ wave:'sawtooth', h2:0.33, h3:0.21, h4:0.13, h5:0.08, h6:0.05, det:19, atk:0.200, dec:0.31, sus:0.61, rel:0.82, click:0.0,  gain:0.232, rev:0.53, lp:4,  cho:0.44, dly:0.21, fenv:0.12}); // 合成垫
    case 12: return mk({ wave:'sine',     h2:0.30, h3:0.24, h4:0.18, h5:0.12, h6:0.08, det:14, atk:0.010, dec:0.30, sus:0.50, rel:0.60, click:0.04, gain:0.33, rev:0.50, lp:9,  cho:0.36, dly:0.26, fenv:0.35, bright:1.3}); // 合成效果
    case 13: return mk({ wave:'triangle', h2:0.30, h3:0.20, h4:0.14, h5:0.09, h6:0.06, det:5,  atk:0.003, dec:0.55, sus:0.16, rel:0.40, click:0.12, gain:0.454, rev:0.30, lp:8,  cho:0.18, dly:0.14, fenv:0.45, bright:1.15}); // 民族
    case 14: return mk({ wave:'sine',     h2:0.24, h3:0.28, h4:0.20, h5:0.16, h6:0.10, det:4,  atk:0.002, dec:0.70, sus:0.12, rel:0.50, click:0.14, gain:0.505, rev:0.36, lp:11, cho:0.16, dly:0.16, fenv:0.4, bright:1.25}); // 打击
    default: return mk({ wave:'triangle', h2:0.28, h3:0.18, h4:0.10, h5:0.06, h6:0.04, det:6,  atk:0.006, dec:0.35, sus:0.35, rel:0.28, click:0.05, gain:0.31, rev:0.30, lp:7,  cho:0.20, dly:0.10, fenv:0.3 }); // 音效
  }
}

/* ══════════════════════════════════════════════════════════════
   响度校准表 —— 修复「各类音色不平衡」
   ══════════════════════════════════════════════════════════════
   ⚠️ 实测发现的真问题：逐个音色单独渲染（单音 vel=100，C4=60；
   贝斯用 C2=36 因音域就在那），测 K 计权 RMS：

     distgtr -18.13   bass -20.62   synbass -20.94   sax -23.27
     oboe    -23.75   trumpet -25.05 flute -25.18   choir -25.53
     horn    -25.45   tuba -26.37   strings -27.55  organ -29.34
     cello   -31.71   violin -32.08  guitar -32.20  epiano -32.52
     piano   -32.58   pad -35.75

   **极差 17.62 dB** —— 失真吉他比小提琴响 14 dB，贝斯比钢琴响 12 dB。
   这是「各类音色平衡」要求下最严重的问题。

   根因：原来的 gain 是**按峰值直觉定的**，但 RMS 取决于
   `sus / dec / drv` 的组合 ——
     · distgtr 有 drv:1.0，失真把动态压掉 → crest 只有 8.5 → RMS 暴涨
     · violin 有 sus:0.74 但 gain 只有 0.184 → 整体偏小
     · piano 有 sus:0.10（打击性），RMS 天然低 —— 这是**物理正确**的，
       不能强行拉平，否则峰值会顶到天花板

   目标带（K 计权 RMS）：
     打击性旋律（钢琴/吉他/古钢琴类，crest 高）   -29 dB  ← 放宽 4dB
     持续旋律（小号/萨克斯/小提琴…）              -25 dB
     合奏 / 弦乐 / 合唱 / 风琴                    -27 dB
     贝斯（托底；K 计权低估低频，感知更轻）        -28 dB
     垫底 pad（背景）                             -33 dB

   同角色内极差应 ≤ 4 dB。系数是「目标 - 实测」换算的线性倍数。

   ⚠️ 必须**迭代**：第一版按理论值算完实测，极差 17.62 → 12.73 dB，
   **压和提都没到位**（失真吉他理论 -6.87dB 实际只降 2.81dB）。
   原因是软削波/压缩器的非线性：响的曲子原本被削着，降 gain 后削波量减少，
   实际降幅小于理论。第二版按**实测残差**再乘一次才收敛。

   ⚠️ 另一个关键认知：`estimateRms` **不含音色 gain**（只算 vel/dur/conc），
   所以曲级 norm 无法区分音色 —— 它只管**曲与曲**之间。
   音色之间的平衡**必须靠 LOUD_CAL 改 gain**，不能指望 norm。
   （也不要把音色因子加进 estimateRms —— 那样 norm 会反向补偿掉
   LOUD_CAL 的效果，等于白调。） */

/** 精确到 prog 的校准系数 */
const LOUD_CAL: Record<number, number> = {
  0: 1.83,
  1: 1.83,
  2: 1.83,
  4: 1.79,
  6: 1.76,
  7: 1.76,
  24: 1.68,
  25: 1.68,
  28: 1.63,
  29: 0.49,
  30: 0.217,
  32: 0.179,
  33: 0.179,
  38: 0.192,
  40: 2.88,
  42: 2.87,
  45: 1.63,
  48: 1.07,
  52: 0.77,
  56: 1.0,
  60: 0.77,
  61: 0.83,
  64: 0.83,
  65: 0.71,
  73: 1.02,
  80: 1.0,
  81: 1.0,
  18: 0.74,
  19: 1.57,
  21: 0.83,
  22: 0.88,
  77: 1.02,
  104: 1.2,
  105: 1.2,
  109: 0.83,
  88: 1.48,
  89: 1.48,
  95: 1.51
};

/** 未精确覆盖时用的分组校准（g = floor(prog/8)） */
const LOUD_CAL_GROUP: number[] = [
  1.83,  // 0 钢琴
  1.76,  // 1 打击性
  1.52,  // 2 风琴
  1.68,  // 3 吉他
  0.179, // 4 贝斯
  2.87,  // 5 弦乐
  1.00,  // 6 合奏
  0.77,  // 7 铜管
  0.77,  // 8 簧片
  1.00,  // 9 管乐
  1.00,  // 10 合成主音
  1.51,  // 11 合成垫
  1.40,  // 12 合成效果
  1.20,  // 13 民族
  1.40,  // 14 打击
];

/* ⚠️ 缓存（性能）：timbre() 是**纯函数**（只依赖 prog），但原来**每音符都调用一次**，
   每次都要走 timbreRaw 的 switch + mk() 建对象 + LOUD_CAL 的对象展开 `{...t}`。
   密集段落（dense 2880 音符）就是 2880 次对象分配 —— GC 压力直接表现为
   「放着放着会卡」。加了 LOUD_CAL 之后又多一次对象展开，雪上加霜。
   按 prog 缓存后，整首曲子每个音色只算一次（GM 最多 128 个）。 */
const timbreCache = new Map<number, Timbre>();

/** 带响度校准的音色查询 */
function timbre(prog: number): Timbre {
  const hit = timbreCache.get(prog);
  if (hit) return hit;
  const t = timbreRaw(prog);
  const c = LOUD_CAL[prog] ?? LOUD_CAL_GROUP[Math.floor(prog / 8)] ?? 1;
  /* 第二轮实测校准层（见 TIMBRE_CAL2 注释）：纯实测反推，不依赖理论公式 */
  const g = Math.floor(prog / 8);
  const c2 = TIMBRE_CAL2[prog] ?? TIMBRE_CAL2_GROUP[g] ?? 1;
  /* 组内微调：避免同组 8 个音色完全一样（prog 在组内的序号 ±3% 的音色偏移） */
  const fine = 1 + ((prog % 8) - 3.5) * 0.012;
  const tot = c * c2 * fine;
  const r = tot === 1 ? t : { ...t, gain: t.gain * tot };
  timbreCache.set(prog, r);
  return r;
}

/** 打击乐通道（GM channel 9）音色：噪声 + 带通，按音高区分鼓件 */
/** fx = 是否送 chorus / delay 总线（最密集档关掉，省 connect 调用） */
interface Quality { voices2: boolean; click: boolean; reverb: boolean; fx: boolean; vib: boolean; maxVoices: number; tier: number }
/*  ⚠️ maxVoices：并发发声声部上限。这是**音频线程**成本的直接决定项 ——
    每个声部 = 1~2 个 PeriodicWave 振荡器 + 低通 + gain + 声像 + 各送出。
    96 个声部 ≈ 200 个振荡器，密集段落音频线程吃不消就会掉音（听起来「卡」）。
    高负载档位把上限也压下来：宁可少几个声部，也不要整段掉音。 */

/** 三档质量。tier 越高越省，动态降级时按 tier 索引取。 */
const TIERS: Quality[] = [
  { voices2: true,  click: true,  reverb: true, fx: true,  vib: true,  maxVoices: 200, tier: 0 },
  { voices2: false, click: false, reverb: true, fx: true,  vib: false, maxVoices: 240, tier: 1 },
  { voices2: false, click: false, reverb: true, fx: false, vib: false, maxVoices: 280, tier: 2 },
];

/** 按音符密度选音质档位。
    ⚠️ 这是「放着放着会卡」的根本对策：密集段落每音符要建 3~6 个音频节点
    （振荡器 / gain / 低通 / 起音瞬态 3 个 / 混响送出），48 音每秒就是
    每秒几百个节点的创建与销毁 —— 主线程和 GC 都会抖，音频线程跟着掉帧。
    按密度降级，把节点数压下来，听感差异很小但不卡。 */
function pickQuality(notesPerSec: number): Quality {
  /* ⚠️ click 的代价被低估过：它每音符要建 3 个节点（BufferSource + 带通 + gain）。
     实测 25 音/秒时共 271 节点/秒，其中一半来自 click。
     所以 click 只在稀疏曲（≤ 15 音/秒）保留 —— 密集曲里它被掩蔽，听不出差别。 */
  if (notesPerSec > 40) return TIERS[2];
  if (notesPerSec > 15) return TIERS[1];
  return TIERS[0];
}

interface DrumKit { freq: number; q: number; decay: number; tone: number; rev: number; body: number }
/* ══════════════════════════════════════════════════════════════
   鼓件响度校准（本轮新增）
   ══════════════════════════════════════════════════════════════
   ⚠️ 根因：**打击乐从未做过响度校准**。

   旋律音色有 LOUD_CAL / TIMBRE_F 逐 prog 校准（上一轮实测把极差
   从 17.62dB 压到 8.80dB），但打击乐走的是完全独立的一套
   （`drum(note)` 表 + 统一系数 1.05），**各鼓件之间从未对齐过**。

   实测（K 计权 RMS，密集场景 2 秒内 16 击）：

     36 底鼓  -9.09    38 军鼓 -11.24    42 闭镲 -11.89
     44 脚踏镲 -11.83   46 开镲  -9.25    45 嗵鼓 -10.00    49 吊镲 -10.06

   单看极差只有 2.80dB，问题不在**单发响度**，而在两点：

   ① **密度**：真实 MIDI 里 hat 是 8 分/16 分音符连续敲，几乎每拍都有，
      而底鼓只在 1、3 拍，军鼓在 2、4 拍。hat 累计能量占比远高于谱面看起来。
   ② **decay 差异**：闭镲 0.10s vs 吊镲 0.72s —— 单发能量差 7 倍，
      而 ampD 公式里**完全没有 decay 项**，长 decay 的镲天然白拿能量。

   所以校准表同时做了两件事：
     · 按实测把鼓件拉到目标响度（角色目标，不是一刀切）
     · hat 类（42/44）额外压 —— 真实混音里 hat 是节奏点缀，
       本就该是鼓组里最轻的，不该和底鼓抢能量
   ══════════════════════════════════════════════════════════════ */

/** 鼓件组：用于共享带通滤波器与响度校准 */
type DrumGrp = 'kick' | 'snare' | 'hat' | 'openhat' | 'tom' | 'cymbal';
function drumGrp(note: number): DrumGrp {
  if (note <= 37) return 'kick';
  if (note === 38 || note === 40) return 'snare';
  if (note === 42 || note === 44) return 'hat';
  if (note === 46) return 'openhat';
  if (note >= 41 && note <= 50) return 'tom';
  return 'cymbal';
}

/** 鼓件响度校准系数（乘在 ampD 上）。目标响度见注释，由 K 计权实测换算。 */
const DRUM_CAL: Record<DrumGrp, number> = {
  kick:    0.955,   // 目标 -9.5 dB（实测 -9.09）  鼓组里最有力，基本不动
  snare:   1.028,   // 目标 -11.0 dB（实测 -11.24）
  hat:     0.560,   // **再压 2.0dB**：峰值全场最高（-6.06），瞬态必须削
  openhat: 0.649,   // 目标 -13.0 dB（实测  -9.25） **压 3.8dB**：decay 0.44 白拿能量
  tom:     0.794,   // 目标 -12.0 dB（实测 -10.00）
  cymbal:  0.673,   // 目标 -13.5 dB（实测 -10.06） **压 3.4dB**：decay 0.72 最长
};

/** 打击乐起音时间（秒）：削掉过高瞬态峰值，同时按鼓件保留冲击力 */
const DRUM_ATK: Record<DrumGrp, number> = {
  kick:    0.0015,   // 最短：保住底鼓「咚」的冲击
  snare:   0.002,
  hat:     0.003,    // 最长：hat 瞬态最尖（实测峰值 -6.06，全场最高）
  openhat: 0.0025,
  tom:     0.0025,
  cymbal:  0.0025,
};

/** 打击乐的**时间密度**补偿（本轮新增，关键）
    ⚠️ 为什么不能用 drumComp（同时发声数）：
    hat 是短音（decay 0.10），一个接一个，**几乎从不重叠** → conc 恒为 1
    → drumComp 恒返回 1 → **完全不补偿**。
    但 hat 每秒敲 8~16 次，能量在时间上持续累积，听感就是「沙沙一片很吵」。

    打击乐的叠加方式是「密集连续」而不是「同时发声」，
    所以补偿必须按**时间密度**（每秒多少击），而不是同时发声数。

    ⚠️ n.drate 在解析期算好（见 smoothDrumRate），避免每音符遍历。 */
function drumDensityComp(rate: number): number {
  if (rate <= 4) return 1;                       // 稀疏：不补偿
  /* 指数 0.30：8 击/秒 → 0.81，16 击/秒 → 0.66，32 击/秒 → 0.54
     比旋律的 POLY_EXP 缓，保住鼓的冲击力（用户明确报过鼓会被切弱） */
  return Math.max(0.45, 1 / Math.pow(rate / 4, 0.30));
}

function drum(note: number): DrumKit {
  /* 35=BassDrum2 36=BassDrum1  38/40=Snare  41~50=Toms  42/44/46=HiHat  49/51/57=Cymbal
     ⚠️ tone = 叠的低频正弦量（音高感），rev = 混响送出量（空间感） */
  /* body = 低频正弦的音高系数（fBody = f0 × body × 0.5）。
     取值让 fBody 落在真实鼓的音高上：底鼓 ~62Hz、军鼓 ~190Hz、嗵鼓 ~120-200Hz。 */
  if (note <= 37)                return { freq: 82,   q: 3.2, decay: 0.36, tone: 1.15, rev: 0.10, body: 1.9 };  // 底鼓
  if (note === 38 || note === 40) return { freq: 210,  q: 0.9, decay: 0.20, tone: 0.70, rev: 0.24, body: 5.2 };  // 军鼓
  if (note === 42 || note === 44) return { freq: 8600, q: 1.4, decay: 0.10, tone: 0.34, rev: 0.12, body: 2 };    // 闭镲
  if (note === 46)                return { freq: 7600, q: 1.1, decay: 0.44, tone: 0.30, rev: 0.20, body: 2 };    // 开镲
  if (note >= 41 && note <= 50)   return { freq: 160 + (note - 41) * 26, q: 4.2, decay: 0.32, tone: 0.95, rev: 0.18, body: 2.5 }; // 嗵鼓
  return { freq: 6200, q: 0.7, decay: 0.72, tone: 0.26, rev: 0.30, body: 2 };                                     // 吊镲 / 其他
}

/** 白噪声 buffer（按长度缓存，避免每个鼓点都重新生成） */
const noiseCache = new Map<number, AudioBuffer>();
function noiseBuf(ctx: AudioContext, seconds: number): AudioBuffer {
  const key = Math.round(seconds * 100);
  const hit = noiseCache.get(key);
  if (hit) return hit;
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  noiseCache.set(key, buf);
  return buf;
}

/** 生成混响脉冲响应：指数衰减的双声道噪声 */
/** MIDI 输出补偿增益。
    实测：未补偿时 4 个 forte 音符峰值 0.361 / RMS 0.044（-27dB），
    比正常音乐低 8~9dB。1.9 倍（叠加默认音量 0.8→1.0 共约 2.4 倍 ≈ +7.5dB）抬到正常区间。

    ⚠️ 取值是量出来的，不是拍的：
      BOOST 2.6 → 峰值 0.994 贴顶
      BOOST 2.2 → 稀疏曲 OK，但密集 + 踏板曲峰值 1.034 撞软削波天花板（失真）
    配合「小信号恒等」的软削波后取 2.0：三种曲实测峰值 0.68~0.89、RMS 0.10~0.17，都不削波 */
const BOOST = 2.0;

/* ══════════════════════════════════════════════════════════════
   输出天花板：-3 dBFS
   ══════════════════════════════════════════════════════════════
   用户要求「整体播放音量不超过 -3dB」—— 留出动态余量，
   和页面上的其他音源（普通音频、视频）并列时不至于顶格过载。

   做法不是「把 BOOST 调小」（那样整条链都变弱、更没劲），
   而是**只削天花板**：整条链保持现在的电平，最后一级统一乘一个
   trim，把软削波的输出上限映射到 -3dB。

   这样「平均响度」基本不变，「峰值」有硬保证。

   ⚠️ 实测修正：WaveShaper 开了 oversample='2x'，上采样→整形→下采样的
   重建滤波会有约 4% 的过冲（振铃）。实测 16 音和弦输出 0.7356，
   而按曲线上限算应该正好是 0.7079 —— 差的那 3.9% 就是过冲。
   所以 outTrim 要留余量，否则「理论 -3dB」实际会超。

   ⚠️ 余量从 6% 提到 15%（修过）：加了曲级响度归一化后输入电平整体抬高
   （稀疏曲实测 +10dB），余量不够了 —— 实测 long 峰值 -2.11dB、complex -2.71dB，
   都越过 -3dB 天花板。滤波器组的相位叠加会让过冲随电平非线性增长，
   余量必须跟着电平一起留。 */
const OUT_CEIL = Math.pow(10, -3 / 20);   // 0.7079 ≈ -3 dBFS
const OVERSAMPLE_MARGIN = 1.22;   // 再降 6%：long 实测 0.7230(-2.82dB) 越界，波动 ±0.5dB

/* ══════════════════════════════════════════════════════════════
   曲级响度归一化（「前面很小声，后面就大声了」）
   ══════════════════════════════════════════════════════════════
   ⚠️ 根因（实测）：不同曲子的 RMS 差 **12dB**（complex -21dB vs dense -33dB），
   同一首曲子的稀疏段与密集段差 7.7dB（burst）。原因是输出链的压缩器被我
   上一轮改成了 **threshold -4 的限幅模式**——它只管削波，对 -33dB 的信号
   完全不动作，于是「稀疏=原样很小声、密集=很大声」的动态全暴露出来。

   靠压缩器压回来是错的：那会把已经够响的密集段也一起压掉（正是上一轮
   「没劲」的原因）。正确做法是 **ReplayGain 思路**：
     ① 解析期估算整曲平均功率 → 算出增益，把**曲与曲之间**的响度拉平
     ② 段内动态交给压缩器收窄（恢复成中等压缩，而不是纯限幅）
   这样「小声的曲子被提上来」，大声的曲子靠压缩和限幅兜住，两头都受益。 */
const TARGET_RMS = 0.115;      // ≈ -18.8 dBFS
const NORM_MIN = 0.35;         // 最多衰减 9dB（避免把本就很响的曲子压扁）
const NORM_MAX = 5.0;          // 最多提升 14dB

/* ⚠️ 标定常数（修过）：第一版没有 K，直接拿 est 当 RMS 用 —— 结果 est 全部
   落在 0.39~0.96，而实测 RMS 只有 0.02~0.09，**高估 5~15 倍**，于是
   norm 全被 clamp 到 0.35（衰减 9dB），越改越小声（dense -33 → -39.65dB）。
   K = 实测 RMS / est，取实测中位数。 */
const RELEASE_TAIL = 0.25;    // 音符结束后的衰减尾，计入「实际发声时长」
const RMS_K = 0.0365;

/** 和弦叠加的「相干性加成」。
    ⚠️ 真 bug（修过）：估算模型假设非相干叠加（功率相加，幅度 √n），
    POLY_EXP=0.5 正好是能量守恒。但**实际大和弦是半音堆叠、音高极近，
   叠加接近相干（幅度相加）**，所以实际比模型响。

   系数与斜坡是**按 K 计权感知响度实测拟合**的，不是拍的：
     实测（裸 RMS，看起来只差 1.4dB，以为修好了）：
       n=1 -25.30  n=2 -25.12  n=4 -24.64  n=8 -23.12  n=16 -23.90
     实测（**K 计权**，接近人耳感知，差 **4.14dB** —— 这才是用户说的「响」）：
       n=1 -31.25  n=2 -30.84  n=4 -30.60  n=8 -28.36  n=16 -27.11

   ⚠️ 方法论教训：**裸 RMS 会严重低估和弦的感知响度**。和弦频谱更密集，
   能量集中在 2~4kHz（等响曲线最敏感处），K 计权的高频搁架会把这个差距放大。
   前几轮用裸 RMS 判「已修好」，实际还差 4dB —— 用户连报三次「还是响」。

   拟合：要把各档拉到 ±1.5dB 内，需要
     n=8  → est ×1.174  → 指数 0.130
     n=16 → est ×1.355  → 指数 0.259
   两个点用 `K × min(1, n/16)` 能同时满足（K=0.26）：
     n=8  → 0.26 × 0.5 = 0.13   ✓
     n=16 → 0.26 × 1.0 = 0.26   ✓ */
function coherenceBoost(n: number): number {
  if (n <= 1) return 1;
  return Math.pow(n, 0.40 * Math.min(1, n / 16));
}

/** 估算整曲平均 RMS。
    ⚠️ 第二版（修过）：第一版只算了 力度² × 时长 ÷ 并发，漏了两个大头，
   导致 est 与实测 RMS 的相关性很差（K 在 0.041~0.131 间波动 3 倍）：
     ① **ADSR 起音饱和**：音符太短时根本到不了峰值（attack 约 12ms）。
        实测 complex 平均时长 0.03s、dense 0.057s —— 都在 attack 量级，
        不建模这一项，短音会被当成满幅，估算完全失真。
     ② **release 尾巴**（第三版补）：音符结束后还有一段衰减尾（约 0.25s），
        「实际发声时长」= dur + RELEASE，不是 dur。⚠️ 这一项影响极大且反直觉：
        complex 名义时长 0.03s，加尾巴后是 0.28s（**9 倍**）；
        long 名义 0.142s → 0.39s（仅 2.7 倍）。按名义时长算会**严重低估密集曲**，
        实测就是把 complex 提升不足、long 提升过头，曲间仍差 11.8dB。
     ② **quality tier 折扣**：密集曲会自动关掉双振荡器 / 混响 / 效果总线，
        实测这就是 complex(-21dB) 比 dense(-33dB) 响 12dB 的主因之一。
        不建模这一项，密集曲的 est 会偏高、norm 偏低（越密集越被压小）。 */
/* ══════════════════════════════════════════════════════════════
   音色响度因子（供 estimateRms 用）—— 修「背景音色独奏时整曲过轻」
   ══════════════════════════════════════════════════════════════
   ⚠️ 真 bug：estimateRms 只算 vel / dur / conc，**完全不含音色**。
   于是它对「轻音色」的曲子估算偏高 → norm 不给提升（甚至衰减）
   → 整曲偏轻。实测 loud.mid（只有 pad 背景音色）从 -25.12 掉到
   **-35.02 dB**，比钢琴曲轻 8 dB —— 用户会以为「这首没声音」。

   ⚠️ 为什么用实测值而不是理论公式：
   先试过 `gain × sus因子 × drv因子`，结果严重失准 ——
   贝斯算出来比平均低 **19.6 dB**，但实测贝斯反而比钢琴**高** 3 dB。
   原因是公式没算**谐波分布**：贝斯的 h4/h5/h6 = 0.56/0.5/0.42，
   能量被移到 250~500Hz 的中频，K 计权测出来并不低。
   → 理论公式不能用，必须用实测。

   ⚠️ 为什么实测值可以直接用（不循环论证）：
   音色测试里所有音色的 **vel / dur / conc 完全相同**，
   而 estimateRms 只看这三项 → **各音色的 norm 完全相同**。
   所以实测到的差异是**纯粹的音色差异**，不含 norm 的影响。

   ⚠️ 归一化到几何中心（REF = -27.02 dB，即实测均值）：
   这样「平均音色构成」的曲子 est 不变，**RMS_K 标定继续有效**。

   作用：让 norm 把**任何音色构成的曲子**都拉到目标响度。
   单音色曲听起来都正常；混合曲里 norm 是标量，不改相对关系，
   所以 LOUD_CAL 的角色差异（pad 轻、旋律响）依然保留。 */

/** 精确到 prog 的音色响度因子（实测 K 计权 RMS 换算，归一化后） */
const TIMBRE_F: Record<number, number> = {
  0: 0.728, 4: 0.717, 19: 0.959, 25: 0.724, 30: 1.397,
  33: 1.027, 38: 1.046, 40: 1.219, 42: 1.196, 48: 0.993,
  52: 1.011, 56: 1.259, 58: 0.920, 60: 1.034, 65: 1.273,
  68: 1.289, 73: 1.259, 88: 0.507,
};

/** 未精确覆盖时用的分组因子（g = floor(prog/8)） */
const TIMBRE_F_GROUP: number[] = [
  0.728, 0.726, 0.959, 0.724, 1.027, 1.219, 0.993, 1.259,
  1.273, 1.259, 1.003, 0.564, 1.003, 1.003, 0.796, 1.003,
];

/* ══════════════════════════════════════════════════════════════
   第二轮实测校准层（TIMBRE_CAL2 / DRUM_CAL2）
   ══════════════════════════════════════════════════════════════
   ⚠️ 为什么要再加一层，而不是直接改 LOUD_CAL：

   上一轮 LOUD_CAL 是**按理论公式**算的（根据 h2~h6 / sus / drv 推算 RMS），
   实测发现严重失准 —— 失真吉他理论降 6.87dB 实际只降 2.81dB。
   原因是软削波是非线性：响的曲子原本被削着，降 gain 后削波量减少，
   实际降幅远小于理论值。

   所以这一层是**纯实测反推**：固定 C4、vel=100、dur=0.5 逐个渲染，
   量 K 计权 RMS，反算到目标响度。不依赖任何理论假设。

   实测单音 RMS 极差 **13.99 dB**（大钢琴 -6.83 vs 无品贝斯 -19.29）——
   贝斯类比钢琴轻 12.5 dB，明显过头了。上一轮用户报「bass 太响」时
   我按理论值一口气压了 -15dB，压过头。

   ⚠️ 目标不是「全部一样响」，而是**按音乐角色分层**：

     · 旋律类（钢琴/吉他/弦乐/铜管/簧片/管乐/主音） → -8.5 dB
     · 打击装饰类（羽管键/击弦古钢/颤音琴/钟琴）     → -9.0 dB
     · 贝斯类                                        → -10.5 dB（比旋律轻 2dB，有底气不盖人）
     · 人声/合唱                                     → -11.5 dB
     · 铺底 pad                                      → -12.0 dB（背景就该退后）
   ══════════════════════════════════════════════════════════════ */

/** 逐 prog 实测校准（乘在 LOUD_CAL 之后）。数值 = 10^((目标 − 实测)/20) */
const TIMBRE_CAL2: Record<number, number> = {
  0: 0.825, 1: 0.872, 2: 0.718, 4: 0.756, 6: 0.882, 7: 0.752,
  24: 0.708, 25: 0.759, 28: 0.888, 29: 1.704,
  30: 2.670, 32: 2.752, 33: 2.818, 38: 2.739,
  40: 0.793, 42: 0.839, 45: 0.891, 48: 0.855, 52: 0.955,
  56: 1.224, 58: 1.152, 60: 1.406, 64: 1.165, 65: 1.219,
  68: 1.196, 71: 1.196, 73: 0.966,
  80: 0.999, 81: 0.971,
  88: 0.779, 89: 0.822, 95: 0.802, 96: 0.688,
};

/** 未精确覆盖时的分组校准（g = floor(prog/8)） */
const TIMBRE_CAL2_GROUP: number[] = [
  0.83,  // 0 钢琴
  0.80,  // 1 打击性（羽管键/钢片琴/钟琴类，装饰性，稍轻）
  0.95,  // 2 风琴
  0.80,  // 3 吉他
  2.75,  // 4 贝斯 ← **提 12.8dB**：上一轮压过头，导致 bass 缺底气
  0.84,  // 5 弦乐
  0.95,  // 6 合奏
  1.22,  // 7 铜管
  1.16,  // 8 簧片
  0.97,  // 9 管乐
  0.99,  // 10 合成主音
  0.80,  // 11 合成垫
  0.85,  // 12 合成效果
  1.00,  // 13 民族
  1.00,  // 14 打击
  1.00,  // 15
];

/** ═══ 打击乐第二轮实测校准 ═══
    实测（16 击/秒 vel127，K 计权 RMS）：
      36 底鼓 -8.20   38 军鼓 -7.76   42 闭镲 -11.58
      44 脚踏镲 -11.59  46 开镲 -7.90   45 嗵鼓 -13.90   49 吊镲 -14.62
    极差 6.86 dB。底鼓/军鼓/开镲偏响（比多数旋律音色还响），
    嗵鼓/吊镲偏轻。目标同样按角色分层。 */
const DRUM_CAL2: Record<DrumGrp, number> = {
  kick:    0.767,   // -8.20 → -10.5
  snare:   0.730,   // -7.76 → -10.5
  hat:     0.849,   // -11.58 → -13.0
  openhat: 0.660,   // -7.90 → -11.5（**压最多**：峰值 -1.62dBFS 全场最高）
  tom:     1.170,   // -13.90 → -12.5
  cymbal:  1.139,   // -14.62 → -13.5
};

/* ══════════════════════════════════════════════════════════════
   第三层：按 note 精确校准（本轮新增，修「鼓组层次不对」）

   ⚠️ 为什么必须细分到 note，而不是继续用 DrumGrp：

   实测（真实播放器渲染，各鼓件按典型密度单独播放，K 计权 RMS）：

     36 底鼓  -32.58    38 军鼓  -27.77    42 闭镲  -22.49
     44 脚踏镲 -23.54    46 开镲 -21.98    45 嗵鼓 -31.62
     41 低嗵  -32.98    43 中嗵 -31.92    49 吊镲 -34.12
     51 叮叮  -15.44    57 吊镲2 -19.56

   极差 **18.69 dB**。两个致命问题：
     ① **镲类整体最响**（叮叮 -15.44 比底鼓 -32.58 响 17 dB）——
        decay 长（吊镲 0.72s）＋ 高频密集，白拿能量
     ② **底鼓最轻** —— 用户明确报「kick 感觉没有 snare 响」，
        实测 snare 比 kick 响 **4.81 dB**，完全吻合

   而 cymbal 组内部就差 18.7 dB（49 吊镲 -34.12 vs 51 叮叮 -15.44），
   **任何单一组系数都无法同时修正** —— 这是组校准的结构性失效。

   目标按真实鼓组的层次（不是一刀切拉平）：
     底鼓/军鼓 最前 → 镲 中等 → 嗵鼓 稍后 → 闭镲/脚踏镲 最轻（节奏点缀）
   ══════════════════════════════════════════════════════════════ */
const DRUM_CAL3: Record<number, number> = {
  /* ── 底鼓 ── 去归一化 -41.57，峰值 -23.75（**全场最低**，没冲击力）
     用户明确报「kick 感觉没有 snare 响」。提到 -38（比军鼓响约 3dB） */
  35: 3.22, 36: 3.22,
  /* ── 军鼓 ── 去归一化 -41.52。作为基准，不动 */
  38: 1.16, 40: 1.16,
  /* ── 闭镲 / 脚踏镲 ── 去归一化 -42.26 / -42.08
     真实混音里 hat 是鼓组最轻的，压到 -43.5 */
  42: 0.323, 44: 0.353,
  /* ── 开镲 ── 去归一化 -39.36，比闭镲响是对的（decay 长），微压到 -40 */
  46: 0.391,
  /* ── 嗵鼓 ── 去归一化 -44.6 ~ -43.7，偏轻，提到 -42 */
  41: 2.10, 43: 1.71, 45: 1.82, 47: 1.82, 48: 1.89, 50: 1.89,
  /* ── 吊镲 ── 去归一化 -45.92（**最轻**），提到 -41
     ⚠️ 和 51 叮叮相反：同为 cymbal 组却一个最轻一个最响，
     组系数根本没法同时修正两者 —— 这就是必须按 note 校准的原因 */
  49: 3.56,
  /* ── 叮叮 ── 去归一化 -34.65（**全场最响**），压到 -40 */
  51: 0.138,
  /* ── 吊镲2 ── 去归一化 -36.44，压到 -40 */
  57: 0.285,
  /* 未单独实测的镲类，按同族量级给 */
  52: 0.19, 53: 0.19, 55: 0.18, 59: 0.19,
  54: 0.35, 56: 0.35, 58: 0.35,
};

/** 音色响度因子查询（带缓存，避免每音符都算一遍） */
const tfCache = new Map<number, number>();
function timbreFactor(prog: number): number {
  const hit = tfCache.get(prog);
  if (hit !== undefined) return hit;
  const v = TIMBRE_F[prog] ?? TIMBRE_F_GROUP[Math.floor(prog / 8)] ?? 1;
  tfCache.set(prog, v);
  return v;
}

/* 鼓的发声时长由 **decay** 决定，不是 MIDI 的 dur。
   ⚠️ 打击乐的 dur 通常只有 0.03s（note-on 后立刻 note-off），
   但实际声音按 decay 拖到 0.10~0.72s —— 用 dur 估算会**严重低估**长 decay 的镲。
   这是「镲太响」的根因之一：norm 以为它很短，把它提过头了。 */
const drDecayCache = new Map<number, number>();
function drumDecay(note: number): number {
  const h = drDecayCache.get(note);
  if (h !== undefined) return h;
  const v = drum(note).decay;
  drDecayCache.set(note, v);
  return v;
}

function estimateRms(notes: Note[], duration: number, q: Quality): number {
  const ATTACK = 0.012;
  let e = 0;
  for (const n of notes) {
    const v = n.vel / 127;
    const c = Math.max(1, n.conc || 1);
    /* ⚠️ 打击乐单独建模（本轮新增，修「鼓组层次不对」）
       原来打击乐也走旋律那套（用 dur、用 timbreFactor(prog)），而：
         · 鼓的发声时长 = decay，不是 dur（0.03s）→ 长 decay 的镲被严重低估
         · 鼓的三层校准（DRUM_CAL / CAL2 / CAL3）完全没算进去
         · 鼓的时间密度补偿（drumDensityComp）没算进去
       后果：norm 对鼓的估算错得离谱 ——
       实测改 DRUM_CAL3 系数 ×4，kick 只涨 6.8dB（理论 12dB）、ride 只涨 5.3dB，
       **效率只有 44~57%**，因为 norm 没跟着改，多出来的部分被软削波吃掉。 */
    if (isDrum(n)) {
      const g0 = drumGrp(n.note);
      const dP = Math.min(drumDecay(n.note) + 0.02, 1.5);
      let g = v;                                                     // 鼓是瞬态，reach = 1
      g *= DRUM_CAL[g0] * DRUM_CAL2[g0] * (DRUM_CAL3[n.note] ?? 1);
      g *= drumDensityComp(n.drate || 1);
      if (q) {
        if (!q.reverb) g *= 0.90;
      }
      e += g * g * dP;
      continue;
    }
    const reach = 1 - Math.exp(-Math.max(n.dur, 0.005) / ATTACK);   // 短音到不了峰值
    const d = Math.min(n.dur + RELEASE_TAIL, 1.5);                   // 含衰减尾，长音截断避免主导平均
    let g = v * reach * Math.pow(c, -POLY_EXP);                      // 和弦补偿
    g *= coherenceBoost(c);                                          // 相干性加成（实测标定）
    g *= timbreFactor(n.prog);                                       // 音色响度（实测标定）
    /* ★ 本轮新增：把角色增益算进响度估算。
       ⚠️ 真 bug：原来估算里**没有** roleGain，而播放时是乘了的
       （和弦声部 -7.5dB、铺底 -4.1dB）。于是「和弦多的曲子」估算偏高
       → norm 给不出应有的提升 → 整首偏小声。
       这正是「因为声部判定不同，音量大小也跟着不一样」的第二个来源：
       判定变了 → roleGain 变了 → 但估算没跟着变 → 曲子整体响度漂移。 */
    g *= roleGain(n);
    if (q) {
      if (!q.voices2) g *= 0.72;   // 少一个振荡器 ≈ -2.8dB
      if (!q.reverb) g *= 0.90;    // 少混响湿声
      if (!q.fx) g *= 0.95;
    }
    e += g * g * d;
  }
  return Math.sqrt(e / Math.max(1, duration));
}

function normGainFor(notes: Note[], duration: number, q: Quality): number {
  const est = estimateRms(notes, duration, q) * RMS_K;
  if (!(est > 0)) return 1;
  return Math.min(NORM_MAX, Math.max(NORM_MIN, TARGET_RMS / est));
}

/** 软削波曲线的输出上限（由曲线形状决定，下面生成曲线时回算）。
    t=0.7 时：0.7 + 0.3·tanh(1) ≈ 0.9285。用它算 outTrim 的系数，
    避免两处各写一个魔数、改了曲线忘了改 trim。 */
let SOFT_MAX = 0.9285;

/* ══════════════════════════════════════════════════════════════
   和弦（复音）增益补偿 —— 「和弦一厚，旋律就闷」的真因
   ══════════════════════════════════════════════════════════════
   ⚠️⚠️ **和贝斯盖人声是同一个机制，只是触发源不同**：

   同时响 N 个音符，总幅度按约 √N 累积（相位随机时）。
   原来**完全没有补偿** —— 和弦一厚、或踏板踩住挂一片音，
   总电平直接冲到 0.9 以上，把后面的宽带压缩器顶到阈值；
   压缩器是**不分声部**的，一压就把所有声部一起压下去。
   听感就是「和弦一出来，旋律和别的声部都闷了」，
   而且密集曲的峰值全靠压缩器硬扛，动态被压扁（没劲）。

   修法同样是**前馈**而不是事后压：按「同时发声数」提前把总线上
   的增益降下来，让总幅度大致恒定。压缩器就不用苦干，
   各声部的相对关系也不再被牵动。

   ⚠️ 指数改成 0.50（修过，实测反推）：
   原来取 0.40（理由是「0.5 太保守、和弦会没力」），但实测 chord1→chord16
   RMS **涨了 4.06dB**（-25.22 → -21.16），用户报「和弦太响」。
   按实测反推：要让 16 音和弦只比单音响约 1.5dB，补偿指数需 ≈ 0.505 ——
   **正好是 0.5（严格能量守恒）**。之前那句「0.5 太保守」是没测过的想当然。

   0.5 = 非相干叠加的能量守恒；实际 MIDI 和弦音高接近、叠加略超相干，
   所以 0.5 下和弦仍会比单音响一点（实测约 1.5dB），正是音乐上想要的分寸。 */
const POLY_EXP = 0.50;
/** 复音补偿系数。n = 同时发声数（1 表示独奏，返回 1.0 不衰减）。 */
/* ══════════════════════════════════════════════════════════════
   并发数的时间平滑 —— 「arps 响度有问题」的真因
   ══════════════════════════════════════════════════════════════
   ⚠️⚠️ 实测抓到（arpbal.mid，5 秒，旋律+断奏和弦+贝斯+16分音符琶音）：

       arp 音符的 conc：t0:c6  t0.125:c3  t0.25:c3  t0.375:c3  t0.5:c6 ...
       即 **拍点 6、拍间 3**，polyComp 0.408 vs 0.577 → **同一声部内跳变 3.01 dB**

   为什么：arp 是错开起音的连贯声部，但拍点那一刻和弦的 3 个音也在响，
   于是「起音瞬间的全局并发数」在拍点暴涨、拍间回落 ——
   补偿跟着跳，arp 就变成「拍点的音闷、拍间的音冒出来」。

   这**不是**和弦场景：和弦所有音同时起音，窗口内 conc 一致，平滑不改变它。
   所以平滑只影响 arp 这类错开起音的声部，正是我们要的。

   取窗口内**平均**（不是最大）：arp 拍间音符的窗口里也含拍点的高 conc，
   平均后两者趋同 → 跳变消失。整曲总电平仍由 norm + 压缩器把关。
   ══════════════════════════════════════════════════════════════ */
const CONC_SMOOTH_WIN = 0.15;    // 秒；≈ 16 分音符 @138BPM 的 1.4 倍间隔

function smoothConcurrency(notes: Note[], win = CONC_SMOOTH_WIN): void {
  const N = notes.length;
  if (N === 0) return;
  /* ── 先把并发数构造成时间轴上的分段常数函数 conc(t) ──
     ⚠️ 第一版我按「起音时刻」取滑动窗，实测只把跳变从 3.01dB 降到 2.71dB。
     原因：长音（lead 在 t=0 起音、持续到 0.4）在 t=0.25 明明还在响，
     但它的起音时刻 0 不在 [0.10, 0.40] 窗口内 → 被错误排除。
     平滑的对象必须是**时间轴上的发声状态**，不是音符列表。 */
  const ev: { t: number; d: number }[] = [];
  for (const x of notes) {
    ev.push({ t: x.time, d: 1 });
    ev.push({ t: x.time + Math.max(x.dur, 0.005) + RELEASE_TAIL, d: -1 });
  }
  ev.sort((a, b) => a.t - b.t || a.d - b.d);
  const segT: number[] = [];
  const segC: number[] = [];
  let cur = 0, i = 0;
  while (i < ev.length) {
    const t = ev[i].t;
    while (i < ev.length && ev[i].t === t) { cur += ev[i].d; i++; }
    segT.push(t); segC.push(Math.max(0, cur));
  }
  const m = segT.length;
  if (m < 2) return;
  /* 前缀积分：cum[k] = ∫(-∞ → segT[k]) conc */
  const cum = new Float64Array(m);
  for (let k = 0; k < m - 1; k++) cum[k + 1] = cum[k] + segC[k] * (segT[k + 1] - segT[k]);
  const prefixAt = (t: number): number => {
    if (t <= segT[0]) return 0;
    if (t >= segT[m - 1]) return cum[m - 1];
    let lo = 0, hi = m - 2;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segT[mid] <= t) lo = mid; else hi = mid - 1; }
    return cum[lo] + segC[lo] * (t - segT[lo]);
  };
  /* 每个音符取 [t-win, t+win] 上的平均并发 */
  for (const x of notes) {
    const a = x.time - win, b = x.time + win;
    const v = (prefixAt(b) - prefixAt(a)) / Math.max(1e-6, b - a);
    x.conc = Math.max(1, v);
  }
}

function polyComp(n: number): number {
  if (n <= 1) return 1;
  /* 下限兜底：极端密集（例如整段踏板挂住 + 密集琶音）时不要压到听不见 */
  return Math.max(0.22, 1 / Math.pow(n, POLY_EXP));
}
/* ══════════════════════════════════════════════════════════════
   打击乐时间密度（drate）：解析期算好，供 drumDensityComp 使用
   ══════════════════════════════════════════════════════════════
   统计「最近 1 秒内该音符所属鼓件组敲了多少次」。
   ⚠️ 按**鼓件组**分组统计，而不是整个打击乐通道：
     底鼓 4 击/秒 + hat 16 击/秒 时，若按通道统计两边都是 20 击/秒，
     底鼓会被误压（它其实很稀疏）。按组分开才准。
   ══════════════════════════════════════════════════════════════ */
function smoothDrumRate(notes: Note[], win = 1.0): void {
  /* 按鼓件组分别收集击打时刻 */
  const byGrp = new Map<DrumGrp, number[]>();
  const idxOf = new Map<DrumGrp, number[]>();
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (!isDrum(n)) continue;
    const g = drumGrp(n.note);
    let a = byGrp.get(g); if (!a) { a = []; byGrp.set(g, a); }
    let b = idxOf.get(g); if (!b) { b = []; idxOf.set(g, b); }
    a.push(n.time); b.push(i);
  }
  for (const g of byGrp.keys()) {
    const times = byGrp.get(g) || [], idxs = idxOf.get(g) || [];
    /* 双指针滑窗：O(n)，避免 O(n²)。times 已按解析顺序（时间升序） */
    let lo = 0, hi = 0;
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      while (lo < times.length && times[lo] < t - win) lo++;
      while (hi < times.length && times[hi] <= t + win) hi++;
      const cnt = hi - lo;
      /* 窗口总宽 2*win → 换算每秒击数 */
      notes[idxs[i]].drate = (cnt / (2 * win)) * 2;
    }
  }
}

/** 打击乐的复音补偿：更缓的指数 + 更高的下限（保住冲击力）。 */
function drumComp(n: number): number {
  if (n <= 1) return 1;
  return Math.max(0.5, 1 / Math.pow(n, 0.25));
}

/* ══════════════════════════════════════════════════════════════
   和弦/伴奏声部的角色增益 —— 用户明确要求
   ══════════════════════════════════════════════════════════════
   要求原文：**「chord 部分还是响，能不能弄得和 bass 一样再比 bass 小」**

   ⚠️ 先说清测量与听感的矛盾（重要，决定了我为什么这样修）：
   分别渲染单声部、K 计权实测：
     bass  (vel100) -20.64 dB / (vel127) -23.46 dB
     chord (3音)    -31.68 dB / (6音 vel127 密集) -31.62 dB
   → **数值上和弦已经比贝斯小 8~11 dB**。

   那为什么听感上还是「和弦响」？两个原因，都不是绝对响度：

   ① **等响曲线**：人耳在 1~4kHz 最敏感，低频迟钝。K 计权只在 2kHz 以上
      抬 4dB、在 38Hz 压 6dB，对 100Hz vs 1kHz 的真实等响差（约 10~15dB）
      覆盖不足 —— 所以「贝斯数值响但听着轻、和弦数值轻但听着响」。
      **我的指标系统性低估了中频（和弦所在）的感知响度。**

   ② **掩蔽**：6 音 × 6 谐波 = 36 条谱线挤在 250~2000Hz，形成一道「音墙」，
      把旋律的谱线淹没。这是**相对**问题，单纯降 gain 只能缓解不能根治。

   所以我做两件事，**不再只靠降 gain**：
     A. 角色增益：和弦声部往下压（响应用户要求）
     B. **推远**：加大混响送出、减小直达声 —— 干湿比变化让声部在听觉上后退，
        这是混音里处理「伴奏盖主旋律」的标准做法，比单纯降音量有效得多

   判定：conc >= 3 视为和弦/伴奏声部（独奏旋律通常是单音或八度双音）。
   ⚠️ 打击乐（ch 9）不走这里：鼓是节奏骨架，压了会散。

   想再压就调小 CHORD_ROLE_GAIN（0.5 = -6dB，0.4 = -8dB）。 */
const CHORD_ROLE_GAIN = 0.42;    // 和弦声部主增益（0.42 ≈ -7.5 dB）
const CHORD_ROLE_HEAVY = 0.82;   // 6 音以上的大和弦再乘一次（再 -1.7 dB）
const BASS_ROLE_GAIN = 0.95;     // 低音区（B2 以下）内声部增益（≈ -0.4 dB）
const CHORD_MIN_CONC = 3;        // 保留兼容（同通道并发，仅用于估算响度）
const BASS_MAX_NOTE = 47;        // 低于这个音高（B2）算低音区
/* ══════════════════════════════════════════════════════════════════
   ★ 声部角色模型（本轮新增）
   ══════════════════════════════════════════════════════════════════
   问题：MIDI 里「这是什么声部」从来不是写在数据里的。

   GM 只规定了一条 —— **通道 9 是打击乐**。其余全靠约定，而约定常被打破：
     · 鼓不在 9 轨（XG/GS、游戏 MIDI、手机铃声转制、部分 DAW 导出）
     · 贝斯用合成 Lead / 钢琴 / 甚至管风琴的低音区弹
     · 一条通道里混着和弦与旋律（键盘录制）
     · 有些文件**通道 9 上放的是旋律**（非 GM 文件，通道号乱用）

   判错的后果是连锁的，不只是「音色不对」：
     1. 鼓没判成鼓 → 走旋律合成器 → 噪声当乐音，声音完全不对
     2. 贝斯没判成贝斯 → 用旋律的亮度/混响/响度校准 → **音量偏大或偏小**
        这正是「鼓或 bass 用的不是常规声部时音量出现差异」的根因

   解决：**多信号投票**，按可靠度排序，取第一个命中的：
     ① 轨道名（作者意图的直接证据，最可靠）
     ② GM 约定（通道 9）
     ③ 音色族（GM program 分组）
     ④ 音高/时值统计启发式（兜底）
   每个通道单独判定，写进 n.role。
   ══════════════════════════════════════════════════════════════════ */
const ROLE_MEL = 0;     // 旋律 / 主奏（默认）
const ROLE_BASS = 1;    // 贝斯 / 低音
const ROLE_DRUM = 2;    // 打击乐
const ROLE_CHORD = 3;   // 和弦 / 伴奏
const ROLE_PAD = 4;     // 铺底 / 垫
const ROLE_VOCAL = 5;   // 人声（Choir / Voice）
const ROLE_COUNTER = 6; // 副旋律 / 对位声部
const ROLE_ARP = 7;     // 琶音 / 分解和弦
const ROLE_BRASS = 8;   // 铜管声部
const ROLE_STRINGS = 9; // 弦乐声部
const ROLE_FX = 10;     // 音效 / 装饰音
/** 铺底声部增益：背景就该轻，但不能轻到听不见（0.62 ≈ -4.1dB） */
const PAD_ROLE_GAIN = 0.62;
/* ── 新增声部的层次增益（相对主旋律的偏移） ──
   层次目标（混音常识 + 用户反馈反复校准）：
     人声 ≈ 主旋律 > 贝斯 > 副旋律 > 琶音 > 铜管 > 弦乐 > 铺底 > 和弦 > 音效
   ⚠️ 这些是**层次偏移**，不是绝对响度 —— 音色自身的响度由
   LOUD_CAL / TIMBRE_CAL2 逐 prog 实测校准，两者相乘。
   用户要的正是这个解耦：同一个钢琴音色，弹旋律按旋律校准，
   弹伴奏再乘「伴奏」的层次偏移。 */
const VOCAL_ROLE_GAIN = 1.00;   // 人声要和主旋律一样突出（歌词信息量最高）
const COUNTER_ROLE_GAIN = 0.75; // 副旋律：-2.5dB，在旋律之下但不消失
const ARP_ROLE_GAIN = 0.71;     // 琶音：-3dB（密集且持续，容易盖人）
const BRASS_ROLE_GAIN = 0.67;   // 铜管声部：-3.5dB
const STRINGS_ROLE_GAIN = 0.63; // 弦乐声部：-4dB
const FX_ROLE_GAIN = 0.38;      // 音效/装饰：-8.4dB（纯点缀，全曲最轻）
/** 角色 → 中文名（UI 展示 / 诊断用） */
const ROLE_NAMES: string[] = ['旋律', '贝斯', '打击乐', '和弦/伴奏', '铺底', '人声', '副旋律', '琶音', '铜管', '弦乐', '音效'];
/** 轨道名关键词 → 角色。中英日都覆盖，大小写不敏感。
    ⚠️ 顺序 = 优先级（先命中者胜），越具体越靠前。
   实测踩过的坑：把 `organ|ensemble|string` 都塞进 PAD 规则里，
   于是「弦乐」和「摇滚风琴主奏」都被判成铺底压掉。现在拆开。 */
const NAME_ROLE_RULES: { re: RegExp; role: number }[] = [
  { re: /drum|perc|kit|beat|鼓|打[击楽]?|爵士鼓|节奏|rhythm\s*section/i, role: ROLE_DRUM },
  { re: /bass|bajo|贝[斯司]|低音|b\.?s\.?\s*$/i, role: ROLE_BASS },
  { re: /arp(e|eg)?|琶音|arpeggio|アルペジオ/i, role: ROLE_ARP },
  { re: /vocal|voice|vox|choir|chorus|唱|人声|歌声|ボーカル/i, role: ROLE_VOCAL },
  { re: /counter|sub\s*mel|副旋|副旋律|对位|対旋律/i, role: ROLE_COUNTER },
  { re: /chord|comp|accomp|和弦|伴奏|伴[奏]?|guitar\s*rhythm/i, role: ROLE_CHORD },
  { re: /brass|horn|trumpet|trombone|tuba|铜管|管[乐]?|ホーン/i, role: ROLE_BRASS },
  { re: /pad|垫|铺底|drone|背景/i, role: ROLE_PAD },
  { re: /string|violin|cello|viola|ensemble|弦乐|弦[乐]?|ストリングス/i, role: ROLE_STRINGS },
  { re: /fx|sfx|effect|音效|装饰|効果音/i, role: ROLE_FX },
  { re: /lead|melody|melod|solo|主旋|旋[律]?|主[音奏]?|メロディ/i, role: ROLE_MEL },
];
/* GM 音色族 → 角色。
   ⚠️ 只标「音色本身就决定了用途」的：
     · Bass 族（32~39）—— 出现即低音，几乎无例外
     · Synth Pad（88~95）—— 音色定义就是铺底
     · Synth FX / SFX（96~103 / 120~127）—— 纯音效
     · Choir Aahs(52) / Voice(54) / Lead7 voice(85) —— 人声
   ⚠️ Brass(56~63) / Strings(40~47) **只是弱暗示**：小号独奏、小提琴独奏
   太常见了，直接按「声部」压 -4dB 会把独奏压没。所以这两个族在
   roleGain 里额外判「是不是齐奏」—— 单音当旋律，多音才算 section。 */
function progRole(prog: number): number {
  if (prog >= 32 && prog <= 39) return ROLE_BASS;
  /* ⚠️ 修过：GM 分组记错了。
       · 弦乐合奏（String Ensemble）是 **48~51**，不在 Strings 组 40~47 里
         → 实测 program 48 齐奏被判成「旋律」，拿不到声部处理
       · **50 不是 Synth Voice**（那是 54），50/51 是 Synth Strings
     GM 实际分组：
       40~47 Strings（40 小提琴 … 45 拨弦 / 46 竖琴 / 47 定音鼓）
       48~55 Ensemble（48/49 弦乐合奏、50/51 合成弦乐、**52/53 人声**、54 合成人声、55 管弦乐齐奏）
     46 竖琴 / 47 定音鼓不归弦乐（竖琴常独奏，定音鼓是打击乐）。 */
  if ((prog >= 40 && prog <= 45) || (prog >= 48 && prog <= 51)) return ROLE_STRINGS;
  if (prog === 52 || prog === 53 || prog === 54 || prog === 85) return ROLE_VOCAL;
  if (prog === 19) return ROLE_PAD;                           // 教堂风琴
  if (prog >= 88 && prog <= 95) return ROLE_PAD;              // Synth Pad
  if (prog >= 96 && prog <= 103) return ROLE_FX;              // Synth Effects
  if (prog >= 120 && prog <= 127) return ROLE_FX;             // Sound Effects
  if (prog >= 56 && prog <= 63) return ROLE_BRASS;
  return ROLE_MEL;
}
/* ══════════════════════════════════════════════════════════════════
   角色档案：每个声部的「混音处理」，不只有音量
   ══════════════════════════════════════════════════════════════════
   原来只有 isChordVoice 一个二值开关，同时控制软起音 / 混响推远 /
   频谱变暗 / click 削弱 —— 于是「和弦」之外的所有背景声部
   （弦乐、铜管、琶音、铺底）都拿不到任何处理，只能靠音量硬压。

   改成每个角色一组系数：
     wet    混响送出倍率（>1 = 推远，<1 = 拉近）
     bright 亮度倍率（<1 = 让出中高频给旋律，减少掩蔽）
     atk    起音时间倍率（>1 = 软起音，削弱瞬态冲击）
     click  击弦/拨弦瞬态噪声倍率
   ══════════════════════════════════════════════════════════════════ */
const ROLE_PROFILE: { wet: number; bright: number; atk: number; click: number }[] = [
  { wet: 1.00, bright: 1.00, atk: 1.00, click: 1.00 },  // 0 旋律：不做处理
  { wet: 0.85, bright: 1.02, atk: 1.00, click: 1.00 },  // 1 贝斯：拉近（低频混响重会糊）
  { wet: 1.00, bright: 1.00, atk: 1.00, click: 1.00 },  // 2 打击乐：走 DRUM_CAL，不在这里
  { wet: 2.30, bright: 0.88, atk: 1.50, click: 0.30 },  // 3 和弦：推远 + 变暗 + 软起音
  { wet: 2.00, bright: 0.92, atk: 1.30, click: 0.30 },  // 4 铺底
  { wet: 1.10, bright: 1.05, atk: 1.00, click: 1.00 },  // 5 人声：略加空间但要清晰
  { wet: 1.40, bright: 0.96, atk: 1.20, click: 0.60 },  // 6 副旋律
  { wet: 1.30, bright: 0.96, atk: 1.15, click: 0.70 },  // 7 琶音
  { wet: 1.50, bright: 0.98, atk: 1.15, click: 0.60 },  // 8 铜管
  { wet: 1.80, bright: 0.95, atk: 1.25, click: 0.40 },  // 9 弦乐
  { wet: 1.60, bright: 1.00, atk: 1.00, click: 0.80 },  // 10 音效
];
/** 音高/时值启发式：这个通道像不像一套鼓？
    判据（三条同时成立才认）：
      · ≥90% 的音落在 GM 打击乐音域 35~81
      · ≥80% 的音时长 < 0.15s（鼓是瞬态，旋律不会这样）
      · 音符数 ≥ 8（样本太少不猜）
    ⚠️ 必须放在「音色族」之后：贝斯音域 35~55 也在 35~81 内，
       但贝斯会先被 program / 音高判定接走。 */
function looksLikeDrum(cnt: number, inRange: number, shortFrac: number): boolean {
  return cnt >= 8 && inRange / cnt >= 0.90 && shortFrac >= 0.80;
}
/** 音高启发式：这个通道像不像贝斯线？
    判据：中位音高 ≤ C3(48) 且 90 分位 ≤ G3(55)，即整条线都在低音区。 */
function looksLikeBass(median: number, p90: number): boolean {
  return median <= 48 && p90 <= 55;
}
/** 和弦声部的角色增益。n = 同时发声数。 */
/* ══════════════════════════════════════════════════════════════
   ⚠️⚠️ **「chord 还是比 lead 响」的真因（本轮定位，实测 + 算术双重确认）**

   原来的 chordRole 用**同通道并发数**判定。这在真实 MIDI 上**几乎必然失效**：
   钢琴曲（以及绝大多数键盘录制的 MIDI）里，右手旋律和左手和弦写在
   **同一个通道**，于是同一时刻所有音符的 voices 都一样大 ——
   旋律也被判成「和弦声部」，和弦音也被判成「和弦声部」，
   **chordRole 退化成一个共同因子，完全没有区分作用**。

   而 polyComp 补偿的是**整体**（让 N 个音的总和 ≈ 单个音），
   它不会改变「3 音和弦 vs 1 个旋律音」的相对关系：
     同一瞬间，和弦 3 个音每个幅度 a，旋律 1 个音也是 a
     → 和弦总能量 3a²，旋律 a²  → **和弦比旋律响 4.8 dB**
   这是算术上必然的，与任何测量无关，也正是用户反复听到的现象。

   修法：**按音高排名区分角色**。同一「同时发声组」内音高最高的那个音
   就是旋律（真实音乐里旋律几乎总是最高声部），其余是内声部。
   这样即使旋律和和弦挤在同一通道，也能正确区分。

   数值怎么定的（按「3 音和弦的总能量要低于 1 个旋律音」反推）：
     和弦每音 g，3 音总能量 = 3g²，要 ≤ 0.7（即 -1.5dB）→ g ≤ 0.483
     → 取 0.45，3 音总和 0.6075 = **-2.2 dB**，比旋律轻
     低音区（B2 以下）单独给 0.85：用户要求「chord 和 bass 一样或更小」
     → 0.85² = 0.72 > 0.6075，bass 比 chord 总能量高 0.75dB ✓
   ══════════════════════════════════════════════════════════════ */
function roleGain(n: Note): number {
  /* ══════════════════════════════════════════════════════════════
     ⚠️ 本轮：先按**作者意图判定出的声部角色**走，再退回音高排名
     ══════════════════════════════════════════════════════════════
     原来只看「同时发声组内音高排名」。这对钢琴曲有效，但遇到
     「贝斯用非贝斯音色」「鼓不在 9 轨」就会判错 —— 判错不仅音色错
     （贝斯走了旋律的亮度/混响），**响度也跟着错**（走错校准表）。
     所以检测出的角色优先。 */
  const role = n.role == null ? ROLE_MEL : n.role;
  const gp = n.grp || 1;
  if (role === ROLE_DRUM) return 1;                       // 鼓走 DRUM_CAL，不在这里压
  if (role === ROLE_BASS) return BASS_ROLE_GAIN;
  if (role === ROLE_CHORD) return chordGain(gp);
  if (role === ROLE_PAD) return PAD_ROLE_GAIN;
  if (role === ROLE_VOCAL) return VOCAL_ROLE_GAIN;
  if (role === ROLE_COUNTER) return COUNTER_ROLE_GAIN;
  if (role === ROLE_ARP) return ARP_ROLE_GAIN;
  if (role === ROLE_FX) return FX_ROLE_GAIN;
  /* ⚠️ 铜管 / 弦乐是**弱暗示**：这两个族里独奏太常见（小号 solo、小提琴 solo），
     直接按 section 压 -4dB 会把独奏压没。所以看**是不是齐奏** ——
     同组内只有 1 个音 → 当旋律；多个音一起 → 才是 section 声部。

     ⚠️ 必须用 **n.voices（同通道并发）**，不能用 gp（全局并发）：
     gp 是「全曲这一瞬间一共响几个音」。全奏段落里小号独奏的 gp 也是 10+，
     于是独奏被当成 section 压掉 —— 实测 rolenoname.mid 里通道 11
     小提琴独奏的 grpMax 就是 14（其它通道同时起音），用 gp 会误压。
     而「齐奏」指的是**本声部**同时按几个键，正是 voices 的定义。 */
  if (role === ROLE_STRINGS || role === ROLE_BRASS) {
    if ((n.voices || 1) <= 1) return 1;
    return role === ROLE_STRINGS ? STRINGS_ROLE_GAIN : BRASS_ROLE_GAIN;
  }
  /* 未判定出具体声部（ROLE_MEL）：退回音高排名 ——
     钢琴曲右手旋律和左手和弦常写在**同一通道**，只能按音高区分。 */
  const r = n.rank || 0;
  if (r === 0) return 1;                                  // 组内最高音 = 旋律
  if (n.note <= BASS_MAX_NOTE) return BASS_ROLE_GAIN;     // 低音区
  return chordGain(gp);
}
/** 和弦声部增益（按同时发声数）。 */
function chordGain(gp: number): number {
  return gp >= 6 ? CHORD_ROLE_GAIN * CHORD_ROLE_HEAVY : CHORD_ROLE_GAIN;
}
/** 取这个音符的混音档案（推远 / 亮度 / 软起音 / 瞬态）。
    角色未判定出具体声部时，按音高排名回落到旋律 / 低音 / 和弦三种档案。 */
function roleProfile(n: Note) {
  const role = n.role == null ? ROLE_MEL : n.role;
  /* ⚠️ 实测抓到的不一致：单音的铜管/弦乐 gain=1（独奏不压），
     但档案里 wet 仍是 1.5 / 1.8（推远）→ 混响湿声更多 → **RMS 反而比
     主旋律还高**（实测 Brass -27.92 dB vs Lead -27.97 dB）。
     音量上「当旋律」，空间上却「推远」，两者矛盾。
     独奏（同通道同时只有 1 个音）就该**完全按旋律处理**：不压也不推远。 */
  if (role === ROLE_STRINGS || role === ROLE_BRASS) {
    if ((n.voices || 1) <= 1) return ROLE_PROFILE[ROLE_MEL];
    return ROLE_PROFILE[role];
  }
  if (role !== ROLE_MEL) return ROLE_PROFILE[role] || ROLE_PROFILE[ROLE_MEL];
  const r = n.rank || 0;
  if (r === 0) return ROLE_PROFILE[ROLE_MEL];
  if (n.note <= BASS_MAX_NOTE) return ROLE_PROFILE[ROLE_BASS];
  return ROLE_PROFILE[ROLE_CHORD];
}
/** 是否按「内声部」处理（推远 + 频谱变暗）。低音区不做推远 ——
    低频混响重了会糊成一团，bass 会失去轮廓。 */
function isChordVoice(n: Note): boolean {
  /* ★ 改为基于角色档案：原来只认「音高排名 ≥1」的和弦音，
     于是弦乐 / 铜管 / 琶音 / 铺底这些**同样需要推远**的背景声部
     全都被当成旋律，拿不到任何处理，只能靠音量硬压。 */
  return !isDrum(n) && roleProfile(n).wet > 1.2;
}
/** 兼容旧调用（同通道并发），仅响度估算用。 */
function chordRole(n: number): number {
  if (n < CHORD_MIN_CONC) return 1;
  return n >= 6 ? CHORD_ROLE_GAIN * CHORD_ROLE_HEAVY : CHORD_ROLE_GAIN;
}

/** 给每个音符算出「发声瞬间同时有多少音符在响」，写进 n.conc（全局）
    与 n.voices（同通道内）。扫描线：O(n log n)，4000 音符实测毫秒级。

    ⚠️⚠️ 真 bug（本轮修）：发声音窗原来只用**名义 dur**，忽略了衰减尾。
   estimateRms 里算能量用的是 `dur + RELEASE_TAIL`，两处口径不一致。
   后果：arp 这种「短音 + 快间隔」的声部，名义上互不重叠（dur 0.11 < 间隔 0.125），
   conc 只有 1~3；但每个音实际还有约 0.25 秒尾音在响，真实叠加约 3 倍。
   → 补偿严重不足，arp 偏响，且拍点/拍间跳变被放大。

   改成与 estimateRms 同口径（dur + RELEASE_TAIL）。

   ⚠️ 用「起音时刻的并发数」而不是「发声期间的峰值」——
    决定峰值的是起音那一瞬（ADSR 的 attack 峰），不是后续延续。

    ══════════════════════════════════════════════════════════
    ⚠️ 致命 bug（本轮修）：原来只算**全局**并发，而和弦角色判定
    （isChordVoice）也用这个值 —— 后果是**主旋律被当成伴奏压掉**。

    实测场景：8 音色乐队一起响（贝斯 / 钢琴4音 / 吉他3音 / 弦乐 / 铜管 /
    长笛 / 电钢3音 / 鼓），全局 conc ≈ 15。于是：
      · 长笛主旋律（**同通道内只有 1 个音**）的 conc 也是 15
      · 被判为「和弦声部」→ 乘 CHORD_ROLE_GAIN 0.5（-6dB）
                          + 混响推远 ×2.3
                          + bright ×0.88（频谱变暗）
      · 结果：主旋律比伴奏还轻，混在音墙里听不见 —— 就是用户说的「lead 弱了」

    正确判据：和弦是**同一乐器同时按几个键**，主旋律在独立通道。
    所以角色判定必须用**同通道内**的并发数，不是全局。

    拆分：
      n.conc   = 全局并发  → 给 polyComp 用（防整体削波，全局才是对的）
      n.voices = 同通道并发 → 给 chordRole / isChordVoice 用（角色判定）

    ⚠️ 打击乐（ch 9）按音高分组算 voices：一套鼓里 36/38/42 是不同鼓件，
    同时敲是正常的，不该被当成和弦压掉（压了鼓会散）。鼓本来就不走
    chordRole（isChordVoice 里已排除 ch 9），这里保持 voices=1 即可。 */
/* ══════════════════════════════════════════════════════════════════
   ★ assignRoles：判定每个通道在原作者眼里是什么声部
   ══════════════════════════════════════════════════════════════════
   输入：音符表 + parseMidi 收集到的轨道信息（轨道名 + 该轨用到的通道）
   输出：写回 n.role，并返回通道 → 角色摘要（给 UI 显示）

   判定顺序（先命中者胜，越靠前越可靠）：
     ① 轨道名关键词  —— 作者意图的直接证据
     ② GM 约定 ch 9  —— 但**可被轨道名推翻**（非 GM 文件会把 9 轨当旋律用）
     ③ GM 音色族     —— program 32~39 是贝斯族
     ④ 音高启发式    —— 整条线都在低音区 → 贝斯
     ⑤ 鼓启发式      —— 音域集中 35~81 + 几乎全是短音 → 鼓

   ⚠️ ②可推翻是刻意的：见过「通道 9 上写着 'Melody'」的文件。
      轨道名是作者手写的，比通道号的约定更可信。
   ══════════════════════════════════════════════════════════════════ */
/* 返回值类型不写：strip_ts 不处理返回类型注解（会漏掉 `): X {` 这一截） */
function assignRoles(notes: Note[], tracks: { name: string; chans: Set<number> }[]) {
  /* 通道 → 轨道名（一条通道可能出现在多条轨里，全部拼起来） */
  const nameByCh = new Map<number, string>();
  for (const tr of tracks) {
    if (!tr.name) continue;
    for (const c of tr.chans) {
      const prev = nameByCh.get(c);
      nameByCh.set(c, prev ? `${prev} / ${tr.name}` : tr.name);
    }
  }

  /* 每个通道的统计量 */
  const byCh = new Map<number, Note[]>();
  for (const n of notes) {
    let a = byCh.get(n.ch);
    if (!a) { a = []; byCh.set(n.ch, a); }
    a.push(n);
  }

  const out: { ch: number; role: number; name: string }[] = [];
  for (const [ch, arr] of byCh) {
    const name = nameByCh.get(ch) || '';
    let role = -1;

    /* ① 轨道名 */
    if (name) for (const r of NAME_ROLE_RULES) { if (r.re.test(name)) { role = r.role; break; } }

    /* ② GM 约定（仅在轨道名没说话时） */
    if (role < 0 && ch === 9) role = ROLE_DRUM;

    /* 统计（③④⑤ 用） */
    const pitches = arr.map((n) => n.note).sort((a, b) => a - b);
    const median = pitches[Math.floor(pitches.length / 2)];
    const p90 = pitches[Math.min(pitches.length - 1, Math.floor(pitches.length * 0.9))];
    let inRange = 0, shortCnt = 0;
    for (const n of arr) {
      if (n.note >= 35 && n.note <= 81) inRange++;
      if (n.dur < 0.15) shortCnt++;
    }
    /* 该通道最常用的音色（多音色轨取众数） */
    const progCnt = new Map<number, number>();
    for (const n of arr) progCnt.set(n.prog, (progCnt.get(n.prog) || 0) + 1);
    let topProg = 0, topN = 0;
    for (const [k, v] of progCnt) if (v > topN) { topN = v; topProg = k; }

    /* ③ 音色族 */
    if (role < 0) { const pr = progRole(topProg); if (pr !== ROLE_MEL) role = pr; }

    /* ④ 琶音启发式 —— ⚠️ 必须放在鼓启发式**之前**
       实测踩到的坑：琶音（C4~C5，16 个 0.1s 短音，0.125s 均匀间隔）
       同时满足鼓的三条判据（音高全在 35~81、时长全 < 0.15s、数量 ≥ 8），
       于是被判成**打击乐** → 走 DRUM_CAL 按鼓件号查表，声音完全不对。
       而鼓同样也满足琶音的判据（间隔也均匀、音高集合也小），
       所以不能靠「谁先谁后」随便定，要有**区分度**：
         鼓件号集中在 35~55（底鼓 36、军鼓 38/40、踩镲 42/44、嗵鼓 41~50）
         琶音在**中高音区**（分解和弦通常在 C4 以上）
       故给 arp 加一条 `median >= 55`：低音区一律不猜琶音。
       判据（五条同时成立才认）：
         · 音符数 ≥ 16（样本太少不猜）
         · 唯一音高数 3~10（在小集合里循环，不是自由旋律）
         · 时长中位数 < 0.30s
         · 起音间隔规律（变异系数 < 0.2，机器式均匀）
         · 中位音高 ≥ 55（中高音区） */
    if (role < 0) {
      const uniq = new Set(arr.map((n2) => n2.note));
      const durs2 = arr.map((n2) => n2.dur).sort((a, b) => a - b);
      const medDur2 = durs2[Math.floor(durs2.length / 2)];
      const sorted = arr.slice().sort((a, b) => a.time - b.time);
      const gaps: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const gg = sorted[i].time - sorted[i - 1].time;
        if (gg > 1e-6) gaps.push(gg);
      }
      let gm = 0;
      for (const gg of gaps) gm += gg;
      gm /= Math.max(1, gaps.length);
      let gv = 0;
      for (const gg of gaps) gv += (gg - gm) * (gg - gm);
      const cv = gm > 0 && gaps.length ? Math.sqrt(gv / gaps.length) / gm : 9;
      if (arr.length >= 16 && uniq.size >= 3 && uniq.size <= 10
        && medDur2 < 0.30 && cv < 0.2 && median >= 55) {
        role = ROLE_ARP;
      }
    }

    /* ④⑤ 两个启发式**一起算，再裁决** —— 不能分先后。
       ⚠️ 实测踩到的坑：鼓的音域 36~42 完全落在贝斯的判据里
       （median 38 ≤ 48、p90 42 ≤ 55），所以「先判贝斯」会把一套鼓
       **误判成贝斯** —— 鼓就走旋律合成器，声音完全不对。
       裁决依据：**时长**。鼓是瞬态（≤0.12s），贝斯即使断奏也有轮廓。 */
    const drumH = looksLikeDrum(arr.length, inRange, shortCnt / arr.length);
    const bassH = looksLikeBass(median, p90);
    if (role < 0) {
      const durs = arr.map((n) => n.dur).sort((a, b) => a - b);
      const medDur = durs[Math.floor(durs.length / 2)];
      if (drumH && bassH) role = medDur < 0.12 ? ROLE_DRUM : ROLE_BASS;
      else if (drumH) role = ROLE_DRUM;
      else if (bassH) role = ROLE_BASS;
    }
    /* ⑥ 琶音启发式已上移到鼓启发式之前（见下方 ④），此处不再重复 */
    /* 兜底：旋律 */
    if (role < 0) role = ROLE_MEL;

    for (const n of arr) n.role = role;
    out.push({ ch, role, name });
  }
  return out;
}

/** 是否打击乐。★ 不再用 `n.ch === 9` —— 鼓可能在别的通道上。 */
function isDrum(n: Note): boolean { return n.role === ROLE_DRUM; }

function assignConcurrency(notes: Note[]): void {
  /* 全局扫描线 */
  const ev: { t: number; d: number }[] = [];
  for (const n of notes) {
    ev.push({ t: n.time, d: 1 });
    ev.push({ t: n.time + n.dur + RELEASE_TAIL, d: -1 });   // 含衰减尾，与 estimateRms 一致
  }
  ev.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0, ei = 0;
  for (const n of notes) {
    while (ei < ev.length && ev[ei].t <= n.time + 1e-9) { cur += ev[ei].d; ei++; }
    n.conc = cur > 0 ? cur : 1;
  }

  /* ══════════════════════════════════════════════════════════
     ⚠️ 声部角色排名（本轮新增）：按「同时发声组」内的音高排名。
     组 = 起音时刻相差 < 30ms 的所有非打击乐音符（30ms 容差是为了容纳
     记谱里微小的错位；strum 最多少 42ms，但排名在 strum **之前**算，
     用的是原始时刻，所以不受影响）。

     组内按音高从高到低排序：第 0 个 = 旋律，其余 = 内声部。
     ⚠️ 必须用**全局**组而不是按通道分组：按通道分组的话，
     单独一个通道里的 3 音和弦，其最高音会被误判成旋律（rank 0），
     拿不到内声部的衰减 —— 正是要避免的情况。 */
  {
    const byOnset = new Map<number, Note[]>();
    for (const n of notes) {
      if (isDrum(n)) { n.rank = 0; n.grp = 1; continue; }
      const k = Math.round(n.time * 33);          // 30ms 桶
      let a = byOnset.get(k);
      if (!a) { a = []; byOnset.set(k, a); }
      a.push(n);
    }
    for (const g of byOnset.values()) {
      g.sort((x, y) => y.note - x.note);
      for (let i = 0; i < g.length; i++) { g[i].rank = i; g[i].grp = g.length; }
    }
  }

  /* 同通道扫描线：按 ch 分组，各自跑一遍 */
  const byCh = new Map<number, Note[]>();
  for (const n of notes) {
    let a = byCh.get(n.ch);
    if (!a) { a = []; byCh.set(n.ch, a); }
    a.push(n);
  }
  for (const [, arr] of byCh) {
    const ev2: { t: number; d: number }[] = [];
    for (const n of arr) {
      ev2.push({ t: n.time, d: 1 });
      ev2.push({ t: n.time + n.dur, d: -1 });
    }
    ev2.sort((a, b) => a.t - b.t || a.d - b.d);
    let c2 = 0, e2 = 0;
    for (const n of arr) {
      while (e2 < ev2.length && ev2[e2].t <= n.time + 1e-9) { c2 += ev2[e2].d; e2++; }
      n.voices = c2 > 0 ? c2 : 1;
    }
  }
}

/** 和弦琶音错位：同一时刻起音的音符，按音高渐进延后一点点。
    偏移量写进 n.time（确定性，不随机 —— 随机会让每次播放不一样）。 */
const STRUM_PER_NOTE = 0.004;    // 每个音延后 4ms
/* ⚠️ 修过：原来是 30ms。但 16 音和弦时 step 被压成 30/15 = **2ms**，
   而钢琴 tb.atk = 3ms —— **错位量小于 attack 时间，attack 峰仍然重叠**，
   等于 strum 白做。要让瞬态真错开，step 必须 ≥ atk。
   42ms → 16 音 step = 2.8ms，接近 atk；42ms 仍在融合区内
   （听起来是快速琶音，不是散音）。 */
const STRUM_MAX = 0.042;         // 总跨度上限 42ms
function applyStrum(notes: Note[]): void {
  let i = 0;
  while (i < notes.length) {
    let j = i;
    /* 同一时刻（1ms 内视为同时）的音符归为一组 */
    while (j + 1 < notes.length && notes[j + 1].time - notes[i].time < 0.001) j++;
    const cnt = j - i + 1;
    /* 打击乐不做琶音错位：鼓是同时敲的，错位会散掉冲击力 */
    if (cnt > 1 && !isDrum(notes[i])) {
      /* 按音高排序：低音先响（真实琶音就是从低到高扫） */
      const grp = notes.slice(i, j + 1).sort((a, b) => a.note - b.note);
      const step = Math.min(STRUM_PER_NOTE, STRUM_MAX / (cnt - 1));
      for (let k = 0; k < grp.length; k++) grp[k].time += step * k;
    }
    i = j + 1;
  }
  notes.sort((a, b) => a.time - b.time);   // 错位后要重新排序，否则调度顺序错乱
}

/* ══════════════════════════════════════════════════════════════
   共享 AudioContext + 共享输出链
   ══════════════════════════════════════════════════════════════
   ⚠️ 真 bug（修过）：原来**每个播放器各建一个 AudioContext**。
   Chrome 的 AudioContext 数量有上限（实测约 6 个），一页放多个 MIDI 时
   第 7 个起 `new AudioContext()` 直接失败 → 点击播放毫无反应、静默无声
   （实测 10 个播放器的页面，后面的全都点不动，且**不报错**）。
   而且每个 ctx 都重复建一整套 EQ / 压缩 / 软削波，是纯浪费。

   改成：全站**共享一个 ctx 和一条输出链**，每个播放器只建自己的
   master gain 挂到共享链的输入。这样播放器数量不再受限，节点更少，
   音量滑块仍然各管各的（master 是各自的）。 */
let gCtx: AudioContext | null = null;
let gBusIn: AudioNode | null = null;   // 共享链的输入（= lowshelf）
let gIr: AudioBuffer | null = null;    // 混响脉冲响应（按 ctx 只生成一次）

function sharedAudio(): { ctx: AudioContext; busIn: AudioNode; ir: AudioBuffer } {
  if (gCtx && gBusIn && gIr) return { ctx: gCtx, busIn: gBusIn, ir: gIr };
  const Ctor = window.AudioContext || (window as any).webkitAudioContext;
  const ctx: AudioContext = new Ctor();

  /* ── EQ：轻微「微笑曲线」 ──
     ⚠️ 修过：原来 低频 +3.2dB @130Hz —— 130Hz 正好是**贝斯的谐波区**，
     等于给贝斯开小灶，是「贝斯盖住其他音色」的成因之一。
     改成 +2.2dB @**90Hz**：只抬真正的超低频（贝斯基频），不抬贝斯谐波。
     高频 +3.4dB @3.4kHz —— 帮旋律声部穿透出来。 */
  const eqLo = ctx.createBiquadFilter();
  eqLo.type = 'lowshelf'; eqLo.frequency.value = 90; eqLo.gain.value = 2.2;
  /* ⚠️ 全局高通：30Hz 以下人耳几乎听不到，却是纯浪费 ——
     实测贝斯能量几乎全在 <250Hz（低频 -23dB vs 中频 -89dB，差 66dB），
     这些低频吃掉动态余量、让宽带压缩器频繁动作，把中频声部一起压下去。 */
  const eqHp = ctx.createBiquadFilter();
  eqHp.type = 'highpass'; eqHp.frequency.value = 30; eqHp.Q.value = 0.7;
  const eqHi = ctx.createBiquadFilter();
  eqHi.type = 'highshelf'; eqHi.frequency.value = 3400; eqHi.gain.value = 3.4;
  eqLo.connect(eqHp); eqHp.connect(eqHi);

  /* 补偿增益：整条链路原本没有电平校准，实测输出比正常音乐低 8~9dB */
  const boost = ctx.createGain();
  boost.gain.value = BOOST;

  /* ══════════════════════════════════════════════════════════════
     ⚠️⚠️ **「贝斯太响、听不到其他音色」的真因在这里（实测证实）**

     同一段旋律，分别「独奏」和「+ 贝斯声部」渲染，量中频能量：

       旋律独奏                中频 44.93 dB
       旋律 + 贝斯             中频 39.11 dB   ← **掉了 5.82 dB**
       旋律 + 贝斯（拆掉压缩器） 中频 43.85 dB   ← 只掉 0.01 dB（纯叠加，正常）

     对照组证明：中频不是被贝斯「盖住」的，是**被压缩器压掉**的。
     DynamicsCompressor 是**宽带**的——它拿整段信号的总能量做检测。
     贝斯的能量几乎全在 <250Hz（实测加贝斯后 低频/中频 = +18 dB），
     于是贝斯一进来就把压缩器顶到阈值，中频声部跟着一起被压下去
     （中频 -4.74 / 高频 -3.25 dB），听感就是「贝斯一响，别的全没了」。

     修法不是「把贝斯调小」（那样在小喇叭上贝斯就完全消失了），
     而是**让压缩器看不见低频** —— 这就是多段处理的思路：
       ① 压缩器前串高通 → 只按中高频做检测，低频不再牵动它
       ② 低频走一条独立支路，绕过压缩器、单独降一档电平
     两条支路在 soft 之前汇合，总动态仍由软削波兜底。
     ────────────────────────────────────────────────────────────── */
  /* 分频点 250Hz。
     ⚠️ 修过：原来定 150Hz，结果**没解决问题** —— 贝斯的谐波区
     （h3≈195Hz、h4≈260Hz）刚好落在 150~250Hz，走的是**主压缩器那条路**，
     loTrim / loComp 根本管不到。实测加贝斯后中频又被压掉 2.65dB。
     提到 250 之后，贝斯的全部低频能量（基频 + 2/3 次谐波）都归低频支路管，
     主压缩器只看得见 250Hz 以上 —— 旋律所在的中频不再被牵动。
     贝斯的「可听度」靠 4~6 次谐波（260~390Hz），它们在中频侧，不受影响。 */
  const XOVER = 250;
  const cHP = ctx.createBiquadFilter();
  cHP.type = 'highpass'; cHP.frequency.value = XOVER; cHP.Q.value = 0.7;
  const cLP = ctx.createBiquadFilter();
  cLP.type = 'lowpass'; cLP.frequency.value = XOVER; cLP.Q.value = 0.7;
  /* 低频支路：单独降一档 + 单独限幅。
     ⚠️ 必须给低频**自己的**限幅器 —— 实测只降 loTrim 不管用：
     loTrim 从 0.55 降到 0.24，低频只掉 2.7dB（理论该掉 7.2dB），
     峰值**纹丝不动地卡在 0.93**（软削波上限）。原因是低频绕过主压缩器后
     完全没人管，贝斯基频（C2≈65Hz）一个声部就能顶满。
     ⚠️ 这个电平只影响低频，改它不会牵动中频。 */
  const loTrim = ctx.createGain();
  loTrim.gain.value = 0.55;      // ≈ -5.2 dB（贝斯谐波重心上移后低频自然变少，无需再压）
  const loComp = ctx.createDynamicsCompressor();
  loComp.threshold.value = -12; loComp.knee.value = 6; loComp.ratio.value = 8;
  loComp.attack.value = 0.004; loComp.release.value = 0.12;

  /* ⚠️ 压缩器改回**中等压缩**（修过两次，这次是第三次）：
     v1 = -18/24/4 强力压缩 —— 从 -30dB 就开始压，补偿前本来就小，越压越没劲。
     v2 = -4/4/6 纯限幅 —— 只管削波，对 -33dB 的稀疏段完全不动作，
          于是「稀疏很小声、密集很大声」的 12dB 动态全暴露（用户报的「前小后大」）。
     v3（现在）= -14/12/3 中等压缩：段内动态收窄（burst 实测 7.7dB），
          同时仍压得住密集段的峰值。响度拉平交给上面的曲级归一化，
          不再让压缩器单干 —— 单干必然是「要么压没劲、要么不均衡」二选一。 */
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 3;
  comp.attack.value = 0.004; comp.release.value = 0.15;

  /* 软削波（安全网）。⚠️ 修过：第一版 `tanh(k*x)/tanh(k)` 在 x→0 处斜率是
     k/tanh(k)=1.736，等于又放大 4.8dB —— 以为是安全网其实是第二级增益。
     改成小信号恒等的分段曲线：|x| ≤ 0.7 完全透明，超过才开始弯。 */
  const soft = ctx.createWaveShaper();
  {
    const N = 2048, t = 0.7;
    const c = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      const a = Math.abs(x);
      const y = a <= t ? a : t + (1 - t) * Math.tanh((a - t) / (1 - t));
      c[i] = x < 0 ? -y : y;
    }
    soft.curve = c; soft.oversample = '2x';
    /* 回算曲线上限（x=1 处的输出），outTrim 靠它换算。
       写死魔数的话，将来改 t 就会悄悄突破 -3dB 天花板。 */
    SOFT_MAX = t + (1 - t) * Math.tanh(1);
  }

  /* 输出 trim：把软削波的上限映射到 -3 dBFS。
     ⚠️ 必须挂在 soft **之后**：挂前面只削一部分信号，
     而和弦/密集段的峰值往往正是软削波之后才定型的。 */
  const outTrim = ctx.createGain();
  outTrim.gain.value = OUT_CEIL / (SOFT_MAX * OVERSAMPLE_MARGIN);

  /* 中高频 → 高通 → 压缩器（低频不参与检测）；低频 → 旁路 → 单独降电平。
     两条在 soft 前汇合。 */
  eqHi.connect(boost);
  boost.connect(cHP); cHP.connect(comp); comp.connect(soft);
  boost.connect(cLP); cLP.connect(loComp); loComp.connect(loTrim); loTrim.connect(soft);
  soft.connect(outTrim); outTrim.connect(ctx.destination);
  /* 频谱取样点：挂在 outTrim **之后**，反映的就是最终输出
     （含软削波 / -3dB 天花板），与耳朵听到的完全一致。
     ⚠️ analyser 是旁路，不再向外连 —— 不改变任何信号。 */
  midiTap = outTrim;

  gCtx = ctx; gBusIn = eqLo; gIr = makeImpulse(ctx, 1.2, 2.6);
  return { ctx, busIn: eqLo, ir: gIr };
}

/** 已预热的播放器数（避免一页建太多 AudioContext）。
    只统计「滚进视口」这种自动预热；悬停预热是用户主动触发的，不占这个名额。 */
let warmCount = 0;
/** 一页最多自动预热几个。AudioContext 有浏览器上限（Chrome 约 50），
    但每个都要建混响 IR + 效果总线，不宜多建。 */
const WARM_LIMIT = 6;

/** 过载/失真曲线。amount 0~1：0.25 轻微温暖，1.0 重金属。

    ⚠️⚠️ **致命 bug（修过）——「贝斯太响盖住一切」的真因就在这里**：

    原曲线 `tanh(k*x) / tanh(k)`，k = 1 + amount*14。
    这条曲线在 x→0 处的斜率是 **k / tanh(k) ≈ k**（k 大时 tanh(k)→1）。

    也就是说 drive 根本不是「过载」，而是一个 **+13 ~ +23dB 的放大器**：

        drv 0.25 → k=4.5  → 放大 4.5 倍（+13.1dB）
        drv 0.5  → k=8.0  → 放大 8.0 倍（+18.1dB）
        drv 0.8  → k=12.2 → 放大 12.2 倍（+21.7dB）
        drv 1.0  → k=15.0 → 放大 15.0 倍（+23.5dB）

    实测后果（单音 RMS，vel 100）：
        合成贝斯(drv 0.5) 0.678   失真吉他(drv 1.0) 0.503
        温暖垫            0.062   小提琴            0.092
        → **最响 / 最轻 = 10.9 倍**，贝斯（含 drive）彻底盖住其他声部。

    （这和我之前在总输出软削波上踩的是同一个坑：`tanh(k*x)/tanh(k)`
      的「归一化」其实是放大。那次修了总线的，漏了 drive 的。）

    改成 `tanh(G*x) / G`：小信号斜率 **恒为 1**（不再放大），
    饱和值 1/G —— 真正起「削平动态」的作用，而不是抬电平。

    ⚠️⚠️ **第二轮修（本轮）——「贝斯还是盖住一切」的真因**：

    上一轮加了一个**常数** `* DRIVE_LOUD = 1.9` 做「失真削峰补偿」。
    实测：drv 0.2 的贝斯单音峰值 0.685 → 关掉 drive 只剩 **0.370**，
    也就是 drive 白送了 **+5.6dB**。

    而常数补偿的方向是**反的**：
        drv 0.2（几乎不饱和，几乎没损失）→ 照送 +5.6dB
        drv 1.0（饱和最狠、损失最大）  → 也只送 +5.6dB（不够）
    → 轻微过载的贝斯凭空抬 5.6dB，失真吉他却还是偏轻。

    正确做法：**补偿量随失真量走**——用参考电平处的实际增益归一化，
    让 f(REF) = REF（参考电平处增益恰为 1），不饱和就不补、饱和多就多补。
    这样贝斯不再白拿增益，失真吉他也能拿到该有的补偿。 */
/** 归一化参考电平：取实际演奏的常见幅度区间 */
const DRIVE_REF = 0.25;
function driveCurve(amount: number): Float32Array {
  const G = 1 + amount * 4;          // drv 1.0 → 5（原来是 15，太狠）
  const N = 1024;
  const c = new Float32Array(N);
  /* 参考电平处的实际增益 = f(REF)/REF，取倒数做归一化系数。
     drv→0 时 tanh(G·REF)/G ≈ REF，norm→1（不补）；
     drv→1 时饱和损失大，norm→1.47（补 3.4dB）。 */
  const norm = DRIVE_REF / (Math.tanh(G * DRIVE_REF) / G);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    c[i] = (Math.tanh(G * x) / G) * norm;
  }
  return c;
}

/** 建一组效果总线。全部是**总线级** —— 只建一次，
    每音符只是连到共享的 send gain，所以加效果几乎不增加 per-note 节点。 */
interface FxBus {
  chorus: GainNode;    // 送合唱（宽度/厚度）
  delay: GainNode;     // 送回声（空间）
  drive: (amt: number) => AudioNode;  // 串在音符路径上的过载节点（按量分桶）
  /** 共振峰：按 (音色) 缓存的送出 gain，内部是两个 peaking 串联的共享链 */
  formant: (key: string, f1: number, f2: number, q: number) => GainNode;
  eqIn: AudioNode;     // 后面串 EQ 的输入
}
function buildFx(ctx: AudioContext, out: AudioNode): FxBus {
  /* ── 合唱：两条不同速率的延迟线，被 LFO 调制 → 声音更宽更厚 ── */
  const chorus = ctx.createGain();
  chorus.gain.value = 1;
  const cOut = ctx.createGain();
  cOut.gain.value = 0.5;
  const cLp = ctx.createBiquadFilter();     // 合唱只加在中高频，低频留干净
  cLp.type = 'highpass';
  cLp.frequency.value = 220;
  chorus.connect(cLp);
  [[0.021, 0.23], [0.034, 0.31]].forEach(([base, rate], i) => {
    const d = ctx.createDelay(0.1);
    d.delayTime.value = base;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rate;
    const lg = ctx.createGain();
    lg.gain.value = base * 0.42;            // 调制深度 ±42%
    lfo.connect(lg); lg.connect(d.delayTime);
    lfo.start();
    cLp.connect(d);
    /* 左右两路延迟时间不同 → 立体声宽度 */
    const pn = ctx.createStereoPanner();
    pn.pan.value = i === 0 ? -0.75 : 0.75;
    d.connect(pn); pn.connect(cOut);
  });
  cOut.connect(out);

  /* ── 回声：延迟 + 反馈（反馈环里串低通，模拟每次反射都变暗） ── */
  const delay = ctx.createGain();
  delay.gain.value = 1;
  const dD = ctx.createDelay(2.0);
  dD.delayTime.value = 0.26;
  const dFb = ctx.createGain();
  dFb.gain.value = 0.34;
  const dLp = ctx.createBiquadFilter();
  dLp.type = 'lowpass';
  dLp.frequency.value = 2600;
  const dOut = ctx.createGain();
  dOut.gain.value = 0.5;
  delay.connect(dD);
  dD.connect(dLp); dLp.connect(dFb); dFb.connect(dD);   // 反馈环
  dD.connect(dOut); dOut.connect(out);

  /* ── 过载：按量分桶（0.25 / 0.5 / 0.8 / 1.0），桶内共享 ── */
  const buckets = new Map<number, WaveShaperNode>();
  const levels = [0.25, 0.5, 0.8, 1.0];
  const drive = (amt: number): AudioNode => {
    let lv = levels[0];
    for (const l of levels) { if (amt >= l - 0.01) lv = l; }
    if (lv !== levels[levels.length - 1]) {
      /* 找最接近且 >= amt 的桶；没有就用最小桶（amt 很小） */
      let pick = levels.find((l) => l >= amt - 0.01);
      lv = pick ?? levels[0];
    }
    let w = buckets.get(lv);
    if (!w) {
      w = ctx.createWaveShaper();
      w.curve = driveCurve(lv);
      w.oversample = '2x';
      /* 过载后补一级低通，去掉刺耳的高次谐波 */
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 4200;
      w.connect(lp);
      buckets.set(lv, w);
      (w as any).__out = lp;
    }
    return w;
  };

  /* ── 共振峰：按 key 缓存。两个 peaking filter 串联 → 声道共鸣 ──
     共享给同音色的所有音符（共振峰频率不随音高变，所以能共享）。 */
  const fBuckets = new Map<string, GainNode>();
  const formant = (key: string, f1: number, f2: number, q: number): GainNode => {
    let g = fBuckets.get(key);
    if (g) return g;
    g = ctx.createGain();
    g.gain.value = 1;
    let node: AudioNode = g;
    /* 第一共振峰宽一点（Q 低），第二共振峰窄一点（Q 高）→ 更像真实声道 */
    [[f1, q, 4.5], [f2, q * 0.8, 6.5]].forEach(([f, db, qq]) => {
      if (!(f > 0)) return;
      const bq = ctx.createBiquadFilter();
      bq.type = 'peaking';
      bq.frequency.value = f as number;
      bq.Q.value = qq as number;
      bq.gain.value = db as number;
      node.connect(bq);
      node = bq;
    });
    node.connect(out);
    fBuckets.set(key, g);
    return g;
  };

  return { chorus, delay, drive, formant, eqIn: out };
}

function makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  /* ⚠️ 性能（修过）：原来每个采样点调一次 Math.pow —— 1.9 秒立体声约 18 万个采样
     × 2 声道，光这个就要几十毫秒，正好卡在**第一次点播放**的时候。
     改成乘法递推（指数衰减相邻采样的比值是常数），快一个数量级。 */
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const preN = Math.floor(ctx.sampleRate * 0.012);
  /* 衰减因子：每步乘一次即可等价 (1 - t)^decay 的指数包络 */
  const step = Math.exp(-decay / (len - preN || 1));
  for (let c = 0; c < 2; c++) {
    const ch = buf.getChannelData(c);
    /* 前面 12ms 留一点预延迟，避免混响糊住起音 */
    ch.fill(0, 0, Math.min(preN, len));
    let env = 1;
    for (let i = preN; i < len; i++) {
      ch[i] = (Math.random() * 2 - 1) * env;
      env *= step;
    }
  }
  return buf;
}

function buildMidi(root: HTMLElement) {
  const src = root.dataset.src || '';
  if (!src) return;
  const title = root.dataset.title || src.split('/').pop() || 'MIDI';

  /* 和音频一样是**单行播放条**，只是多个 MIDI 标记 */
  const play = document.createElement('button');
  play.className = 'audio-btn audio-play';
  play.type = 'button';
  play.textContent = '\u25b6';
  play.setAttribute('aria-label', '播放');

  const t = document.createElement('span');
  t.className = 'audio-title';
  t.textContent = `${title}`;
  const tag = document.createElement('span');
  tag.className = 'mono audio-tag';
  tag.textContent = 'MIDI';
  tag.title = '谐波合成 + 混响（音色为近似模拟，非真实音源）';

  /* BPM 标记：加载后填入。多 tempo（变速）时加 * 号 */
  const bpmEl = document.createElement('span');
  bpmEl.className = 'mono audio-tag audio-bpm';
  bpmEl.textContent = '--';
  bpmEl.setAttribute('data-empty', '');
  bpmEl.title = '速度';

  const seek = document.createElement('span');
  seek.className = 'audio-seek';
  const fill = document.createElement('i');
  seek.appendChild(fill);

  const time = document.createElement('span');
  time.className = 'mono audio-time';
  const tCur = document.createElement('b');
  tCur.textContent = '0:00';
  const tDur = document.createElement('i');
  tDur.textContent = ' / --:--';
  time.append(tCur, tDur);

  const vol = document.createElement('input');
  vol.type = 'range';
  vol.className = 'audio-vol';
  vol.min = '0'; vol.max = '1'; vol.step = '0.01'; vol.value = '1';
  vol.setAttribute('aria-label', '音量');
  fillAudioRange(vol);

  const spec = makeSpectrum(root);

  root.className = 'audio-player midi-player';
  /* 和音频保持一致的横排顺序：… 进度 · 频谱 · 时间 … */
  root.append(play, t, tag, bpmEl, seek, spec.canvas, time, vol);

  /* ── 状态 ── */
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let polyGain: GainNode | null = null;   // 和弦补偿（每个播放器一个）
  let normG: GainNode | null = null;      // 曲级响度归一化
  let fx: FxBus | null = null;
  let reverb: ConvolverNode | null = null;
  let total = 0;              // 曲子总时长（秒）
  let data: MidiData | null = null;
  let playing = false;
  let startedAt = 0;       // ctx.currentTime，播放起点
  let offset = 0;          // 秒，曲内偏移
  let timer: number | null = null;
  const live: { stop: () => void; fade: (t: number) => void; start: number; until: number; perc: boolean }[] = [];
  /* 诊断计数（供本地诊断读取） */
  /* ══════════════════════════════════════════════════════════════
     诊断计数（供本地诊断读取）

     ⚠️ 本轮新增：CPU 被其它软件占用时的掉供指标。
     之前只有 steals/forced/maxLive，全都指向「声部数太多」这一个方向，
     而用户报的是「有其他软件占用时开始卡」——那是**调度供不上**，
     属于完全不同的失效模式，没有指标根本看不出来：

       · pumpGap   两次 pump 的实际间隔（毫秒）。setInterval 名义 50ms，
                   主线程被抢占时会拉长到几百毫秒，这是掉供的直接原因。
       · dropped   因「已经过期」被跳过的音符数（n.time < pos - ?）。
                   掉供时这个数会暴涨，听感就是「音符不见了」。
       · late      排到了过去（when < now）的次数。Web Audio 会立刻发声，
                   但时间已经错位，听感是「节奏乱了」。
       · starve    pump 落后于播放位置超过阈值的次数（真正的断供）。
     ══════════════════════════════════════════════════════════════ */
  const diag = { steals: 0, forced: 0, maxLive: 0,
    pumpGap: 0, dropped: 0, late: 0, starve: 0, maxLag: 0, dropAt: [] };
  (window as any).__midiDiag = diag;
  /* 诊断钩子：给自检脚本拿 AudioContext / master，用于**录制真实输出**、
     实测各声部在合奏里的真实响度（静态算 roleGain 看不出混响推远、
     亮度、软起音这些处理的实际效果，前面几轮「数值说对、耳朵说不对」
     就是这么来的）。
     ⚠️ 必须用 getter：ctx / master 初始为 null，ensure() 之后才赋值，
     直接 `window.x = ctx` 会永远拿到 null。 */
  Object.defineProperty(window, '__midiCtx', { get: () => ctx, configurable: true });
  Object.defineProperty(window, '__midiMaster', { get: () => master, configurable: true });
  /* 复用的声像 / 混响送出节点（按通道缓存，数量有限） */
  const panByCh: (StereoPannerNode | undefined)[] = new Array(16);
  const revByChProg: Record<string, GainNode> = {};
  const choByChProg: Record<string, GainNode> = {};
  const dlyByChProg: Record<string, GainNode> = {};
  /* ⚠️ 高通按 (通道, 音色) 复用，和 send gain 一样：
     线性时不变系统下「先混合再滤波」=「先滤波再混合」，所以可以共享，
     **每音符只多一次 connect，不新建节点**。 */
  const hpByChProg: Record<string, BiquadFilterNode> = {};
  const bpByGrp: Record<string, BiquadFilterNode> = {};   // 打击乐共享带通（按 通道:鼓件组）
  const formByChProg: Record<string, GainNode> = {};
  let nextIdx = 0;          // 下一个待调度音符（滚动窗口用）
  let pumpTimer: number | null = null;
  let pumping = false;      // pump 重入保护
  let morePending = false;  // 本批没排完
  let activeVoices = 0;      // 正在响的音符数（不含预排未发声的）
  let avgConc = 1;          // 整曲平均并发（静态，供总线削波兜底）
  let q: Quality = { voices2: true, click: true, reverb: true, fx: true, vib: true, maxVoices: 200, tier: 0 };
  /* ⚠️ 自适应档位（修过）：q 原来只按**整曲平均密度**定一次，
     **局部爆发不会降级** —— 实测一首「整曲 13 音/秒、中间某段 44 音/秒」的曲子，
     档位停在 tier 0（全效果），爆发段掉了 33ms 一帧，听感就是「叠一起会卡」。
     现在：qBase = 按平均密度定的基准档，qLive = 运行时按实际调度耗时动态升降。 */
  let qBase: Quality = q;
  /* ⚠️ 指标选错了（修过）：第一版用「pump 耗时 EMA」，但 pump 是**分批**的
     （单次最多 BATCH 个），耗时一直很低（实测爆发段只有 2.7ms，远低于 6ms 阈值）
     → 永远不触发降级，等于没做。
     真正的压力是**实时吞吐率**（44 音/秒 × 3.3 节点 = 145 节点/秒的创建速率）。
     改成滑动窗口统计最近 1 秒实际调度的音符数。 */
  let schedWin: number[] = [];   // 最近 1 秒各音符的调度时间戳
  let tierUp = 0;                // 迟滞计数，避免档位抖动
  let batchTimer: number | null = null;
  let seq = 0;             // 播放序号，用来作废旧的调度
  let lastPumpAt = 0;      // 上次 pump 的 performance.now()（掉供观测用）
  /* CPU 压力 EMA：pump 实际间隔 ÷ 名义间隔，1 = 主线程空闲，越大表示被抢占越狠 */
  let cpuStress = 1;

  /* ⚠️ 真 bug（修过）：ensure() 没有并发保护。
     预热（IntersectionObserver / 悬停）触发 ensure 后，里面 await fetch + parse；
     用户在这期间点播放 → 第二次进入 ensure，此时 ctx 已赋值但 data 还是 null
     （`if (!data)` 成立）→ **同一首曲子被 fetch 两遍、parse 两遍、波形预建两遍**。
     4000 音符的曲子解析一遍就要几十毫秒，重复一次正好叠在「播放开始」那一帧，
     实测 complex 首次播放卡 28.5ms（前 10 帧里），就是这么来的。
     改成：把 in-flight 的 promise 存下来，后续调用复用同一个。 */
  let ensureP: Promise<MidiData> | null = null;
  const ensure = async (): Promise<MidiData> => {
    if (ensureP) return ensureP;
    ensureP = ensureInner().catch((e) => { ensureP = null; throw e; });
    return ensureP;
  };

  const ensureInner = async () => {
    if (!ctx) {
      /* ⚠️ 共享 ctx：不再每个播放器各建一个（会撞浏览器上限，后面几个直接点不动） */
      const sh = sharedAudio();
      ctx = sh.ctx;
      master = ctx.createGain();
      master.gain.value = Number(vol.value);
      /* 和弦补偿节点：**每个播放器各一个**。
         ⚠️ 不能做成共享的 —— 那一首曲子的和弦会把页面上
         另一个播放器的音量也压下去，属于串台。
         串在 master 之后、共享链之前：音量滑块仍然管总输出。 */
      polyGain = ctx.createGain();
      polyGain.gain.value = 1;
      /* 曲级归一化插在 master 之后、和弦补偿之前：
         音量滑块管 master（用户可控），归一化管 normG（自动），互不覆盖；
         归一化也盖住混响湿声（wet 连的是 master）。 */
      normG = ctx.createGain();
      normG.gain.value = 1;
      master.connect(normG);
      normG.connect(polyGain);
      polyGain.connect(sh.busIn);

      /* 混响：算法生成脉冲响应（指数衰减噪声），不用外部音频文件。
         缩短到 1.2 秒 —— 够用且生成更快。
         ⚠️ IR buffer 按 ctx 共享（生成一次 ~14ms），各播放器各建自己的
         convolver + wet，这样 wet 能连到自己的 master。 */
      const conv = ctx.createConvolver();
      conv.buffer = sh.ir;
      const wet = ctx.createGain();
      wet.gain.value = 0.34;
      /* ⚠️ 真 bug（修过）：原来 wet.connect(comp) —— 混响湿声**绕过 master**，
         音量滑块（和静音）管不到混响：把音量拖到 0，混响还在响。
         改成 wet → master（master → 共享链），滑块才管得住。 */
      conv.connect(wet); wet.connect(master);
      reverb = conv;

      /* 效果总线挂在 master 上：音量滑块能同时盖住干声和所有效果 */
      fx = buildFx(ctx, master);
    }
    if (ctx.state === 'suspended') await ctx.resume();
    if (!data) {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`加载失败 ${res.status}`);
      data = parseMidi(await res.arrayBuffer());
      total = data.duration;
      q = pickQuality(data.notes.length / Math.max(1, total));
      qBase = q;
      bpmEl.textContent = `${data.bpm}${data.bpmVaries ? '*' : ''}`;
      /* ⚠️ 预热波形（修过）：原来每个 program 的 PeriodicWave 是**播到那个音时才建**。
         复杂曲往往一次用十几个音色，开头十几个音符各建一次波形
         （13 个傅里叶系数 + createPeriodicWave），叠加在首次播放上就是「一顿」。
         解析完就把这首曲子用到的所有音色波形一次性建好。 */
      for (const pr of new Set(data.notes.map((n) => n.prog))) {
        const tb = timbre(pr);
        toneWave(ctx, tb);
        /* 共振峰链也一起建：复杂曲里人声/管乐类音色多，
           不预热的话首次播放要现建十几个滤波器（实测会多出 1 帧）。 */
        if (fx && tb.f1 && tb.f1 > 0) fx.formant(`${pr}`, tb.f1, tb.f2 || 0, tb.fq || 8);
      }
      /* 整曲平均并发（静态），供总线削波兜底用。
         只统计「正在响」的加权平均，不是音符总数/时长。 */
      let csum = 0;
      for (const nn of data.notes) csum += Math.max(1, nn.conc || 1);
      avgConc = data.notes.length ? csum / data.notes.length : 1;

      /* 曲级响度归一化：把这首曲子的平均响度拉到 TARGET_RMS。
         ⚠️ 只在 data 刚解析出来时算一次（放在 `if (!data)` 块内，天然幂等）。 */
      if (normG) {
        /* 用 qBase（按整曲平均密度定的基准档）而不是当前 q：
           当前 q 会随播放中的实时吞吐动态升降，用它算归一化会让音量跟着抖。 */
        const g = normGainFor(data.notes, data.duration, qBase);
        /* 暴露给诊断：单独播放一个鼓件时 norm 会把整曲拉到 TARGET_RMS，
           测到的「极差」其实是 estimateRms 的误差而不是层次。
           拿到 norm 就能反算出去归一化后的原始响度。 */
        (diag as any).norm = g;
        normG.gain.setTargetAtTime(g, ctx.currentTime, 0.02);
      }
      bpmEl.removeAttribute('data-empty');
      bpmEl.title = data.bpmVaries ? `速度：起始 ${data.bpm} BPM（曲中有变速）` : `速度：${data.bpm} BPM`;
      /* ★ 声部判定结果写进 MIDI 标签的 tooltip：作者意图一眼可见，
         判错了也能立刻发现（比如鼓被判成旋律）。 */
      if (data.roles && data.roles.length) {
        tag.title = `声部判定：${data.roles
          .slice()
          .sort((a, b) => a.ch - b.ch)
          .map((r) => `${r.ch + 1}轨=${ROLE_NAMES[r.role] || '?'}（${r.name || '无名'}）`)
          .join('、')}`;
        (diag as any).roles = data.roles.map((r) => ({ ch: r.ch, role: r.role, name: r.name }));
      }
      tCur.textContent = '0:00';
      tDur.textContent = ` / ${fmt(total)}`;
    }
    return data;
  };

  const stopAll = () => { live.forEach((l) => { try { l.stop(); } catch (_) {} }); live.length = 0; };

  /* ⚠️ 起音保护（本轮修）：原来回收的是 until 最小的声部，但在密集段落
     所有声部都是刚建的，until 差不多 —— 于是**刚响起来的音符被立刻切断**，
     一次 pump 建 48 个就切 48 个，听感是声音断续甚至「没了」。
     现在：响了不足 80ms 的声部不回收。如果全都太新，就宁可超上限
     （超上限只是声音厚一点，切断则是失声，两害相权取其轻）。 */
  const STEAL_PROTECT = 0.08;

  /** 回收一个最老的旋律声部（打击乐不回收）：优先保住新进来的音 */
  /* ══════════════════════════════════════════════════════════
     ⚠️ **「吞声部」的主因（本轮定位）**

     原来的回收是 **硬切**：`o.stop()` 不带参数 = 立刻把振荡器停在当前采样点。
     如果那一刻波形不在零点，就是一次**阶跃** → 爆音（click）；
     同时那个声部是「啪」地消失，而不是自然收尾 —— 密集段落频繁触发时，
     听感就是「声部被吞掉 + 咔咔响」。

     真实合成器的 voice stealing 会先给一个极短的释放（5~15ms）再停，
     听起来是「被后面的音盖过去」，而不是「断掉」。

     ⚠️ 另外：强制回收（force）原来无视 STEAL_PROTECT，会去切
     **刚刚起音、还在 attack 里**的音 —— 那是最响的时刻，切下去最明显。
     现在 force 时也优先挑**已经起音完成**的，实在没有才退而求其次挑最老的。
     ══════════════════════════════════════════════════════════ */
  /* allowPerc：极端兜底时允许回收打击乐（见调用处说明）。默认 false = 鼓永不回收。 */
  const stealOldest = (now: number, force = false, allowPerc = false) => {
    let bi = -1, bu = Infinity, fallback = -1, fbStart = Infinity;
    for (let k = 0; k < live.length; k++) {
      const l = live[k];
      if (l.perc && !allowPerc) continue;   // 打击乐不动（除非极端兜底）
      /* 最老的（用于 force 兜底） */
      if (l.start < fbStart) { fbStart = l.start; fallback = k; }
      if (!force && now - l.start < STEAL_PROTECT) continue;   // 刚起音的，不切
      if (l.until < bu) { bu = l.until; bi = k; }
    }
    if (bi < 0) bi = force ? fallback : -1;
    if (bi < 0) return false;
    const victim = live[bi];
    live.splice(bi, 1);
    /* 淡出 12ms 再停：不再有阶跃，也没有「啪」的消失感 */
    try { victim.fade(now); } catch (_) {}
    setTimeout(() => { try { victim.stop(); } catch (_) {} }, 60);
    diag.steals++; if (force) diag.forced++;
    return true;
  };

  /** 调度 [from, duration] 里的音符 */
  /* ══════════════════════════════════════════════════════════
     ⚠️ 致命 bug（修过）：原来是一次性把 60 秒内**所有**音符的节点
     全部创建出来，然后 `break` —— 60 秒之后**没有任何续排机制**。

     后果有两个，都直接导致「长的播不了」：
       ① 超过 60 秒的部分永远不发声（进度条还在走，但没声音）
       ② 60 秒内的密集段落可能一次性创建上万个 oscillator/gain/filter，
          浏览器直接卡死或爆音

     改成**滚动窗口调度**（Web Audio 的标准做法）：
       只预排未来 LOOKAHEAD 秒，定时器定期补充。
       无论曲子多长，同时在响的节点数都保持在一个小常数。
     ══════════════════════════════════════════════════════════ */
  /* ══════════════════════════════════════════════════════════
     ⚠️ 卡顿主因（本轮实测定位）：LOOKAHEAD 原来是 **4 秒**。

     预排窗口 = 同时存活在音频图里的节点数。44 音/秒的段落，4 秒就是
     ~176 个音符 × 5~9 个节点 ≈ **900~1500 个节点常驻**，
     而 Web Audio 的标准做法是 0.1~0.5 秒。常驻节点数是音频线程每
     render quantum 遍历成本的主要来源，也直接决定 GC 压力。

     改成 1.0 秒（仍比标准宽松，防主线程抖动导致断音），
     常驻节点直接降到 1/4。PUMP_MS 同步 180 → 50：
     稳态下每次 pump 只需补 50ms 的音符（约 2 个），
     而不是 180ms 一批 8 个 —— 创建更均匀，不会有成批的尖峰。 */
  const LOOKAHEAD = 1.0;    // 预排窗口（秒）
  const PUMP_MS = 50;       // 补充间隔（毫秒）
  const BATCH = 48;         // 单次 pump 最多建多少个音符（防密集段卡顿）
  /* ⚠️ 首批用小批量（修过）：播放开始那一帧要一口气建完整个预排窗口的音符，
     complex（8 通道全效果）实测 48 个音符 × 3.3 节点 ≈ 158 个节点，
     叠加混响送出和共振峰链，实测卡 26ms（前 5 帧里的第 5 帧）。
     首批只建 16 个（≈53 节点），剩下的下一批立刻续上（morePending），
     听感上没有任何差别，但第一帧轻了一半以上。 */
  const BATCH_FIRST = 16;
  /* ══════════════════════════════════════════════════════════════
     启动前置量（本轮新增，修「开头音符被吞」）

     ⚠️ 真 bug：原来 `startedAt = ctx.currentTime`，然后**同步**调用 pump。
     但 startRoll 到 pump 内部再读 `ctx.currentTime` 之间，音频时钟照常前进：
       · CPU 空闲：间隔 ≈ 0，pos ≈ 0，开头音符勉强不被跳过
       · 有其它软件占用：这段间隔实测到 **85ms** → pos = 0.085
         → `n.time(0) < pos - 0.05 = 0.035` 成立 → **开头音符全部判为过期丢掉**

     实测 badapple（开头 62 个音同时起音）在 CPU 降速 8 倍下 **dropped=62**，
     且掉落时刻**全是 t=0** —— 不是播放中掉供，就是开头被吞。

     修法：把起点推到未来 START_LEAD 秒。这样 pos 从负数开始，
     开头音符既不会被判过期，排出的 when 也一定在未来（不会撞 late）。
     代价是按下播放后约 0.15 秒才出声，这在 Web Audio 调度里是标准做法
     （避免首批音符排到过去），听感上几乎察觉不到。
     ══════════════════════════════════════════════════════════════ */
  const START_LEAD = 0.15;
  let firstPump = true;
  /* 声部上限改由 q.maxVoices 按档位给（96 / 72 / 56），见 TIERS */

  /** 单个音符发声（原来 schedule 循环里的循环体，原样保留） */
  const playNote = (n: Note, when: number) => {
    if (!ctx || !master) return;
    /* ⚠️ 弯音（pitch bend）：原来完全忽略 → 所有滑音、揉弦听起来是
       一级级跳的，非常机械。现在把它算进基频。 */
    const f0 = 440 * Math.pow(2, (n.note - 69) / 12) * Math.pow(2, n.bend / 12);
    /* 滑音（CC65 开 × CC5 时长，0~0.12s）：从下方 3 半音滑到位。
       真实 MIDI 里贝斯 / 合成主音常用；原来完全忽略。
       ⚠️ 只改振荡器的 frequency 曲线，不新增节点。 */
    const glide = n.glide || 0;
    const f0Start = glide > 0 ? f0 * Math.pow(2, -3 / 12) : f0;

    /* 声像：CC10。原来所有通道都堆在正中间，混在一起糊成一团；
       拉开之后各声部能听清，宽度感明显。
       ⚠️ 性能（修过）：原来**每个音符**建一个 StereoPanner —— 密集段落
       又多几百个节点。同一通道的 CC10 通常固定，按通道复用即可。 */
    let out = panByCh[n.ch];
    if (!out) { out = ctx.createStereoPanner(); out.connect(master); panByCh[n.ch] = out; }
    const pv = Math.max(-1, Math.min(1, n.pan));
    if (Math.abs(out.pan.value - pv) > 0.05) out.pan.setValueAtTime(pv, when);

      /* ── 打击乐通道：噪声 + 带通，和旋律合成完全两套 ── */
      if (isDrum(n)) {
        const dk = drum(n.note);
        const len = Math.max(0.04, dk.decay + 0.02);
        const nb = ctx.createBufferSource();
        nb.buffer = noiseBuf(ctx, len);

        /* ══════════════════════════════════════════════════════════
           ⚠️ 播放能力增强（本轮）：打击乐带通滤波器**按鼓件组共享**
           ══════════════════════════════════════════════════════════
           原来每个鼓点都新建 BiquadFilter。而 RTF 实测显示
           **BiquadFilter 是全套里最贵的节点**（300 声部下，加一个低通
           就让渲染从 209ms 涨到 359ms）。

           而打击乐是最密集的声部 —— hat 常是 8 分/16 分音符连续敲，
           每秒 8~16 次。密集鼓点 = 密集建滤波器，正好撞在最贵的节点上。

           同一鼓件组的带通参数（freq/Q）**完全相同**，可以共享。
           但共享要求改连接顺序：
               原：nb → bp → gd → out      （bp 在 gd 前，无法共享）
               新：nb → gd → bp(共享) → out（gd 先做包络，bp 共享）
           这样每个鼓点的 gain 包络仍独立（必须独立，否则包络互相干扰），
           而滤波器只建一份。

           每鼓点节点数：4 → 3（BufferSource + Gain，滤波器共享）。
           密集 hat 段落（16 击/秒）每秒省 16 个最贵的节点。
           ══════════════════════════════════════════════════════════ */
        const dg = drumGrp(n.note);
        const bpKey = `${n.ch}:${dg}`;
        let bp = bpByGrp[bpKey];
        if (!bp) {
          bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.value = dk.freq;
          bp.Q.value = dk.q;
          bp.connect(out);
          /* 混响送出同样按组共享（dk.rev 只由鼓件决定，组内相同） */
          if (reverb && dk.rev > 0) {
            const gr = ctx.createGain();
            gr.gain.value = dk.rev;
            bp.connect(gr); gr.connect(reverb);
          }
          bpByGrp[bpKey] = bp;
        }

        /* 再叠基频正弦：纯噪声的鼓没有「音高感」，底鼓尤其明显。
           ⚠️ 修过：原来写 `Math.max(30, f0 / 2)` —— 36 号底鼓的 f0 是 65Hz，
           减半变 32.7Hz，笔记本喇叭根本放不出来，底鼓听起来「没声」。
           改成用 f0 本身（65Hz），并给一段下滑的频率包络做「咚」的冲击感。 */
        const oscD = ctx.createOscillator();
        oscD.type = 'sine';
        const fBody = Math.max(38, f0 * dk.body * 0.5);
        oscD.frequency.setValueAtTime(fBody * 1.8, when);
        oscD.frequency.exponentialRampToValueAtTime(fBody * 0.72, when + 0.07);

        const gd = ctx.createGain();
        const gdO = ctx.createGain();
        /* ⚠️ 修过：鼓的整体音量 0.5 → 1.05。旋律改用 PeriodicWave 之后
           高次谐波更丰富、听感更响，鼓就相对被压下去了。 */
        /* ⚠️ 打击乐也要补偿，但用**更缓的曲线 + 更高的下限**：
           几个鼓同时敲（底鼓+军鼓+踩镲）确实会叠，不补会爆；
           但鼓的听感靠冲击力，压太狠就「没劲」了（上一轮刚把鼓调响）。
           所以指数取 0.25（缓），并设 0.5 的下限 —— 最多只压一半。 */
        /* 鼓件响度校准 × 时间密度补偿（本轮新增，见 DRUM_CAL / drumDensityComp 注释） */
        const ampD = Math.pow(n.vel / 127, 1.6) * 1.05 * n.vol
          * drumComp(n.conc || 1) * DRUM_CAL[drumGrp(n.note)] * DRUM_CAL2[drumGrp(n.note)]
          * (DRUM_CAL3[n.note] ?? 1)
          * drumDensityComp(n.drate || 1);
        /* ══════════════════════════════════════════════════════════
           ⚠️ 打击乐软起音（本轮修，hat 响度问题的真因）
           ══════════════════════════════════════════════════════════
           实测（统一场景，K 计权）：

             声部        RMS      峰值     crest
             主音 lead   -9.15    -6.96    2.19
             闭镲 hat   -14.33    **-6.06**  8.27

           **hat 的峰值是所有声部里最高的**，比 lead 还高 0.9dB ——
           尽管它的 RMS 比 lead 低 5.2dB。

           这就是「hat 响度有问题」的真因：**不是平均响度响，是瞬态响**。
           每次敲击那一瞬的尖峰盖过旋律。和之前 chord 的问题同一类
           （RMS 拉平了但峰值没有）—— 同一个教训重演了一次。

           根因：`setValueAtTime(ampD, when)` 是**零起音时间的阶跃**，
           噪声从此刻起满幅输出 → 瞬态达到理论最大值。
           真实镲片/鼓皮敲击有 1~3ms 起音（棒接触→振动建立）。

           按鼓件给不同起音时间：越长越柔、越短越有冲击。
           ══════════════════════════════════════════════════════════ */
        const atkD = DRUM_ATK[drumGrp(n.note)];
        gd.gain.setValueAtTime(0.0001, when);
        gd.gain.linearRampToValueAtTime(ampD, when + atkD);
        gd.gain.exponentialRampToValueAtTime(0.0001, when + len);
        gdO.gain.setValueAtTime(0.0001, when);
        gdO.gain.linearRampToValueAtTime(ampD * dk.tone, when + atkD);
        gdO.gain.exponentialRampToValueAtTime(0.0001, when + Math.min(len, 0.14));

        /* 新顺序：先包络（每鼓点独立）再共享带通 */
        nb.connect(gd); gd.connect(bp);
        oscD.connect(gdO); gdO.connect(bp);
        /* 混响送出：改由共享带通之后统一接出（见上方 bp 创建处） */


        nb.start(when); nb.stop(when + len);
        oscD.start(when); oscD.stop(when + len);
        live.push({ stop: () => { try { nb.stop(); oscD.stop(); } catch (_) {} },
        fade: (t: number) => { for (const gn of [gd, gdO]) { try { gn.gain.cancelScheduledValues(t); gn.gain.setTargetAtTime(0, t, 0.004); } catch (_) {} } },
        start: when, until: when + len + 0.05, perc: true });
        return;
      }

      /* ── 旋律：三个振荡器叠加谐波 ── */
      const tb = timbre(n.prog);
      /* 力度走指数曲线：线性会让轻音太响、响音不够突出 */
      /* CC7 通道音量 × CC11 表情 */
      /* 1.5 → 1.35：原来中低力度的音偏虚，稍微补一点 body */
      /* 和弦补偿：按「起音瞬间同时响几个音」预缩放。
         ⚠️ 必须是**解析期静态值**（n.conc），不能用总线上的动态计数 ——
         动态计数滞后约 240ms，而峰值就在起音那一瞬，补偿赶不上（实测无效）。 */
      const amp = Math.pow(n.vel / 127, 1.35) * tb.gain * n.vol * polyComp(n.conc || 1) * (isDrum(n) ? 1 : roleGain(n));
      if (amp <= 0.0001) return;

      const g = ctx.createGain();
      /* 峰值按振荡器数量配平（两个振荡器直接汇入同一个 gain，不各带一个）
         ⚠️ 真 bug（修过）：配平原来写在 **osc 创建并 start() 之后**
         （`if (oscs.length > 1) peak = peak / oscs.length`）。那时 gain 包络
         早已排好，改的只是一个局部变量 —— **配平从未生效**，
         所有 det > 0.5 的音色（几乎全部）都白白响 6dB，
         也更容易把总电平顶到软削波。必须在建包络之前就算好。 */
      const nOsc = (tb.det > 0.5 && q.voices2) ? 2 : 1;
      const peak = Math.max(0.0002, amp) / nOsc;
      /* ⚠️ chord 必须在包络之前定义：包络（软起音）和 click 都要用。
         原来定义在 rk 之后（1703 行），而包络在 1682 行 →
         **TDZ ReferenceError**，整个脚本崩溃、播放器完全不工作
         （实测所有曲 RMS 都是 -inf）。 */
      const prof = roleProfile(n);
      const rel = Math.min(tb.rel, Math.max(0.05, n.dur * 0.6));
      /* 和弦声部**软起音**：拉长 attack → 峰值上升更缓 → 瞬态冲击减小。
         ⚠️ 本轮根因：RMS 已拉平（chord1 -31.49 / chord16 -31.73），
         但**峰值没有** —— crest factor 19.8 → **23.2 dB**，和弦高 3.3 dB。
         「几个键一起按」的「冲」来自这里：RMS 一样但瞬态更陡。
         只压 RMS 治不了「冲」。
         clamp 到 dur*0.35：避免 attack 比音符本身还长。 */
      const atkT = prof.atk > 1 ? Math.min(tb.atk * prof.atk, Math.max(0.003, n.dur * 0.35)) : tb.atk;
      g.gain.setValueAtTime(0.0002, when);
      g.gain.linearRampToValueAtTime(peak, when + atkT);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * tb.sus), when + atkT + tb.dec);
      /* 音符结束时继续衰减到 release，而不是硬切（硬切有咔哒声） */
      g.gain.exponentialRampToValueAtTime(0.0002, when + n.dur + rel);

      /* 过载：串在音符路径上（改变音色本身，不是空间效果）。
         按量分桶共享 → 每音符只多一次 connect，不新建节点。 */
      let head: AudioNode = g;
      let tailEarly: AudioNode = g;
      if (fx && tb.drv > 0.05) {
        const d = fx.drive(tb.drv);
        g.connect(d);
        head = d;
      }

      const rk = `${n.ch}:${n.prog}`;
      /* 和弦声部「推远」：混响送出加大 → 干湿比变化 → 听觉上后退。
         这是混音里处理「伴奏盖主旋律」的标准做法。
         ⚠️ 用独立 key（加 :c），否则和同音色的独奏共用一份 send gain
         → 独奏的混响也被改掉。 */
      const revKey = prof.wet === 1 ? rk : `${rk}:${n.role == null ? 0 : n.role}`;
      /* 低通 + **滤波包络**：起音瞬间把截止频率开高再收回。
         这是真实乐器最有辨识度的动态特征（铜管的「呲」、贝斯的「咚」、
         克拉维内特的「啪」），少了它每个音都是一条静态的频谱。
         ⚠️ 复用这一个 BiquadFilter，不额外建节点。 */
      /* 和弦声部频谱略暗：把 2~5kHz 让给旋律，减少掩蔽。
         这是混音里的 frequency carving —— 伴奏和主旋律抢同一段频率时，
         把伴奏的那段挖掉一点，旋律就「浮」出来了，比整体降音量有效。 */
      const bright = tb.bright * prof.bright;
      /* ══════════════════════════════════════════════════════════
         效果增强（本轮新增）：力度 → 亮度
         ══════════════════════════════════════════════════════════
         真实乐器「弹得越响越亮」—— 钢琴弱奏是暗的圆润音色，
         强奏泛音全开、明显更亮更尖；铜管尤其极端。
         原来 lp 截止只由音色和音高决定，不管力度，
         于是**弱奏和强奏音色完全相同，只是大小不同**，听起来很电子。

         vel 从 1 到 127 映射成 0.72~1.45 的亮度倍率（约 ±3.2dB 的
         高频能量差，听感明显但不夸张）。不额外建节点。
         ══════════════════════════════════════════════════════════ */
      const velBright = 0.72 + 0.73 * Math.pow(n.vel / 127, 0.7);
      /* CC74 亮度（默认 64 → 倍率 ≈1.0）＋ 触后加亮。
         两项都只改**同一个 lp 的截止频率**，不新增任何节点。 */
      const ccBright = 0.55 + (n.bright || 0.5) * 2.1 + (n.aft || 0) * 0.35;
      const cut = Math.min(16000, f0 * (tb.lp || 6) * (0.6 + bright * 0.4) * velBright * ccBright);
      /* ══════════════════════════════════════════════════════════
         ⚠️⚠️ 卡顿主因（本轮用 RTF 实测定位，不是猜的）

         **BiquadFilter 是全套里最贵的节点**。受控实验（OfflineAudioContext，
         300 声部同时响、渲染 2 秒）：

             F 无低通（1osc+gain）      209 ms   RTF 0.105
             A 有低通                   359 ms   RTF 0.180   ← 一个滤波器 +150ms
             E 全套（双osc+click+混响）  678 ms   RTF 0.339

         即：**单独一个低通滤波器就吃掉一半成本**。而它每音符建一个。

         而此前 maxVoices 给到 340 —— 比实测安全边界还激进
         （早先实测 420 上限时帧 p95 54ms、44 帧超 20ms）。

         对策（tier 2，最密集档）：**省略独立低通**，只走共享高通。
         每音符节点数 3~4 → 2（仅 gain + 振荡器）。
         代价：失去滤波包络（起音时截止频率开高再收回）。
         但密集段落里包络本就听不清，而掉音是致命的 —— 这是明确取舍。
         音色亮度改由 PeriodicWave 的谐波比例承担（h^-1.35 已限制高频）。
         ══════════════════════════════════════════════════════════ */
      if (q.tier >= 2) {
        /* 共享高通（已有缓存）；无高通时干声直连 out，送出仍从 head 接出，
           ⚠️ 不能把 tail 设成 out —— 否则 tail.connect(rv) 会变成
           out.connect(rv)，把主输出又送进混响，形成错误路径。 */
        if (tb.hp) {
          let hp2 = hpByChProg[rk];
          if (!hp2) {
            hp2 = ctx.createBiquadFilter();
            hp2.type = 'highpass';
            hp2.frequency.value = tb.hp;
            hp2.Q.value = 0.7;
            hp2.connect(out);
            hpByChProg[rk] = hp2;
          }
          head.connect(hp2);
          tailEarly = hp2;
        } else {
          head.connect(out);
          tailEarly = head;
        }
      } else if (q.tier >= 0) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      /* CC71 谐振：默认 64 → Q 0.9（与原来一致），范围 0.7~2.4。
         XG 曲常用它做「哇」感，原来忽略。 */
      lp.Q.value = 0.7 + (n.reso || 0.5) * 1.7;
      if (tb.fenv > 0.02 && n.dur > 0.05) {
        const open = Math.min(17000, cut * (1 + tb.fenv * 2.4));
        lp.frequency.setValueAtTime(open, when);
        lp.frequency.exponentialRampToValueAtTime(
          Math.max(180, cut * 0.75),
          when + Math.min(0.40, tb.atk + n.dur * 0.55),
        );
      } else {
        lp.frequency.value = cut;
      }
      head.connect(lp);
      /* 高通（串联）：切掉听不见的超低频，把动态余量还给中频。
         放在低通之后 —— 先塑音色再清淤。 */
      let tail0: AudioNode = lp;
      if (tb.hp) {
        let hp = hpByChProg[rk];
        if (!hp) {
          hp = ctx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.value = tb.hp;
          hp.Q.value = 0.7;
          hp.connect(out);
          hpByChProg[rk] = hp;
        }
        lp.connect(hp);
        tail0 = hp;
      } else {
        tail0.connect(out);
      }
      tailEarly = tail0;
      }

      const tail: AudioNode = tailEarly;
      /* 混响 / 合唱 / 回声 送出。
         ⚠️ send gain 全部按 (通道, 音色) 缓存复用 —— 同通道同音色的送出量相同，
         **每音符只是一次 connect，不新建节点**。这是「加很多效果但不卡」的关键。 */
      if (reverb && q.reverb && tb.rev > 0) {
        /* 和弦声部混响 ×2.3（上限 0.9 防止过湿糊成一团）。
           ⚠️ 1.9 → 2.3：用户第二次报「还是有点响」，而峰值已经和单音持平
           （chord16 -11.57 vs chord1 -12.16 dBFS），说明**绝对峰值降不动了**，
           只能靠加大湿声比让它在空间上更远、更「退到后面」。 */
        const revAmt = Math.min(0.9, tb.rev * prof.wet);
        let rv = revByChProg[revKey];
        if (!rv) { rv = ctx.createGain(); rv.gain.value = revAmt; rv.connect(reverb); revByChProg[revKey] = rv; }
        tail.connect(rv);
      }
      if (fx && q.fx) {
        if (tb.cho > 0.02) {
          let c = choByChProg[rk];
          if (!c) { c = ctx.createGain(); c.gain.value = tb.cho; c.connect(fx.chorus); choByChProg[rk] = c; }
          tail.connect(c);
        }
        if (tb.dly > 0.02) {
          let d2 = dlyByChProg[rk];
          if (!d2) { d2 = ctx.createGain(); d2.gain.value = tb.dly; d2.connect(fx.delay); dlyByChProg[rk] = d2; }
          tail.connect(d2);
        }
        /* 共振峰：送出量固定 0.5（和干声混合），强度由 tb.fq 控制 */
        if (tb.f1 && tb.f1 > 0) {
          /* ⚠️ key 用 **prog** 而不是 ch:prog：共振峰只由音色决定，
             用 ch:prog 会让同音色在不同通道各建一份（多通道 MIDI 常见）。 */
          let f = formByChProg[n.prog];
          if (!f) {
            f = ctx.createGain();
            f.gain.value = 0.5;
            f.connect(fx.formant(`${n.prog}`, tb.f1, tb.f2 || 0, tb.fq || 8));
            formByChProg[n.prog] = f;
          }
          tail.connect(f);
        }
      }

      const stopAt = when + n.dur + rel + 0.02;
      /* 单个 PeriodicWave 振荡器 = 原来的 3 个；失谐 > 0.5 时再叠一个反向失谐的副本
         保留「合唱厚度」，否则单振荡器会偏薄。
         ⚠️ 性能（修过）：原来每个振荡器还各带一个 gain（0.5 配平），
         现在把配平折进共用的 ADSR 峰值（peak / nOsc），**每音符少 1~2 个节点**。 */
      const wantPair = nOsc > 1;
      const oscs: OscillatorNode[] = [];
      const mk = (det: number) => {
        const o = ctx.createOscillator();
        o.setPeriodicWave(toneWave(ctx, tb));
        if (glide > 0) {
          o.frequency.setValueAtTime(f0Start, when);
          o.frequency.exponentialRampToValueAtTime(Math.max(20, f0), when + glide);
        } else {
          o.frequency.value = f0;
        }
        o.detune.value = det;
        o.connect(g);
        o.start(when); o.stop(stopAt);
        oscs.push(o);
      };
      if (wantPair) { mk(-tb.det); mk(+tb.det); }
      else mk(0);
    /* ⚠️ CC1 调制轮 → 颤音（vibrato）。原来完全没有，
       长音听起来像电子音「嗡——」一条直线，没有生命力。
       用一个低频 LFO 调制 detune（±约 25 cents）。 */
    let lfo: OscillatorNode | null = null;
    /* ⚠️ 真 bug（本轮修）：颤音 LFO 原来**完全不受音质档位门控** ——
       只要 CC1 调制轮 > 0.02 就建「LFO 振荡器 + gain」两个节点，
       在 tier 2（最该省的时候）照样每音符 +2 个节点。
       带 CC1 的曲子密集段落等于每个音多 2 个节点，且 LFO 是**全程在跑**
       的振荡器，音频线程成本比一次性节点更高。
       改成只在 tier 0 保留。 */
    if (q.vib && n.mod > 0.02 && oscs.length) {
      lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 5.2;
      const lg = ctx.createGain();
      lg.gain.value = n.mod * 25;          // cents
      lfo.connect(lg);
      oscs.forEach((o) => lg.connect(o.detune));
      lfo.start(when); lfo.stop(stopAt);
    }

    /* ⚠️ 起音瞬态：真实乐器发声的瞬间都有「敲击/拨弦/气流」的 noise burst，
       少了它，起音听起来是纯电子的「噗」。给短起音音色叠一点点。 */
    if (q.click && tb.click > 0.001) {
      const cl = ctx.createBufferSource();
      cl.buffer = noiseBuf(ctx, 0.03);
      const cf = ctx.createBiquadFilter();
      cf.type = 'bandpass';
      cf.frequency.value = Math.min(11000, f0 * 3.5);
      cf.Q.value = 0.9;
      const cg = ctx.createGain();
      /* 和弦大幅降低 click：N 个宽频噪声 burst 同时爆是最「刺」的部分，
         等能量下比乐音响得多。和弦不需要这份冲击（那是独奏的表现力）。 */
      cg.gain.setValueAtTime(amp * tb.click * prof.click, when);
      cg.gain.exponentialRampToValueAtTime(0.0001, when + 0.03);
      cl.connect(cf); cf.connect(cg); cg.connect(out);
      cl.start(when); cl.stop(when + 0.03);
    }

    live.push({
      stop: () => { oscs.forEach((o) => { try { o.stop(); } catch (_) {} }); if (lfo) { try { lfo.stop(); } catch (_) {} } },
      fade: (t: number) => { try { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, 0.004); } catch (_) {} },
      start: when,
      until: when + n.dur + rel + 0.05,
      perc: false,
    });
  };

  /** 滚动调度：把 [pos, pos + LOOKAHEAD] 内的音符排进去 */
  const pump = () => {
    if (!playing || !ctx || !data) return;
    if (pumping) return;              // 防重入（分批续排时可能重入）
    pumping = true;
    const __t0 = performance.now();
    /* ── 掉供观测：两次 pump 的实际间隔 ──
       setInterval 名义 PUMP_MS，但主线程被其它软件抢占时会拉长。 */
    let gapMs = PUMP_MS;
    if (lastPumpAt > 0) {
      gapMs = __t0 - lastPumpAt;
      if (gapMs > (diag as any).pumpGap) (diag as any).pumpGap = gapMs;
    }
    lastPumpAt = __t0;
    try {
      const now = ctx.currentTime;
      const pos = offset + (now - startedAt);
      const t0 = now + 0.06;
      const until = pos + LOOKAHEAD;
      let made = 0;
      while (nextIdx < data.notes.length && data.notes[nextIdx].time < until) {
        /* ⚠️ 卡顿主因之二：一次 pump 若遇到超密集段落（例如 32 分音符连奏、
           或大量重叠音），可能要建几百个节点 → 这一帧直接卡住几十毫秒，
           听感就是「顿一下」。分批处理：单次最多 BATCH 个，剩下的下一批继续。 */
        if (made >= (firstPump ? BATCH_FIRST : BATCH)) { morePending = true; break; }
        const n = data.notes[nextIdx++];
        /* 追赶时（比如被节流后）已经过去的直接跳过，不要再补发声 */
        if (n.time < pos - 0.05) {
          (diag as any).dropped++;
          const __lag = pos - n.time;
          if (__lag > (diag as any).maxLag) (diag as any).maxLag = __lag;
          /* 记录掉落发生时刻（曲内秒），用来判断是「开头」还是「播放中掉供」 */
          if ((diag as any).dropAt.length < 40) (diag as any).dropAt.push(+n.time.toFixed(2));
          continue;
        }
        /* 排到过去：Web Audio 会立刻发声但时间已错位，听感是「节奏乱了」 */
        const __when = t0 + (n.time - pos);
        if (__when < now) { (diag as any).late++; }
        /* ⚠️ 声部上限：
           - 真 bug（修过）：原来用 `live.length`，但里面含**已预排未发声**的音符
             （预排窗口 4 秒）→ 上限瞬间占满 → 后面音符全被丢弃。
             必须只统计「已开始且未结束」的。
           - 真 bug（修过）：原来超限时**丢弃新音符**，而打击乐（ch 9）短促、
             排在旋律后面，总是先被丢 → 鼓听起来又弱又断。
             现在：① 打击乐永不丢弃 ② 超限时**回收最老的旋律声部**，
             而不是丢掉正在进来的新音。 */
        /* ⚠️ 硬天花板（本轮修）：STEAL_PROTECT 会让 stealOldest 在密集段落
   全部返回 false（大家都是刚起音的），于是 activeVoices **无上限增长** ——
   加了保护反而比不加更容易爆。
   现在：超过档位上限 1.4 倍时无视保护，强制回收。
   正常情况（保护起作用）几乎不会走到这里，只是防止失控。 */
        /* ══════════════════════════════════════════════════════
           ⚠️ 致命 bug（本轮修，压力曲实测抓到）：

           原来用 `activeVoices + made >= cap` 判定。实测探针显示
           **activeVoices 恒为 0** —— 因为调度时刻 `when = now + 0.06`，
           而清理/统计用的 `now` 是本次 pump 的 `ctx.currentTime`，
           于是「已起音」(l.start <= now) 永远不成立
           （实测最早 start 恒为 now+0.06，已起音数恒为 0）。

           后果：主判定 `made >= cap` 基本失效（made 每次 pump 最多 48），
           真正生效的只有**强制回收**那一条（live.length > cap×1.4）——
           而它是「无视起音保护、硬切」的那条，最伤听感。
           实测 badapple.mid 11 秒内 **295 次回收，其中 283 次是强制**
           ≈ 每秒砍掉 27 个声部 —— 就是用户说的「吞声部」。

           改成只对 **live.length**（已排入音频图的总声部数，也就是真实成本）
           判定，并放宽上限：实测 44 音符/秒时 live 峰值 124，
           节点约 500 个，帧时间仍在 17ms，完全扛得住。
           上限怎么定的（实测权衡，不是拍脑袋）：
             · 192 → 113 次回收，帧 p50 17ms、最大 24ms、超 20ms 仅 1 帧
             · 300 →  99 次回收，帧 p50 17ms、最大 22ms、超 20ms 3 帧
             · 420 →   0 次回收，**但帧 p95 54ms、最大 73ms、44 帧超 20ms**
           最后一组说明：Bad Apple 这种密度**天然就需要 ~300 个声部**，
           而 300 个声部本身就已经把 CPU 吃满 —— 卡顿的真身是它，不是回收逻辑。
           既然如此，**温和地淡出几个声部，远比整段掉帧好听**，
           所以取 300（回收最少且帧时间仍干净），而不是追求 0 回收。
           ══════════════════════════════════════════════════════ */
        /* ══════════════════════════════════════════════════════════
           ⚠️ 真 bug（本轮实测抓到）：live 峰值 **301**，超过 tier2 上限 280。

           原因：打击乐 `if (l.perc) continue` **永不回收**，
           而 Bad Apple 这类曲子鼓点密集 → 鼓声部无限累积 →
           上限形同虚设，音频线程成本失控。

           但不能简单改成「打击乐也回收」—— 鼓的冲击力靠完整发声，
           回收会让鼓「又弱又断」（用户明确报过）。

           折中：平时仍不动鼓；**超过上限 15%** 时才允许回收打击乐。
           这是纯粹的失控兜底，正常情况不触发。
           ══════════════════════════════════════════════════════════ */
        if (live.length >= q.maxVoices) {
          const allowPerc = live.length > q.maxVoices * 1.15;
          if (!isDrum(n) || allowPerc) stealOldest(ctx!.currentTime, false, allowPerc);
        }
        playNote(n, t0 + (n.time - pos));
        made++;
        schedWin.push(performance.now());
      }
      /* live 只增不减会堆积几万条 → 内存泄漏 + stopAll 遍历卡顿。按结束时间清理，
         同时统计「正在响」的数量供声部上限使用。 */
      let w = 0;
      activeVoices = 0;
      for (let k = 0; k < live.length; k++) {
        const l = live[k];
        if (l.until > now) { live[w++] = l; if (l.start <= now) activeVoices++; }
      }
      live.length = w;
      if (live.length > (diag as any).maxLive) (diag as any).maxLive = live.length;
      /* ══════════════════════════════════════════════════════════
         ⚠️ 致命 bug（本轮修）：这里原来是**总线级再乘一次** polyComp，
         造成「复杂段落失声」。

         两个补偿叠加了：
           · 音符级：amp 里已经乘了 polyComp(n.conc)      （第 1882 行）
           · 总线级：这里又乘 polyComp(activeVoices)

         复杂段落两处都取到 20 左右 → 0.22 × 0.22 ≈ 0.048 → **-26 dB**。
         整体被压掉 26dB，听感就是「声音没了」；
         过了这段 conc 和 activeVoices 都降下来，音量自然回来 ——
         完全吻合「过了复杂的部分就又恢复正常」。

         必须二选一。保留**音符级静态**，理由：
           ① estimateRms 是按音符级 conc 标定的，两者一致，norm 才准
           ② 静态值解析期算好，没有 60ms 平滑滞后，不会有音量台阶
           ③ 总线级的初衷是「平滑和弦进出」，但它只会让密集段更闷

         总线级改为只做**削波兜底**：仅在实际并发远超静态预估时
         （踏板挂住导致叠加，activeVoices > conc × 1.6）才介入，
         且下限 0.7（-3dB），不会再把声音压没。
         踏板密集段仍靠软削波 + 压缩器兜住。 */
      if (polyGain) {
        const estConc = Math.max(1, avgConc);
        const over = activeVoices / estConc;
        const target = over > 1.6 ? Math.max(0.7, 1 / Math.pow(over / 1.6, 0.35)) : 1;
        if (Math.abs(polyGain.gain.value - target) > 0.012) {
          polyGain.gain.setTargetAtTime(target, ctx!.currentTime, 0.06);
        }
      }
    } finally {
      pumping = false;
      /* ── 动态档位：按**最近 1 秒的实际吞吐率**升降 ──
         阈值和 pickQuality 一致（15 / 40 音/秒），只是输入从「整曲平均」换成「实时窗口」。
         迟滞：升档要连续 2 次超标，降档要连续 8 次轻松 —— 避免在阈值附近抖动
         （抖动会让音色忽厚忽薄，比一直卡更难听）。 */
      const tNow = performance.now();
      /* ⚠️ 原地把超窗的戳挤掉，不 filter 新建数组 ——
         pump 每 50ms 一次，44 音/秒下数组有 44 项，每次都新建数组是白给的 GC 压力，
         在「其它软件占用 CPU」时这笔开销尤其不该付。 */
      let sw = 0;
      for (let i = 0; i < schedWin.length; i++) {
        if (tNow - schedWin[i] < 1000) schedWin[sw++] = schedWin[i];
      }
      schedWin.length = sw;
      const liveRate = schedWin.length;
      /* ══════════════════════════════════════════════════════════
         ⚠️ 本轮新增：把 **CPU 压力**纳入档位判定。

         原来只看音符密度（liveRate）。但用户报的场景是「其它软件占用时开始卡」——
         此时音符密度没变，档位却应该降，因为**瓶颈是 CPU 总量**：
         同样 30 音/秒，CPU 独占时游刃有余，被抢占时就供不上了。

         指标：pump 实际间隔 / 名义间隔。
           · 1.0  = 定时器准时，主线程空闲
           · 2.0+ = 主线程被抢占（实测 CPU 降速 8 倍时到 1.3，真机多开软件更高）

         ⚠️ 只在「非续排」的 pump 上采样：morePending 走 setTimeout(0)，
         间隔常常 < 5ms，会把 stress 拉到 0.1，反而掩盖真实的抢占。
         ══════════════════════════════════════════════════════════ */
      if (gapMs > PUMP_MS * 0.5) {
        const stress = Math.min(6, gapMs / PUMP_MS);
        cpuStress = cpuStress * 0.75 + stress * 0.25;
      }
      /* ⚠️ 阈值说明：沙盒实测 CPU 降速 8 倍时 pumpGap 只从 51ms 涨到 75ms
         （stress 1.54）—— 因为 CDP 的 throttle 是「降速 JS」，定时器仍准时，
         **它模拟不了真机「开别的软件抢时间片」那种 200~500ms 的延迟**。
         所以阈值定得比沙盒实测更敏感一点（1.4 / 2.2），真机上更早开始省。
         同时加一条**绝对兜底**：单次 pumpGap 超过 300ms 就是明确的掉供风险，
         不看 EMA 直接拉到最低档 —— EMA 平滑在突发抢占时反应太慢。 */
      const cpuTier = gapMs > 300 ? 2 : cpuStress > 2.2 ? 2 : cpuStress > 1.4 ? 1 : 0;
      const want = Math.max(liveRate > 25 ? 2 : liveRate > 10 ? 1 : 0, cpuTier);
      const target = Math.max(qBase.tier, want);
      if (target > q.tier) {
        if (++tierUp >= 2) { q = TIERS[target]; tierUp = 0; }
      } else if (target < q.tier) {
        if (++tierUp >= 8) { q = TIERS[target]; tierUp = 0; }
      } else {
        tierUp = 0;
      }
      window.__dbg = { liveRate, tier: q.tier, base: qBase.tier,
      /* 并发声部数：音频线程成本的直接指标，便于定位「卡」 */
      voices: live.length, act: activeVoices, cap: q.maxVoices };
    }
    /* 这一批没排完 → 立刻（下一个宏任务）接着排，不等下一个 tick */
    if (morePending && playing) {
      morePending = false;
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = window.setTimeout(() => { batchTimer = null; pump(); }, 0);
    }
  };

  /** 定位 nextIdx 到 offset（二分），用于开始 / 拖动进度 */
  const rewind = (to: number) => {
    if (!data) return;
    const ns = data.notes;
    let lo = 0, hi = ns.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ns[mid].time < to) lo = mid + 1; else hi = mid; }
    nextIdx = lo;
  };

  /** 开始（或拖动进度后继续）滚动播放 */
  const startRoll = (d: { notes: Note[]; duration: number }, from: number) => {
    if (!ctx) return;
    startedAt = ctx.currentTime + START_LEAD;
    offset = from;
    schedWin.length = 0; tierUp = 0; q = qBase;
    rewind(from);
    pump();
    if (pumpTimer) clearInterval(pumpTimer);
    pumpTimer = window.setInterval(pump, PUMP_MS);
    tick();
  };

  const tick = () => {
    if (!playing || !ctx || !data) return;
    const pos = offset + (ctx.currentTime - startedAt);
    if (pos >= data.duration) {
      stopAll();
      playing = false;
      play.textContent = '\u25b6';
      play.setAttribute('aria-label', '播放');
      if (pumpTimer) { clearInterval(pumpTimer); pumpTimer = null; }
      if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
      offset = 0;
      fill.style.width = '0%';
      tCur.textContent = fmt(0);
      tDur.textContent = ` / ${fmt(total)}`;
      /* ⚠️ 自然播完也要淡出频谱（同 audio 的 ended） */
      if (timer) clearTimeout(timer);
      timer = null;
      spec.stop();
      return;
    }
    /* START_LEAD 让起点在未来，刚开始时 pos 是负数 ——
       显示层 clamp 到 0，否则 fmt() 会输出负时间、进度条宽度变负。 */
    const shown = pos < 0 ? 0 : pos;
    tCur.textContent = fmt(shown);
    tDur.textContent = ` / ${fmt(total)}`;
    fill.style.width = `${(shown / data.duration) * 100}%`;
    timer = window.setTimeout(tick, 120);
  };

  play.onclick = async () => {
    try {
      const d = await ensure();
      if (playing) {
        offset += ctx!.currentTime - startedAt;
        stopAll();
        playing = false;
        spec.stop();
        play.textContent = '\u25b6';
        play.setAttribute('aria-label', '播放');
        if (timer) clearTimeout(timer);
      if (pumpTimer) { clearInterval(pumpTimer); pumpTimer = null; }
        return;
      }
      if (offset >= d.duration - 0.05) offset = 0;
      firstPump = true;      // 每次从头开始播放，首批都走小批量
      playing = true;
      /* 频谱：挂在最终输出节点上（旁路，不影响音质） */
      if (midiTap && ctx) { spec.attach(ctx, midiTap, false); spec.start(); }
      play.textContent = '\u275a\u275a';
      play.setAttribute('aria-label', '暂停');
      startRoll(d, offset);
    } catch (err) {
      flash(root, `MIDI 加载失败：${(err as Error).message}`);
      playing = false;
      spec.stop();
      play.textContent = '\u25b6';
    }
  };

  vol.oninput = () => { if (master) master.gain.value = Number(vol.value); fillAudioRange(vol); };

  const seekTo = (e: PointerEvent) => {
    const r = seek.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    /* ⚠️ 真 bug（修过）：MIDI 要 fetch + 解析才有 duration，
       首次点进度条时 data 还是 null → 直接 return，点了完全没反应。
       （实测：先点播放再点进度条能用，一上来就点进度条没用）
       改成未加载时先加载，加载完再定位。 */
    if (!data) {
      ensure().then(() => { if (data) applySeek(p); }).catch(() => {});
      return;
    }
    applySeek(p);
  };

  const applySeek = (p: number) => {
    if (!data) return;
    const to = p * data.duration;
    const wasPlaying = playing;
    if (wasPlaying) { stopAll(); playing = false; if (timer) clearTimeout(timer); if (pumpTimer) { clearInterval(pumpTimer); pumpTimer = null; } if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; } }
    offset = to;
    fill.style.width = `${p * 100}%`;
    tCur.textContent = fmt(to);
    tDur.textContent = ` / ${fmt(total)}`;
    if (wasPlaying) { playing = true; startRoll(data, offset); }
  };
  let drag = false;
  seek.addEventListener('pointerdown', (e) => { drag = true; try { seek.setPointerCapture(e.pointerId); } catch (_) {} seekTo(e); });
  seek.addEventListener('pointermove', (e) => { if (drag) seekTo(e); });
  seek.addEventListener('pointerup', (e) => { drag = false; try { seek.releasePointerCapture(e.pointerId); } catch (_) {} });

  root.tabIndex = 0;
  root.addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); play.click(); } });

  /* ⚠️ 预热（修过）：第一次点播放要做「建 AudioContext + fetch + 解析 + 生成混响 IR」
     四件事，实测主线程卡 **97ms** —— 用户按下去要顿一下才出声，就是「卡」的一部分。
     鼠标移到播放器上（或键盘聚焦）时提前做完，点下去就立刻响。
     不调用 resume()，所以不违反自动播放策略（resume 仍由点击手势触发）。 */
  let warmed = false;
  const warm = () => {
    if (warmed) return;
    warmed = true;
    ensure().catch(() => {});
  };
  root.addEventListener('pointerenter', warm, { once: true });
  root.addEventListener('focus', warm, { once: true });

  /* ⚠️ 光靠悬停不够：很多人是鼠标移过去**立刻就点**，悬停预热那 600ms 根本来不及
     （实测不预热首次播放卡 97ms，预热后 17ms）。要一层自动预热兜底。

     这一层改过两次：
       v2 = idle 时预热「一页前 3 个」—— ⚠️ 有问题：前 3 个可能在页面底部，
           用户永远滚不到、也永远不点，白白占着 AudioContext；
           而用户真正会点的那个反而因为排在后面没被预热。
       v3（现在）= **滚进视口才预热**（IntersectionObserver，提前 240px）。
           命中率最高：一页放 20 个 MIDI 也只有滚到的那几个建 AudioContext。
     超出上限的不会失效 —— 点击时仍然会 ensure()，只是少了预热（功能不受影响）。 */
  if (typeof IntersectionObserver !== 'undefined') {
    const io = new IntersectionObserver((ents) => {
      for (const e of ents) {
        if (!e.isIntersecting) continue;
        io.disconnect();
        if (warmCount >= WARM_LIMIT) return;
        warmCount++;
        warm();
        return;
      }
    }, { rootMargin: '240px 0px' });
    io.observe(root);
  }
}
