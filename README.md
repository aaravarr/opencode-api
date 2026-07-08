# opencode-api

本项目是一个本地 OpenCode Go API 网关：客户端只连一个 OpenAI-compatible endpoint，服务在后面管理多个你自己的 OpenCode Go API key，并在额度不足、key 失效、限流或上游错误时自动切换账号。

官方 OpenCode Go endpoint：`https://opencode.ai/zen/go/v1`。

## 快速开始

```bash
cp config.example.json config.json
```

交互式添加账号。CLI 会自动生成 `go-1`、`go-2` 这样的账号 ID，label 可空；默认会打开你的真实浏览器，你手动登录 OpenCode、创建或复制 API key，然后粘贴回终端。

```bash
opencode-api account add
```

也可以直接粘贴 API key，不打开浏览器。key 会写入 `data/keys.json`，不会写进 `config.json`。

```bash
opencode-api account add --method key
```

查看账号：

```bash
opencode-api account list
```

启动/关闭后台 server：

```bash
opencode-api server start
opencode-api server status
opencode-api server stop
```

客户端配置：

- Base URL: `http://127.0.0.1:8080/v1`
- API key: `config.json` 里的 `server.api_tokens` 任意一个，示例是 `local-opencode-key`

测试：

```bash
curl http://127.0.0.1:8080/v1/models \
  -H 'Authorization: Bearer local-opencode-key'
```

## 常用命令

```bash
# 交互式添加账号，自动生成 id
opencode-api account add

# 指定 label
opencode-api account add --label your-email@gmail.com

# 直接 key 方式
opencode-api account add --method key

# 非交互传 key
opencode-api account add --method key --api-key '你的 key'

# 删除账号，同时删除本地 key store 里的 key
opencode-api account remove --id go-2

# 前台运行，方便看日志
opencode-api serve
```

## 配置说明

- `server.api_tokens`: 客户端访问本地网关用的 token，不是 OpenCode Go key。
- `server.admin_token`: 调管理接口用的 token。
- `server.key_store_path`: CLI 保存账号 API key 的位置，默认 `data/keys.json`。
- `server.pid_path`: 后台 server pid 文件，默认 `data/server.pid`。
- `server.log_path`: 后台 server 日志，默认 `data/server.log`。
- `accounts[].id`: 账号槽位 ID，比如 `go-1`；`account add` 会自动生成。
- `accounts[].priority`: 数字越大越优先。
- `accounts[].monthly_budget_cents`: 该账号可用预算，单位为美分。

服务启动时读取 key 的顺序是：`accounts[].api_key`、`accounts[].api_key_env`、`data/keys.json`。

## 管理接口

```bash
curl http://127.0.0.1:8080/admin/accounts \
  -H 'Authorization: Bearer change-me-admin-token'
```

手动修正某个账号的剩余额度估算：

```bash
curl -X POST http://127.0.0.1:8080/admin/accounts/go-1/remaining \
  -H 'Authorization: Bearer change-me-admin-token' \
  -H 'Content-Type: application/json' \
  -d '{"remaining_cents": 650}'
```

临时禁用/启用：

```bash
curl -X POST http://127.0.0.1:8080/admin/accounts/go-1/disable \
  -H 'Authorization: Bearer change-me-admin-token'

curl -X POST http://127.0.0.1:8080/admin/accounts/go-1/enable \
  -H 'Authorization: Bearer change-me-admin-token'
```

## 边界

- 只管理你自己有权使用的账号和 API key。
- Google 登录、验证码、2FA、风控确认由你本人在真实浏览器中完成。
- CLI 不保存 Google 密码，也不会绕过 Google 或 OpenCode 的安全检查。
- 如果官方没有公开“剩余额度 API”，服务会用响应里的 token usage 做本地估算，并结合上游的 `401`、`403`、`402`、`429`、`5xx` 自动切换。
