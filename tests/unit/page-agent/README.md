# PageAgent 单元测试

给一份输入，得到一份输出。

```bash
npm run page-agent:run -- --input tests/unit/page-agent/<用例>/00-module-input.json
```

输出写在输入旁边的 `01-module-output.json`。

> 有些站点拦无头浏览器，返回一个 403 人机验证页——模型会如实报告「访问受限」，任务当然做不成。对这类站点加 `--headed`。这是目标站点的策略，不是单元的问题。

## PageAgent 不是用户 Agent

用户 Agent 决定这次任务要不要动页面；PageAgent 是决定之后**真的去动页面**的那一半。它读屏幕上有什么、选下一步做什么、做完判断够不够 brief 说的完成标准。选路、挑能力、组织最终措辞，都不是它的事。

这个边界不是为了测试造出来的，产品里本来就是这样：PageAgent 是**单独打包**的一个 bundle，宿主用 `<script>` 加载它，然后调一个函数。

```
client/user-agent-adaptive.ts  ──构建──►  public/sitewake-adaptive.js
                                          window.SiteWakeAdaptive.run(options)
                                            → { success, text, output, episode }
```

它跟宿主**没有共享状态**：要什么全靠 `options` 传进去，产出什么全靠回调传出去。所以这个单元做的事就是：把输入文件翻译成那个 `options`，调用，收结果。

## 真实的部分

真 Chromium 打开真页面，真的 `public/sitewake-adaptive.js` 在上面跑，模型是配好的那个，模型请求打在 `app/api/**/route.ts`——生产环境同一份处理函数（存储走内存，不碰任何数据库）。每一步做什么、什么时候停，全由 PageAgent 和模型自己决定。

**唯一手写的是 `00-module-input.json`。**

跑之前要先满足两个前置条件，不满足会直接告诉你缺什么：

- SDK 包已构建（`npm run sdk:build`）
- 模型 API 已配置

配置属于环境，不属于这个单元——输入文件里不会有、也不该有任何 API 相关的字段。

## 输入

| 字段 | 说明 |
| --- | --- |
| `request` | 任务本身：`goal` / `input` / `conversation` / `origin` / `url`。`url` 是 PageAgent 起步的那一页 |
| `execution.brief` | **W3 给的授权**，不是提示。`effect` 划定能对页面做到什么程度，`completionCriteria` 定义什么算做完，模型改不了 |
| `execution.budget` | 起始额度。不填就用生产默认（180 秒 / 100 次模型请求） |
| `release` | PageAgent 真正会读的那几样：`profile`（站点摘要）/ `scenes`（能跳到哪）/ `targets`（认识过的元素，可空）/ `capabilities`（`call_capability` 能调什么，可空） |
| `services` | 宿主平时用回调提供的服务，见下。可以整个不写 |
| `runtime` | 闸门：`mode` / `maxSteps` / `requiredActionEvidence` / `runtimeV2` / `evidenceV2` |

### `brief.entities` 值得单独说

它是这次运行的**可信值集合**。写空了（`{}`）的话，任务本身可能照样做成，但这份经验能力中心学不走——查询类目标的完成证明第一步就是「没有可信实体直接判否」。

### `services` 是声明，不是脚本

只能说「这个环境里有没有人可以问、问了会答什么」，不能说「第 3 步答 A、第 5 步答 B」。后者等于把用例作者塞回运行过程里替模型做决定。

| 字段 | 不填的含义 |
| --- | --- |
| `askUser: { answer }` | **`ask_user` 这个工具直接不给模型**，跟真实宿主没传这个回调时完全一致 |

### 没有「允许跳转」这个开关

`onNavigateAction` 的含义不是「允许我跳转吗」，是「**宿主你接手吗**」——一说 yes，PageAgent 立刻挂起等待，因为按设计应该由**新页面上一个新的 PageAgent**带着 trace 把任务接着做完。

跨文档续跑是宿主的活：存 checkpoint → 让新文档认领 AgentRun → 带 `resumeTrace` 重新开一个 PageAgent。单元里没有宿主，所以诚实的回答永远是「不接手」。

**这意味着：PageAgent 单独跑活不过整页跳转。** 这个单元的用例都是单文档内能完成的；需要跳转的任务测的是宿主，不是 PageAgent。

## 输出

三样，各去一个地方。

| 字段 | 交给谁 | 说明 |
| --- | --- | --- |
| `result` | 调用方 | `{ success, text, output }`。`text` 是 PageAgent 自己的交代，**不是**给用户的最终措辞——那是宿主的事 |
| `episode` | 能力中心 | 带 `observationRefs`（只有编号和校验码）和 `actionReceiptsV2`（每一步操作的前后对照） |
| `evidence.observations` | 证据库 | 模型每一步看到的页面内容。生产里是跑的过程中就一批批发走的，这里收集起来是为了不开数据库也能读 |

比用户 Agent 少一样：**运行记录（AgentRun）不归 PageAgent**。它只是借宿主的 run token 去发模型请求，run 本身是宿主的。

**跑测试时算出来的东西不写进输出文件**——用的哪个浏览器和模型、借了哪个 AgentRun、`ask_user` 开没开、模型请求几次、有没有被拒的请求，这些都直接打在命令行上。它们不是 PageAgent 交给谁的。

## 用例

每个用例一个文件夹：`00-module-input.json`、`01-module-output.json`、说明它的 `README.md`。维护者在真实站点上录制的用例不随公开仓库发布；检出里没有用例时，测试会跳过并说明原因。
