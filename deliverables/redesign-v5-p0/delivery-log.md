# WhyNot 前端 v5 P0 交付与验收日志

日期：2026-11-21  
基线提交：`9f4575a`  
交付范围：按《WhyNot-月台改版方案.md》的 **P0「整屏场景 + 填票」** 落地；月台采用 **纯 CSS 矢量**（用户确认），不引入位图资产。未修改后端与 API 契约，未提交、未推送、未部署。

## 1. 实际改动

- [web/index.html](../../web/index.html)
  - 新增 `.stage` 全视口月台：天光、城市灯带、雨棚斜撑与玻璃、接触网、信号灯、轨道、列车、车头灯光锥、地面反射、售票机、黄线、站台面、前景立柱。全部 `aria-hidden`，不参与焦点。
  - 三站 `section.lane` 与收集条删除，换成一张 `.sheet` 票：齿孔、票头、区间带、三格字段（时间 / 精力 / 场景）、微缩印刷行、撕线、出票按钮。
  - 保留 12 个 radio 的 `name/id/value` 与原顺序：`budget [b3,b5,b10,b15]`、`energy [elow,esteady,ehigh]`、`scene [snone,swaiting,sdesk,soutside,shome]`。
  - `#result`、`#status`、`#lane-status`、`#feedback-status`、`#share-status`、`#share-text`、`#about`、模型设置与记忆管理节点保留。
- [web/style.css](../../web/style.css)
  - 删除 `.lane / .station-ticket / .station-body / .stub / .collection-strip / .collect-dot / .station-marks / .picked-note` 等三站样式，新增月台、票面表单、结果票、区间带、字段折叠、选项与响应式规则。
  - 结果卡改成同纸色、同齿孔、同票头基线的「结果票」；`.card` / `.sheet` 增加实色纸底，避免半透明渐变导致深色主题文字对比度失控。
  - `prefers-reduced-motion` 下统一 `animation:none / transition:none`；在途时 radio 禁用，防止 DOM 点击改动在途条件。
- [web/app.js](../../web/app.js)
  - `laneState { station, confirmed }` → `formState { step, values, touched, epoch, phase }`；`selectStation()` → `fillField()`；`showStation()` → `openField()/returnToForm()`。
  - 一屏一问：选中即写入并收起本格、展开下一格；焦点移到下一格第一个选项；最后一格选完焦点落到出票按钮；播报「已记下 X，下一步 Y」。
  - 三格齐了才启用「出一张现在」；出票走原有 `startInteraction()`，快照、`request_id`、`replaces` 与失败重试语义不变。
  - 失败回到第三格并保留全部选择，重试复用同一份快照与 UUID；`用上次的条件` 一键填满；`重填` 清空；结果票三枚条件键可返回对应格。
  - 结果票新增区间带（`现在 ─▶ 现在 +N′ · HH:MM`）、齿孔条、票头与底部票根；聊天、候选记忆、照片上传、反馈、分享逻辑未改。
- [dev/acceptance-ui.mjs](../../dev/acceptance-ui.mjs)
  - `lane` 组从「三站」迁移为「三格票面」语义；共享 `stationInput` / `enterLaneThroughUI` 改为按字段选择并点出票按钮。
  - 主题色、meta 色、768 单列、200% 字号、引导文案、对比度测量面、阴影判定等常量同步到 v5；未削弱 API、焦点、失败重试、存储异常与 reduced-motion 断言。

## 2. 最终验收结果

### 浏览器 UI

在隔离的空内存服务 `http://127.0.0.1:8895`（PGlite 内存库）与既有 fake-model `http://127.0.0.1:8766` 上运行：

| 组 | 通过 | 失败 |
| --- | ---: | ---: |
| lane | 92 | 0 |
| state | 32 | 0 |
| timing | 12 | 0 |
| layout | 21 | 0 |
| polish | 86 | 0 |
| legends | 60 | 0 |
| completion | 46 | 0 |
| b4 | 66 | 0 |
| ix | 64 | 0 |
| **合计** | **479** | **0** |

- 完整结果：[ui-final.json](ui-final.json)
- 无脚本异常；控制台中的 4xx 均来自负向用例。
- 验收常量随视觉方案同步：`.lane/.station-*` → `.field/.f-*`，引导文案改为三格版；未改动断言语义。

### API 回归

在同一服务上运行（清库后）：

| 套件 | 通过 | 失败 |
| --- | ---: | ---: |
| base | 42 | 0 |
| interactions | 112 | 0 |
| **合计** | **154** | **0** |

- [api-base.log](api-base.log)、[api-interactions.log](api-interactions.log)
- 首次 base 运行出现 1 项 `无模型 Key 时走内置兜底` 失败，原因是同一内存库残留了 UI 验收写入的 `source=model` 记录；重启 8895 清库后 42/42 通过。不是代码缺陷。
- 未运行 model / photos / memories / local 四套（本次未改对应代码与接口）。

### 静态检查

- `node --check web/app.js` 通过。
- `node --check dev/acceptance-ui.mjs` 通过。
- `git diff --check` 通过。
- [source-manifest.json](source-manifest.json)：四个改动文件的 SHA-256 与字节数；`source-after` 与当前工作区一致。

## 3. 资源体积

按 Node v24.22.1 / zlib 1.3.2.1，8 个网页资源分别 gzip level 9 后求和：

| | raw | gzip9 |
| --- | ---: | ---: |
| 改动前（V4.1） | 122,198 B | 33,281 B |
| 改动后 | 135,640 B | 36,908 B |
| 目标 | — | ≤24,576 B |
| 结果 | — | **未达标，超出 12,332 B** |

- 本次增加 raw +13,442 B、gzip +3,627 B；月台纯 CSS 与票面排版是主要增量，已通过删除三站样式做减法，但仍高于既有 24 KiB 执行口径。
- 未采用压缩/混淆脚本规避；未擅自提高阈值。

## 4. 视觉证据

- [01-initial-dark-1440.png](01-initial-dark-1440.png)：1440×900 深色首屏，一屏内同时看到月台、文案与票。
- [02-filled-dark-1440.png](02-filled-dark-1440.png)：三格填完，票收成三行印刷体，主按钮实心。
- [03-ticket-dark-1440.png](03-ticket-dark-1440.png)：出票后的结果票，含区间带、票头、条件键、正文与票根。
- [04-initial-light-1440.png](04-initial-light-1440.png)：浅色清晨首屏，列车与黄线仍可辨。
- [05-initial-light-390.png](05-initial-light-390.png)：390×844 单列，票在文案下，选项不换行。
- 截图脚本：[shots.mjs](shots.mjs)，通过 CDP 固定 1440×900 / 390×844 与 `prefers-color-scheme`。

## 5. 方案边界与已知取舍

- 月台为纯 CSS 矢量，没有使用 `art/` 概念图；P1 的位图 AVIF 昼/夜底图、列车 1180ms 进站编排、光锥扫入、浮尘与静息收敛尚未实现。
- 结果票与填写票是同一视觉容器的两个 DOM 状态，不是真正的同一节点变形；齿孔、票头、纸色与宽度一致。
- 已实现「用上次的条件」一键填满；首次进入不预选任何值，因此不是零操作出票。
- 从结果票条件键返回某格时保留全部已填值，改完后可直接再次出票；未沿用 V4.1「改一站需重验后续各站」的强制确认。
- 桌面端黄线从票后穿过，票压在黄线上；与方案 §5.4「黄线不可遮」仍有差距，P1 可将黄线下移或把票抬离站台面后再校准。
- 印章落地、撕票根 520ms 编排、三套时间氛围属于 P1/P2，本次未做。
- 印章、完成态、反馈、分享、对话、候选记忆、照片上传沿用 V3/V4 逻辑，只随结果票排版调整。

## 6. 未验证的硬门槛

以下项目本机环境无法真实完成，不能视为通过：

- iOS Safari / Android 真机
- VoiceOver / TalkBack 实际读屏
- 1440×900 真机 60fps 与 GPU 合成性能
- 五人盲测、15 秒真机录屏
- 已部署环境与真实视觉模型套件
- 视觉概念图与实际位图资产的一致性（本次未使用位图）

## 7. 环境与归档

- 本次临时服务：`dev/server.mjs 8895`（PGlite 内存库）与既有 `dev/fake-model.mjs 8766`。验收结束后已停止 8895，8766 未触碰。
- 已删除 CDP 临时 profile、调试截图与临时分组脚本。
- [source-before/](source-before/)：编辑前 `web/index.html`、`web/style.css`、`web/app.js`、`dev/acceptance-ui.mjs` 快照；范围仅这四个文件，不是可独立运行的完整仓库。
- [source-after/](source-after/)：验收完成后的同类快照。
- [changes.patch](changes.patch)：四个改动文件的完整二进制安全补丁。
- `dev-8895.log`：临时服务启动日志。
- **未提交、未推送、未部署。**
