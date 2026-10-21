# 账号与云存档 API

Python 3.10+ WSGI，SQLite 与密码哈希使用标准库；唯一直接部署依赖固定为 `gunicorn==26.2.0`。不需要邮箱、第三方账号或支付服务。

启动示例（在项目根目录，数据路径必须位于静态 web 根之外）：

```sh
python3 -m venv /absolute/path/to/api-venv
/absolute/path/to/api-venv/bin/pip install -r api/requirements.txt
FKSSJ_DATA_DIR=/absolute/path/outside-web-root/fkssj-data \
FKSSJ_PUBLIC_ORIGIN=https://fkssj.harvey-ai.xyz \
FKSSJ_TRUSTED_PROXIES=127.0.0.1,::1 \
  /absolute/path/to/api-venv/bin/gunicorn --bind 127.0.0.1:4180 --workers 2 \
  --worker-class sync --timeout 30 'api.app:create_app()'
```

应用创建 `FKSSJ_DATA_DIR/fkssj.sqlite3`，目录权限0700、数据库0600，启用WAL、外键与5秒busy timeout。可通过 `FKSSJ_WEB_ROOT` 显式指定静态根；未指定时按当前工程根判断。数据库格式版本高于已知版本时拒绝启动，不清空数据。部署文件、SQLite、WAL、SHM和备份均不可进入静态发布清单。

反向代理保留完整 `/api/` 路径，转发到上述回环地址；覆盖 `X-Real-IP` 为实际访客地址，并限制请求体在1 MiB左右。只有请求的直接对端属于显式 `FKSSJ_TRUSTED_PROXIES` 时才采用 `X-Real-IP`，默认不信任代理头。HTTPS生产使用精确Origin；本地可显式配置 `http://localhost:4174` 等源。跨源访问不提供CORS。只监听回环地址，WSGI不直接承担公网TLS。

所有响应为JSON，设置 `Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`。主要接口：

| 请求 | 返回/要求 |
|---|---|
| GET `/api/health` | `{ok:true}` |
| GET `/api/auth/me` | `{user:null}` 或 `{user:{id,username},csrfToken}` |
| POST `/api/auth/register` | JSON `{username,password}`，成功200 `{user,csrfToken}` |
| POST `/api/auth/login` | 同上；错误账号与错误密码统一401文案 |
| POST `/api/auth/logout` | `{ok:true}`，匿名调用幂等；无需请求体 |
| GET `/api/save` | `{revision:0,save:null,updatedAt:null}` 或实际记录 |
| PUT `/api/save` | JSON `{expectedRevision,save}`，成功 `{revision,updatedAt}` |

用户名是3–24个ASCII字母、数字或下划线，统一转小写。密码是8–128个字符，保留前后空格，不做trim或Unicode归一化。注册与登录均设置30天 `__Host-fkssj_session`，具有 `HttpOnly; Secure; SameSite=Lax; Path=/`；每次成功登录生成新token并撤销当前cookie对应的旧会话。数据库仅保留256位随机session的SHA256，不保存原token；CSRF token通过该随机会话派生。浏览器HTTP本地环境若不接受Secure cookie，应使用本地HTTPS，不降低生产cookie属性。

所有写请求要求 `Origin` 精确匹配。注册、登录和PUT要求 `application/json`。已登录注销与PUT同时要求 `X-CSRF-Token`；PUT还要求 `X-FKSSJ-User: String(user.id)` 与该事务内查到的session账号一致。客户端body内的owner/userId不决定归属。匿名云存档接口返回401；错误来源/CSRF/owner分别为403 `origin_invalid`、`csrf_invalid`、`user_mismatch`。

云存档整次HTTP JSON请求体上限1,048,576字节。校验外层version1和基本对象/数组形状，全树数值有限，最多64层与100,000节点；不归一化游戏内部版本，不改变已付生产/施工快照，不改 `save.savedAt`。`revision` 从1单调递增，服务器独立提供毫秒Unix整数 `updatedAt`，无档时为null。账号验证、CSRF、owner核对与CAS更新位于同一 `BEGIN IMMEDIATE` 事务。冲突返回409 `{code:'save_conflict',message,revision,updatedAt}`，不覆盖数据。每账号最近10个被替换快照保存在内部 `save_history`，没有对外读取/恢复接口。

登录每IP默认30次/10分钟、每账号10次/15分钟；注册每IP和每用户名各5次/小时，均含成功请求。限流状态保存在SQLite，不因WSGI worker重启而消失；429附 `Retry-After`。SQLite租约把跨worker正在计算的密码哈希限制为2个，失败/结束释放，崩溃租约120秒到期。拒绝原因不返回SQL、密码、文件路径或traceback。

密码使用随机32字节salt和 `hashlib.scrypt(n=32768,r=8,p=3,maxmem=64MiB,dklen=32)`。该成本组是[OWASP列出的scrypt最低防护组合之一](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)；64MiB为[Python/OpenSSL执行内存上限](https://docs.python.org/3.13/library/hashlib.html#hashlib.scrypt)，并非哈希实际固定用量。未知用户执行相同成本的dummy scrypt。固定Gunicorn版本及Python要求核对自[26.2.0官方PyPI元数据](https://pypi.org/project/gunicorn/26.2.0/)和[对应源码tag](https://github.com/benoitc/gunicorn/blob/26.2.0/pyproject.toml)。

执行领域/WSGI测试：

```sh
python3 -m unittest api.test_api api.test_boundaries -v
```

测试使用临时web根外数据库；不连接生产服务器、不发送邮件、不修改游戏存档夹具。真实部署、反向代理与真实设备验收由部署流程另行完成。
