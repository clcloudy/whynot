# WhyNot 前端 v5 P2.3 修订与验收日志

日期：2026-11-21  
基线：v5 P2.2 已验收快照（[../redesign-v5-p2.2/source-after](../redesign-v5-p2.2/source-after/)）  
触发：结果票标题「聊聊正在忙的事」获得焦点时出现黑色矩形边框。  
范围：仅前端焦点样式与对应测试；未改后端/API。本次由用户明确要求提交并推送到 `main`；未部署。

## 1. 原因与修复

- 原因：为兼容无窗口焦点的 headless 验收，P2.1 把选项、设置和票面标题的焦点样式从 `:focus-visible` 扩到了 `:focus`。结果票标题 `h2` 带有 `tabindex="-1"`，出票后会被程序化聚焦供读屏朗读；`:focus` 因此在标题上留下持续可见的黑色 outline。
- 修复：
  - `.card h2:focus, .card h2:focus-visible { outline: none }`：标题仍接收焦点供读屏使用，但不再画视觉边框；它不是 Tab 可达控件。
  - 选项、主题标签、页脚设置恢复为 `:focus-visible`：鼠标选择不再显示焦点环，键盘导航仍保留。
  - polish 验收的票面焦点样本从标题改为票内的「换一个」按钮，并改用 `:focus-visible` 规则；headless 无窗口焦点时仍只校验规则存在。
- 验证：出票后 `document.activeElement` 仍是 `h2#card-title`，`getComputedStyle(h2).outlineStyle === 'none'`；截图 [06-result-no-focus-ring-1440.png](06-result-no-focus-ring-1440.png) 确认标题无黑框。

## 2. 验收结果

独立 CDP Edge 活动页，`http://127.0.0.1:8895` + fake-model `http://127.0.0.1:8766`：

| 组 | 通过 | 失败 |
| --- | ---: | ---: |
| lane | 97 | 0 |
| state | 32 | 0 |
| timing | 12 | 0 |
| layout | 21 | 0 |
| polish | 87 | 0 |
| legends | 60 | 0 |
| completion | 48 | 0 |
| b4 | 67 | 0 |
| ix | 64 | 0 |
| **合计** | **488** | **0** |

- 完整结果：[ui-final.json](ui-final.json)，由 [run-ui.mjs](run-ui.mjs) 生成。
- 本次未改后端/API，未重跑 API 套件；上一次合并后 API 结果仍为 base 42/42、interactions 112/112。

## 3. 资源体积

| | raw | gzip9 |
| --- | ---: | ---: |
| P2.2 结束时 | 149,022 B | 39,682 B |
| P2.3 结束时 | 149,780 B | 39,930 B |
| 目标 | — | ≤24,576 B |
| 结果 | — | **未达标，超出 15,354 B** |

- 焦点选择器由 `:focus` 改为更长的 `:focus-visible` 并增加标题规则，gzip +248 B。
- 未压缩/混淆规避；未提高阈值。

## 4. 视觉证据

- [06-result-no-focus-ring-1440.png](06-result-no-focus-ring-1440.png)：出票后结果票标题无黑色焦点框。
- [01-arrival-light-1440.png](01-arrival-light-1440.png)、[02-stopped-light-1440.png](02-stopped-light-1440.png)、[03-stopped-dark-1440.png](03-stopped-dark-1440.png)、[04-details-open-light-1440.png](04-details-open-light-1440.png)、[05-stopped-light-390.png](05-stopped-light-390.png)：其余状态回归。
- 截图脚本：[shots-p2.3.mjs](shots-p2.3.mjs)。

## 5. 已知边界

- 结果票标题不再有可见焦点环是刻意取舍：它不是 Tab 可达控件，程序化焦点仅用于读屏；键盘用户仍可在选项、按钮、设置上看到焦点环。
- 真实浏览器/读屏的焦点行为仍属未验项；headless 检查只验证标题无 outline、控件规则存在。
- 体积仍高于 24 KiB 参考口径。

## 6. 环境与归档

- 8895 预览与 8766 fake-model 以独立进程运行；没有云部署。
- [source-before/](source-before/)：P2.2 已验证快照。
- [source-after/](source-after/)：P2.3 验收后快照。
- [changes.patch](changes.patch)：焦点样式与测试的最小 diff。
- 本修订由用户明确要求提交并推送到 `main`；未部署。
