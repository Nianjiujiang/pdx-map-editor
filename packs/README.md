# 地图包（`.pdxmap`）

这个目录用于存放可发布的地图包。编辑器本体和地图包分开下载，地图包是其中的地图部分。

`.pdxmap` 是 zip 格式，内部包含一份数据缓存和 `manifest.json`，导入时由编辑器校验。

**仓库中看不到 `.pdxmap` 文件是正常的。** 它们是构建产物，合计约 27 MB，已被 `.gitignore` 排除，不进入 Git，只随编辑器一起作为 Release 附件上传。需要在本机生成时运行：

```bash
python build_packs.py
```

默认生成 7 个公开地图包（游戏自带地图，文件大小统计于 2026-10-17；CK2 仍在内部测试，不包含在内）：

| 文件 | 地图 | 大小 |
|---|---|---|
| `pdx-ck3-vanilla.pdxmap` | CK3 原版 | 2.43 MB |
| `pdx-eu4-vanilla.pdxmap` | EU4 原版 | 0.82 MB |
| `pdx-hoi4-vanilla.pdxmap` | HOI4 原版 | 1.52 MB |
| `pdx-hoi4-alt.pdxmap` | HOI4 修改边界 | 1.49 MB |
| `pdx-vic3-vanilla.pdxmap` | VIC3 原版 | 3.67 MB |
| `pdx-eu5-vanilla.pdxmap` | EU5 原版 | 4.17 MB |
| `pdx-eu5-full.pdxmap` | EU5 原尺寸 | 12.50 MB |

> CK2 模式仍在内部测试，默认不会生成到 `packs/`。如需本地测试，运行 `python build_packs.py --include-private --out _local/packs-internal`；该目录中的包不要上传。

## 玩家使用方式

双击 `pdx-map-editor.html`（不到 1 MB，无需安装），在选图页点击「＋ 导入地图包…」选择 `.pdxmap`。手机版为 `pdx-map-editor-mobile.html`，用手机浏览器打开后即可触屏操作。

导入的地图保存在浏览器中，刷新页面不会丢失；换电脑或清除浏览器数据后需要重新导入。

## 生成自定义地图包

以自定义地图为例：

```bash
python pack_map.py data_custom --id my-map --label "我的地图" --author 你的名字 --out my-map.pdxmap
```

格式、字段和校验规则以 `pack_map.py` 与编辑器的校验器为准，详细说明见 [`docs/构建与开发说明.md`](../docs/构建与开发说明.md)。
