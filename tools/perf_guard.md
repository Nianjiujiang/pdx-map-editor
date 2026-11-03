# 性能回归护栏 · 一页说明

改完跟"每帧 / 每点一次"沾边的代码（app.js 的帧循环、drawLabels、rebuildPaintBlocks、
gl.js 的 render、labels.js 的 draw），提交前跑这三条：

```
node tools/check_modules.js                 # 模块清单 + 拍平还能不能起来（10 条）
node tools/test_modes.js EU4                # 功能没坏
node tools/perf_baseline.js --check         # 性能没退（超红线退出码 1）
```

`--check` 红了怎么读：

- 只看**这次碰过**的指标。改 gl.js 却红在 `legendEntries`，那是噪声，不是你的锅。
- 全都涨一点点 = 机器在忙（后台编译、别的 Node 在跑），**重跑一次**再下结论。
- 真红了：`node tools/perf_baseline.js --check --maps EU5` 缩小范围，再用
  `node tools/bench_core.js EU5` 看逐项明细（带"最慢"值，抖动大的指标一眼看得出）。
- 有意慢下来（换实现、加清晰度）→ `--save` 更新基线，并在提交信息里写清为什么。

红线公式：`现在 > max(基线 × 1.25, 基线 + 1.5ms)`；boot 例外（× 1.6 / +80ms，
只量一次、噪声大）。想调宽容度改 `tools/perf_baseline.js` 顶上的 `TOLERANCE`。

基线文件 `tools/perf_baseline.json` **要跟着仓库走**（别 gitignore）——
它的意义就是"上次合入时是什么样"。换机器、换 Node 版本后数字会整体漂，
那时重跑一次 `--save` 覆盖，算是重新校准（顺带在提交信息里记一笔）。

指标定义只写在 `tools/bench_core.js`（`measure()` 的返回值），
`perf_baseline.js` 只负责存 / 比 / 印。**加指标改 bench_core**，别两边各写一份。

## 临时文件（`tools/` 下，收尾时清）

| 文件 | 是什么 | 处理 |
| --- | --- | --- |
| `_app_backup.js` / `_app_opt.js` / `_app_new.js` | rebuildPaintBlocks 优化前 / 中 / 后的 app.js 快照 | 优化合入并跑过 `--check` 后删 |
| `_prof_blocks.js` / `_prof_labels.js` | inspector Profiler 探针（`--cpu-prof` 在这项目里没行号） | 探针，留着有用 |
| `_dump_blocks.js` | rebuildPaintBlocks 新旧实现对拍 | 留着，改这块时用 |
| `_bench_viewpts.js` | `placePointsInView` 视口取舍微基准 | 留着 |
| `_probe_exit.js` / `_tm_eu4.log` | 上一轮试脚本留下的碎屑 | 可删 |
| `_splice.py` / `_patchphase.py` / `_patch2.py` / `_new_blocks.txt` | 打补丁用的中间产物 | 可删 |
