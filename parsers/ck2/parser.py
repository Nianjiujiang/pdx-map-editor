"""CK2（十字军之王 II）的地图数据解析。

CK3 那份（``parsers/ck3/parser.py``）能抄的地方都抄了 —— 两代引擎的脚本语法
是同一套（``key = value`` / ``key = { … }`` / ``#`` 注释 ✓），所以词法与语法
**直接复用 CK3 那份**（EU5 也是这么干的 ✓ 见 ``parsers/eu5/parser.py`` 的 import ✓），
不在这儿再抄一份 ✗（抄三份的教训见 ``build_standalone.py`` 顶上那段 ✓）。

⚠⚠ **CK2 跟 CK3 不是同一套地图模型** ✗✗ —— 这一条决定了下面所有事，先记牢：

    CK3：一个**省份** = 一个**男爵领**（``b_`` ✓ 见 landed_titles 里的 ``province = N`` ✓）
    CK2：一个**省份** = 一个**伯爵领**（``c_`` ✓ 见 ``history/provinces/<pid> - <名>.txt``
         里的 ``title = c_xxx`` ✓）

依据（实跑数出来的 ✓ CK2 3.3.3 vanilla ✓）：

* ``map/provinces.bmp`` 上真正用到的地块号是 **1 … 2014**（2014 个 ✓），
  跟 ``map/default.map`` 的 ``max_provinces = 2015`` 对得上 ✓
  （``definition.csv`` 里那 14148 行**大半是历史遗留** ✗ —— 2015 号以后
   一个像素都没有 ✓ 后面那些连省份号都没有的行是块调色板 ✓ 见 ``parse_definition`` ✓）
* ``history/provinces/`` 有 **1761** 个文件，每个里面一行 ``title = c_xxx``，
  去重后 **1740** 个伯爵领 ✓（跟 ``landed_titles`` 里的 c_ 数一模一样 ✓）
  → **1740 个陆地省份 ↔ 1740 个伯爵领，一一对应** ✓
* ``landed_titles`` 里有 **12973** 个 ``b_`` ✗ —— 它们是**伯爵领里面的地产
  （holding）** ✓（省份历史里写作 ``b_hvamm = tribal`` / ``b_kildare = city`` ✓
   一块地最多 ``max_settlements`` 个 ✓）**完全不占地图像素** ✗
* 海域：``default.map`` 的 ``sea_zones`` 覆盖 **259** 个地块号 ✓
  1740 + 259 = 1999，剩下的十来个是 ``externals``（丝绸之路那几条）之类的
  "有像素、没归属"的地块 → 走 ``#wasteland`` 那一条 ✓

于是编辑器这一侧：**最细那一层（男爵领）在地图上没有东西可画** ✗ ——
由 ``build_ck2.py`` 用 CK3 现成的那套「男爵领空缺 → 拿所属伯爵领的色块顶替」的
**降级机制**填满 ✓（``degradedBaronies`` ✓ 前端一行都不用改 ✓），依据写在那边 ✓。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable

# 词法 / 语法 / 颜色 / 定义表这几样两代引擎是同一套 ✓ 直接复用，别抄第二份 ✗
from parsers.ck3.parser import (
    Block,
    Title,
    as_int_list,
    as_rgb,
    block_all,
    block_get,
    parse_script,
)
#: 法理层级，**粗 → 细**（项目惯例 ✓）
#:
#: 🔴🔴 **CK2 只有四级，没有男爵领** ✗✗（2026-10-15 用户点名的 ✓ 依据在下面 ✓）::
#:
#:     帝国(e_) → 王国(k_) → 公爵领(d_) → 伯爵领(c_)        ← 地图上的四级
#:     男爵领(b_)                                          ← **不上地图** ✗
#:
#: 依据（实跑数出来的 ✓ CK2 3.3.3 vanilla ✓）：
#:   · 地图上真正有像素的地块是 1…2014（2014 个 ✓ 见 `parse_max_provinces` ✓），
#:     其中陆地 1740 个 ✓ —— 而 `history/provinces/*.txt` 里那 1740 行
#:     `title = c_xxx` **全部指向伯爵领** ✓（去重后 1740 个 `c_` ✓ 一个 `b_` 都没有 ✓）
#:   · `landed_titles` 里那 **12973** 个 `b_` 是**伯爵领里面的地产（holding）** ✓
#:     —— 省份历史里写作 `b_hvamm = tribal` / `b_kildare = city` ✓
#:       一块地最多 `max_settlements` 个 ✓ 它们**一个像素都不占** ✗
#:   · 所以"一个省份 = 一个伯爵领" ✓ 男爵领那一级在地图上**没有落点** ✓
#:     （CK3 反过来：那边一个省份 = 一个男爵领 ✓ 所以它有五级 ✓ 这是两款游戏
#:       地图模型的正经差别，不是我们少做了一级 ✓）
#:   · 强行留一级空的话：`titles.json` 会白胖一万两千多条"没地盘"的节点 ✓
#:     每一层还都得靠"降级"填 ✓ —— 那才是编数据 ✗
TIER_ORDER = ("e", "k", "d", "c")
TIER_NAME = {"e": "帝国", "k": "王国", "d": "公爵领", "c": "伯爵领"}

#: 头衔 key 的合法形状。CK2 的 key 也是 ``c_luneburg`` / ``b_st_brigit`` 这种 ✓
#: 连字符照 CK3 一样留着（``c_sieradzko-leczyckie`` 那种写法两边都有 ✓ 漏了会整块地掉层 ✓）
_TITLE_RE = re.compile(r"^([ekdcb])_([A-Za-z0-9_\-]+)$")

#: **不上地图的那一级**（见 `TIER_ORDER` 那段 ✓）—— 解析时直接跳过 ✗
#: ⚠ 跳过而不是"收下再筛" ✗：12973 个 b_ 块里还嵌着别的块 ✓
#:   走一遍白花时间，还会往 ``titles``/``children`` 里塞一万多条用不上的东西 ✓
SKIP_TIERS = ("b",)

#: 头衔表的编码。vanilla 的 ``landed_titles.txt`` 是 **UTF-8 BOM** ✓
#: 但模组 / 别的版本有 cp1252 的 ✗ → 一律走回退链 ✓（localisation 那边更是混的 ✓）
_ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")


def read_text(path: Path) -> str:
    """按回退链读一个文本文件（CK2 的文件编码是**混的** ✓ 见 ``_ENCODINGS`` ✓）"""
    for enc in _ENCODINGS:
        try:
            return path.read_text(encoding=enc)
        except (UnicodeDecodeError, LookupError):
            continue
        except OSError:
            return ""
    return path.read_text(encoding="latin-1", errors="replace")


# ---------------------------------------------------------------- definition.csv


def parse_definition(path: Path, max_prov: int) -> dict[int, tuple[int, int, int, str]]:
    """读 ``map/definition.csv`` → ``{province_id: (r, g, b, 内部名)}``。

    格式跟 CK3 的 ``map_data/definition.csv`` 一模一样
    （``省份号;R;G;B;名字;x`` ✓ 分号隔开 ✓），但**有两条 CK2 专属的坑** ✗：

    ⚠ ① **编码是 cp1252** ✗ 不是 UTF-8 ✓（``Ã…`` 那种字母满地都是 ✓
       用 UTF-8 读会 ``UnicodeDecodeError`` 直接崩 ✓ 见 ``read_text`` ✓）
    ⚠ ② **行数远多于真正的地块数** ✗✗ —— 这份 vanilla 里有 **14148** 行，
       可地图上只用了 1…2014（``max_provinces = 2015`` ✓）；
       2015 号往后**一个像素都没有** ✓，最后 61 行甚至连省份号都没有
       （``;108;16;240;x;x`` 这种，是块调色板 ✓ 我上一轮就是这么被它骗的 ✓）。
       → **按 ``max_provinces`` 裁掉** ✓（``max_prov`` 由调用方从 default.map 读 ✓）
       不裁的话 ``numProvinces`` 会变成 14149 ✓ 前端按它建纹理、算偏移 ✓
       整张图会多出 1.2 万个"永远没有像素"的空位 ✗（还白白多 24 KB 的 id 表 ✓）

    :param max_prov: ``max_provinces`` 的值 = **最大省份号 + 1** ✓
                     （CLI 口径跟游戏一致：``max_provinces = 2015`` 时合法号是 1…2014 ✓）
    """
    out: dict[int, tuple[int, int, int, str]] = {}
    for line in read_text(path).splitlines():
        parts = line.split(";")
        if len(parts) < 5:
            continue
        try:
            pid = int(parts[0])
            r, g, b = int(parts[1]), int(parts[2]), int(parts[3])
        except ValueError:
            continue                      # 表头 / 空行 / 调色板那几行 ✓ 正常跳过
        if not (0 < pid < max_prov):
            continue                      # 2015 号往后的历史遗留：地图上没有 ✓ 裁掉 ✓
        out[pid] = (r, g, b, parts[4])
    return out


# ---------------------------------------------------------------- default.map

#: 只认这几个键的值（别的键是文件名 / 调参 ✓ 解析出来也没用 ✓）
#: ⚠ ``sea_zones`` 是 CK2 的叫法 ✗ —— EU4 才叫 ``sea_starts`` ✓ CK3 也叫 ``sea_zones`` ✓
_LIST_KEYS = ("sea_zones", "major_rivers", "externals", "lakes", "impassable_seas",
              "impassable_mountains")


def parse_max_provinces(path: Path, fallback: int = 0) -> int:
    """读 ``map/default.map`` 里的 ``max_provinces`` —— **= 最大省份号 + 1** ✓

    这一条是 CK2 的"省份总数"权威口径 ✓（实跑对的账 ✓）：

    * ``max_provinces = 2015`` → 合法地块号是 **1…2014**（2014 个 ✓）
    * ``provinces.bmp`` 上真正用到的地块号：**1…2014**，正好 2014 个 ✓
    * ``localisation`` 里 ``PROV0``…``PROV2014`` 共 **2015** 个键 ✓ 一个不多一个不少 ✓
    * 反过来 ``definition.csv`` 有 **14148** 行 ✗ —— 2015 号往后**一个像素都没有** ✓
      → 所以**必须**拿这个数去裁 definition.csv ✓ 见 ``parse_definition`` ✓
      （不裁的话 ``numProvinces`` 会变成 14149 ✓ 前端多背 1.2 万个空位 ✓）

    :param fallback: 文件里没有这个键时按它算（0 = 让调用方自己判 ✓）
    """
    if not path.is_file():
        return fallback
    v = block_get(parse_script(read_text(path)), "max_provinces")
    nums = as_int_list(v)
    return nums[0] if nums else fallback


def parse_default_map(path: Path) -> dict[str, set[int]]:
    """读 ``map/default.map`` → ``{键: {地块号}}``。

    ⚠ 这份**不能拿 CK3 的 ``build_data.parse_default_map`` 来读** ✗✗
      那个是按行正则扫的，CK2 有三处会当场读歪 ✓：

    ⚠ ① **``sea_zones = { 936 943 }`` 是【区间】** ✗ 不是"936 和 943 两个号" ✓
       （``= { 1014 1111 }`` 是 98 个海地块 ✓ 当两个号读的话海边会缺一大片 ✓
         CK3 / EU4 的同类写法是 ``RANGE { 632 641 }`` 那样带前缀的 ✓
         CK2 **没有前缀** ✗ 每个 ``sea_zones`` 都是区间 ✓）
       —— 反过来 ``major_rivers`` 是**一个一个列**的（``1043 1044 1045 #Rhine`` ✓）
       ✗ 所以两个键的读法不一样 ✓ 见下面分支 ✓
    ⚠ ② **有嵌套** ✗：``ocean_region = { sea_zones = { 1 2 3 … 15 } }`` ✓
       行扫会把里面那几个 ``sea_zones`` 也当真的收走 ✓ → **1…15 号陆地省份变海** ✗
       （那几号是 Vestisland / Austisland / Tyrconnell… 全是大西洋上的正经陆地 ✓）
    ⚠ ③ ``major_rivers`` 的 ``{`` **另起一行** ✗ ——
       ``major_rivers = `` 后面是换行、方块从下一行开始 ✓
       行扫会读出一个**空集** ✓（volga / 莱茵 / 尼罗河全部丢掉 ✓ 我第一版就栽在这儿 ✓）

    → 所以这里**不按行走** ✗，直接把整份文件丢给现成的脚本解析器 ✓：
      `ocean_region` 天然是一个**独立的键** ✓ 它的嵌套 `sea_zones` 压根碰不到 ✓；
      换行的方块也是语法本身的事 ✓ —— 三条坑一次性全躲开 ✓（比逐条打补丁稳 ✓）

    :returns: 键 → 地块号集合。没有的键（CK2 没有 ``lakes`` ✓）**不出现在字典里** ✓
              调用方按 ``.get(键) or ()`` 取 ✓ 别指望空集合 ✓
    """
    out: dict[str, set[int]] = {}
    if not path.is_file():
        return out
    block = parse_script(read_text(path))
    for key in _LIST_KEYS:
        if key == "sea_zones":
            # **每一个** `sea_zones` 各自是一个区间 ✓（25 段 ✓ 见 docstring ①）
            # ⚠ 不能把 25 段拼成一个列表再取头两个数 ✗ —— 那样只剩第一段（936…943 ✓
            #   实跑过：259 个海地块会缩成 8 个 ✓ 然后 251 个海被当成"有像素没归属的陆地" ✓）
            acc: set[int] = set()
            for value in block_all(block, key):
                nums = as_int_list(value)
                if len(nums) >= 2:
                    acc.update(range(nums[0], nums[1] + 1))
                elif nums:
                    acc.add(nums[0])
            if acc:
                out[key] = acc
            continue
        nums: list[int] = []
        for value in block_all(block, key):
            nums.extend(as_int_list(value))
        if nums:
            out[key] = set(nums)           # 其余键本来就是逐个数列 ✓
    return out


# ---------------------------------------------------------------- landed_titles


def parse_landed_titles(path: Path
                        ) -> tuple[dict[str, Title], dict[str, int]]:
    """解析 ``common/landed_titles/landed_titles.txt``（CK2 就这一个文件 ✓）。

    头衔树是靠**嵌套**表达的，跟 CK3 一式一样 ✓::

        e_x = { k_y = { d_z = { c_w = { b_v = { } } } } }

    🔴 **`b_` 那一级整块跳过** ✗（CK2 的男爵领是伯爵领里的地产、不占地图像素 ✓
    见 ``TIER_ORDER`` 那段长注释 ✓）—— 所以返回的 ``titles`` 里只有四级 ✓。

    :returns: ``(titles, capitals)``
              ``titles`` = ``{头衔 key: Title}``（用 CK3 那个类 ✓ 见文件头说明 ✓）
              ``capitals`` = ``{头衔 key: 法理首都的**省份号**}}``

    ⚠⚠ **``capital`` 在 CK2 里是【地块号】** ✗✗ 不是头衔 key ✓
       （``e_outremer = { capital = 774 }`` ✓ 774 号地块 ✓）
       这跟 CK3 **正好相反** ✗（CK3 写的是 ``capital = c_roma`` 那种头衔 key ✓）
       → 所以**不往 ``Title.capital`` 里塞** ✗（那个字段在 CK3 那边定义成"头衔 key" ✓
         塞个数字进去，将来谁拿它去 ``titles[]`` 查就是一场空 ✓）
         另开一个字典返回 ✓ 调用方要用自己拿 ✓

    ⚠⚠ **只往下走【头衔块】** ✗✗ —— 这一条是整份文件里最容易读错的地方：
       头衔体内还有 ``allow`` / ``trigger`` / ``conditional_tooltip`` /
       ``cultural_names`` 这些**非头衔块** ✓ 它们里面的 ``k_germany = { … }``
       是**引用**（"这个头衔是不是存在/是不是名义头衔"那种判断 ✓）不是定义 ✓
       走进去就会把**王国挂到公国底下** ✓（``e_outremer`` 的 ``allow`` 里还引用了
       ``e_outremer`` 自己 ✓ 于是它会变成**自己的父级** ✓ 一条自环 ✓）
       —— CK3 那份是走进去的 ✓（它的数据里没这个写法 ✓）CK2 这边**不能** ✗
       ⚠ 反过来不用担心漏头衔 ✗：CK2 的法理树是**直接嵌套**的
         （``d_`` 直接写在 ``k_`` 体内、``c_`` 直接写在 ``d_`` 体内 ✓ 实跑核过 ✓）
         这一条我拿"正则数出来的头衔数"对过账 ✓ 见 ``build_ck2.py`` 的日志 ✓

    ⚠ ``color2`` **不读** ✗ —— CK2 每个头衔还带一个副色（``color2={ 255 255 255 }`` ✓
       那是"地图上相邻同级头衔撞色时用哪个"那套防混淆机制 ✓ 编辑器只填一个主色 ✓
       跟 CK3 那份同一个口径 ✓ 头衔没有 ``color`` 的会往上继承 ✓）
    """
    titles: dict[str, Title] = {}
    capitals: dict[str, int] = {}

    def walk(block: Block, stack: list[str]) -> None:
        for key, value in block:
            if key is None:
                continue
            m = _TITLE_RE.match(key)
            if m is not None and isinstance(value, list):
                # 🔴 **男爵领跳过** ✗（CK2 不上地图 ✓ 见 `TIER_ORDER` 那段长注释 ✓）
                if m.group(1) in SKIP_TIERS:
                    continue
                t = titles.get(key)
                if t is None:
                    t = titles[key] = Title(key)
                # ⚠ 一个头衔**在文件里可能出现好几次** ✗（名义头衔在最前面顶格一次 ✓
                #   法理树里又嵌一次 ✓）—— **第一次定下来的父级为准** ✓
                #   后面那些当引用看 ✓ 不重挂 ✓（CK3 那份是"后写覆盖前写"，这里不能照抄 ✗：
                #   CK2 顶格那批标题（e_rebels / k_papal_state 那种）先出现 ✓
                #   它自己是**顶格**的 → 挂不上父级 ✓ 后面真嵌进树里那次才是它的位置 ✓
                #   ⚠ 于是这里要的恰恰是"**后写的**那次才挂"——用"还没父级就挂"实现 ✓
                #     一旦挂上就不再改 ✓ 两个方向的乱序都能兜住 ✓）
                if stack and t.parent is None:
                    t.parent = stack[-1]
                    pt = titles.get(stack[-1])
                    if pt is not None and key not in pt.children:
                        pt.children.append(key)
                stack.append(key)
                walk(value, stack)          # 只有**头衔块**往下走 ✓ 见 docstring ✓
                stack.pop()
                continue

            # ---- 非头衔键：只认"当前头衔"身上的那几个 ✓
            if not stack:
                continue
            cur = titles.get(stack[-1])
            if cur is None:
                continue
            if key == "color":
                if cur.color is None:
                    rgb = as_rgb(value)
                    if rgb is not None:
                        cur.color = rgb
                continue
            if key == "capital":
                if stack[-1] not in capitals:
                    # CK2 写的是**地块号** ✓（`capital = 774` ✓）
                    nums = as_int_list(value)
                    if nums:
                        capitals[stack[-1]] = nums[0]
                continue
            # 其余（`allow` / `old_saxon = Ostfalia` / `de_jure_liege` …）一律不管 ✓
            # ⚠ **不往下递归** ✗ —— 见 docstring 里那两段 ✓

    walk(parse_script(read_text(path)), [])
    return titles, capitals


# ---------------------------------------------------------------- 省份历史

#: ``history/provinces/1 - Vestisland.txt`` 这种文件名
_PROV_FILE_RE = re.compile(r"^(\d+)\s*-")
#: 文件里那行 ``title = c_vestisland``
#: ⚠ **行尾不能锚死** ✗ —— vanilla 里有两个文件是这么写的::
#:       title = c_sieradzko-leczyckie		#With HF = Czersk, Warsaw, Gostynin, Rawa
#:       title = c_czersk		#Is more or less "Liw" since HF
#:   （528 / 530 号 ✓ 都带一条**制表符 + 行尾注释** ✓）
#:   锚成 `\s*$` 那两个就读不出来 ✓ → 528 / 530 会掉进"有像素没头衔"那堆 ✓
#:   变成两块灰的荒地 ✓（实跑核过 ✓ 这就是我第一版少 2 个省份的原因 ✓）
_PROV_TITLE_RE = re.compile(r"(?m)^\s*title\s*=\s*\"?([A-Za-z0-9_\-]+)\"?")


def parse_province_history(province_dir: Path) -> dict[int, str]:
    """读 ``history/provinces/*.txt`` → ``{地块号: 伯爵领 key}``。

    **这就是 CK2 的"省份轴"** ✓✓ —— 一个地块归哪个伯爵领，只写在这里 ✓
    （CK3 那条路数是 ``landed_titles`` 里每个 b_ 自己带 ``province = N`` ，
      CK2 **一个都没有** ✗ 全文 ``province =`` 出现 0 次 ✓ 实跑核过 ✓
      —— 谁要是照 CK3 那样去头衔里找省份号，会得到一张**全空**的归属表 ✓）

    文件格式（``history/provinces/1 - Vestisland.txt`` ✓）::

        # 1 - Vestisland
        title = c_vestisland        ← 要的就是这一行
        max_settlements = 1
        b_hvamm = tribal            ← 男爵领 = 这块地里的**地产** ✓ 不占地图像素 ✓
        culture = norse
        terrain = arctic
        867.1.1 = { … }             ← 剧本历史（本版不读 ✓ 见 build_ck2 那段 TODO ✓）

    ⚠ 文件名里的编号才是**地块号** ✗ —— 别去信文件里第一行那个注释 ✓
      （它对得上 ✓ 但注释是给人看的 ✓ 编号是文件名 ✓）
    ⚠ 文件名里有**空格**（``1013 - Lori.txt`` ✓）→ 用正则切 ✓ 别 ``split(" ")`` ✗
    ⚠ 一个伯爵领可能被两个地块号指向（vanilla 里有 1 例：``c_kyzyl`` ✓）
      —— 照收 ✓ 那个伯爵领会同时拿到两个地块 ✓（不特殊处理：数据就是这样 ✓）
    """
    out: dict[int, str] = {}
    if not province_dir.is_dir():
        return out
    for fp in sorted(province_dir.glob("*.txt")):
        m = _PROV_FILE_RE.match(fp.name)
        if m is None:
            continue
        t = _PROV_TITLE_RE.search(read_text(fp))
        if t is None:
            continue
        out[int(m.group(1))] = t.group(1)
    return out


def prov_loc_key(pid: int) -> str:
    """``PROV<pid>`` —— **CK2 的伯爵领名字挂在这个键上** ✓✓（不是 ``c_xxx`` ✗）

    实跑数出来的（vanilla 3.3.3 ✓ 这条最容易想当然，先说清楚）：

    * ``localisation/`` 里 ``PROV*`` 键 **2015 个**，正好覆盖 1…2014 ✓ 一个不缺 ✓
      （``PROV1;Vestisland`` ✓ ``PROV123;…`` ✓）
    * ``c_*`` 键只有 **2154** 个，而且里面还包括 ``cu_`` / ``ca_`` 那种别的键 ✗
      —— **1432 个伯爵领压根没有 ``c_xxx`` 名字** ✓
      （``c_aargau`` / ``c_acre`` / ``c_achaia`` / ``c_abkhazia`` 这些正经伯爵领
       全都没有 ✓ 直接拿 ``c_`` 去查会有一大半变成光秃秃的 key ✓）
    * 反倒是 ``b_*``（男爵领）有 **13816** 个名字 ✓ —— CK2 里
      **"一块地的名字"本来就是它那个首府男爵领的名字** ✓（``b_luneburg`` → Lüneburg ✓）

    所以：**地图上该显示什么名字，看 ``PROV<地块号>``** ✓
    （它就是游戏画在地图上的那个地名 ✓ 也跟 ``definition.csv`` 第 5 列同源 ✓）
    编辑器每一层显示的是头衔名 ✓ 而 CK2 一个省份 = 一个伯爵领 ✓
    → 伯爵领那一层的名字取它自己那个地块的 ``PROV`` ✓ 见 ``build_ck2.py`` ✓
    """
    return f"PROV{int(pid)}"


# ---------------------------------------------------------------- 剧本历史
#
# ⚠⚠ **CK2 的 `history/titles` 跟 CK3 那份【结构不一样】** ✗✗ —— 这一段最容易照抄错 ✓
#
#   CK3：一个文件里装着**好几个头衔**，头衔 key 包着日期::
#
#       k_mesopotamia = {          ← 文件里写着头衔
#           1066.9.15 = { holder = 145292  liege = e_persia }
#       }
#
#   CK2：**一个头衔一个文件**，头衔 key 在**文件名**上，顶层键直接就是日期 ✓::
#
#       history/titles/b_aarschot.txt
#           1066.1.1={ liege="c_brabant" }      ← 顶层键 = 日期
#           1066.1.1={ holder=33193 }
#
#   ⚠ 所以**不能**拿 `parsers/ck3/parser.py` 的 `parse_title_history` 来读 ✗ ——
#     那个要求"顶层键是头衔 key 且在 titles 里" ✓ CK2 这边顶层键是日期 ✓
#     直接借会**一条都读不出来** ✓（而且不报错，静默全空 ✓ 最坑的那种 ✓）
#
#   ⚠ 还有一层：文件里**也有不带日期的顶层 `holder` / `liege`** ✓（实跑 309 / 22 条 ✓）
#     那是"最开始那一条"（相当于 1.1.1 ✓）→ 这里按日期 ``(0, 0, 0)`` 收 ✓
#     任何带日期的条目都比它新 ✓ 正好是想要的先后 ✓

#: ``1066.1.1`` / ``751.1.1`` 这种日期键
_DATE_KEY = re.compile(r"^(\d{3,4})\.(\d+)\.(\d+)$")


def _as_date(s: object) -> tuple[int, int, int] | None:
    m = _DATE_KEY.match(str(s))
    if m is None:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def parse_title_history(history_dir: Path, until: tuple[int, int, int],
                        titles: dict[str, "Title"] | None = None,
                        ) -> tuple[dict[str, int | str], dict[str, str | None],
                                   dict[str, str | None]]:
    """读 ``history/titles/*.txt`` 里 **≤ until** 的最后一条归属（见上面那段 ✓）。

    :param until: 取到哪一天为止（**含当天** ✓）—— 剧本日期从 bookmark 里读 ✓
                  （``find_bookmark`` ✓ 别自己拍 ✗）
    :param titles: 给了就顺手把"指向不存在的头衔"的条目**滤掉** ✓
                   （CK2 的历史里确实有指向已删头衔的残条 ✓ 留着会让封君链断在半路 ✓）
    :returns: ``(holders, lieges, dejure)``

              * ``holders[头衔] = 角色号``（``0`` / ``"none"`` = 空位 ✓）
              * ``lieges[头衔] = 上级头衔 key``，``None`` = 没有封君（独立 ✓）
              * ``dejure[头衔] = 法理上级 key``，``None`` = 法理上不归任何人 ✓
                （``de_jure_liege`` ✓ 全库只有 8 条 ✓ 但少了它 c_amalfi 那种会挂错公国 ✓）

    ⚠ ``holder`` 在 CK2 里是**数字**（角色号 ✓ 实跑 9849 条全是数字 ✓ 没有 CK3 那种
      字符串 ID ✓）；``liege`` 是**头衔 key**（``liege="c_brabant"`` ✓ 带引号 ✓）。
      两种都照收，别假设一定是哪种 ✓
    """
    holders: dict[str, int | str] = {}
    lieges: dict[str, str | None] = {}
    dejure: dict[str, str | None] = {}
    h_at: dict[str, tuple[int, int, int]] = {}
    l_at: dict[str, tuple[int, int, int]] = {}
    d_at: dict[str, tuple[int, int, int]] = {}
    if not history_dir.is_dir():
        return holders, lieges, dejure

    def _ok_title(v: object) -> str | None:
        """值是不是一个**存在的**头衔 key（``titles`` 没给就不查 ✓）"""
        if not isinstance(v, str):
            return None
        s = v.strip()
        if not s or s.lower() in ("0", "none"):
            return None
        if titles is not None and s not in titles:
            return None
        return s

    for fp in sorted(history_dir.rglob("*.txt")):
        # **头衔 key 在文件名上** ✓（见上面那段 ✓ 子目录也照收：CK2 是平的 ✓ 防御 ✓）
        key = fp.stem
        if titles is not None:
            if key not in titles:
                continue
        elif _TITLE_RE.match(key) is None:
            continue
        for dkey, dval in parse_script(read_text(fp)):
            if dkey is None:
                continue
            date = _as_date(dkey)
            if date is None:
                # 不带日期的顶层 `holder = N` / `liege = "x"` ✓ 当"最开始那一条"✓
                body: list = [(str(dkey), dval)]
                date = (0, 0, 0)
            elif isinstance(dval, list):
                body = list(dval)
            else:
                continue
            if date > until:
                continue
            for bkey, bval in body:
                if bkey is None:
                    continue
                if bkey == "holder":
                    h: int | str | None
                    if isinstance(bval, (int, float)) and not isinstance(bval, bool):
                        h = int(bval)
                    elif isinstance(bval, str):
                        s = bval.strip()
                        h = 0 if s.lower() in ("0", "none") else s
                    else:
                        h = None            # `holder = { … }` 这种块：不认识 ✓ 跳过 ✓
                    if h is not None and (key not in h_at or date >= h_at[key]):
                        holders[key] = h
                        h_at[key] = date
                elif bkey == "liege":
                    if key not in l_at or date >= l_at[key]:
                        lieges[key] = _ok_title(bval)
                        l_at[key] = date
                elif bkey == "de_jure_liege":
                    if key not in d_at or date >= d_at[key]:
                        dejure[key] = _ok_title(bval)
                        d_at[key] = date
    return holders, lieges, dejure


def apply_de_jure(dejure: dict[str, str | None], titles: dict[str, "Title"]) -> int:
    """把上面读出来的法理改动**盖到骨架上**（landed_titles 那份是初始法理 ✓）。

    改完重建 ``children`` ✓（原来的那套是按骨架连的，父级换了就作废 ✓
    跟 ``parsers/ck3/parser.py`` 的 ``parse_de_jure_history`` 尾巴上一模一样 ✓）。

    防环：新父级不能是自己或者自己的后代（历史里真有写反的 ✓ 不防就是死循环 ✓）。

    :returns: 真正改了父级的头衔个数
    """
    changed = 0
    for key, liege in dejure.items():
        if key not in titles:
            continue
        if liege is not None:
            seen: set[str] = set()
            cur: str | None = liege
            bad = False
            while cur and cur not in seen:
                if cur == key:
                    bad = True
                    break
                seen.add(cur)
                nxt = dejure.get(cur, titles[cur].parent if cur in titles else None)
                cur = nxt
            if bad:
                continue
        if titles[key].parent != liege:
            titles[key].parent = liege
            changed += 1
    for t in titles.values():
        t.children = []
    for t in titles.values():
        if t.parent and t.parent in titles:
            titles[t.parent].children.append(t.key)
    return changed


# ---------------------------------------------------------------- 剧本（bookmark）

#: 剧本文件的日期行（要报"哪一行"所以按文本找 ✓ 不靠解析器 ✓）
_BM_DATE_LINE = re.compile(r"(?m)^[ \t]*date[ \t]*=[ \t]*(\d{3,4})\.(\d+)\.(\d+)")


def find_bookmark(bookmarks_dir: Path, year: int = 1066) -> dict:
    """在 ``common/bookmarks/*.txt`` 里找**那一年**那个"正经剧本"的日期。

    为什么不自己拍一个日期 ✗：CK2（跟 CK3 一样）的剧本日期是**游戏自己写死的** ✓
    抄错一天，"≤ 该日期的最后一条归属"就会多吃/少吃一条历史 ✓
    （1066 在 CK2 里有**两个**书签 ✓ 见下 ✓）

    挑法（先后顺序固定，免得随文件顺序变 ✓）：

    1. 只看 ``bm_*`` 块里 ``date`` 的年份 == ``year`` 的那些 ✓
    2. **优先 ``era = yes`` 的那个** ✓ —— CK2 的书签里只有它是"时代开场"
       （``00_bookmarks.txt`` 里 ``bm_fate_of_england`` 写着 ``era = yes`` +
        ``custom_start = yes`` ✓ 另一个 ``bm_norman_conquest`` 两条都没有 ✓）
    3. 还有并列就取**日期最早**的 ✓ 再并列取 key 排序 ✓

    :returns: ``{"date": (1066, 9, 15), "key": "bm_fate_of_england",
                "name": "BM_FATE_OF_ENGLAND_ERA", "file": "00_bookmarks.txt",
                "line": 384, "text": "1066.9.15", "era": True}``
              —— 找不到就抛 ``SystemExit``（**宁可不做，也不编一个日期** ✗）
    """
    cands: list[dict] = []
    if bookmarks_dir.is_dir():
        for fp in sorted(bookmarks_dir.rglob("*.txt")):
            text = read_text(fp)
            raw_lines = text.splitlines()
            for key, value in parse_script(text):
                if key is None or not isinstance(value, list) or not key.startswith("bm_"):
                    continue
                dv = block_get(value, "date")
                date = _as_date(dv)
                if date is None or date[0] != year:
                    continue
                era = str(block_get(value, "era") or "").lower() in ("yes", "true", "1")
                # 行号：按"那一天的文本"在原文里找第一处 ✓（只为了回报时说得清 ✓）
                line = 0
                if isinstance(dv, str):
                    for i, ln in enumerate(raw_lines, 1):
                        if _BM_DATE_LINE.match(ln) and dv in ln:
                            line = i
                            break
                cands.append({"date": date, "key": key,
                              "name": str(block_get(value, "name") or key),
                              "file": fp.name, "line": line,
                              "text": str(dv), "era": era})
    if not cands:
        raise SystemExit(
            f"在 {bookmarks_dir} 里找不到 {year} 年的剧本 ✗ —— "
            f"日期不许自己拍 ✗（用户交代 ✓）请确认 --root 指的是 CK2 游戏根目录 ✓")
    cands.sort(key=lambda c: (0 if c["era"] else 1, c["date"], c["key"]))
    return cands[0]


# ---------------------------------------------------------------- localisation

#: CK2 的本地化是 **CSV** ✗（CK3 是 yml ✓ 完全两套东西 ✓）::
#:
#:     #CODE;ENGLISH;FRENCH;GERMAN;;SPANISH;;;;;;;;;x
#:     PROV123;Vestisland;Vestisland;Vestisland;;Vestisland;;;;;;;;;x
#:     c_luneburg;Lüneburg;Lunebourg;Lüneburg;;Luneburgo;;;;;;;;;x
#:
#: ⚠ **第 3 列是空的** ✗（德文和西班牙文之间那一栏 ✓ 玄学 ✓ 别按"第 N 列"数 ✗）
#: ⚠ **中文列根本没有** ✗✗ —— CK2 vanilla 只有英 / 法 / 德 / 西四栏 ✓
#:   所以"中文名"只能靠 ``nametools`` 反查 ✓（CK3 那条路是"简中优先、缺了用英文补" ✓
#:   CK2 这边是"**英文打底、中文全靠反查**" ✓ 见 build_ck2.py ✓）
#: ⚠ 行尾那个 ``x`` 是**必需**的结束标记 ✓ 不是数据 ✓
_COL_KEY = 0
_COL_ENGLISH = 1

#: CK2 文本里的格式码：``§Y…§!``（颜色）、``§R``… 整段 ``§X`` 都是排版 ✓ 名字里不要 ✓
_FMT = re.compile(r"§.")
#: ``$key$`` / ``$key|U$`` 那种变量引用（CK3 的 yml 里满地都是 ✓）
_VAR = re.compile(r"\$([A-Za-z0-9_.'\-]+)(?:\|[A-Za-z]+)?\$")


def _clean(value: str) -> str:
    """把游戏文本压成"能直接画在图上"的名字。

    * ``§Y…§!`` 之类的排版码去掉 ✓
    * ``\\n`` / 制表 / 不换行空格 → 空格 ✓
    * 连续空白压成一个 ✓（剩下的排版交给编辑器 ✓）
    """
    value = _FMT.sub("", value)
    for a, b in (("\\n", " "), ("\\t", " "), ("\u00a0", " ")):
        value = value.replace(a, b)
    return " ".join(value.split())


def parse_localisation(loc_dir: Path,
                       keys: Iterable[str] | None = None) -> dict[str, str]:
    """读 ``localisation/*.csv`` → ``{键: 显示名}``（取 **ENGLISH 那一栏** ✓）。

    整个目录一起读（124 个文件 ✓ 一个 key 可能在好几份里 ✓）：
    ``text1.csv`` 是本体、``HolyFury.csv`` / ``JadeDragon.csv`` / ``LT.csv``
    那些是各 DLC 补的 ✓。

    ⚠ ``$key$`` 基本用不上 ✗ —— 那是 CK3 那套 yml 的写法 ✓
      CK2 的 CSV 里名字就是名字 ✓（实跑核过：``PROV*`` 与 ``e/k/d/c/b_*``
      这几类名字里一个 ``$`` 都没有 ✓）；真撞上一个也只做**一层**替换 ✓
      没做 CK3 那种递归展开（那是另一套数据才会用到的 ✓ 不凭空加一层 ✓）
    ⚠ **先读到的赢** ✓（``setdefault`` ✓ 跟 CK3 那份同一个口径 ✓）——
      全库 92129 个唯一键里只有 263 个重复 ✓ 且全是 ``String_*`` 那种名字碎片 ✓
      没有一个是头衔键或 ``PROV`` 键 ✓（实跑核过 ✓）所以这条选择不影响地名 ✓

    :param keys: 只要这些键（``None`` = 全要 ✓）
    """
    if not loc_dir.is_dir():
        return {}
    want = set(keys) if keys is not None else None
    out: dict[str, str] = {}
    for fp in sorted(loc_dir.glob("*.csv")):
        text = read_text(fp)
        for line in text.splitlines():
            if not line or line.startswith("#"):
                continue                     # 表头 / 注释行 ✓（`#CODE;ENGLISH;…` ✓）
            parts = line.split(";")
            if len(parts) <= _COL_ENGLISH:
                continue
            k = parts[_COL_KEY].strip()
            if not k:
                continue
            if want is not None and k not in want:
                continue
            v = _clean(parts[_COL_ENGLISH])
            if not v:
                continue
            # 变量引用：CK2 这两类键里没有 ✓ 真碰上了就把 $…$ 原样留着（比清空强 ✓）
            if "$" in v and _VAR.search(v):
                v = _VAR.sub(lambda mm: out.get(mm.group(1), mm.group(0)), v)
                v = _clean(v)
            out.setdefault(k, v)
    return out
