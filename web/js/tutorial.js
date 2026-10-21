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
   *
   * 🔴 **2026-10-20 整体重写** ✗✗（用户："教程过时不知道多久了，重新做一下"）
   *
   *   过时点（都跟 v1.10 的改版有关）：
   *     · 老第 4 步说"去顶栏的「视图」里点个其他年份"——
   *       年份**早就不在那一排了** ✗ 全收进了「剧本」下拉栏 ✓
   *       照老文案点，用户会在「大洲/区域/省份」那排里找一个不存在的年份 ✓
   *     · 那一排现在是**地理层级**（大洲 / 大区 / 区域 / 地区 / 省份）——
   *       这是 v1.10 的头号新功能，老教程一个字没提 ✗
   *     · 「导出 ▾」那个按钮**改名叫「文件 ▾」**了 ✓ 老文案还在喊旧名字 ✗
   *     · 撤销 / 搜索 / 悬停卡片这几个天天用的，老教程全没提 ✓
   *
   *   ⚠ 剧本那一步要**看情况**：剧本 ≥3 个才有下拉栏 ✓
   *     少于 3 个（CK3 / VIC3 / EU5）时年份就是普通按钮 ✓ 指错地方等于教错 ✗
   */
  /** 有没有「剧本」下拉栏（跟 app.js 的 `useEraDropdown()` 同一判据 ✓） */
  function hasEraDropdown() {
    const g = $('era-group');
    return !!(g && !g.hidden && $('era-btn'));
  }
  /** 回退模式下**第一个年份按钮**（那一排的第一个 ✓） */
  function firstEraButton() {
    const box = q('[data-role="tier"]');
    return box && box.children && box.children.length ? box.children[0] : null;
  }

  function buildSteps() {
    const booted = snap().boot;      // 地图已经选好（比如重开教程）→ 第一步不做自动判定 ✓
    // （「荒地也能自动上色」那一步已随荒地专属机制退役 ✓ —— 2026-10-15：
    //    水域 / 荒地 = 普通陆地，没有那组开关了 → 教程少这一步 ✓）
    return [
      {
        title: '挑选地图',
        text: '先挑选一个中意的世界吧。稍微等待一小会儿，地图正在努力加载中哦。',
        target: () => q('#map-pick-list') || q('#map-pick'),
        done: booted ? null : () => snap().boot,
      },
      {
        title: '放大地图',
        text: '向上滚动鼠标滚轮，把画面放大一点点。靠近之后，每一块土地的名字都会悄悄地浮现出来呢。',
        target: () => q('#map'),
        arm: (f) => armOn($('map'), 'wheel', f),
        done: (b, f) => f.hit,
      },
      {
        title: '名称开关',
        text: '左边这一栏的「名称」开关，轻轻点一下就能打开，地名会乖乖贴到地图上面。'
          + '如果觉得太热闹，再关掉就清清爽爽啦。',
        target: firstNamedSwitch,
        arm: (f) => armOn(firstNamedSwitch(), 'change', f),
        done: (b, f) => f.hit,
      },
      {
        /* 🔴 **地理层级**（v1.10 新增 ✓ 老教程完全没有这一步）
         *   大洲 → 大区（+次大陆） → 区域 → 地区 → 省份，
         *   点一下换一层看，越往右越细 ✓ */
        title: '更换层级',
        text: '顶栏「视图」那一排写着大洲、大区、区域、地区、省份，同一张地图可以换一种粗细来观察。'
          + '想看大块的地方就靠左边，想看清细节就靠右边，随便选择一个试试吧。',
        target: () => q('[data-role="tier"]'),
        arm: (f) => armOn(q('[data-role="tier"]'), 'click', f),
        done: (b, f) => f.hit,
      },
      {
        /* 🔴 **剧本 / 年份**（v1.10 改成下拉栏了 ✓）
         *   剧本 ≥3 个 → 顶栏有个「剧本」下拉，点开挑年份
         *   剧本 <3 个 → 年份就是视图那排里的普通按钮（回退模式 ✓） */
        title: '挑选剧本',
        text: () => (hasEraDropdown()
          ? '顶栏那个「剧本」下拉菜单，点开之后全是年份。挑选一个喜欢的就好，国界和配色都会整整齐齐变成那一年的模样。'
          : '「视图」那一排最左边就是年份按钮，轻轻按一下，国界和配色都会变成那一年的模样。'),
        target: () => (hasEraDropdown() ? $('era-btn') : firstEraButton()),
        arm: (f) => (hasEraDropdown()
          // 下拉模式：要等你**真的挑了一项**才算（打开面板不算 ✓）
          ? armOn(q('[data-role="era-panel"]'), 'click', f)
          : armOn(firstEraButton(), 'click', f)),
        done: (b, f) => f.hit,
      },
      {
        // **先吸管、后涂色** ✓（用户定的顺序：先挑到满意的颜色，再上手涂 ✓）
        title: '右键取色',
        text: '看到喜欢的颜色了吗？在那块土地上右键点一下，颜色就会自动落进左边的调色板里面，是不是很方便呀。',
        target: () => q('#map'),
        arm: (f) => armOn($('map'), 'contextmenu', f),
        done: (b, f) => f.hit,
      },
      {
        title: '涂抹颜色',
        text: '在左边挑选一个喜欢的颜色，然后在地图上按住鼠标拖动，涂抹出一片属于你的土地吧。',
        target: () => q('#map'),
        arm: (f) => armOn($('map'), 'mouseup', f),
        // 光松开鼠标不算 ✗（擦一下没涂上也算点过）→ 得**改动数真的涨了** ✓
        done: (b, f) => f.hit && snap().changes !== b.changes,
      },
      {
        /* 🔴 **撤销**（新增 ✓ 涂歪了怎么办是最常问的）
         *   顶栏 ↶ 那个按钮，或者 Ctrl+Z ✓ 两个都认 ✓ */
        title: '撤销操作',
        text: '不小心涂错了也不要紧，顶栏那个 ↶ 按钮按一下就能退回去（键盘 Ctrl+Z 同样可以）。'
          + '旁边的 ↷ 是重做，实在乱成一团还可以用「清除」重新开始，怎么尝试都不会弄坏真正的文件哦。',
        target: () => $('btn-undo') || q('#btn-undo'),
        arm: (f) => armOn($('btn-undo') || q('#btn-undo'), 'click', f),
        done: (b, f) => f.hit,
      },
      {
        /* 🔴 **搜索**（新增 ✓ 图大了光靠点根本找不着） */
        title: '搜索地名',
        text: '地图这么大，一格一格地点过去实在太累了。左边有一个搜索框，输入几个字就好'
          + '（地名或者势力名都可以），马上就能跳过去看看呢。',
        target: () => $('search'),
        arm: (f) => armOn($('search'), 'input', f),
        done: (b, f) => f.hit,
      },
      {
        title: '导出作品',
        text: '想把这幅作品留下来吗？点一下右上角的「文件 ▾」就好啦。整张地图可以保存成 PNG 图片，'
          + '涂抹的成果也能存成文件，下次导入还能接着修改，进度不会丢失哦。',
        target: () => $('btn-export'),
        arm: (f) => armOn($('btn-export'), 'click', f),
        done: (b, f) => f.hit,
      },
      {
        title: '尽情发挥',
        text: '剩下的就随意尝试吧，弄乱了按「清除」就能恢复原样，完全不用担心玩坏。'
          + '遇到问题随时点顶栏的「永夜廿九」来找我，我一直都在呢。',
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
      /* ⚠ `text` 可以是**函数** ✗ —— 有的步骤要按当时的界面决定说法
       *   （比如「挑个剧本」：剧本 ≥3 个是下拉栏、少于 3 个是普通按钮 ✓
       *     两套说法，写死一种就会教错 ✓ 见 buildSteps 里那一步 ✓）*/
      if (c) c.textContent = (typeof st.text === 'function') ? st.text() : st.text;
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
