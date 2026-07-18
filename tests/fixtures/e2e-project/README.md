# Confui E2E Fixture

## Configuration

| Field | Description | Default | Required |
| --- | --- | --- | --- |
| server.port | HTTP 服务对外监听的端口 | 8080 | yes |
| server.enabled | 是否启动内置 HTTP 服务 | true | no |
| logLevel | 控制终端输出的日志详细程度 | info | no |
| apiToken | 调用远程服务时使用的访问凭据 | - | yes |

## Environment Variables

- `DATABASE_URL`: 数据库连接地址，生产环境必须填写。
- `DEBUG`: 是否显示调试日志。
