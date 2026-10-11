# Capability Center V2 模块 I/O Harness Fixtures

这组 Fixture 以维护者文档 module-io-contracts 为唯一接口标准，用于后续给 B、C1、C2、C3、Review、D 的正式生产入口增加数据驱动测试。

## 目录约定

```text
module-io-harness/
  bases/             # 每个模块一份完整、合法的目标接口输入
  cases/<module>/    # 每个边界场景一个独立 JSON 文件
  manifest.json      # 覆盖矩阵和所有 case 的索引
```

每个 case 文件包含：

```json
{
  "schemaVersion": "capability-module-harness-case.v1",
  "module": "B",
  "caseId": "B-01",
  "title": "Episode 创建 Discovery Task",
  "baseRef": "../../bases/b-episode.json",
  "inputPatch": {},
  "removePaths": [],
  "setup": {},
  "expected": {
    "outcome": "success",
    "assertions": [],
    "sideEffects": []
  }
}
```

- `baseRef`：相对当前 case 文件的完整正式输入。
- `inputPatch`：使用 JSON Merge 语义覆盖基线；数组整体替换。
- `removePaths`：合并后需要删除的点路径，用于缺失字段和旧字段边界测试。
- `setup`：测试环境准备要求，例如已有 Active 能力、模型返回场景、持久化故障。它不是生产模块输入。
- `expected.assertions`：对模块正式返回值的断言。
- `expected.sideEffects`：对 Artifact、Task、发布状态和 AI 调用次数等外部事实的断言。

测试代码使用 `tests/helpers/capability-v2-module-io-fixtures.mjs` 加载 case。加载器只组合测试数据，不修改生产输入，也不包含测试专用业务判断。

## 断言操作

- `equals` / `notEquals`
- `present` / `absent`
- `matches`
- `lengthAtLeast`
- `sha256`

`sideEffects` 由模块 Harness 根据对应 Repository、模型 spy 或 Task Store 的真实状态执行断言。

## 重要边界

- Fixture 使用目标协议，因此故意不在合法基线中出现 `normalizedGoal`、`browser.mode`、`semantic`、`dependencyLedger` 或独立 `entryPolicy`。
- 旧字段 case 会通过 `inputPatch` 主动注入旧字段，期望严格 decoder 拒绝。
- C2 基线代表 C2 输入；C2 成功输出必须是内部提交后的 CandidateArtifact 和 C3 Task ID。
- 每个模块 case 可以独立加载，不依赖先运行上一个模块。

## 运行命令

全部 78 条模块边界用例：

```powershell
npm run test:capability-module-harness
```

单模块运行：

```powershell
npm run test:capability-module-harness:B
npm run test:capability-module-harness:C1
npm run test:capability-module-harness:C2
npm run test:capability-module-harness:C3
npm run test:capability-module-harness:Review
npm run test:capability-module-harness:D
```

Harness 会在 `.artifacts/capability-center-v2/module-io-harness/<timestamp>/` 生成 `report.json` 和 `report.html`。报告逐条保存相对 case/base 路径、输入、期望、实际输出、生产入口、模型调用次数、页面证据摘要和副作用断言，不保存本地绝对路径或凭据。模型只使用 HTTP fixture 返回；浏览器、页面探索、证据侧车、门禁、C2 内部提交、C3 执行和 D 持久化均调用正式代码。

D-10 使用 SQLite D1 形态适配器让正式发布事务在版本写入阶段失败，验证数据库回滚后 Capability、Version 和分类 reservation 都没有半成品；不是在 Harness 里直接伪造 D 返回值。
