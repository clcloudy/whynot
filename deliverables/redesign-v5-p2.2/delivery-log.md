# WhyNot 前端 v5 P2.2 修订与验收日志

日期：2026-11-21  
基线：v5 P2.1 已验收快照（[../redesign-v5-p2.1/source-after](../redesign-v5-p2.1/source-after/)）  
触发：用户要求删除「填一张票，三步出门」这组大字，进一步减轻画面文字压力。  
范围：仅前端标题与对应测试断言；未修改后端与 API 契约，未提交、未推送、未部署。

## 1. 实际改动

- [web/index.html](../../web/index.html)
  - 删除可见的 `<h1 class="board-title">填一张票，三步出门</h1>`。
  - 保留 `<h1 class="sr-only">填一张票，三步出门</h1>`，只供读屏与文档大纲使用，不占画面。
  - 左栏现在只剩步骤、操作与「+ 说明」。
- [web/style.css](../../web/style.css)
  - 删除 `.board-title` 与 `.board-title span` 规则，以及窄屏下的标题字号规则。
- [dev/acceptance-ui.mjs](../../dev/acceptance-ui.mjs)
  - b4「深浅主题同时改变月台与纸外文字」改用 `.ghost` 操作按钮的颜色作纸外文字样本（原 `.board-title` 已不存在；`.progress li b` 在完成后会变强调橙，不适合作为中性文字样本）。

## 2. 验收结果

### 浏览器 UI

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
- 首轮 b4 的「纸外文字」样本误用了完成后会变橙的进度值，属测试常量问题；改用「用上次的条件」按钮颜色后 67/67，全量 488/488。

### API 回归

清空内存实例 `http://127.0.0.1:8897`：

| 套件 | 通过 | 失败 |
| --- | ---: | ---: |
| base | 42 | 0 |
| interactions | 112 | 0 |
| **合计** | **154** | **0** |

- [api-base.log](api-base.log)、[api-interactions.log](api-interactions.log)
- 8897 已停止；8895 预览与 8766 fake-model 保持运行。

### 静态检查

- `node --check web/app.js` 通过。
- `node --check dev/acceptance-ui.mjs` 通过。
- `git diff --check` 通过。
- [source-manifest.json](source-manifest.json)：四个改动文件 SHA-256；`source-after` 与当前工作区一致。

## 3. 资源体积

| | raw | gzip9 |
| --- | ---: | ---: |
| P2.1 结束时 | 149,292 B | 39,758 B |
| P2.2 结束时 | 149,022 B | 39,682 B |
| 目标 | — | ≤24,576 B |
| 结果 | — | **未达标，超出 15,106 B** |

- 删除可见标题后 raw −270 B、gzip −76 B；仍高于既有 24 KiB 执行口径。

## 4. 视觉证据

- [01-arrival-light-1440.png](01-arrival-light-1440.png)：进站中段。
- [02-stopped-light-1440.png](02-stopped-light-1440.png)：浅色首屏，无大字标题，左栏只剩步骤、操作与说明。
- [03-stopped-dark-1440.png](03-stopped-dark-1440.png)：深色首屏。
- [04-details-open-light-1440.png](04-details-open-light-1440.png)：展开说明。
- [05-stopped-light-390.png](05-stopped-light-390.png)：390×844 单列。
- 截图脚本：[shots-p2.2.mjs](shots-p2.2.mjs)。

## 5. 已知边界

- 页面没有可见的主标题；依赖读屏的用户仍能通过 `sr-only` 的 h1 获得页面名称。
- 左栏在桌面端以步骤表开头，顶部留白较大；这是删除标题后的直接结果，若觉得空，可后续加一个很小的场景控制或站名，而不是恢复大字。
- 深浅主题、说明折叠、进站/重播、站台落印沿用 P2.1 的行为。
- 体积仍超 24 KiB 执行口径。

## 6. 环境与归档

- 8895 预览继续运行；刷新即可看到无标题版本。
- 8897 API 实例已停止；P2.2 CDP 临时 profile 已清理。
- [source-before/](source-before/)：P2.1 已验证的 source-after 快照。
- [source-after/](source-after/)：P2.2 验收后的同类快照。
- [changes.patch](changes.patch)：P2.2 相对 P2.1 的最小 diff。
- **未提交、未推送、未部署。**

## 8. 合并远端后复验

- 远端 `main` 新增 `2cc30e1`（活动库存推荐与 AI 互动、模型/记忆检索改进），未修改 `web/` 或 `dev/acceptance-ui.mjs`。
- 本地改版提交已 rebase 到 `2cc30e1` 之上；合并后重启 8895 与 8766，重新验收：
  - UI：488/488（活动 CDP Edge，63s）。
  - API：base 42/42、interactions 112/112。
  - 远端新增单元测试：activities 47/47、interactions/model 44/44。
- 复验日志：[dev-8895-merged.log](dev-8895-merged.log)、[fake-8766-merged.log](fake-8766-merged.log)、[api-base-merged.log](api-base-merged.log)、[api-interactions-merged.log](api-interactions-merged.log)、[test-activities.log](test-activities.log)、[test-interactions.log](test-interactions.log)。
- 合并后 `ui-final.json` 已更新为 488/488；前端源码与 P2.2 归档内容未变。
