# 企业微信 + 个人微信 ChatGPT 网页机器人

在 Windows 本机运行的双渠道机器人。企业微信使用官方 WebSocket SDK；普通个人微信通过本地只读数据库读取文本消息，并通过 Windows 官方微信 PC 客户端发送。两个渠道汇入同一个 MessageRouter，再用 Playwright 操作已登录的 ChatGPT 网页。项目不调用 OpenAI API 或 ChatGPT 私有接口。

## 已实现

- 企业微信单聊文本与 Markdown 流式回复
- 一个持久化 Chromium Profile，人工登录一次后复用登录状态
- 用户与 ChatGPT conversation URL 的 SQLite 持久映射
- `msgid` 持久去重、任务审计和进程重启中断标记
- 全局 FIFO 串行队列，避免同一个页面并发输入
- UTF-8 字节级长度控制及超长回答主动分段
- `/new`、`/retry`、`/stop`、`/status`、`/help`
- 普通微信监听配置、联系人白名单和可选 `/gpt` 前缀
- 可为每个普通微信联系人或群聊配置独立系统提示词
- 普通微信单发送 worker、自然段长回复拆分和自身消息过滤
- `wecom:userId` / `wechat:userId` 隔离的会话上下文
- 浏览器崩溃最多恢复三次；DOM 异常保存截图、HTML 和 URL
- 结构化日志与敏感字段脱敏，默认不记录问题和回答正文

普通微信目前只处理私聊和群聊纯文本，不支持图片、文件、语音、好友请求、多账号和多浏览器并发；不注入 DLL，也不包含风控绕过。

## 环境要求

- Windows 10/11
- Node.js 22 或更高版本
- 企业微信智能机器人 Bot ID 与 Secret
- Windows 官方微信 PC 客户端；普通微信渠道要求已人工登录并保持主窗口可用
- .NET 9 Desktop Runtime/SDK（已发布桥接程序仅需要 Desktop Runtime）
- 可正常登录 `https://chatgpt.com/` 的浏览器网络环境

## 安装

```powershell
npm install
npm run playwright:install
Copy-Item .env.example .env
Copy-Item config/wechat-conversations.example.json config/wechat-conversations.json
```

编辑 `.env` 并填写企业微信 Bot ID 与 Secret。Secret 只从环境变量读取；`.env`、浏览器 Profile、SQLite 数据库和错误页面快照都已排除在 Git 之外。

## 启用普通个人微信

先编译 Windows UI Automation 桥接程序：

```powershell
npm run wechat:build
```

保持 Windows 官方微信已由用户本人登录，然后配置：

```ini
WECHAT_ENABLED=true
WECHAT_ALLOWLIST=
WECHAT_REQUIRE_PREFIX=false
WECHAT_PREFIX=/gpt
```

程序会优先使用 `native/WeChatBridge/publish-v2/WeChatBridge.exe`，兼容回退到旧的 `publish/` 目录。若没有发布文件，会通过本机 `dotnet run` 启动源码桥。

可先检查客户端状态：

```powershell
npm run wechat:probe
```

`windowFound: true` 且 `loggedIn: true` 表示桥接层已看到登录后的微信主窗口。

首次联调可暂时保持白名单为空，但建议同时启用前缀模式。收到消息后，结构化日志会输出该联系人的本地 `wxui_...` ID（不会输出聊天正文），再将允许的 ID 写入：

```ini
WECHAT_ALLOWLIST=wxui_xxxxxxxxxxxxxxxxxxxxxxxx
WECHAT_REQUIRE_PREFIX=true
WECHAT_PREFIX=/gpt
```

此时只有白名单联系人发送 `/gpt 问题内容` 才会触发机器人；其他联系人不会收到自动回复。

普通微信依赖官方客户端暴露的 Windows 可访问性元素。不同微信版本如果控件结构变化，操作会停止并将最小错误状态和窗口截图保存到 `logs/wechat/`。联系人 ID 优先来自客户端暴露的 AutomationId，否则由显示名生成并持久映射；显示名重复或改名时需要重新确认白名单 ID。

## 第一次运行

```powershell
npm run dev
```

首次启动会打开 Chromium。若 ChatGPT 未登录，请只在这个窗口中人工完成登录；程序每两秒检测一次，成功后无需重启。后续启动会复用 `data/browser-profile`。

生产运行：

```powershell
npm run build
npm start
```

## 微信监听与系统提示词

先从 `config/wechat-conversations.example.json` 复制本地配置，再编辑 `config/wechat-conversations.json`，即可增加、停用或修改监听对象，无需再修改程序代码。真实监听配置默认不会提交到 Git：

```json
{
  "conversations": [
    {
      "name": "群聊或联系人显示名称",
      "type": "group",
      "id": "可选但推荐填写的稳定微信 ID",
      "enabled": true,
      "systemPrompt": "仅作用于这个会话的系统提示词"
    }
  ]
}
```

`type` 只能是 `group` 或 `contact`。新增对象时可以暂时省略 `id`，程序会按准确名称查找；成功解析后建议补上稳定 ID。`enabled` 设为 `false` 即停止监听。`systemPrompt` 留空表示不注入提示词。修改文件后需要重启 Bot。

由于 ChatGPT 网页没有 API 的 system 角色，程序会在每次实际问题前加入该会话的系统指令；任务数据库仍只记录原始问题，`/retry` 不会重复嵌套提示词。

## 分阶段联调

先独立验证 ChatGPT 网页自动化：

```powershell
npm run chatgpt:smoke
```

它会等待人工登录，发送固定的 `hello`，并打印最终回复。随后启动完整 Bot，在企业微信中依次测试普通问题、多轮追问、连续消息、`/new`、`/retry`、`/stop`、`/status` 和长回答。

## 数据与排障

- 会话及任务：`data/bot.sqlite`
- ChatGPT 登录：`data/browser-profile/`
- DOM 异常证据：`logs/debug/`
- 普通微信 UI 自动化错误与截图：`logs/wechat/`
- 所有 ChatGPT selector：`src/chatgpt/selectors.ts`
- 普通微信 UI 定位：`native/WeChatBridge/Program.cs`

如果 ChatGPT 改版，优先根据 `logs/debug` 中的截图和 HTML 修改 selector 层。长期驻留时建议关闭 Windows 自动睡眠，并用 Windows 任务计划程序或 NSSM 设置开机启动与进程守护。
