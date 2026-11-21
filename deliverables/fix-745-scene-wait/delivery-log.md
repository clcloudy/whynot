# fix-745：出票进站联动 + masthead 类名 + will-change 按相位生效

日期：2026-11-21。改动仅涉及 `web/` 前端资源与 README，未改后端。

## 改动

1. **出票等待绑定进站动画（原 #7）**
   - `web/app.js`：新增 `armIssueScene()`／`takeSceneGate()`／`settleScene()`。点「出一张现在」后，按压过场结束时（480ms）触发列车进站（`arriveScene()`），与模型请求并行；`ask()`／`startInteraction()` 在响应校验通过后 `await` 场景门闩（1500ms，约等于列车进站、车门开启的时点）再落票。门闩一次一发：互动开场消费后，重试/降级不再等待；reduced-motion 下门闩立即通过、场景保持停站态。
   - 出票失败（`failTicket()`）时 `settleScene()` 中止进站编排，月台直接回到停站态；成功路径让进站尾段动画（worldPush、settle、doorLight）自然播完。
   - 换票（swap）维持原有 `flashScene()` 车窗快闪，不变。
   - 效果：模型等待（最长 7s×2）被藏进进站叙事；骨架屏文案与 8 秒「还在找」提示不变。快路径（内置兜底）从点击到出票约 2.5s（按压 480ms + 门闩 1500ms + 票面落下 550ms）。
2. **masthead 重复类名（原 #4）**：`web/index.html:57` 第二个 `.masthead-left` 改为 `.masthead-right`；`web/style.css` 中 `.masthead-left,.masthead-right` 共用原布局规则。布局原由 `.station-marks` 的 `margin-inline-start:auto` 侥幸撑住，语义 bug 已修。
3. **will-change 常驻合成层（原 #5）**：`.st-world`／`.st-train` 的 `will-change` 从基础规则移除，改为仅在 `.stage[data-phase="arriving"]` 规则内生效，进站结束（phase 离开 arriving）即释放合成层。

README「v5 月台与票面」节的进站播放描述已同步更新（页面加载与每次出票播放、失败中止回停站）。

## 验收（2026-11-21，本机）

验收服务 `node dev/server.mjs 8895`（内存库，启动后确认 `/__local/db` 三表为 0），假模型 `dev/fake-model.mjs`（8766）。UI 驱动为本目录 `run-ui.mjs`（复制自 P2.2 的 CDP 活动页方案，输出指向本目录）。

| 套件 | 结果 |
| --- | --- |
| dev/acceptance.mjs | 42/42 |
| dev/acceptance-model.mjs | 8 ok / 0 fail |
| dev/acceptance-interactions.mjs | 112/112 |
| dev/acceptance-photos.mjs | 46/46 |
| dev/acceptance-memories.mjs | 63/63 |
| UI 九组（lane/state/timing/layout/polish/legends/completion/b4/ix） | **488/488**（lane 97/97） |

明细见 `ui-final.json`。进站联动曾首跑失败 1 项（`lane/进站编排已停站或静息`：失败路径的进站动画播放 2400ms 超出断言时点），以 `settleScene()` 失败中止修复后复验通过。

## 体积（观察项，不阻断）

8 个 web 资源 gzip9 **40,163 B**（改前 39,682 B，+481 B），raw **149,771 B**（+749 B）。高于 24 KiB 参考口径，按现行体积政策仅记录。

## 过程记录：验收服务端口陷阱

本次排查发现：后台停止任务只终止外层 shell，`node dev/server.mjs` 子进程可能存活并继续持有 8895 端口，后续「重启」全部以 `端口 8895 已占用` 静默退出，五套件实际打在被 UI 数据污染的旧内存库上，触发 README 已警告的「历史行污染误报」（`无模型 Key 时走内置兜底` 间歇失败）。复跑验收前应确认端口确实释放（`Get-NetTCPConnection -LocalPort 8895`）或改用新端口。本目录 `probe-phase.mjs` 为定位该问题时用的相位时间线探针，仅留档。

## 未验项（沿用既有边界）

真机（手机/多浏览器）、有声屏幕阅读器、原生安装、60fps 基准仍属未验项；进站联动的实际观感（1500ms 门闩时点）仅经无头验收，未经人眼确认。未提交、未推送，等待指示。
