# v1.3 Windows 安装版交接（开发预览）

本文记录当前实现与验收边界，供维护者继续开发和审阅。版本号 `1.3.0-dev.0` 为开发预览，不是发行版。原任务书的 SnowLuma 内置方案已根据后续决定改为用户自行下载、阅读许可并选择目录；本分支不自动下载、部署或分发 SnowLuma。

## 已实现

- 源码批处理启动托盘和带鉴权的面板；未填写机器人 QQ 时保留面板，完成设置后需重启。
- 角色创建和保存增加重名、Windows 保留名及损坏文件保护，避免静默覆盖已有角色。
- 增加安装模式及通用版、TB 版启动器，分别使用各自的默认数据和设置；支持已安装版多实例、自启与重启。
- 增加 C# Windows per-user 安装器、快捷方式、开机启动选项、旧数据复制导入、升级备份与回滚、卸载和明确确认后删除默认数据。源码文件采用显式清单打包，安装负载有 SHA-256 校验。
- 协议端由用户自行准备；安装版可使用随包 Node 运行时。进程停止及重启只针对当前心语实例启动的进程。对已识别的 SnowLuma 1.14.22，首次密码未修改或 WebUI 配置异常时要求先手动初始化，降低初始密码进入心语日志的风险。
- 安装界面包含项目、Node 和扩展许可及来源；扩展作者清单由随包 manifest 生成。具体操作见 [INSTALLATION.md](INSTALLATION.md)。

## 已做的离线验证

在 Windows 本机隔离临时目录、模拟协议端和模拟数据上运行过：

- 自动化安全、角色保存、首次启动、安装模式、协议端、负载打包与解压、数据迁移、升级回滚和卸载测试；两版安装器的静默安装、启动、自检、升级及卸载集成测试通过。
- 独立扩展测试 91 项通过；对话流程及开发工具测试 21 项通过；模块冒烟、数据库备份恢复、导入名及 UI 模板静态检查通过。
- 自定义实例目录和登记在其他位置的实例数据库备份、损坏登记表停止升级，均使用模拟数据验证。
- 以上不代表全部历史测试在本次修改后均已重新运行。测试不能证明真实 QQ、SnowLuma 或图形界面行为。

## 后续与发行前阻塞

1. 使用独立测试账号和干净 Windows 10/11 环境，逐项执行任务书的手工矩阵：安装 UI、快捷方式、登录自启、托盘、迁移、升级、卸载、中文路径、无网及 SmartScreen。当前用户没有测试 VM 或 QQ 测试账号，尚未执行。
2. 在用户自备并确认许可的 SnowLuma 环境验证实际 WebUI 初始化、QQ 登录、账号接管、OneBot 通信及多实例；当前仅静态检查了官方 1.14.22 Lite 包并运行本地模拟协议端。不同 SnowLuma 版本和其他协议端仍可能将敏感内容写入日志；旧日志不会自动清除。
3. `EXTENSIONS.md` 说明 16 个移植扩展的原始素材缺少许可证，公开分发或将安装包交给他人前须逐项确认作者授权。清单中的作者名不等于授权证明。SnowLuma 的内置或自动部署也需要另行核实其许可和授权；当前方案不内置。
4. 安装和迁移使用进程检查、实例锁和安装操作互斥降低并发风险，但应用运行时与安装器并未使用同一个完整的跨进程事务锁。升级和迁移前应退出心语、子实例及所有其他数据写入程序；仍需设计并验证完整并发协调。多实例存在 `instancesMainDataDir` 等高级配置及环境变量覆盖，应继续核对其备份覆盖范围。
5. 两版共存提示仅检查默认实例的数据锁，自定义数据目录和其他实例不一定被覆盖。尚未对真实 QQ 注入和端口冲突完成验收。
6. 全仓库 ESLint 仍有上游既有问题；本分支涉及的协议端文件及测试单独检查通过，未为本次工作改动无关代码或 CI。

## 本机构建与回归

需要 Windows、Node 24 或更新版本，以及 Windows .NET Framework `csc.exe`。构建时需要取得与 Node 版本匹配的官方许可证；离线可设置 `HEARTECHO_NODE_LICENSE` 指向该文件。输出路径须不存在。

```powershell
node tools/build-installer.mjs --edition generic --output dist/installer/心语-安装-预览.exe
node tools/build-installer.mjs --edition tb --output dist/installer/领航员终端-安装-预览.exe
node --test tools/installer-payload-test.mjs tools/payload-packaging-test.mjs tools/protocol-offline-test.mjs
node --test tools/security-test.mjs tools/next-version-test.mjs tools/m1-character-test.mjs tools/m1-startup-test.mjs tools/installed-runtime-test.mjs
```

对两份刚构建的安装器运行集成测试时，将绝对路径用 Windows 分号连接后设置到 `HEARTECHO_TEST_INSTALLERS`，再运行 `node --test tools/installer-integration-test.mjs`。测试自行建立临时数据目录；不要将其指向真实用户数据。预览安装包、Node 运行时、SnowLuma、用户配置和数据不应提交进仓库。
