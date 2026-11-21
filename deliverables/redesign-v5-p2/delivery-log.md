# WhyNot 前端 v5 P2 交付与验收日志

日期：2026-11-21  
基线：v5 P1（[../redesign-v5-p1](../redesign-v5-p1/)）  
交付范围：按《WhyNot-月台改版方案.md》**P2「质感与氛围」** 落地：三套月台光线、站台落印痕迹、纸张网点与套色偏移。未修改后端与 API 契约，未提交、未推送、未部署。

## 1. 实际改动

- [web/index.html](../../web/index.html)
  - 月台加入 `.stamp-ground` 站台印记层。
  - 「关于与数据」新增「月台光线」单选组：跟随主题 / 清晨 / 黄昏 / 夜班。
- [web/style.css](../../web/style.css)
  - 三套场景变量：`data-stage-light="dawn|dusk|night"`；默认不设属性时仍由浅/深主题决定（浅色=清晨，深色=夜班）。
  - 黄昏场景：暖橙到紫的天光、暗暖雨棚、暖色站台面、暖白纸外文字与描边；主题与场景解耦后，纸外文字颜色跟随场景，纸内文字仍固定为墨色。
  - 站台印记：42px 椭圆纸面压痕，`scaleY(-.58)`、橙色虚线内圈、落印 260ms、2s 后淡到 .24；最多 5 枚。
  - 纸张：`.sheet` / `.card` 增加 5px 网点纹理（opacity .04），票面标题与第一步加 `.3px` 套色偏移；印章加同向投影。
- [web/app.js](../../web/app.js)
  - `applyStageLight()`：读取/写入 `whynot-stage`，显式场景优先，`theme` 时移除属性、跟随主题。
  - 落印：`loadGroundMarks / saveGroundMarks / renderGroundMarks / addGroundStamp`；仅反馈成功且 `completed` 后 60ms 落印；同一天最多 5 枚，存 `whynot-marks`（含日期），换票不消失。
  - 初始化时恢复当日印记与月台光线设置。
- [dev/acceptance-ui.mjs](../../dev/acceptance-ui.mjs)
  - b4 新增 3 项：黄昏可独立选择并写入存储、月台不被主题覆盖、跟随主题恢复。
  - completion 新增 2 项：完成后站台累积落印、最多 5 枚。
  - polish 新增 1 项：票面网点纹理与套色偏移。
  - completion 组开始时清理当日印记，避免跨组残留影响计数。

## 2. 最终验收结果

### 浏览器 UI

在 `http://127.0.0.1:8895`（PGlite 内存库）与 `http://127.0.0.1:8766` fake-model 上运行：

| 组 | 通过 | 失败 |
| --- | ---: | ---: |
| lane | 95 | 0 |
| state | 32 | 0 |
| timing | 12 | 0 |
| layout | 21 | 0 |
| polish | 87 | 0 |
| legends | 60 | 0 |
| completion | 48 | 0 |
| b4 | 69 | 0 |
| ix | 64 | 0 |
| **合计** | **488** | **0** |

- 完整结果：[ui-final.json](ui-final.json)
- 无脚本异常；控制台 4xx 均来自负向用例。

### API 回归

在独立空内存实例 `http://127.0.0.1:8897` 上运行，避免污染 8895 预览：

| 套件 | 通过 | 失败 |
| --- | ---: | ---: |
| base | 42 | 0 |
| interactions | 112 | 0 |
| **合计** | **154** | **0** |

- [api-base.log](api-base.log)、[api-interactions.log](api-interactions.log)
- 8897 已停止；8895 预览继续运行。

### 静态检查

- `node --check web/app.js` 通过。
- `node --check dev/acceptance-ui.mjs` 通过。
- `git diff --check` 通过。
- [source-manifest.json](source-manifest.json)：四个改动文件的 SHA-256；`source-after` 与当前工作区一致。

## 3. 资源体积

按 Node v24.22.1 / zlib 1.3.2.1，8 个网页资源 gzip level 9：

| | raw | gzip9 |
| --- | ---: | ---: |
| P1 结束时 | 144,782 B | 38,642 B |
| P2 结束时 | 151,901 B | 40,064 B |
| 目标 | — | ≤24,576 B |
| 结果 | — | **未达标，超出 15,488 B** |

- P2 增加 raw +7,119 B、gzip +1,422 B。
- 未采用压缩/混淆脚本规避；未擅自提高阈值。

## 4. 视觉证据

- [01-dusk-stopped-1440.png](01-dusk-stopped-1440.png)：黄昏停站，暖橙天光、暗暖纸外文字、票面网点。
- [02-night-stopped-1440.png](02-night-stopped-1440.png)：夜班停站，切回深色场景。
- [03-night-ground-stamp-1440.png](03-night-ground-stamp-1440.png)：完成建议后，票面印章与站台地面「此刻」压痕同时存在；印记位于票下方、黄线上方。
- [04-dusk-stopped-390.png](04-dusk-stopped-390.png)：390×844 黄昏单列。
- 截图脚本：[shots-p2.mjs](shots-p2.mjs)。

## 5. 方案边界与已知取舍

- 「自动」在本次实现为 **跟随主题**（浅色=清晨、深色=夜班），没有按本地时间自动在三套之间切换；设置里可手动选清晨/黄昏/夜班。这是为了保持纸外文字与场景的对比稳定。
- 显式月台光线在 app.js 初始化时应用；内联首屏脚本未写入场景属性，刷新瞬间可能先出现默认主题场景再切到已选场景。
- 站台印记放在票面下方、黄线上方；很高的互动票会遮住部分印记，窄屏滚动时也可能被票面盖住。
- 印记按当天持久化在 localStorage；跨设备/服务端不同步。超过 5 枚只保留最新 5 枚，没有「最旧一枚先淡出」的过渡。
- 纸张网点是 CSS 点阵，不是 `feTurbulence` 纤维；没有做四边 alpha 侵蚀与纸张透光渐变。
- 三套氛围为纯 CSS 调色，没有 AVIF 位图与 700ms 双底图交叉淡入。
- 换票撕离/延迟落定、印章旋转 260ms 完整编排、真机 60fps 仍未完成。

## 6. 未验证的硬门槛

- iOS Safari / Android 真机
- VoiceOver / TalkBack 实际读屏
- 1440×900 真机 60fps 与 GPU 合成性能
- 五人盲测、15 秒真机录屏
- 已部署环境与真实视觉模型套件
- 本地时间自动切换三套氛围

## 7. 环境与归档

- 8895 预览服务继续运行，供用户查看；8766 fake-model 保持运行。
- 8897 空内存 API 实例已停止；P2 CDP 临时 profile 已清理。
- [source-before/](source-before/)：P2 编辑前四个文件快照。
- [source-after/](source-after/)：P2 验收后的同类快照。
- [changes.patch](changes.patch)：P2 相对 P1 的四个文件 unified diff。
- **未提交、未推送、未部署。**
