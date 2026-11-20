# WhyNot

**当你不知道接下来做什么，WhyNot 给你一个现在就能开始的建议。**

走在路上、一个人吃饭，或刚上完一节课时，我们常常顺手打开抖音。有时是真的想看，有时只是暂时想不到别的选择。WhyNot 是一个 AI 生活伙伴，帮你在这些空当里，刷视频之前选一件适合当下的事。做件小事、看看周围或者什么都不做，都可以。

## 一次推荐是什么样的

你刚下课，在食堂等饭，还有 10 分钟，脑子有点累。打开 WhyNot，选好时间和状态，就能看到一条建议。

> 等饭的时候，给自己两分钟放空。把手机放在桌上，看看窗外。饭到了就安心吃。

如果这条建议不合适，点一下「换一个」。想自己决定，直接关掉也行。

| 此刻的情境 | WhyNot 可能给出的建议 |
| --- | --- |
| 在食堂吃饭，还有几分钟，想看点新鲜的 | 看看窗口是怎么分开点单和取餐的。你能找到一个让队伍走得更快的设计吗？ |
| 有 3 分钟，想看看日常技术的小细节 | 看一张二维码，找找三个方形定位标记。二维码还会存一些冗余信息，所以局部被挡住时，扫描器有时仍能恢复原来的内容。 |
| 忙完一阵，想轻松一下 | 想刷短视频就刷一会儿。要是 10 分钟后还有事，可以先定个提醒。 |

## 当前 P0 怎么用

项目已有可在本地运行的前后端，不再只是产品构想。主页面只有「此刻」，没有「今日」页或历史列表；页脚折叠区用于「关于与主题」。

- 默认 **10 分钟、还可以（steady）**，场景可跳过。时间可选 3／5／10／15 分钟，精力可选有点累／还可以／精神好；场景为等饭／排队、在桌前、在路上、在家／宿舍。
- 每次只给一个行动，写清第一步和预计耗时，耗时不超过所选预算。
- 修改条件不会自动生成。「换一个」使用**当前表单**条件，只请求新建议，从不提交反馈；失败后的「再试一次」保留**失败请求的条件快照**，不会悄悄改用新条件。
- 「喜欢」「不喜欢」可以改选，以最后选择为准。「已完成」独立、幂等，确认成功后不可撤销；反馈始终绑定具体建议。

建议参考主动选择的时间、精力、场景和当前匿名会话的历史偏好，不提供兴趣输入，也不接入或追踪定位、日历、健康与兴趣数据。累了可以休息，有点好奇心时也可以探索身边的小事。未配置模型密钥或模型失败时，服务端使用符合条件的内置建议；配置模型后，每次调用超时 7 秒，最多尝试 2 次，并校验输出。

## B4 界面与边界

界面采用「空当纸册」视觉体系，保留系统字体、原生 HTML／CSS／JavaScript，无新增运行时依赖。

- 页脚折叠的「关于与主题」说明匿名会话、推荐与反馈数据用途，并提供跟随系统／浅色／深色。显式 `light`／`dark` 选择存于 `whynot-theme`，跟随系统则移除覆盖值；存储读写失败时静默回到跟随系统。
- 只有已完成的建议提供分享：原生分享 → Clipboard → `execCommand` → 可选中文本手动复制。用户取消原生分享时安静结束，不再复制。分享链接只取 `location.origin + location.pathname`，不带 query、hash、建议编号、会话或反馈信息；分享不会记录反馈。
- 安装相关仅补 manifest、Apple 180px 图标及 192／512px 安装图标；能否添加到主屏幕取决于浏览器，不承诺自动安装。**无 service worker，不支持离线重新打开。** 已打开的页面断网后仍可看原卡片，但不能生成新建议；恢复网络后由用户手动重试。

## 本地开发与验收

使用 Node.js，在仓库根目录 `E:\whynot` 的 Git Bash 中运行；分别保留服务终端：

```sh
# 终端 1：当前前端 + 实际 functions 路由，内存数据库
node dev/server.mjs 8765

# 终端 2：本地 API 验收
node dev/acceptance.mjs
# 如服务换到其他端口，可覆盖 BASE（不包含 /functions/v1/app）
BASE=http://127.0.0.1:8875 node dev/acceptance.mjs

# 终端 3：无真实密钥的假模型，固定监听 8766
node dev/fake-model.mjs
# 回到终端 2，假模型保持运行
node dev/acceptance-model.mjs
```

打开 `http://127.0.0.1:8765/` 体验。内存数据随服务重启清空；无须云凭据，不设置 `MODEL_API_KEY` 即走内置建议。`acceptance-model.mjs` 也支持 `BASE`，会临时切换本地模型配置，覆盖成功、无效输出、上游错误和超时；不要与其他验收并行运行。本地 `/__local/*` 为测试控制入口，不是生产 API。

`dev/acceptance-ui.mjs` 是浏览器测试模块，**不是 Node 命令行测试**。在上述本地页面的浏览器控制台运行已有分组：

```js
const { default: run } = await import('/__local/acceptance-ui.mjs');
for (const group of ['state', 'timing', 'layout', 'b4']) console.log(await run(group));
```

`b4` 覆盖三态主题、存储受限、分享降级和安装资源。系统配色组合通过浏览器 CSS 媒体规则模拟，原生分享／剪贴板权限分支使用桩函数，不等于真实系统面板或手机验收。具体结果见 [B4 阶段日志](deliverables/b4-wrapup/B4-关于主题与收尾日志.md)。

全量 `web/`（包括安装图标和 manifest）gzip 上限放宽至 **16 KiB（16384 B）**；原四项资源同时对照初定的 14 KiB。逐文件使用 gzip level 9 求和，不是当前本地服务器的实际传输量；raw 上限未放宽，超限单独报告。

## 当前 API 契约

代码入口为 `functions/index.ts` → `functions/routes.mjs`；浏览器统一基址为 **`/functions/v1/app`**。以下路径均接在该基址后：

| 方法与路径 | 行为 |
| --- | --- |
| `POST /api/session` | 建立匿名会话，返回 `{ok:true, token}`；已有有效 token 时复用，返回 `{ok:true}`。 |
| `POST /api/recommendations` | JSON 条件生成一条建议，成功为 201。 |
| `POST /api/recommendations/:id/feedback` | JSON `{kind:"like"}`／`dislike`／`completed`，成功为 200 并返回更新后的卡片。 |
| `GET /api/health` | 健康检查，返回 `{ok:true}`。 |

三个业务端点之外仅有上述健康检查；当前 Functions **没有 `/api/history`**。

会话流程：前端把 token 存于 `localStorage` 的 `whynot-session`，后续通过 `x-whynot-session` 请求头携带；存储不可用时仍可在当前页面内存中使用。服务端按 token 的 SHA-256 摘要识别归属，不信任请求 JSON 中的用户身份。前端保留 `credentials: 'same-origin'`，但 Sites 网关不转发应用 cookie，当前路由不靠 cookie 认证。

推荐请求只接受 `budget`（整数 3／5／10／15）、`energy`（`low`／`steady`／`high`）及可省略或为 `null` 的 `scene`（`waiting`／`desk`／`outside`／`home`），拒绝额外字段。例如：

```json
{"budget":10,"energy":"steady","scene":null}
```

卡片字段为 `id`、`scene`、`energy`、`budget`、`category`、`title`、`first_step`、`detail`、`minutes`、`created`、`preference`、`completed`。增量字段 `category` 取 `rest`／`observe`／`listen`／`tidy`／`explore`；缺失、空值或未知值时前端仅隐藏类别，不丢弃整卡。`preference` 为 `null`／`like`／`dislike`，`completed` 为布尔值。换建议仍调用推荐端点，没有 swap 反馈类型。

典型错误：401 `SESSION_REQUIRED`，400 `INVALID_CONTEXT`／`INVALID_FEEDBACK`／`INVALID_BODY`，415 `JSON_REQUIRED`，404 `NOT_FOUND`（含不属于当前会话的建议），503 `STORAGE_UNAVAILABLE`；请求体超过 2048 字节返回 413 `INVALID_BODY`。

`app.py` 是较早的 Python／SQLite 原型：访问首页设置 HttpOnly `whynot` cookie，直接使用 `/api/*`，另有 `GET /api/history`。它与当前共享前端的 `/functions/v1/app` URL 和 token 会话流不兼容，不能用 `python app.py` 替代上述当前前端联调入口。

## 交付状态

详细交互与验收目标见 [产品说明](产品说明.md)。云端部署、公网链接验收、真实手机与有声屏幕阅读器测试、性能基准均不在此声明通过。后续部署及公开访问须另行授权执行。

**每阶段记录实际改动、测试结果与未验项，然后停止，等待下一条指令；不自动提交、发布或进入下一阶段。** 日志只记录验证摘要，不记录密钥、用户原文或模型原始响应。
