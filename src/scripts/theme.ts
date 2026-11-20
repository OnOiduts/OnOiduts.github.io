/**
 * 明暗：首次进入跟随系统；用户手动切换后记住，永远不跟系统。
 * head 里的 inline script 负责首屏无闪烁地落值，这里负责交互。
 */
const KEY = 'onoiduts-theme';

export function initTheme() {
  const btn = document.querySelector<HTMLButtonElement>('#theme-toggle');
  const btnM = document.querySelector<HTMLButtonElement>('#theme-toggle-mobile');
  const sync = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    [btn, btnM].forEach((b) => {
      if (!b) return;
      b.innerHTML = dark ? sunIcon() : moonIcon();
      b.setAttribute('aria-label', dark ? '切换到日间' : '切换到夜间');
    });
  };
  const toggle = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(KEY, next);
    sync();
  };
  btn?.addEventListener('click', toggle);
  btnM?.addEventListener('click', toggle);

  // 只在用户从未手动选择过时跟随系统
  if (!localStorage.getItem(KEY)) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', (e) => {
      if (!localStorage.getItem(KEY)) {
        document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
        sync();
      }
    });
  }
  sync();
}

const moonIcon = () =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
const sunIcon = () =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>`;

/** 站内导航标记：点导航链接时写入，下一页据此跳过加载遮罩 */
export const BOOT_SKIP_KEY = 'onoiduts-skip-boot';

/** 供 head inline 使用的首屏落值逻辑（字符串形式注入） */
export const THEME_BOOTSTRAP = `
(function(){
  var k='${KEY}';
  var s=localStorage.getItem(k);
  var t=s||(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
  document.documentElement.dataset.theme=t;
  document.documentElement.dataset.world='org';

  /* 站内导航过来的：跳过加载遮罩。
     ⚠️ 必须在这里（head 里、#boot 渲染之前）就落 data-skip-boot ——
     等 bootSequence 走到时遮罩已经画出来了，会闪一下。
     标记读完立刻清掉，所以下次真正的刷新仍会正常显示加载态。 */
  try{
    if(sessionStorage.getItem('${BOOT_SKIP_KEY}')==='1'){
      document.documentElement.dataset.skipBoot='';
      document.documentElement.classList.add('app-ready');
      sessionStorage.removeItem('${BOOT_SKIP_KEY}');
    }
  }catch(e){}
})();
`;
