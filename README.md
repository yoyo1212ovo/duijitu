# 物流运费堆积图分析平台

物流运费分析、堆积图、单量汇总工具。

## 本地运行

```bash
npm install
npm start
```

访问 http://localhost:4567

## 环境变量

- `PORT` - 服务端口（默认 4567）
- `DATA_DIR` - 数据存储目录（默认 ./web/data）
- `UPLOADS_DIR` - 上传文件目录（默认 ./web/uploads）
- `JWT_SECRET` - JWT 密钥

## 部署

本项目支持 Railway / Render 部署。需要配置持久化磁盘（Volume），并将 `DATA_DIR` 和 `UPLOADS_DIR` 指向该磁盘。
