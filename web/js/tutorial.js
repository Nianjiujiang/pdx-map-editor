/**
 * 新手引导 —— **就在编辑器里**（不另开页面 ✓）
 *
 * 核心规矩（用户定的）：
 *   **这一步的要求没做到，就绝不往下跳** ✓
 *
 * 怎么做：不是"轮询界面状态" ✗ —— 状态会自己变（地图加载完缩放数字就跳一下、
 * 导出菜单可能本来就开着…），那样会误判成"你做到了" ✗。
 * 现在每一步都**直接监听你的动作**：
 *   滚轮真的滚了 / 开关真的点了 / 年份真的按了 / 地图真的涂了 / 右键真的按了…
 * 只有**你动手**才记账，然后（再等最低停留时间过去）才进下一步 ✓
 * 手痒想快进：卡片上的「下一步 ▸」；不想看了：「跳过」✓
 *
 * 界面上：圈出该点的东西（呼吸金环）+ 底部大字字幕 + 做到时"叮"一圈绿光 ✓
 */
(function () {
  'use strict';

  // id 选择器：**带不带 `#` 都收** ✓
  const $ = (s) => document.getElementById(String(s).replace(/^#/, ''));
  const q = (sel) => document.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TICK = 160;                       // 轮询间隔：只用来刷新高亮环和检查"动作记账"✓

  /* ---------------------------------------------------------------- 界面快照 */
  const snap = () => ({
    boot: (() => { const b = $('boot'); return !b || b.style.display === 'none' || b.classList.contains('done'); })(),
    changes: ($('status-changes') || {}).textContent || '',
  });

  /** 左栏第一个"名称"开关（各游戏叫法不同 ✓ 按标签找，别写死 id ✗） */
  function firstNamedSwitch() {
    for (const el of document.querySelectorAll('.switch input[type="checkbox"]')) {
      const t = (el.parentElement && el.parentElement.textContent) || '';
      if (t.includes('名称')) return el;
    }
    return $('#show-region-name') || $('#show-labels-paint') || null;
  }
  const wasteSwitch = () => $('waste-auto') || $('show-waste');

  /* ---------------------------------------------------------------- 动作探针
   * 一步开始时挂上（arm），只认"这一次"的动作 ✓
   * 记账了就撤掉监听，绝不重复算 ✗
   */
  function armOn(target, ev, flag) {
    const el = typeof target === 'string' ? q(target) : target;
    if (!el || !el.addEventListener) return null;
    const fn = () => {
      flag.hit = true;
      try { el.removeEventListener(ev, fn, true); } catch (e) { /* 取消失败也无所谓 ✓ */ }
    };
    el.addEventListener(ev, fn, true);
    return () => { try { el.removeEventListener(ev, fn, true); } catch (e) { /* ✓ */ } };
  }

  /* ---------------------------------------------------------------- 步骤表
   *   arm(flag)  = 这一步要监听什么动作
   *   done(b, f) = 算不算做到了（b = 这一步开始时的快照，f = 动作记号）
   */
  function buildSteps() {
    const booted = snap().boot;      // 地图已经选好（比如重开教程）→ 第一步不做自动判定 ✓
    // **这张图有没有荒地** ✓（HOI4 / 维多利亚3 一个都没有 ✗）
    //   怎么看：app 在没有荒地数据时会把「荒地」那几行收起来（style.display='none'）
    //   —— 教程**只认 DOM** ✓ 不碰 app 的 state ✗（那是模块内变量，开发版根本读不到 ✓）
    //   有 → 照旧教「荒地自动上色」；没有 → 换一句话、并且自己过去 ✓
    //   （以前没荒地时那一步会**永远卡住** ✗ 要勾的开关根本不存在 → 怎么做都不算完成 ✓）
    const _wlab = $('waste-label');
    const hasWaste = !(_wlab && _wlab.style && _wlab.style.display === 'none');
    return [
      {
        title: '选择地图',
        text: '选一个你中意的世界吧~ 挑好之后稍微等一下下，正在努力加载地图！',
        target: () => q('#map-pick-list') || q('#map-pick'),
        done: booted ? null : () => snap().boot,
      },
      {
        title: '推近看看',
        text: '把滚轮往上滚滚，凑近一点看嘛~ 地图放大之后，每块地的名字就会一块块悄悄探出头来。',
        target: () => q('#map'),
        arm: (f) => armOn($('map'), 'wheel', f),
        done: (b, f) => f.hit,
      },
      {
        title: '名称开关',
        text: '左栏这个「名称」开关，点一下打开，名字就会乖乖贴到地图上啦；要是觉得太乱，再关掉就干干净净了~',
        target: firstNamedSwitch,
        arm: (f) => armOn(firstNamedSwitch(), 'change', f),
        done: (b, f) => f.hit,
      },
      {
        title: '年份视图',
        text: '去顶栏的「视图」里点个其他年份试试，国界和配色统统变成那一年的样子！',
        target: () => q('[data-role="tier"]'),
        arm: (f) => armOn(q('[data-role="tier"]'), 'click', f),
        done: (b, f) => f.hit,
      },
      {
        // **先吸管、后涂色** ✓（用户定的顺序：先挑到满意的颜色，再上手涂 ✓）
        title: '右键就是吸管',
        text: '看到哪块地颜色好看？直接右键点它一下！那个颜色就自己溜进左边的调色板里，很方便吧？',
        target: () => q('#map'),
        arm: (f) => armOn($('map'), 'contextmenu', f),
        done: (b, f) => f.hit,
      },
      {
        title: '涂一块地',
        text: '在左边挑个喜欢的颜色，然后在地图上按住涂一块试试~',
        target: () => q('#map'),
        arm: (f) => armOn($('map'), 'mouseup', f),
        // 光松开鼠标不算 ✗（擦一下没涂上也算点过）→ 得**改动数真的涨了** ✓
        done: (b, f) => f.hit && snap().changes !== b.changes,
      },
      hasWaste ? {
        title: '荒地也能自动上色',
        text: '把「荒地自动上色」打开，沙漠和荒山就会自己乖乖跟着周围一起上色啦，不用一块块去操心~',
        target: wasteSwitch,
        arm: (f) => armOn(wasteSwitch(), 'change', f),
        done: (b, f) => f.hit,
      } : {
        // 没有荒地的图（HOI4 / V3）：这一条讲不了 ✗ → 说清楚为什么，停够时间自己过 ✓
        title: '这张图没有荒地',
        text: '沙漠、荒山这类走不了的地方，这张地图上本来就没有，所以「荒地」那组开关不用管它~ 我们接着往下走！',
        target: () => q('#map'),
        done: () => true,
      },
      {
        title: '想存下来就导出',
        text: '想留住这份杰作？点一下「导出 ▾」就好啦！整张图能存成 PNG，涂色也能存成文件 —— 下次导入就能接着改，不会丢进度的！',
        target: () => $('btn-export'),
        arm: (f) => armOn($('btn-export'), 'click', f),
        done: (b, f) => f.hit,
      },
      {
        title: '就这么简单',
        text: '剩下的随便点随便玩，弄乱了按「清除」就能恢复原样，不用怕玩坏哦。要是有什么问题，随时点顶栏那个「永夜廿九」来找我，我一直都在的！',
        target: () => $('btn-author'),
        done: null,
      },
    ];
  }

  /* ---------------------------------------------------------------- 浮层 */
  // 只留**卡片**（小标题 + 说明 + 两个按钮）+ 高亮环 + "叮" ✓
  // 底部那行白字黑边的大字幕**去掉了**（用户要求 ✓ 卡片里已经写了同样的字 ✓）
  let layer = null, ring = null, card = null, ping = null;
  function buildLayer() {
    if (layer && card && ring) return;             // 引用齐了就别动它 ✓
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'tutLayer';
      layer.innerHTML =
        '<div id="tutRing"></div>'
        + '<div id="tutPing"></div>'
        + '<div id="tutCard">'
        +   '<div class="tut-head"><span class="tut-step"></span><b class="tut-title"></b></div>'
        +   '<p class="tut-text"></p>'
        +   '<div class="tut-btns">'
        +     '<button type="button" class="tut-next">下一步 ▸</button>'
        +     '<button type="button" class="tut-skip">跳过</button>'
        +   '</div>'
        + '</div>';
      document.body.appendChild(layer);
    }
    ring = $('#tutRing'); card = $('#tutCard'); ping = $('#tutPing');
  }

  function placeRing(el) {
    if (!ring) return;
    if (!el) { ring.classList.remove('on'); return; }
    const r = el.getBoundingClientRect();
    if (r.width < 2 && r.height < 2) { ring.classList.remove('on'); return; }
    const pad = 8;
    ring.style.left = Math.round(r.left - pad) + 'px';
    ring.style.top = Math.round(r.top - pad) + 'px';
    ring.style.width = Math.round(r.width + pad * 2) + 'px';
    ring.style.height = Math.round(r.height + pad * 2) + 'px';
    ring.classList.add('on');
    if (card) {
      const cw = card.offsetWidth || 320, ch = card.offsetHeight || 150;
      const x = Math.min(Math.max(12, r.left), Math.max(12, window.innerWidth - cw - 12));
      let y = r.bottom + 14;
      if (y + ch > window.innerHeight - 12) y = Math.max(12, r.top - ch - 14);
      card.style.left = Math.round(x) + 'px';
      card.style.top = Math.round(y) + 'px';
    }
  }

  function pingAt(el) {
    if (!ping || !el) return;
    const r = el.getBoundingClientRect();
    ping.style.left = Math.round(r.left + r.width / 2) + 'px';
    ping.style.top = Math.round(r.top + r.height / 2) + 'px';
    ping.classList.remove('go');
    void ping.offsetWidth;
    ping.classList.add('go');
  }

  /* ---------------------------------------------------------------- 跑流程 */
  let steps = [], idx = 0, running = false, timer = 0;
  let base = null, flag = null, disarmer = null, since = 0;
  let advancing = false;          // 正在翻页的锁 ✓（防"一次做到被连算好几遍"✗）
  // 每步最低停留（毫秒）：一行字得看得完 ✓ 自测里可以调成 0 ✓
  let MIN_DWELL = 3200;

  const nowMs = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());

  function armStep(st) {
    if (disarmer) { try { disarmer(); } catch (e) { /* 无所谓 ✓ */ } disarmer = null; }
    flag = { hit: false };
    if (st && st.arm) { try { disarmer = st.arm(flag); } catch (e) { disarmer = null; } }
  }

  function render() {
    const st = steps[idx];
    if (!st) return;
    if (!card) buildLayer();
    base = snap();
    since = nowMs();
    armStep(st);                                  // 这一步要监听什么，现在就挂上 ✓
    if (card) {
      const a = card.querySelector('.tut-step'), b = card.querySelector('.tut-title'),
            c = card.querySelector('.tut-text');
      if (a) a.textContent = `${idx + 1} / ${steps.length}`;
      if (b) b.textContent = st.title;
      if (c) c.textContent = st.text;
      card.classList.add('on');
    }
    requestAnimationFrame(() => placeRing(st.target && st.target()));
  }

  async function next(auto) {
    // **同一时间只允许推进一次** ✓
    // （踩过的坑：判定循环每 160ms 跑一次 → 同一个"做到了"被连算七八次 ✗
    //   → 一次点击就把后面好几步全冲过去了 = "跳得飞快" ✗）
    if (!running || advancing) return;
    advancing = true;
    try {
      const st = steps[idx];
      const el = st.target && st.target();
      if (auto) {
        pingAt(el);                       // "叮"一下：你做到了 ✓
        await sleep(1200);                // 停一下，让"叮"和这张卡片被看清 ✓
      }
      if (idx >= steps.length - 1) { finish(); return; }
      idx += 1;
      render();
    } finally {
      advancing = false;                  // 下一步已经开始（或结束了）→ 放开锁 ✓
    }
  }

  function finish() {
    running = false;
    clearTimeout(timer);
    if (disarmer) { try { disarmer(); } catch (e) { /* ✓ */ } disarmer = null; }
    // 走完（或主动跳过）就记下来 —— 原来这个键只读不写，"第一次玩"的提示每次启动都弹
    try { localStorage.setItem('pdx_tut_done', '1'); } catch (e) { /* 无痕模式存不了就算了 */ }
    if (!layer) return;
    if (card) card.classList.remove('on');
    if (ring) ring.classList.remove('on');
    tutorialToast('教程走完啦 ✓');
  }

  function loop() {
    if (!running) return;
    const st = steps[idx];
    placeRing(st.target && st.target());          // 目标动（缩放/滚动）就跟着动 ✓
    // **要求没做到就不跳** ✓：
    //   ① 必须是**你在这一步里真的动过**（flag 记账）→ 状态自己变不算 ✗
    //   ② 这一步至少显示满 MIN_DWELL（默认 3.2 秒）→ 来不及看也不会跳 ✗
    if (st.done && nowMs() - since >= MIN_DWELL) {
      let ok = false;
      try { ok = !!st.done(base || snap(), flag || { hit: false }); } catch (e) { ok = false; }
      if (ok) { next(true); }
    }
    timer = setTimeout(loop, TICK);
  }

  function start() {
    buildLayer();
    steps = buildSteps();
    idx = 0;
    running = true;
    render();
    clearTimeout(timer);
    loop();
  }

  /* ---------------------------------------------------------------- 提示条 */
  /**
   * 教程自己的那两条浮条（「教程走完啦 ✓」+ 九秒后那句"第一次玩？点顶栏教程"）
   * **也关掉了** ✓（用户：这些提示都去掉好了）
   * 想开回来的话：把下面这行 return 注释掉 ✓ 显示逻辑原封不动都在这儿 ✓
   * 教程本身不受影响 ✓ —— 九步的卡片是另一套 UI ✓ 参考线、文案全在 ✓
   */
  function tutorialToast(msg) {
    return;
    /* eslint-disable no-unreachable */
    const el = document.createElement('div');
    el.className = 'tut-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    setTimeout(() => { el.classList.remove('on'); setTimeout(() => el.remove(), 400); }, 3200);
  }

  /* ---------------------------------------------------------------- 起飞 */
  function init() {
    // 自测用的小口子：把每步最低停留调成 0 ✓
    if (typeof window !== 'undefined' && window.__TUT_MIN_DWELL != null) {
      MIN_DWELL = Math.max(0, Number(window.__TUT_MIN_DWELL) || 0);
    }
    const btn = $('btn-tutorial');
    if (btn) btn.addEventListener('click', start);
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('.tut-next')) next(false);
      else if (t.closest('.tut-skip')) finish();
    });
    window.addEventListener('resize', () => {
      if (running && steps[idx]) placeRing(steps[idx].target && steps[idx].target());
    });
    // 第一次玩：地图烘完之后轻轻提一句（不强迫 ✓ 点一下才开）
    setTimeout(() => {
      if (running || !$('btn-tutorial')) return;
      try {
        if (localStorage.getItem('pdx_tut_done') === '1') return;
        tutorialToast('第一次玩？点顶栏「教程」两个字，我带你走一遍 ✓');
      } catch (e) { /* 无痕模式读不了 localStorage，那就不提示 ✓ */ }
    }, 9000);
  }

  window.initTutorial = init;
})();
