/**
 * 新手引导 —— 在编辑器内完成，不另开页面
 *
 * 核心规则：当前步骤的动作未完成时，不推进到下一步。
 *
 * 判定方式：不轮询界面状态 —— 状态会自行变化（地图加载完成时缩放数字跳动、
 * 导出菜单可能本来就处于展开状态），据此判定会误判为已完成。
 * 改为逐步监听操作：
 *   滚轮滚动 / 开关切换 / 年份按钮点击 / 地图涂抹 / 右键取色…
 * 仅在发生上述动作时记账，并等最低停留时间结束后进入下一步。
 * 推进也可用卡片上的「下一步 ▸」，或点「跳过」结束。
 *
 * 界面元素：高亮环（呼吸金环）+ 说明卡片 + 达成时的一圈绿光。
 */
(function () {
  'use strict';

  // id 选择器：接受带或不带 `#` 前缀的写法
  const $ = (s) => document.getElementById(String(s).replace(/^#/, ''));
  const q = (sel) => document.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TICK = 160;                       // 轮询间隔：仅用于刷新高亮环与检查动作记账

  /* ---------------------------------------------------------------- 界面快照 */
  const snap = () => ({
    boot: (() => { const b = $('boot'); return !b || b.style.display === 'none' || b.classList.contains('done'); })(),
    changes: ($('status-changes') || {}).textContent || '',
  });

  /** 左栏第一个「名称」开关：各游戏标签不同，按标签文本查找，不写死 id */
  function firstNamedSwitch() {
    for (const el of document.querySelectorAll('.switch input[type="checkbox"]')) {
      const t = (el.parentElement && el.parentElement.textContent) || '';
      if (t.includes('名称')) return el;
    }
    return $('#show-region-name') || $('#show-labels-paint') || null;
  }

  /* ---------------------------------------------------------------- 动作探针
   * 步骤开始时挂载监听（arm），只记本次步骤内的动作。
   * 记账后立即移除监听，避免重复计数。
   */
  function armOn(target, ev, flag) {
    const el = typeof target === 'string' ? q(target) : target;
    if (!el || !el.addEventListener) return null;
    const fn = () => {
      flag.hit = true;
      try { el.removeEventListener(ev, fn, true); } catch (e) { /* 取消失败可忽略 */ }
    };
    el.addEventListener(ev, fn, true);
    return () => { try { el.removeEventListener(ev, fn, true); } catch (e) { /* 忽略 */ } };
  }

  /* ---------------------------------------------------------------- 步骤表
   *   arm(flag)  = 该步骤需要监听的动作
   *   done(b, f) = 判定是否完成（b = 步骤开始时的界面快照，f = 动作记号）
   *
   *   注意事项：
   *     · 年份入口位于顶栏「剧本」下拉栏，不在「视图」那一排按钮中。
   *     · 「视图」那一排是地理层级（大洲 / 大区 / 区域 / 地区 / 省份）。
   *     · 导出入口按钮名为「文件 ▾」。
   *     · 撤销 / 搜索 / 悬停卡片均纳入步骤。
   *
   *   剧本步骤按界面状态分支：剧本 ≥3 个时使用「剧本」下拉栏；
   *     少于 3 个（CK3 / VIC3 / EU5）时年份为普通按钮，指向错误的元素会误导操作。
   */
  /** 是否存在「剧本」下拉栏（与 app.js 的 `useEraDropdown()` 使用同一判据） */
  function hasEraDropdown() {
    const g = $('era-group');
    return !!(g && !g.hidden && $('era-btn'));
  }
  /** 回退模式下**第一个年份按钮**（该排的首个按钮） */
  function firstEraButton() {
    const box = q('[data-role="tier"]');
    return box && box.children && box.children.length ? box.children[0] : null;
  }

  function buildSteps() {
    const booted = snap().boot;      // 地图已选好（如重开教程）→ 第一步跳过自动判定
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
        /* **地理层级**：
         *   大洲 → 大区（+次大陆） → 区域 → 地区 → 省份，
         *   点击切换到对应层级，越靠右越细。 */
        title: '更换层级',
        text: '顶栏「视图」那一排写着大洲、大区、区域、地区、省份，同一张地图可以换一种粗细来观察。'
          + '想看大块的地方就靠左边，想看清细节就靠右边，随便选择一个试试吧。',
        target: () => q('[data-role="tier"]'),
        arm: (f) => armOn(q('[data-role="tier"]'), 'click', f),
        done: (b, f) => f.hit,
      },
      {
        /* **剧本 / 年份**：
         *   剧本 ≥3 个 → 顶栏提供「剧本」下拉栏，展开后选择年份
         *   剧本 <3 个 → 年份为视图那一排中的普通按钮（回退模式） */
        title: '挑选剧本',
        text: () => (hasEraDropdown()
          ? '顶栏那个「剧本」下拉菜单，点开之后全是年份。挑选一个喜欢的就好，国界和配色都会整整齐齐变成那一年的模样。'
          : '「视图」那一排最左边就是年份按钮，轻轻按一下，国界和配色都会变成那一年的模样。'),
        target: () => (hasEraDropdown() ? $('era-btn') : firstEraButton()),
        arm: (f) => (hasEraDropdown()
          // 下拉模式：选中具体项才算完成（仅展开面板不算）
          ? armOn(q('[data-role="era-panel"]'), 'click', f)
          : armOn(firstEraButton(), 'click', f)),
        done: (b, f) => f.hit,
      },
      {
        // **先取色、后涂色**：先选定颜色，再进行涂抹
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
        // 仅松开鼠标不算完成（擦除操作也会触发）；要求**改动数确实增加**
        done: (b, f) => f.hit && snap().changes !== b.changes,
      },
      {
        /* **撤销**：
         *   顶栏 ↶ 按钮，或按 Ctrl+Z，两种操作均识别。 */
        title: '撤销操作',
        text: '不小心涂错了也不要紧，顶栏那个 ↶ 按钮按一下就能退回去（键盘 Ctrl+Z 同样可以）。'
          + '旁边的 ↷ 是重做，实在乱成一团还可以用「清除」重新开始，怎么尝试都不会弄坏真正的文件哦。',
        target: () => $('btn-undo') || q('#btn-undo'),
        arm: (f) => armOn($('btn-undo') || q('#btn-undo'), 'click', f),
        done: (b, f) => f.hit,
      },
      {
        /* **搜索**：地图较大时无法靠点击定位，使用左侧搜索框。 */
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
  // 浮层仅保留**卡片**（小标题 + 说明 + 两个按钮）、高亮环与「叮」光效；
  // 底部大字字幕已移除，其文字已并入卡片。
  let layer = null, ring = null, card = null, ping = null;
  function buildLayer() {
    if (layer && card && ring) return;             // 引用已就绪，无需重建
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
  let advancing = false;          // 推进锁：防止同一次达成被重复计数并连续推进多步
  // 每步最低停留（毫秒）：保证文案可读完；自测时可通过 __TUT_MIN_DWELL 调为 0
  let MIN_DWELL = 3200;

  const nowMs = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());

  function armStep(st) {
    if (disarmer) { try { disarmer(); } catch (e) { /* 忽略 */ } disarmer = null; }
    flag = { hit: false };
    if (st && st.arm) { try { disarmer = st.arm(flag); } catch (e) { disarmer = null; } }
  }

  function render() {
    const st = steps[idx];
    if (!st) return;
    if (!card) buildLayer();
    base = snap();
    since = nowMs();
    armStep(st);                                  // 挂上本步骤需要监听的动作
    if (card) {
      const a = card.querySelector('.tut-step'), b = card.querySelector('.tut-title'),
            c = card.querySelector('.tut-text');
      if (a) a.textContent = `${idx + 1} / ${steps.length}`;
      if (b) b.textContent = st.title;
      /* `text` 可以是**函数**：部分步骤需按当前界面状态决定文案
       *   （例如「挑选剧本」：剧本 ≥3 个时为下拉栏，少于 3 个时为普通按钮，
       *     两种文案需分别给出，固定一种会误导操作；见 buildSteps 中对应步骤）*/
      if (c) c.textContent = (typeof st.text === 'function') ? st.text() : st.text;
      card.classList.add('on');
    }
    requestAnimationFrame(() => placeRing(st.target && st.target()));
  }

  async function next(auto) {
    // **同一时间只允许推进一次**
    // 判定循环每 160ms 执行一次，同一达成状态会被重复判定；
    // 若不限制，一次操作可能连续推进多个步骤。
    if (!running || advancing) return;
    advancing = true;
    try {
      const st = steps[idx];
      const el = st.target && st.target();
      if (auto) {
        pingAt(el);                       // 「叮」提示：动作达成
        await sleep(1200);                // 稍作停留，便于看清提示与卡片
      }
      if (idx >= steps.length - 1) { finish(); return; }
      idx += 1;
      render();
    } finally {
      advancing = false;                  // 下一步已开始（或已结束）→ 释放锁
    }
  }

  function finish() {
    running = false;
    clearTimeout(timer);
    if (disarmer) { try { disarmer(); } catch (e) { /* 忽略 */ } disarmer = null; }
    // 完成或跳过时写入标记，避免「第一次玩」提示重复出现
    try { localStorage.setItem('pdx_tut_done', '1'); } catch (e) { /* 无痕模式无法写入 localStorage */ }
    if (!layer) return;
    if (card) card.classList.remove('on');
    if (ring) ring.classList.remove('on');
    tutorialToast('教程走完啦 ✓');
  }

  function loop() {
    if (!running) return;
    const st = steps[idx];
    placeRing(st.target && st.target());          // 目标移动（缩放/滚动）时同步跟随
    // **动作未完成不推进**：
    //   ① 必须在本步骤内**确实发生过动作**（flag 记账），界面状态自行变化不算
    //   ② 本步骤显示时间需达到 MIN_DWELL（默认 3.2 秒），保证文案可读完
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
   * 教程浮条（「教程走完啦」与启动 9 秒后的「第一次玩？」提示）
   * 当前关闭：函数首行直接返回，显示逻辑保留在下方。
   * 如需启用，移除首行的 return 即可；教程卡片使用独立的浮层 UI，不受影响。
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
    // 自测入口：可将每步最低停留调为 0
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
    // 首次使用：地图加载完成后提示一次（不强制，点击后才开始教程）
    setTimeout(() => {
      if (running || !$('btn-tutorial')) return;
      try {
        if (localStorage.getItem('pdx_tut_done') === '1') return;
        tutorialToast('第一次玩？点顶栏「教程」两个字，我带你走一遍 ✓');
      } catch (e) { /* 无痕模式无法读取 localStorage，跳过提示 */ }
    }, 9000);
  }

  window.initTutorial = init;
})();
