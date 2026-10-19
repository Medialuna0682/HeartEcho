# 本地代码检查与格式化

开发工具需要 Node 22.13+（或 Node 24）和 npm。运行 SQLite 自检还需要 Node 自带的 SQLite 支持 FTS5；本次在 Node 24 上验证。

```powershell
npm ci
npm run lint
npm run format:check
npm run test:tooling
```

修改代码后可运行：

```powershell
npm run lint:fix
npm run format
```

最后再运行项目已有的 `npm run selftest` 和 `npm run smoke`。这些命令都是本地工具，本次没有配置 CI 或 Git hooks。

## 为什么分开使用 ESLint 与 Prettier

- ESLint 使用推荐规则检查未定义名称、未使用变量、错误的表达式等问题；`lint` 遇到任何警告或错误都返回非零退出码。
- Prettier 统一缩进、引号、换行和长行布局。格式不再依赖手动调整，也不会与 ESLint 的格式规则打架。
- 依赖均为开发依赖，版本固定在 `package.json`，并提交 `package-lock.json`。新环境使用 `npm ci`，无需改变应用“无第三方运行时依赖”的打包方式。

有意保留而暂时不用的参数可用 `_` 前缀明确标记。确需规则例外时，应先确认业务意图，再在对应行写明理由。

本次只接入工具，没有清理或格式化现有业务代码。因此 `lint` 和 `format:check` 在当前代码上会报告存量问题并返回非零；这代表检查发现问题，不代表工具未安装。既有问题列在接入 PR 的说明中，后续可分批修复，不使用全局关闭规则或排除业务目录掩盖问题。

## 特别处理内嵌前端

`lib/ui-app.mjs` 的 `APP_JS` 是 `String.raw` 模板字符串。只对外层 `.mjs` 运行普通检查，无法覆盖其中的浏览器 JavaScript。

- `tools/embedded-ui.mjs` 静态解析模板，ESLint 同时检查外层 Node 模块和内层浏览器代码，并将内层错误位置/修复范围映射回原文件。
- 两种环境分别使用 Node 和浏览器全局变量；浏览器块不会因为外层属于 Node 模块就把 `process` 当成合法全局。`ICONS` 是运行时由 `appScript()` 注入的只读全局。
- `npm run format` / `format:check` 会额外用 Prettier 处理 `APP_JS` 内部代码，保留单文件前端结构。
- 检查过程不会导入或启动应用，不读取聊天数据、QQ 登录态和 API Key。模板结构发生变化时会明确失败，避免悄悄漏掉前端检查。
- `npm run test:tooling` 验证内嵌代码检出、位置映射、自动修复、格式化语义和幂等性。

数据、第三方协议端、打包产物和本机设置不参与检查/格式化。GBK/CRLF 的 `.bat` / `.cmd` 启动器也不会被重写。CSS、HTML、PowerShell 等其他内嵌字符串保持原样；当前特别处理的是 `APP_JS` 中的 JavaScript。

相关机制见 [ESLint 自定义处理器](https://eslint.org/docs/latest/extend/custom-processors) 和 [Prettier API](https://prettier.io/docs/api)。
