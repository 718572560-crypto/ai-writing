# 本地开发、GitHub 版本管理与服务器部署

项目名称：**AI 写作**。私有仓库：[ai-writing](https://github.com/718572560-crypto/ai-writing)。本地源码目录：`C:\Users\Administrator\Documents\Codex\2026-10-31\https-qdaiyoushu-com-https-qdaiyoushu-com\outputs\youshu-studio`。

建议使用一个私有 GitHub 仓库和一台 Ubuntu/Debian 服务器。流程为：本地修改和测试，提交并推送 `main`，GitHub 检查通过后，在服务器更新。推送本身不会自动修改生产网站。

## 源码与数据的位置

- GitHub 保存源码、依赖锁定文件、Docker 配置和部署脚本。
- 本地测试的 `ai-config.json`、`.env*`、`data/`、数据库、私钥、运行日志和旧源码打包文件不会加入 Git。两个 `.env` 示例文件可以加入。
- 服务器的 `.env` 和 `.env.production` 由部署人员单独配置。不要把真实 API 密钥、管理员密码或支付证书提交到仓库。
- 服务器的账号、会员及订单数据库放在 `data/youshu.sqlite`；后台保存的 AI 配置放在 `data/ai-config.json`。整个 `data/` 挂载到容器，代码更新不会替换这个目录。
- 本地浏览器中的草稿不会因为上传源码而同步到服务器。需要迁移时，在旧站导出，再登录新站账号导入。

## 第一次上传 GitHub

先创建一个空的私有仓库，不要在 GitHub 自动添加 README。完成 GitHub 的本机认证后，在源码目录运行：

```powershell
git status --short
git add .
git diff --cached --stat
git commit -m "Initial Youshu Studio source"
git remote add origin https://github.com/718572560-crypto/ai-writing.git
git push -u origin main
```

如果 Git 提示缺少作者，请先设置你自己的 `user.name` 和 `user.email`。首次推送后，在仓库 Actions 页面检查 `Check and build` 的结果；它会检查语法、运行现有测试、检查部署脚本并构建 Docker 镜像。

## 服务器首次部署

服务器需要 Git、Docker Engine 和较新的 Docker Compose v2，支持 `up --wait --wait-timeout`。私有仓库建议使用仅对该仓库有读取权限的 SSH deploy key。不要把私钥放入项目目录，也不要将含访问令牌的 URL 写进 Git remote。

选一个专用目录，例如 `/opt/youshu-studio`。不要覆盖已有站点目录。将私有仓库克隆到该目录后：

```sh
git clone git@github.com:718572560-crypto/ai-writing.git /opt/youshu-studio
cd /opt/youshu-studio
cp .env.production.example .env.production
printf 'DOMAIN=%s\n' '你的真实域名' > .env
chmod 600 .env .env.production
```

编辑 `.env.production`，设置真实的 `PUBLIC_BASE_URL`、`ADMIN_EMAIL`、强管理员密码、模型地址及密钥；其余生产配置参见 `DEPLOYMENT.md`。后台保存过 AI 配置后，`data/ai-config.json` 的值优先于环境变量。

确认域名 DNS 指向目标服务器，且 80/443 端口可用。如果服务器已有 Nginx、Caddy 或其他网站，不要停止原服务；应先接入现有反向代理，再调整本项目的 Caddy 配置。当前 Compose 默认单独占用 80/443，不能直接与已有服务抢占端口。

```sh
mkdir -p data
chown 1000:1000 data
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 180
docker compose ps
```

用真实域名打开网站和 `/admin`，验证管理员登录、AI 写作以及会员账户。只有需要微信登录或微信支付时才配置相关商户信息。

## 后续在本地更新

在本地源码目录：

```powershell
npm run check
npm test
git status --short
git add .
git commit -m "Describe this version's changes"
git push origin main
```

确认 GitHub Actions 通过后，连接服务器并执行：

```sh
cd /opt/youshu-studio
bash scripts/deploy.sh
```

更新脚本只接受干净的 `main` 分支并拒绝分叉的提交历史。它会拉取 `origin/main`，在旧版本仍运行时创建数据库快照，快进更新源码、构建镜像，再替换应用容器并等待健康检查。Caddy 容器不在此更新步骤中。首次部署、反向代理配置变更和生产环境变量变更需要按上面的部署步骤单独处理。

应用容器重建期间会有短暂中断；当前方案是单机部署。数据库备份最多保留 14 份，仍需另行保存异机备份。更新记录写入 `data/deployments.log`。

## 更新失败与代码回退

先查看应用日志：

```sh
docker compose logs --tail=100 app
```

脚本会打印更新前的提交号。需要回到该版本时，在确认工作区干净后执行下列命令，将 `OLD_COMMIT` 替换为打印的实际提交号：

```sh
git switch --detach OLD_COMMIT
docker compose up -d --build --no-deps --wait --wait-timeout 180 app
```

这只回退代码，保留当前数据库。若新版本做了不兼容的数据库结构迁移，需要评估后单独恢复备份；直接恢复旧快照会丢失快照之后的新增数据，脚本不会自动执行此操作。

修复提交已推送并准备恢复 `main` 时：

```sh
git switch main
bash scripts/deploy.sh
```

如果 `main` 已是目标提交而当前容器仍是回退版本，则再执行 `docker compose up -d --build --no-deps --wait --wait-timeout 180 app`，明确重新部署当前源码。
