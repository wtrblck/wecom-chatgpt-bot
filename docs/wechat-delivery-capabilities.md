# 微信 4.1.13.12 发送能力核验

核验日期：2026-09-06。先完成只读检查，再经用户明确授权执行可访问性激活，并向用户指定的测试群验证发送。已验证：本机微信 4.1.13.12 可通过 UIA 精确定位输入框、核验焦点和文本，再以单次 Enter 发送；数据库确认测试文案只新增一条。ChatGPT 网页单独的 `hello` 冒烟及两次完整“群内新问题 → GPT → 同群回复”业务轮次均已通过。第二轮精确回复“链路测试成功”，同时验证重启续读；详见 [验证记录](validation.md)。

## 本机观察

| 状态 | 窗口 | UIA 节点 | 可读输入框 | 可 Invoke 发送按钮 |
| --- | --- | --- | --- | --- |
| 激活前最小化 | 237 × 39 | Pane 1、TitleBar 1 | 无 | 无 |
| 激活前还原 | 1342 × 971 | Pane 1、TitleBar 1、Button 4 | 无 | 无 |
| 激活后 | 正常聊天主窗口 | 首次检测 167 个节点 | 有，`chat_input_field` | 暴露 Invoke，但实测未提交 |

激活前窗口类为 `Qt51514QWindowIcon`，只有外壳。激活后为 `mmui::MainWindow`，其可访问性名称可能为 `Weixin`，因此窗口识别已兼容该名称与明确的主窗口类。原生桥接返回 `protocolVersion=2`，输入框优先按唯一 `AutomationId=chat_input_field` 定位。

第一次和第二次 `InvokePattern.Invoke()` 均没有真正发出消息：新取的输入框中 ValuePattern 与 TextPattern 均保留完整测试文案，数据库也没有新增。操作结果标为未知，没有自动切换发送方式或重试。每次都分别核对数据库与同一草稿后，第三次显式选择 Enter；输入框清空回执成功，耗时约 1009 毫秒，随后数据库确认只有一条测试文案记录。该耗时是单次本机验证，不是长期性能保证。

默认 `WECHAT_SEND_ACTION=enter`；客户端设置为 Ctrl+Enter 发送时可显式选择 `ctrl-enter`；`invoke` 仍可手动选择，但不作为本机默认。每次只执行一个选定动作。所有动作要求精确目标、前台窗口、输入框焦点及文本一致；不使用鼠标发送。回执表示本地客户端提交证据，不代表对方已读。独立桥接进程通过会话内命名互斥锁共享窗口操作权，冲突时在操作开始前拒绝。

本机安装的是 .NET 10 SDK / Runtime；原 `net9.0-windows` 桥接能够编译但缺少 .NET 9 Runtime，运行失败。项目目标已调整为 `net10.0-windows`，发布目录固定为 `native/WeChatBridge/publish`。

## 上游方案的实际边界

1. [wechatauto-replica uia_driver.py](https://github.com/fanyuantaier/wechatauto-replica/blob/b9a9f5619f34c6a3e6eb15c27ec73d0adbbb4386/wechatauto/uia_driver.py) 第 6–26 行说明：WeChat 4.1.12+ 冷启动只暴露 Qt 外壳；实测 4.1.12.26 通过热激活得到 `mmui::*` 控件。第 398–439 行的激活过程调用 `OpenProcess`（含写权限）及 `WriteProcessMemory`，写入扫描得到的 Qt accessibility active byte。硬编码表只列 4.1.11.22，其他版本依赖 DLL 指令模式扫描。本项目复用并加强了候选扫描算法，未导入上游自动登录、坐标或发送代码；激活通过项目独立 helper 在用户授权后执行。
2. 同一文件第 572–595 行仅在没有运行中微信窗口时设置 Windows `SPI_SETSCREENREADER` 标志再启动微信；对已有窗口走的是内存热激活。没有证据说明给 Bot 的环境设置 `QT_ACCESSIBILITY` 就能激活已经运行的微信。进程环境设置也不会自动传入既存微信进程。
3. [Qt 5.15.2 Windows UIA 处理](https://github.com/qt/qtbase/blob/v5.15.2/src/plugins/platforms/windows/uiautomation/qwindowsuiaaccessibility.cpp) 第 70–87 行在 `handleWmGetObject` 中调用 `setActive(true)`。微信的现行封装与标准 Qt 行为并不等价：本机普通 UIA 查询没有物化聊天控件，不能仅据 Qt 源码保证可用。
4. [Qt 5.15.2 QAccessible 文档源码](https://github.com/qt/qtbase/blob/v5.15.2/src/gui/accessible/qaccessible.cpp) 第 101–108 行提到的强制启用变量是 **Unix/X11** 的 `QT_LINUX_ACCESSIBILITY_ALWAYS_ON`。这不能作为 Windows 微信的启用方案。
5. 上游 `uia_driver.py` 第 779–850 行仍是搜索名称、UIA `.Click()` 打开会话、剪贴板粘贴及 `SendKeys("{Enter}")`。传入 wxid 时会先映射为显示名（第 761–784 行），并非按稳定群 ID 直接调用微信发送接口。[README](https://github.com/fanyuantaier/wechatauto-replica/blob/b9a9f5619f34c6a3e6eb15c27ec73d0adbbb4386/README.md) 的 `quick_send(..., verify=True)` 使用数据库读回验证，值得借鉴为客户端提交后的回执层。

## Hook 发送支持证据

- [WeChatFerry](https://github.com/lich0821/WeChatFerry/blob/master/README.MD) 的当前变更记录适配 3.9.12.51；不能据此接入正在运行的 4.1.13.12。
- [WeChatCopilot 逆向记录](https://github.com/DesolateVE/WeChatCopilot/blob/cca36a0258a6025c8f2269bd4b82ab7e029b0012/docs/REVERSE_ENGINEERING.md) 明确完整研究基线为 4.1.12.26，4.1.13.12 仅增量适配 WCDB 密钥入口（第 9–17 行）；发送链完整 ABI、线程/协程、所有权与错误回调尚未确认，不能作为安全发送 API（第 35–36 行）。
- [wxcli-windows](https://github.com/Sisyphus-seeker/wxcli-windows) 列出 4.1.13.12 支持，但侧重消息读取，并建议结合已有发送能力。读取支持不能当作发送支持。

现有证据支持继续使用稳定群 ID 的数据库读取，并把发送作为独立、可替换且带回执的传输层。没有找到足以证明可直接替换本机 4.1.13.12 发送链的成熟 Hook 方案。本机已验证“严格检查的 accessibility 激活 + UIA 定位与焦点核验 + 单次 Enter”发送；微信更新或重启后，需要重新检查状态与控件契约。

## 独立候选验证工具

项目已增加 `native/WeChatAccessibility`，默认 `--check` 只读。离线合成 PE 测试 17 项通过；本机 4.1.13.12 只读验证成功：

| 证据 | 结果 |
| --- | --- |
| 模块 SHA-256 | `e3240bf8a4d00593a4b3e6ce6c8b6ac26897622c27f410f6655c4eee17cb3b6d` |
| 唯一 gate 候选 RVA | `0xAD19668` |
| 内存页 | 所选模块的已提交 MEM_IMAGE，可写、非执行 |
| gate 指令 RVA | `0x82A4E2` |
| 日志字符串引用 RVA | `0x82996E` |
| 引用距离 | 2932 字节，小于上游 `0x20000` 上限 |
| 磁盘/内存指令证据 | 完全匹配 |
| 只读检查时原字节 | `0` |
| 用户授权后的激活 | 显式 `--apply`，单字节 `0 → 1`，读回成功 |

用户授权激活后，UIA 节点由外壳变为可用的聊天控件，后续单次 Enter 发送已由数据库读回核实。此结果只验证本机当前版本；helper 的字节读回成功本身不等价于消息发送成功。独立工具仅在显式 `--apply --pid ... --expected-sha256 ...` 后才允许单字节写入，Bot 和 setup 不会自动调用。详见 `native/WeChatAccessibility/README.md`。
