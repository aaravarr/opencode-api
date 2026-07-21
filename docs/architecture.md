# 架构

## 身份与租户

本地用户分为 `ADMIN` 和 `USER`。所有 OpenCode 账号、统一 API Key、额度窗口、路由状态、请求与事件都带 `owner_user_id`。

统一 API Key完成两件事：

- 调用 `/v1/*` 时定位请求所属用户。
- 浏览器插件调用 `/api/plugin/accounts` 时定位账号应录入的 owner。

插件 payload 无 owner 字段，后端不接受客户端指定用户。`workspace_id` 全局唯一，不能被另一个用户重复绑定。管理员只读查看其他用户状态时不会改变自身路由 owner。

## 浏览器插件

插件是 MV3 扩展，权限限定为 storage、tabs、cookies，以及 `opencode.ai` / `auth.opencode.ai`。任意后端域名通过 optional host permission 由用户保存配置时授权。

流程：

1. 打开 `opencode.ai/auth/authorize?continue=/auth`。
2. `auth.opencode.ai` 的 provider 选择页出现时自动点击 Google。
3. 用户完成 Google 身份验证与 OpenCode 授权。
4. 标签页进入 `/workspace/{workspaceId}` 时读取 `auth` Cookie。
5. 使用用户配置的统一 API Key调用 `/api/plugin/accounts`。

Cookie 只存在于消息处理的局部变量和后端请求体，不进入 popup view model、调试输出或 extension session storage。

## OpenCode Web 协议

后端固定只访问 `https://opencode.ai`：

- `GET /workspace/{id}/go`：通过订阅文案或 `liteSubscriptionID` 自动确认 Go 订阅，并解析 Use balance、三档使用百分比和恢复时间。
- `GET /workspace/{id}/keys`：解析当前用户可见的完整 Go Key。
- `POST /_server?id={action}`：创建固定名称 `OpenCode to API` 的 Key。

创建 Action ID不是稳定 API。客户端从当前 `entry-client` route manifest 找到 Keys chunk，再按逻辑名 `key.create` 解析相邻 `createServerReference`。Action 必须返回 302、有效 flash、`error=false` 且 result 无 error 才算成功。创建前后按 Key ID做集合差分，避免同名和并发歧义。

## 凭据存储

账号包含：

- `workspace_id`
- 加密 `auth_cookie_ciphertext`
- 加密 `go_api_key_ciphertext`
- `go_key_id`
- 插件版本与最近同步时间
- 订阅、Use balance、认证与三档额度快照

`authCookie` 只用于 Console 页面与 Key 管理；`goApiKey` 只用于模型请求。加密由数据目录中的随机 `master.key` 提供 AES-256-GCM 密钥。

## 路由

同步选择条件：

```text
owner 匹配
AND admin_state = ENABLED
AND auth_state = VALID
AND subscription_state = ACTIVE
AND billing_guard = VERIFIED_GO_ONLY
AND use_balance = false
AND 所有额度 usage_percent < 100 或已过 reset_at
AND 未超过 max_concurrency
```

候选优先级：preferred → current → ordinal 循环。上游请求期间不持有 SQLite 事务，route lease 负责并发占用和崩溃后超时释放。

只有 HTTP/SSE 中精确的 `GoUsageLimitError` 会执行：记录 100% 窗口 → 清除 current → 同一外部请求选择下一个账号。其他上游响应和网络异常不会切号。

## 额度与自动恢复

Dashboard 额度写入 `quota_windows`：

- `FIVE_HOUR`
- `WEEKLY`
- `MONTHLY`
- `usage_percent`
- `reset_at`
- `source = DASHBOARD | UPSTREAM_429`

达到 100% 且 reset 未到的账号被排除；reset 到期后可以重新参与真实请求。真实请求仍返回额度错误时会更新窗口并继续切换。

后台维护只检查最近 10 分钟实际承载过请求的账号。新账号录入时已完成一次检查；长期闲置账号不会因为仍是 current/preferred 而持续请求 Console。

## 数据模型切换

本版本不兼容旧 CLI OAuth 账号数据。启动时如果检测到旧 `accounts` 结构，会删除账号域表及其依赖状态，保留本地用户、统一 API Key和系统设置，然后创建新结构。
