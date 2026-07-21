# 安全边界

## 敏感数据

禁止记录或返回：

- OpenCode `auth` Cookie
- 完整 Go `sk-...` Key
- 统一入口 `ocg_...` Key
- 本地登录 Session
- `master.key`、API Key Pepper、Cron Secret

账号 Cookie 和 Go Key使用 `master.key` 进行 AES-256-GCM 加密。统一入口 Key只保存带 Pepper 的哈希。插件 popup、运行状态和后端 API响应均不得包含 Cookie 或完整 Go Key。

## 插件权限

插件的 `cookies` 权限可以读取用户的 OpenCode Console 会话，因此：

- 只从本项目源码加载或由可信渠道分发。
- 固定读取 `https://opencode.ai` 下名为 `auth` 的 Cookie。
- 后端域名由用户明确配置并授予 optional host permission。
- API Key保存在 `chrome.storage.local`，不使用同步存储。
- 不在控制台输出配置、Cookie、请求 body 或后端响应秘密。

## 插件上报 API

`POST /api/plugin/accounts` 必须使用有效且未过期的统一 API Key。后端从 Key记录得到 owner；payload 只能包含 Cookie、workspaceId、插件版本和可选显示名。

workspaceId 必须匹配 `wrk_[A-Za-z0-9]+`，Cookie 和 body 长度受限。跨 owner 重复绑定同一 workspace 必须返回冲突，不允许覆盖原账号。

## 上游限制

Console 客户端只允许访问 `https://opencode.ai` 的固定页面和构建资源；不接受账号记录或用户输入提供的任意 URL。模型上游设置只允许官方 HTTPS `opencode.ai` 域名及子域，禁止用户名、密码、端口、查询和 fragment。

SolidStart Action ID必须动态发现并严格验证。未知构建、找不到 Action、非 302、缺少 flash 或 flash 业务错误都应关闭操作，不能回退到猜测成功。

## 路由安全

只有明确解析到活动 Go 订阅且 `useBalance=false` 的账号可参与路由。字段缺失为未知并禁止路由，不能从“能看到额度”推断按量回退已关闭。

只有 `GoUsageLimitError` 可以切号。认证、参数、模型、网络和其他上游错误直接返回，避免把业务错误误判成余额耗尽并造成请求风暴。

## 数据目录

数据库与 `master.key` 必须一起备份。只恢复数据库而缺失原主密钥时，服务应拒绝生成新密钥覆盖；否则历史 Cookie 和 Go Key将永久无法解密。

管理员能只读查看其他用户的账号状态，但账号明文凭据永不进入管理 API。管理员的统一 API请求仍只使用管理员自己 owner 下的账号。

发现数据目录、浏览器插件、管理员 Session 或统一 API Key泄露时，应立即：停用相关 Key、在 OpenCode Console 删除对应 Go Key、退出 OpenCode 会话、轮换本地秘密并审计请求记录。
