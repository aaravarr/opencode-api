# OpenCode Go Connector

Chrome / Edge Manifest V3 插件，用于把用户自己的 OpenCode Go 账号连接到 OpenCode to API。

## 安装

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”，指向本目录。
4. 打开插件，填写后端地址和该用户在管理页面生成的统一 API Key。
5. 点击“使用 Google 登录”。插件会打开居中的固定尺寸登录窗口；完成 Google 登录和 OpenCode 授权后，会在进入 workspace 时自动上报账号。

登录阶段窗口固定为 `520 × 720`。Chrome 扩展 API 不支持强制“始终置顶”，切换到其他应用后仍可能被遮挡。

插件只读取 `opencode.ai` 域下名为 `auth` 的 Cookie，并只将它发送到用户配置的后端 `/api/plugin/accounts`。Cookie 不会显示在界面或写入日志。

## 验证

```bash
npm run check
```
