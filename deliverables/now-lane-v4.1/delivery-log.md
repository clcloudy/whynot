# WhyNot 此刻通道 V4.1 交付与验收日志

日期：2026-11-20  
基线提交：`5fda514`  
交付范围：前端三站通道、撕票交互、样式与对应 UI 验收；未修改后端 API。

## 1. 已完成的改动

- [index.html](../../web/index.html)：用三站原生单选表单替代旧出票面板，保留原有单选 ID、name、value 与 label 关系；新增票根收藏条、状态播报、结果条件键。
- [app.js](../../web/app.js)：实现三站确认、盖章/撕根/收根、回站重验、失败回第三站并保留同 UUID 快照重试、本地条件恢复、键盘空格/回车确认、reduced-motion 立即完成；第三站调用现有 `startInteraction`，条件变化时沿用 `replaces`。
- [style.css](../../web/style.css)：夜色背景、浅色票纸、独立右侧票根、齿孔与撕痕、52px 选项、移动端与 220% 字号布局、双主题对比度；删除旧面板/场景展开器样式。
- [acceptance-ui.mjs](../../dev/acceptance-ui.mjs)：同步旧八组 UI 验收并新增 `lane` 组，覆盖正常、失败、取消竞态、键盘、存储异常、reduced-motion、320/390/768 与 220% 字号。

方案文档内部关于动画时长存在矛盾；实现采用“按章 120ms + 撕根 360ms + 收根 200ms + 离站 200ms”，reduced-motion 下同步跳过。

## 2. 最终验收结果

### 浏览器 UI

运行于隔离的空内存服务 `http://127.0.0.1:8865`，Windows Qoder Electron 内核 Chromium：

| 组 | 通过 | 失败 |
| --- | ---: | ---: |
| lane | 104 | 0 |
| state | 32 | 0 |
| timing | 12 | 0 |
| layout | 21 | 0 |
| polish | 86 | 0 |
| legends | 60 | 0 |
| completion | 46 | 0 |
| b4 | 66 | 0 |
| ix | 64 | 0 |
| **合计** | **491** | **0** |

- 结果文件：[ui-final.json](ui-final.json)
- 无脚本异常；控制台中仅有负向用例故意触发的 404/400 请求。
- 最终 `ix` 忙碌态断言采用测试专用的首请求放行闸门，先断言 `ISSUING` / `aria-busy`，再放行响应；生产代码与断言均未削弱。
- 键盘路径使用真实 Tab / 空格 / 回车验证，未只依赖程序化 `.focus()`。

### API 回归

在自有空内存实例 `http://127.0.0.1:8876` 依次运行：

| 套件 | 通过 |
| --- | ---: |
| base | 42 |
| model | 11 |
| interactions | 112 |
| photos | 46 |
| memories | 63 |
| local | 54 |
| **合计** | **328** |

- 汇总：[api-run.log](api-run.log)
- 328 通过、0 失败；未改动生产代码或既有 API 验收。
- 未触碰 8765、8766、8787、8875 上的既有进程；自有 8876 已停止且端口释放。

### 静态检查

- `node --check web/app.js` 通过。
- `node --check dev/acceptance-ui.mjs` 通过。
- `git diff --check` 通过。
- [source-manifest.json](source-manifest.json) 校验：23 个存档文件与基线一致，`source-after` 与当前工作区完全一致。

## 3. 资源体积

按 Node v24.22.1 / zlib 1.3.2.1，8 个网页资源分别 gzip level 9 后求和：

- 改动前：29,767 B
- 改动后：33,281 B（增加 3,514 B）
- 目标：≤24,576 B
- 结果：**未达标，超出 8,705 B**
- 原 16 KiB 目标同样未达到
- 未采用压缩/混淆脚本规避；只读试验的整体最小化后仍约 29,921 B，且会破坏测试钩子，因此未纳入交付
- 明细：[budget.json](budget.json)

## 4. 未验证的硬门槛

以下项目本机环境无法真实完成，不能视为通过：

- iOS Safari / Android 真机
- VoiceOver / TalkBack 实际读屏
- 五人盲测
- 15 秒真机录屏
- 已部署环境与真实视觉模型套件

本次仅运行本地 fake-model 与空内存/本地数据环境；截图中的 `fake 开场` 为本地 fake-model 返回内容。

## 5. 视觉证据

- [final-station-dark.png](final-station-dark.png)：390×844 视口深色首站（无头 Edge，DPR 2）
- [final-ticket-dark.png](final-ticket-dark.png)：同一视口走完三站后的互动票卡

截图只用于本地渲染复核，不是真机或读屏证据。

## 6. 归档内容

- `source-before/`：改动前 `web/` 与 `dev/` 快照；范围仅限这两个目录，不是可独立运行的完整仓库。
- `source-after/`：验收完成后的同类快照。
- [changes.patch](changes.patch)：四个改动文件的完整二进制安全补丁。
- [references/](references/)：方案文档中提取的三张参考图；原 DOCX 未修改。
- `api-*.log`：六组 API 验收及运行汇总。
- [ui-final.json](ui-final.json)：九组浏览器验收的完整结构化结果。

## 7. 环境清理与代码状态

- 临时 8865 服务、无头 Edge、9223 调试端口、临时用户配置和截图脚本均已停止/删除。
- 当前仅 8765、8766、8787、8875 保持原有监听，PID 与开始时一致。
- 工作区改动仅包含 `web/` 三文件、`dev/acceptance-ui.mjs` 和本交付目录。
- **未提交、未推送、未部署。**
