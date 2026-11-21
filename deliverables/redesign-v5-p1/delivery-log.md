# WhyNot 前端 v5 P1 交付与验收日志

日期：2026-11-21  
基线：v5 P0（[../redesign-v5-p0](../redesign-v5-p0/)）  
交付范围：按《WhyNot-月台改版方案.md》**P1「场景与出票」** 落地。延续 P0 的 **纯 CSS 矢量** 决定，不引入位图底图；未修改后端与 API 契约，未提交、未推送、未部署。

## 1. 实际改动

- [web/index.html](../../web/index.html)
  - 月台加入 `.st-world` 镜头层、列车门内发光、3 条速度线、车门暖光层；`data-phase` 初始为 `idle`。
  - 黄线从 `bottom:24%` 下移到 `12%`，桌面端回到票的下方。
- [web/style.css](../../web/style.css)
  - 进站编排：镜头 `scale(1→1.03)` 3200ms；列车 `translate 148px→0` 1180ms（延迟 180ms）；车头灯 bloom 420ms；光锥 1100ms；速度线 700ms；车门 350ms（延迟 1180ms）；地面暖光 600ms（延迟 1200ms）；雨棚/城市反向漂移 3200ms；前景立柱 900ms；列车余震 420ms（延迟 1360ms）；浮尘 500ms（延迟 300ms）。
  - 停站与静息：`arriving → stopped → resting`；停站时车头灯呼吸、车门开、窗灯亮；`resting` 暂停场景内所有动画（运行中数量为 0）。
  - 出票：主按钮下压 480ms + 售票机出票口唇光 720ms + 车窗闪一次 200ms；结果票 `ticket-in` 550ms（`translateY 28→0`、`rotate -1.2deg→0`、`opacity 0→1`），用 `--m-ticket` 曲线。
  - `prefers-reduced-motion`：无进站、无下压、无票面落下；直接呈现停站静态画面，功能与播报不变。
- [web/app.js](../../web/app.js)
  - 新增场景状态机 `arriveScene / flashScene / flashSlot / restScene`：页面启动后进站，2400ms 停站，20s 静息；换票/重试只闪窗灯；`restScene()` 供静息态与验收调用。
  - 出票改为「按下 480ms → 闪窗灯 → 发起请求」；reduced-motion 下跳过 480ms 直接出票；在途点击与重置被 `PRESSING` 状态锁住。
  - 首次出票结果票播放 `ticket-in`；后续换票仍走 `card-refresh` 不重播入场，避免几何抖动。
- [dev/acceptance-ui.mjs](../../dev/acceptance-ui.mjs)
  - `lane` 组新增 3 项场景验收：进站已停站/静息、`restScene` 后运行中动画为 0、reduced-motion 首帧停站且无场景动画。
  - 新增 reduced-motion 探针：同时覆盖 JS `matchMedia` 与 CSS 媒体规则，避免只改 JS 造成假阴性。
  - 为 4 条回合/图片断言补失败详情，不改变断言条件。

## 2. 最终验收结果

### 浏览器 UI

在 `http://127.0.0.1:8895`（PGlite 内存库）与 `http://127.0.0.1:8766` fake-model 上运行：

| 组 | 通过 | 失败 |
| --- | ---: | ---: |
| lane | 95 | 0 |
| state | 32 | 0 |
| timing | 12 | 0 |
| layout | 21 | 0 |
| polish | 86 | 0 |
| legends | 60 | 0 |
| completion | 46 | 0 |
| b4 | 66 | 0 |
| ix | 64 | 0 |
| **合计** | **482** | **0** |

- 完整结果：[ui-final.json](ui-final.json)
- 无脚本异常；控制台 4xx 均来自负向用例。
- 过程记录：首次 P1 全量运行时 `ix` 组有 6 项回合/图片失败；定位为 **8766 fake-model 进程已停止**，开场退化到内置文案、`/turns` 返回模型不可用。重启 fake-model 后 `ix` 64/64、全量 482/482 通过。不是代码缺陷，也不把环境故障记成通过。

### API 回归

清库重启 8895 后：

| 套件 | 通过 | 失败 |
| --- | ---: | ---: |
| base | 42 | 0 |
| interactions | 112 | 0 |
| **合计** | **154** | **0** |

- [api-base.log](api-base.log)、[api-interactions.log](api-interactions.log)
- 未运行 model / photos / memories / local 四套；本次未改对应接口。

### 静态检查

- `node --check web/app.js` 通过。
- `node --check dev/acceptance-ui.mjs` 通过。
- `git diff --check` 通过。
- [source-manifest.json](source-manifest.json)：四个改动文件的 SHA-256；`source-after` 与当前工作区一致。

## 3. 资源体积

按 Node v24.22.1 / zlib 1.3.2.1，8 个网页资源 gzip level 9：

| | raw | gzip9 |
| --- | ---: | ---: |
| P0 结束时 | 135,640 B | 36,908 B |
| P1 结束时 | 144,782 B | 38,642 B |
| 目标 | — | ≤24,576 B |
| 结果 | — | **未达标，超出 14,066 B** |

- P1 增加 raw +9,142 B、gzip +1,734 B。
- 未采用压缩/混淆脚本规避；未擅自提高阈值。

## 4. 视觉证据

- [01-arrival-1440.png](01-arrival-1440.png)：列车进站中段，车头灯亮、车窗与车门开始出现。
- [02-stopped-1440.png](02-stopped-1440.png)：停稳，车门开、车头灯呼吸，黄线在票下方。
- [03-issue-press-1440.png](03-issue-press-1440.png)：三格填完，主按钮下压、出票口唇光亮起。
- [04-ticket-drop-1440.png](04-ticket-drop-1440.png)：结果票落下后的互动票面（本地 fake 开场文案）。
- [05-resting-1440.png](05-resting-1440.png)：静息态，场景动画全部暂停。
- [06-light-stopped-1440.png](06-light-stopped-1440.png)：浅色清晨停站，列车车门与黄线仍可辨。
- [07-light-stopped-390.png](07-light-stopped-390.png)：390×844 单列停站。
- 截图脚本：[shots-p1.mjs](shots-p1.mjs)，CDP 固定 1440×900 / 390×844 与 `prefers-color-scheme`。

## 5. 方案边界与已知取舍

- 底图仍为纯 CSS 渐变，没有 P1 方案里的 16:9 昼/夜 AVIF 位图，也没有 700ms 双底图交叉淡入；主题切换是 CSS 变量瞬时切换。位图资产留待后续单独一批。
- 镜头 `scale(1.03)` 结束不回位；未做真实 60fps/GPU 合成测量。
- 出票口唇光是售票机上的光效，票面从右栏落下；没有把票做成从机器内腔物理推出的几何关系。
- 按下 480ms + 票面 550ms ≈ 1.03s，加 API 时间，未严格等于方案的 1240ms 感知时长。
- 换票只闪一次车窗灯，不重放进站；新票仍走 `card-refresh`，没有撕离/延迟落定的完整编排（P2 可补）。
- 进站在页面加载时开始，不与首次出票绑定；静息计时为 20s。
- 桌面端黄线已在票下方；窄屏单列滚动时票仍可能压过黄线。
- 印章落地、撕票根 520ms、三套时间氛围仍未做。

## 6. 未验证的硬门槛

- iOS Safari / Android 真机
- VoiceOver / TalkBack 实际读屏
- 1440×900 真机 60fps 与 GPU 合成性能
- 五人盲测、15 秒真机录屏
- 已部署环境与真实视觉模型套件
- 位图 AVIF 资产与双底图交叉淡入

## 7. 环境与归档

- 本次使用 `dev/server.mjs 8895`（PGlite 内存库）与 `dev/fake-model.mjs 8766`。fake-model 在 P1 验收前曾停止，已重启；API 验收后 8895 已停止，8766 保持运行。
- 已清理 CDP 临时 profile（其中一个残留 msedge 进程被按 user-data-dir 定向结束）。
- [source-before/](source-before/)：P1 编辑前四个文件快照。
- [source-after/](source-after/)：P1 验收后的同类快照。
- [changes.patch](changes.patch)：P1 相对 P0 的四个文件 unified diff。
- **未提交、未推送、未部署。**
