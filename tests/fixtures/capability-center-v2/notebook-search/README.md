# notebook 渐进式正式逻辑测试

原始输入：`00-original-input.json`

C1 的独立输入：`01-c1-input.json`。它是从一次 B `Created.task` 结果固化下来的
`GenerationTask` 快照。C1 的业务输入只来自这一个 JSON，不读取 B 的 artifact；harness 只用本地模型响应和本地站点替换耗时外部依赖，实际执行正式的 Explore → Contract → JavaScript author → Candidate Replay 流程。

正式链路固定为 `B → C1 → C2（生成、校验并提交 CandidateArtifact） → C3 → Review → D`。C2 是独立生产模块，但沿用 C1 的 `generationTaskId`，不新增数据库 Task type。

每个后续模块也都有独立的典型输入快照：

| 模块 | 输入文件 | 运行命令 |
| --- | --- | --- |
| B 分类 | `00-original-input.json` | `npm run capability:classify -- --input tests/fixtures/capability-center-v2/notebook-search/00-original-input.json` |
| C1 编写 | `01-c1-input.json` | `npm run capability:c1:mock -- --input tests/fixtures/capability-center-v2/notebook-search/01-c1-input.json` |
| C2 生成用例（Mock 模型 HTTP） | `02-c2-input.json` | `npm run capability:c2:mock -- --input tests/fixtures/capability-center-v2/notebook-search/02-c2-input.json` |
| C2 生成、校验并提交 Artifact（真实模型） | `02-c2-input.json` | `npm run capability:c2:real -- --input tests/fixtures/capability-center-v2/notebook-search/02-c2-input.json` |
| C2 生成、校验并提交 Artifact（Mock 模型 HTTP） | `02-c2-input.json` | `npm run capability:c2:mock -- --input tests/fixtures/capability-center-v2/notebook-search/02-c2-input.json` |
| C3 验证 | `04-c3-input.json` | `npm run capability:c3:mock -- --input tests/fixtures/capability-center-v2/notebook-search/04-c3-input.json` |
| AI Review | `05-review-input.json` | `npm run capability:review:mock -- --input tests/fixtures/capability-center-v2/notebook-search/05-review-input.json` |
| D 发布 | `06-publish-input.json` | `npm run capability:d:mock -- --input tests/fixtures/capability-center-v2/notebook-search/06-publish-input.json` |

表中的每条命令都可以直接运行，不要求先执行表中上一行。B 命令调用真实分类模型；C1 的耗时模型响应来自 `01-c1-model-fixture.json`；`capability:c2:mock` 只用 `02-c2-model-fixture.json` 替换模型 HTTP，Mock/Real 两个命令都调用同一个生产 C2 服务；Review 的模型响应来自 `05-review-model-fixture.json`。C2 成功提交阶段调用正式 Artifact 持久化、哈希、幂等和 C3 Task 创建逻辑，C3 调正式 Runner 和三个 hash 门禁，Review 调完整正式模型协议，D 的测试准备通过正式 B/claim/submit/Validation submit 建立血缘，再把正式生成的 package 原样交给 `publishValidatedCapability`。

`06-publish-input.json` 明确是 D 的独立场景 fixture：`setup` 只描述候选、用例和已完成的 C3 结果，不伪造固定的 task/candidate/hash。harness 使用这些数据调用正式 API 建立内存状态；真正传给 D 的 `generationTaskId` 和 `validated` 都直接取自正式 `submitTaskResult` 的输出。

C1 输出只包含 `generationTaskId` 与 Candidate 字段，不包含 `caseContextRef`、正式用例或业务测试值。C1 的 `groundingExamples` 仅用于本次编写和私有 Candidate Replay，不写入 C1 输出，也不成为正式 ValidationSuite。

C2 读取独立的 `02-c2-input.json`，其正式顶层结构是 `generationTaskId`、`siteId`、`candidate` 和 `browser`，不是 C1 输出的别名。C2 不接收 C1 的 Page、BrowserContext、`caseContextRef` 或 `groundingExamples`；它根据 `browser` 配置启动并最终关闭一个 fresh BrowserContext，从真实页面重新收集业务区域和控件值。请求拦截在首个 Page 创建前安装：所有请求都只允许同源 GET，非 GET、跨域导航和跨域子资源都会被阻断；默认只检查入口页，只有服务端显式提供 `readOnlyPathPrefixes` 时，匿名只读能力才能继续访问与能力语义相关且命中白名单的 GET 页面。探索证据在发送模型前先做脱敏与 64 KiB 门禁，再写入 C2 自己的 `caseDiscoveryEvidence` 侧车；C2 输出只携带其 `caseDiscoveryEvidenceRef`。

真实模型只生成 1–12 个 case 的 `input` 和 `expected`。`expected` 是实际 output 的顶层 partial map；每个 input 叶子值必须精确来自 C2 页面证据，expected 叶子值必须来自本 case 输入、页面证据或由 Contract 的确定性 `textTemplate`/`urlTemplate` 按本 case 输入渲染得到的值；无法证明时必须使用空对象。`target` 参数只能使用叶级 `business-region` 业务值，宽泛祖先区域不能证明跨业务对象组合。模型未过门禁时，生产服务最多反馈重生成两次，仍失败则停止在 C2。稳定 `caseId`、Schema、默认值省略、case 独立性、参数消费、目标绑定和确定性条件均由纯代码门禁生成或判定。C2 成功提交阶段会读取受控证据 Artifact，核对 site/task/kind、原始字节长度、SHA-256、Candidate hash 和逐 case 输入映射，重算 Contract、Program、ValidationSuite hash，随后形成 CandidateArtifact 并创建 C3 Task；失败时不留下本次新建 Artifact 或 C3 Task。C3 再从受控接口加载冻结 Artifact 与证据，精确核对 Program、Suite、顺序、输入和证据引用，并要求成功 Stage receipts。D 只发布服务端持久化的 C3 package，调用方替换 Candidate 或 suite 会得到 WriteConflict。`caseContextRef`、上游 `validationCases` 等旧字段仅用于读取历史记录，不得进入新链路。

所有下游 fixture 都保存完整、生产形态的 `ModuleRef` 和 `stages`，并使用与磁盘 Bundle 一致的 content hash；harness 只核对这些值，不会补 stages、改 URL 或修复输入 hash。新候选不输出 `contract.semantic`。页面文案、CSS 选择器、参数依赖、`scopeDecision` 和 `groundingExamples` 明细仅进入 C1 私有状态或调试 trace。

按顺序执行：

```bash
npm run capability:c1:mock -- --input tests/fixtures/capability-center-v2/notebook-search/01-c1-input.json
npm run capability:c2:mock -- --input tests/fixtures/capability-center-v2/notebook-search/02-c2-input.json
npm run capability:c3:mock -- --input tests/fixtures/capability-center-v2/notebook-search/04-c3-input.json
npm run capability:review:mock -- --input tests/fixtures/capability-center-v2/notebook-search/05-review-input.json
npm run capability:d:mock -- --input tests/fixtures/capability-center-v2/notebook-search/06-publish-input.json
```

C2 使用真实模型运行：

```bash
npm run capability:c2:real -- --input tests/fixtures/capability-center-v2/notebook-search/02-c2-input.json
```

C2 与正式链路测试：

```bash
npm run test:capability-c2
npm run test:capability-c2:mock
npm run test:capability-v2:production-flow:mock
npm run test:capability-module-harness:production-flow -- --input tests/fixtures/capability-center-v2/notebook-search/00-original-input.json
npm run test:capability-module-harness
```

2026-08-21 本地结果：C2 单元测试 45/45、C2 HTTP Mock 10/10、渐进式模块测试 71/71、Capability Center 核心测试 100/100、模块 I/O Harness 78/78、后端正式生产流 1/1、C2 Real 生成 2 cases 并通过、C2 real-site 生成 2 cases 并通过。按当前验收范围不执行前端 Agent 全链路 E2E。旧的 `test:capability-v2:production-flow:mock` 入口依赖本地 Workers/Miniflare 集成环境，若该环境启动失败，不等同于后端模块断言失败；推荐使用上面的 backend-flow 入口验证 B→C1→C2→C3→Review→D。

其中 C1 Mock 可以单独验证，不需要先运行 B：

```bash
npm run capability:c1:mock -- --input tests/fixtures/capability-center-v2/notebook-search/01-c1-input.json
npm run test:capability-c1:mock
```

C1 使用真实大模型运行（模型配置读取 `.env.local`，浏览器使用本地确定性测试站点）：

```bash
npm run capability:c1:real -- --input tests/fixtures/capability-center-v2/notebook-search/01-c1-input.json --output-dir .artifacts/capability-center-v2/notebook-search-real
```

验证所有独立 Mock 用例：

```bash
npm run test:capability-progressive:mock
```

如果 B → C1 的边界结构发生变化，再单独运行一次 B 并更新
`01-c1-input.json`；这不是 C1 测试的前置步骤。

输出目录：

```text
.artifacts/capability-center-v2/notebook-search/
```

C1 运行后，生成的模块不会内嵌在 `02-author.json` 中，而是单独写入：

```text
.artifacts/capability-center-v2/notebook-search/02-author.module.ts
.artifacts/capability-center-v2/notebook-search/02-author.bundle.js
```

`02-author.json` 保留 Candidate 字段和生产运行时使用的 `program.module`（`moduleUrl`、`contentHash`、`exportName`）。源码与 Bundle 写入 artifact 存储；绝对文件路径只在命令输出中展示，不进入模块 JSON，也不作为后续业务字段。C2 运行后另行写出：

```text
.artifacts/capability-center-v2/notebook-search/03-c2-output.json
.artifacts/capability-center-v2/notebook-search/03-generate-cases.case-discovery-evidence.json
```

前一个文件已经是 C2 提交后的 `{ artifact, validationTask }`；后一个文件是 C2 从 fresh BrowserContext 探索真实页面生成的 `caseDiscoveryEvidence` 侧车，不是 C1 产物。

C2/C3/Review/D fixture 对应的典型模块源码固定为：

```text
C:\Users\Administrator\code\sitewake\tests\fixtures\capability-center-v2\notebook-search\01-c1-module.ts
```

C3 会在随机空闲端口启动确定性站点，逐条真实回放两个 case；Contract 使用生产支持的相对 URL template，因此不需要改写输入 URL。若 RunSpec 与冻结 Artifact 的 Program、Suite、顺序、输入或证据引用不同，即使攻击者同时重算自哈希也会报 `candidate_frozen_artifact_mismatch`。harness 不会修复输入。

正式模块命令均使用前文列出的独立输入 JSON，并显式传入 `--input`；批量便利入口不代表模块边界。

运行测试：

```bash
npm run test:capability-mock
```
