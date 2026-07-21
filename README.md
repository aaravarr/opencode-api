# OpenCode to API

面向 OpenCode Go 订阅账号的多用户统一网关。每个用户通过浏览器插件连接自己的 `opencode.ai` Console 会话，后端自动复用或创建专用 Go API Key，并只在该用户自己的账号池中智能路由。

## 能力

- 首次启动初始化管理员；支持 `ADMIN` / `USER` 两种角色
- 用户、账号、统一 API Key、路由状态、额度、请求和事件严格隔离
- Chrome / Edge MV3 插件，仅支持 Google 登录
- 自动读取 `auth` Console Cookie 与 `workspaceId`，不收集 Google 密码
- 自动维护名称为 `OpenCode to API` 的 Go API Key
- 从 Go Console SSR 页面读取 5 小时、周、月使用百分比和恢复时间
- 通过订阅文案或 `liteSubscriptionID` 自动识别 Go 订阅，并读取 `Use balance`；不需要用户手工确认
- Go 额度耗尽时在内部切换账号；其他上游错误直接返回
- 支持用户设置优先账号，额度不足时继续自动轮询
- 只刷新当前、优先或最近使用的账号，避免高频检查闲置账号
- Console 会话失效后标记为需要重新登录，插件重新登录即可覆盖更新

## 凭据模型

系统保存两类彼此独立的凭据：

1. `authCookie`：仅用于访问 `opencode.ai/workspace/{id}/go`、Keys 页面和创建 Go Key。
2. Go API Key：仅用于 `https://opencode.ai/zen/go/v1/*` 模型请求。

两者均使用本机随机生成的主密钥进行 AES-256-GCM 加密。数据库不会保存 Google token、CLI OAuth token 或 refresh token。

## 启动

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:3000`。首次启动会进入管理员初始化页面，密码最少 6 位。

生产构建：

```bash
npm run build
npm start
```

也可以使用 Docker：

```bash
docker build -t opencode-to-api .
docker run --rm -p 3000:3000 -v opencode-data:/data opencode-to-api
```

默认情况下无需编辑 `.env`。系统设置与随机安全密钥会在首次启动时保存到数据目录；只有需要改变持久化目录时才设置：

```env
DATA_DIR=/data
```

## 连接 OpenCode Go 账号

### 1. 创建当前用户的统一 API Key

登录管理页面，进入“API 密钥”，创建一个 Key。这个 Key既用于调用统一模型入口，也用于验证浏览器插件上报的账号归属。

### 2. 安装浏览器插件

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 开启开发者模式。
3. 点击“加载已解压的扩展程序”。
4. 选择项目中的 `browser-extension` 目录。
5. 在插件中配置后端地址和第一步创建的 API Key。

### 3. Google 登录

点击插件的“使用 Google 登录”。插件会：

1. 打开 `opencode.ai/auth/authorize`。
2. 在 `auth.opencode.ai` 自动选择 Google。
3. 等待用户完成 Google 登录和 OpenCode 授权确认。
4. 进入 workspace 后读取 `auth` Cookie 与 `workspaceId`。
5. 自动调用 `POST /api/plugin/accounts` 上报。

后端随后读取订阅、额度与 Keys 页面。Go 订阅由 “You are subscribed to OpenCode Go” 文案或非空 `liteSubscriptionID` 自动确认。如果当前用户已经有名为 `OpenCode to API` 的 Key则直接复用，否则动态发现当前 SolidStart `key.create` Action并创建，再按创建前后 Key ID 差分取得新 Key。

## 统一模型入口

Base URL：

```text
http://127.0.0.1:3000/v1
```

支持：

```text
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
POST /v1/messages
```

调用示例：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer ocg_your_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-4-5","messages":[{"role":"user","content":"hello"}]}'
```

对上游调用时，`messages` 使用 `x-api-key`，其余 Go 接口使用 Bearer；不会发送 `x-org-id`。

## 路由规则

账号必须同时满足以下条件才会进入候选池：

- 管理状态为启用
- Console 会话有效
- Go 订阅存在
- `Use balance` 明确为 `false`
- 5 小时、周、月窗口均未达到 100%
- 未超过账号并发上限

优先级为：用户指定的优先账号 → 当前账号 → 后续可用账号。只有精确识别到 `GoUsageLimitError` 时才会在同一个外部请求内切换账号；其他 HTTP、模型、参数和网络错误不会触发切号。

## 额度维护

额度来自：

```text
GET https://opencode.ai/workspace/{workspaceId}/go
Cookie: auth=...
```

系统解析 SolidStart SSR hydration 或 `data-slot` 回退格式，保存 `usagePercent` 与 `resetAt`。维护任务只选择：

- 当前路由账号
- 用户指定的优先账号
- 最近 10 分钟实际使用的账号

无订阅或不安全账号延迟检查；Cookie 失效后停止检查，直到插件重新连接。

## 系统配置

管理员可在设置页面修改：

- Go 上游地址
- 上游请求超时
- 额度维护开关与执行间隔
- 每批检查数量和并发数
- API Key Pepper 与定时任务密钥轮换

主加密密钥、API Key Pepper 和 Cron Secret 首次启动自动随机生成，不需要放进 `.env`。

## 验证

```bash
npm run lint
npm test
npm run build
cd browser-extension && npm run check
```

浏览器真实登录和线上 Key 创建不会包含在自动测试中，需要由部署者自行验证。

## 安全说明

- `data/master.key` 与数据库必须一起备份；丢失主密钥后无法解密 Console Cookie 和 Go Key。
- 浏览器插件拥有 `cookies` 权限，只应从本项目源码加载或由可信渠道分发。
- 插件不会在 UI、storage session 或日志中展示 `authCookie`；仅将它发送到用户配置的后端。
- `POST /api/plugin/accounts` 必须使用有效的用户统一 API Key，payload 不能指定 owner。
- 管理员可以只读查看所有用户的账号状态，但管理员自己的请求绝不会路由其他用户账号。
- SolidStart Action hash 可能随 OpenCode 发布变化，后端会从当前前端资源动态发现，发现失败时关闭操作而不是猜测成功。

更详细的边界见 [SECURITY.md](SECURITY.md) 与 [docs/architecture.md](docs/architecture.md)。
