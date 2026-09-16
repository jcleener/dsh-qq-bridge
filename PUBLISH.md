# 发布到 GitHub（公开仓库）

仓库：<https://github.com/jcleener/dsh-qq-bridge>（已创建并完成首次推送）
目录：`D:\DSH\plugin\dsh-qq-bridge`（本文件所在目录）

## 以后更新（常规）

```powershell
cd D:\DSH\plugin\dsh-qq-bridge
git add -A
git commit -m "fix: …"
git push
```

## ⚠️ 本机特有：TLS 报错时加 `-c http.sslBackend=schannel`

本机外网走代理，git 默认的 OpenSSL 后端会失败：

```
fatal: unable to access '…': TLS connect error: error:0A000126:SSL routines::unexpected eof while reading
```

解决办法是换用 Windows 原生 TLS 后端（已在本仓库写死为本地配置）：

```powershell
git config http.sslBackend schannel        # 本仓库；想全局生效就用 --global
# 或临时：git -c http.sslBackend=schannel push
```

（同源现象：`git-remote-http.exe` 在轮询/抓取时会崩、GitNotify 会弹"检查失败"——都是这个代理 TLS 问题。）

## 首次发布流程（备查，已完成）

1. 网页 <https://github.com/new> 建**空**的 public 仓库 `dsh-qq-bridge`（不勾 README/gitignore/license）；
   也可用 GitHub API：`POST https://api.github.com/user/repos`（`{"name":"dsh-qq-bridge","private":false}`），
   凭据可直接从 git 凭据管理器取出（`git credential fill`，host=github.com）。
2. 本地：
   ```powershell
   git init -b main
   git add -A
   git commit -m "feat: QQ-DSH 单插件桥接 v0.7.9"
   git remote add origin https://github.com/jcleener/dsh-qq-bridge.git
   git -c http.sslBackend=schannel push -u origin main
   ```

## 安全检查（已做）

- 插件本体**不含**任何 AppID / AppSecret（`grep` 校验过）；
- `.gitignore` 已挡住运行期文件：`qq-bridge-state.json`（含 openid ↔ 会话映射）、`registry.json`、`_backup/`、`_share/`、`*.zip`；
- 首次提交 8 个文件：`.gitignore` `LICENSE` `PUBLISH.md` `README.md` `cordis.patch.yml` `lib/client.js` `lib/index.js` `package.json`。
