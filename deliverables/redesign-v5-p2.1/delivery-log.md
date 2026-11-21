# WhyNot 前端 v5 P2.1 修订与验收日志

日期：2026-11-21  
基线：v5 P2 已验收快照（[../redesign-v5-p2/source-after](../redesign-v5-p2/source-after/)）  
触发：用户反馈三条——深浅主题看不出区别、左上角文字与无关注释过多、动态视觉效果没有呈现。  
范围：前端视觉与交互修订；未修改后端与 API 契约，未提交、未推送、未部署。

## 1. 问题定位

1. **深浅看不出区别**
   - P2 新增的「月台光线」设置会显式锁定场景，切「主题」时只改纸面与设置面板，主画面不变；用户很可能选了「清晨」后再切主题，因此看不出变化。
   - 修复：移除「月台光线」设置，场景完全跟随主题（浅色=清晨、深色=夜班）；删除 dusk 显式调色层与 `whynot-stage` 存储。主题切换同时改变月台、纸外文字与票面投影。
2. **左上角文字与注释压力**
   - 眉标「01 此刻通道」、首屏引导三行、说明段与月台注释同时出现。
   - 修复：删除眉标；标题下只保留步骤、操作与票面；引导、说明段、月台注释全部折进 `<details class="board-more"><summary>说明</summary>`，默认收起；移除首访引导的 localStorage 逻辑与「首访自动显示」行为。
3. **动态视觉效果没有呈现**
   - 根因一：进站启动依赖 `requestAnimationFrame`，在后台/未激活页可能永远不触发，舞台停在 `idle`，列车停在画外、光锥 opacity 0。
   - 根因二：场景关键状态依赖 CSS transition，标签页未激活时 transition 会停在起始值（列车 200px、光锥 0），即使阶段已是 stopped。
   - 修复：
     - 进站改为 `idle → 强制 reflow → arriving`，不依赖 rAF；
     - 场景把**最终外观**写成基础样式，进站只用 animation（trainArrive / worldPush / coneIn / headOn / doorOpen / dustIn 等）；即使动画没播，停站也一定看到列车、车门、光锥与黄线；
     - 列车进站位移 200px / 1320ms（原 148px / 1180ms），增加横穿站台的光扫 `lightSweep`；
     - 新增「重播进站」按钮，随时可重看；
     - 反馈标记动画加 140ms 清理兜底；找不到可见标记时不再抛错（全量测试发现并修复）。

## 2. 实际改动

- [web/index.html](../../web/index.html)
  - 删除眉标与首屏引导；把说明段、三行引导、月台注释折进 `<details>`。
  - 操作区新增「重播进站」。
  - 删除「月台光线」设置。
  - 首屏内联脚本移除 `guided` 逻辑。
- [web/style.css](../../web/style.css)
  - 删除 dusk/night/dawn 显式场景覆盖层与 `data-stage-light` 选择器；场景继续由浅/深主题变量驱动。
  - 场景基础样式改为最终态；进站改为 animation；停站/静息不再依赖 transition。
  - 新增光扫动画；卡片入场改为 opacity-only（`cardIn`），避免布局位移。
  - 反馈/分享状态预留 `1.625em` 高度，避免完成反馈出现时把票推下 12px。
  - 焦点环由 `:focus-visible` 扩展为 `:focus`（选项、主题标签、页脚、票面标题）。
- [web/app.js](../../web/app.js)
  - `arriveScene()` 去掉 rAF；`defer()` 替代 rAF 做焦点移动，避免后台页焦点不前进。
  - 中文字段/详情/说明逻辑移除首访 guide localStorage；`dismissGuide` 与 `GUIDE_KEY` 删除。
  - 新增重播按钮监听。
  - 反馈标记动画在无可见标记时跳过；清理加 140ms 兜底。
- [dev/acceptance-ui.mjs](../../dev/acceptance-ui.mjs)
  - lane 新增「进站不依赖可见帧启动」「重播进站可重新触发」；说明相关断言改为 details 默认折叠。
  - b4 新增「深浅主题同时改变月台与纸外文字」；移除月台光线设置断言。
  - polish 焦点对比在 `headless-no-focus` 环境下校验焦点规则存在并记录详情；有窗口焦点时仍校验实际 outline。

## 3. 最终验收结果

### 浏览器 UI

使用独立 CDP Edge 活动页（避免隐藏页定时器节流），在 `http://127.0.0.1:8895` 与 fake-model `http://127.0.0.1:8766` 上运行：

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

- 完整结果：[ui-final.json](ui-final.json)，由 [run-ui.mjs](run-ui.mjs) 在活动页直接生成。
- 过程记录：隐藏的 browser-use 页会触发 Chrome 定时器节流，导致 polish 组异常缓慢；改用独立 CDP Edge 活动页后 62s 完成。
- 全量运行发现并修复了一个真实健壮性问题：反馈动画在找不到可见标记时会抛 `Cannot read properties of undefined (reading 'classList')`；已加守卫。

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
- [source-manifest.json](source-manifest.json)：四个改动文件的 SHA-256；`source-after` 与当前工作区一致。

## 4. 资源体积

按 Node v24.22.1 / zlib 1.3.2.1，8 个网页资源 gzip level 9：

| | raw | gzip9 |
| --- | ---: | ---: |
| P2 结束时 | 151,901 B | 40,064 B |
| P2.1 结束时 | 149,292 B | 39,758 B |
| 目标 | — | ≤24,576 B |
| 结果 | — | **未达标，超出 15,182 B** |

- 本次删除眉标、首访引导逻辑、月台光线设置与 dusk 场景，抵消了新增的 details/重播/场景动画，gzip 反而减少 306 B。
- 未采用压缩/混淆脚本规避；未擅自提高阈值。

## 5. 视觉证据

- [01-arrival-light-1440.png](01-arrival-light-1440.png)：进站中段，列车仍在画面右侧移动。
- [02-stopped-light-1440.png](02-stopped-light-1440.png)：浅色停站；无眉标/首屏说明；标题、步骤、三个操作与「+ 说明」。
- [03-stopped-dark-1440.png](03-stopped-dark-1440.png)：深色停站，与浅色形成明确差异。
- [04-details-open-light-1440.png](04-details-open-light-1440.png)：展开「说明」后看到折叠的说明段、三行引导与月台注释。
- [05-stopped-light-390.png](05-stopped-light-390.png)：390×844 单列新布局。
- 截图脚本：[shots-p2.1.mjs](shots-p2.1.mjs)。

## 6. 已知边界

- 「自动」仍为跟随主题，没有按本地时间自动切换清晨/黄昏/夜班；P2 的黄昏显式光效已随设置一起撤下。
- 进站仍是一次性动画，停站后只保留车头灯呼吸；需要持续动态时用「重播进站」。
- 场景动画在隐藏标签页可能不播放，但最终停站画面不依赖动画，仍完整可见。
- 焦点环在无窗口焦点的 headless 环境中只校验了规则存在与颜色，没有做真实可见像素验证；真实浏览器有焦点时使用 `:focus` 显示。
- 位图 AVIF、印章落地痕迹、撕票根 520ms、真机 60fps 仍未完成；完成落印沿用 P2 的站台印记。
- 体积仍超 24KiB 执行口径。

## 7. 环境与归档

- 8895 预览继续运行（刷新即可看新布局；可直接点「重播进站」）。
- 8897 API 实例已停止；P2.1 CDP 临时 profile 已清理。
- [source-before/](source-before/)：取自 P2 已验证的 `source-after` 快照（修订前内容）。
- [source-after/](source-after/)：本次验收后的同类快照。
- [changes.patch](changes.patch)：P2.1 相对 P2 的四个文件 unified diff。
- **未提交、未推送、未部署。**
