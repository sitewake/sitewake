# 模块单元测试

这里一个子文件夹就是一个模块。每个模块把自己做成一个能单独跑的单元：**一条命令 + 一个输入 JSON → 一个输出 JSON**。想知道某个模块吃什么、吐什么，不用读代码，跑一遍就看到了。

| 模块 | 文件夹 | 命令 |
| --- | --- | --- |
| PageAgent（浏览器侧，真正在页面上操作的那一半） | [page-agent/](page-agent/) | `npm run page-agent:run -- --input <用例>/00-module-input.json` |

能力中心走的是同一个思路（`npm run capability:classify`，用例在 `tests/fixtures/capability-center-v2/`），还没搬进来。

```bash
npm run test:unit
```

跑各模块的契约测试：校验用例文件确实是现实环境交给该模块的输入格式。不依赖浏览器、模型或任何外部服务。

## 约定

```text
tests/unit/<模块名>/
├── README.md                  这个模块的输入输出结构体、前置条件、已知边界
├── <模块名>.test.mjs           契约测试
└── <用例名>/
    ├── 00-module-input.json   你给模块的
    └── 01-module-output.json  模块交出来的
```

- **一个文件夹 = 一个用例**，输入和输出并排放，`git diff` 直接能看出输出漂在哪一行。
- **输出写回输入旁边**，命令不带 `--output` 时默认如此。
- **输入就是现实环境的输入格式**。不放重放提示、不放测试脚手架、不放模型或密钥配置——模块内部该真跑就真跑。
- **前置条件（API、依赖服务）不进输入文件**。缺什么就在启动前用一句话说清楚缺什么、怎么补。

## 加一个模块

1. 建 `tests/unit/<模块名>/`，先写一个用例的 `00-module-input.json`——照现实环境交给它的样子写。
2. 在 `lib/<模块名>/` 里定义输入输出结构体，成员类型尽量复用运行时协议里的原类型，别另写一份。
3. 写 `scripts/<模块名>-run.ts`：读输入、跑模块、把输出写到输入旁边。
4. 在 `package.json` 里加 `<模块名>:run`。
5. 写 `<模块名>.test.mjs` 和 `README.md`。测试会被 `npm run test:unit` 自动捡到。
