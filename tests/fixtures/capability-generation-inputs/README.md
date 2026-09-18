# CapabilityGenerationInput fixtures

此目录只存放能力中心模块 B 的逻辑输入。每一个 `*.json`（不含
`manifest.json`）都是一份完整的 `CapabilityGenerationInput`，不是数据库
记录，也不是 C/D 的输出快照。

## 使用边界

```text
fixture JSON → B / CapabilityGenerationInput → C1 → C2 → C3 → Review → D
```

fixture 只模拟 A→B 的边界。文件中故意没有 `CapabilitySeed`、Contract、
Program、JavaScript 源码、CandidateArtifact、Capability/Version ID 或
Validation Task。后续对象必须由真实能力中心代码产生。`episodeId`、观察引用
和回执引用是输入证据的逻辑相关 ID，不是预置能力 ID。

测试运行器应在发送前替换字符串占位符：

- `{{RUN_ID}}`：本次运行唯一值，避免 Episode/Trace 互相复用。
- `{{SITE_ID}}`：如果运行器需要把站点标识放进外层请求头，可使用本次隔离站点；它不属于 `CapabilityGenerationInput` 的业务字段。

不要把运行器生成的 task、runner、candidate、capability 或 version ID 回写到
这些 JSON；它们应只在报告和 Debug Trace 中出现。

## 场景概览

| 文件 | 重点 | B 的期望 | 后续关注 |
| --- | --- | --- | --- |
| `01-episode-search-general.json` | 通用搜索、关键词参数化（重复基线） | Created | 全链路 Published |
| `02-episode-add-cart-default.json` | 动态商品详情、数量省略 | Created | 默认值必须有证据并通过 C3 |
| `03-episode-add-cart-explicit-quantity.json` | 显式数量输入 | Created | 参数先消费再执行写操作 |
| `04-episode-dynamic-product-detail.json` | 动态详情跳转 | Created | 禁止固化详情 URL |
| `05-episode-category-scoped-search.json` | 目录作用域判断 | Created | 作用域与业务参数分离 |
| `06-admin-create-search.json` | 管理员直接创建 | Created | 与 Episode 共用 B→D 链路 |
| `07-episode-duplicate-synonym.json` | 同义语义重复 | Duplicate（需先有基线） | 不新增能力/版本 |
| `08-episode-duplicate-broader.json` | 宽泛目标覆盖判断 | Duplicate 或明确新作用域 | 不能只按原文比较 |
| `09-episode-search-no-result.json` | 业务无结果 | Created | NoResult 不能伪装成技术异常 |
| `10-episode-ambiguous-target.json` | 多候选歧义 | Created | 允许 Published 或明确 Ambiguous/NoResult fail-closed；C/Runner 必须拒绝无条件首项 |
| `11-invalid-empty-goal.json` | 空目标边界 | Rejected | `generation_goal_required` |
| `12-invalid-empty-entry-url.json` | 缺少浏览器起点 | Rejected | `generation_entry_url_required` |
| `13-invalid-episode-id.json` | Episode 关联缺失 | Rejected | `generation_episode_required` |
| `14-invalid-admin-repair-target.json` | Repair 缺目标能力 | Rejected | `generation_target_capability_required` |

完整机器可读的运行顺序、分组、依赖和期望码见同目录的
`manifest.json`。其中 07/08 是重复检测场景：先用一个成功 fixture 生成并
发布基线，再在同一个隔离 `siteId` 上提交重复候选；不要在两者之间清空环境。
其他场景建议每个用例运行前清空一次测试环境。

## 判定原则

“测试通过”不是指每个输入都必须 Published：

1. 正常用例必须完成 B→C→C3→Review→D，或在报告中给出明确、可审计的门禁失败。
2. 重复用例必须返回 Duplicate，或明确说明为什么语义覆盖不足而创建新能力；不能无理由创建第二份等价能力。
3. 边界拒绝用例必须在 B 阶段失败，不能调用模型、创建 GenerationTask 或写 Capability。
4. 歧义用例不得选择 `candidates[0]`、`matches[0]`、`.first()` 或等价的无条件第一项。
5. 每次运行的节点输入、输出、schemaRef、hash、失败码和最终状态由外部测试运行器写入 `dataflow.jsonl` 与 HTML 报告；fixture 本身不携带这些运行产物。
