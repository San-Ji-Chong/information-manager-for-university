# 大学资料信息管理程序
使用一个统一的日历界面来规划管理你的待办，思训与学习资料！
## 功能
-. 抓取每周的思训信息并呈现在日历上
-. 从QQ聊天记录中查找可能的待办并由你选定（需LLM api）（微信暂时只支持手动粘贴）
-. 用一个索引来串联起你的学习资料与网站
## 运行环境
可能有点长，但除了napcat(onebot)与大模型api没什么特别的
### 必需

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 24（开发环境 v24.19） | 用到内置 `node:sqlite`；22.5–23.x 需加 `--experimental-sqlite` 启动，未实测 |
| npm 依赖 | 无 | 零依赖、零构建，克隆后直接跑，不需要 `npm install` |
| 浏览器 | 任意支持 ES Module 的现代浏览器 | 前端为原生 JS，无打包步骤 |
| 端口 | 8787 | Web UI、REST API、OneBot 推送入口共用这一个端口 |

### 按功能可选的外部条件

| 功能 | 需要什么 | 不配会怎样 |
| --- | --- | --- |
| QQ 群消息 | napcat（或任意 OneBot v11 实现）开一个 HTTP 服务器通道，默认 `http://127.0.0.1:3000`，Token 可留空；群号填 `data/config.json` 的 `qq.groups` | 收件箱没有 QQ 批次；仍可用「粘贴解析」手动归纳 |
| LLM 归纳 | 任意 OpenAI 兼容 `/chat/completions` 接口，填 `llm.base_url / model / api_key` | 自动退化为内置规则引擎，能用但质量差一些 |
| 语雀活动文档 | 语雀只读 Token + 知识库路径（`yuque.namespace`），走 OpenAPI v2 | 退路：在知识库页面 F12 跑 `tools/yuque-sync-snippet.js`，用浏览器登录态取文档，不碰凭证 |
| helenote 截图导入 | Windows 10/11 自带 WinRT OCR（`tools/ocr.ps1`，以 `-ExecutionPolicy Bypass` 单次调用，不修改系统策略） | 非 Windows 无法 OCR；可改用粘贴解析 |

### 平台说明

- 服务端与前端跨平台（纯 Node + 浏览器）。
- 仅 Windows 的部分：`tools/ocr.ps1`（WinRT OCR）、`tools/*.bat`（启动与开机自启脚本）。
- 所有数据落在 `data/`（首次运行自动创建）：`app.db`（SQLite）、`config.json`、`inbox/` 截图、运行日志。该目录含个人数据与密钥，已被 `.gitignore` 排除，**请勿提交**。

### 启动

```bash
cp data/config.example.json data/config.json   # 换成自己的群号 / Key / Token
node server.js                                 # Windows 也可双击 tools/start-server.bat
# 浏览器打开 http://127.0.0.1:8787/（直接双击 web/index.html 只会得到没样式的空壳）
```

QQ 开机拉历史：给 `tools/qq-sync-boot.bat` 在 `shell:startup`（Win+R 输入即可打开）建一个快捷方式，无需管理员权限。
## 打开方式
“日历”点开特定日期可查看当天待办
“思训”阅读思训具体要求，按“同步语雀”拉取文档
“资料”可通过标签管理
“收件箱”QQ消息中你可以将大肥鱼整理后的群聊消息固定为待办，呈现在日历上，粘贴解析则可以手动加入待办
## 结语
本人QQ 3550869103 欢迎交流
欢迎社团成员提交 Issue、提出建议，或通过 Pull Request 贡献改进!
