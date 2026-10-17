# 地图包（`.pdxmap`）放这儿

**这个文件夹是给玩家看的**：地图和编辑器是分开下的，这里就是地图的那一半 ✓

⚠ **文件夹里看不到 `.pdxmap` 文件是正常的** ✗ —— 它们是构建产物（合计约 27 MB 的二进制），
**不进 git**（`packs/*.pdxmap` 被忽略了），只跟编辑器一起传
[Releases](../../releases) 附件。想让它们出现在这儿，跑一句就有：

```bash
python build_packs.py          # 打完就落在这个文件夹里 ✓
```

打出来的 7 个包（游戏自带的那几张图，2026-10-17 量的；CK2 内测中，暂不提供）：

> CK2 模式还在内测，默认**不会**打进 `packs/`。
> 要本地测可以跑 `python build_packs.py --include-private --out _local/packs-internal`，
> 这一批**不要上传**。

| 文件 | 地图 | 大小 |
|---|---|---|
| `pdx-ck3-vanilla.pdxmap` | CK3 原版 | 2.43 MB |
| `pdx-eu4-vanilla.pdxmap` | EU4 原版 | 0.82 MB |
| `pdx-hoi4-vanilla.pdxmap` | HOI4 原版 | 1.52 MB |
| `pdx-hoi4-alt.pdxmap` | HOI4 修改边界 | 1.49 MB |
| `pdx-vic3-vanilla.pdxmap` | VIC3 原版 | 3.67 MB |
| `pdx-eu5-vanilla.pdxmap` | EU5 原版 | 4.17 MB |
| `pdx-eu5-full.pdxmap` | EU5 原尺寸 | 12.50 MB |

**玩家怎么用**：双击 `pdx-map-editor.html`（不到 1 MB，不用装东西），
在选图那一页点「＋ 导入地图包…」，选一个 `.pdxmap` 就进去了 ✓
手机上就下 `pdx-map-editor-mobile.html`，手机浏览器打开，触屏涂。
导入的图存在他自己的浏览器里，刷新还在（换电脑要重导一次）。

**想自己给 mod 打一个包**（KR 之类）：

```bash
python pack_map.py data_kr --id kr-1936 --label "KR 1936" --author 你的名字 --out kr-1936.pdxmap
```

格式、字段、校验规矩以 `pack_map.py` 和编辑器的校验器为准 ✓
⚠ 打包**别人做的 mod 地图**要先拿到授权 —— 这个仓库里只发游戏自带的那几张，
就是这个原因。
