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

## 发布成公开网站

这个项目有 Node.js 后端、登录、上传和 JSON 文件存储，因此不能只放到 GitHub Pages（GitHub Pages 只能托管静态网页）。正确做法是：先放到 GitHub 仓库，再连接到 Railway 或 Render 运行 Node.js 服务。

### 1. 创建 GitHub 仓库

打开 https://github.com/new ，新建一个仓库，例如名字填 `duijitu`。创建完成后，把仓库地址填到下面命令里：

```powershell
git remote add origin https://github.com/你的用户名/duijitu.git
git branch -M main
git push -u origin main
```

### 2. 推荐用 Railway 部署

1. 打开 https://railway.app ，用 GitHub 登录。
2. 点击 `New Project`，选择 `Deploy from GitHub repo`，选择 `duijitu`。
3. 项目会自动读取 `railway.json` 并执行 `npm start`。
4. 给项目添加一个 Volume，挂载路径填 `/data`，用来保存上传文件和用户数据。
5. 添加环境变量：
   - `DATA_DIR=/data`
   - `UPLOADS_DIR=/data/uploads`
   - `JWT_SECRET=一串随机长密码`
6. 部署完成后，Railway 会生成一个公开网址，例如 `https://xxx.up.railway.app`。

### 3. 也可以用 Render

Render 已经带有 `render.yaml` 配置。打开 https://render.com ，用 GitHub 登录后创建 Blueprint，选择 `duijitu` 仓库即可。需要在服务里添加一个持久化磁盘，挂载路径为 `/data`。

### 4. 注意事项

- 免费计划通常没有永久磁盘，重新部署可能会清空上传数据。要长期保存几十万单的数据，建议使用 Railway Volume 或 Render 的持久化磁盘。
- 如果别人无法访问，检查部署平台是否返回 `502 Bad Gateway`，通常需要看 Railway/Render 的启动日志，确认服务端口使用 `PORT` 环境变量且没有启动报错。