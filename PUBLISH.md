# 发布到 GitHub（公开仓库）

目录：`D:\DSH\plugin\dsh-qq-bridge`（本文件所在目录）
前置：本机已装 git（`C:\Program Files\Git\cmd\git.exe`）；**未装 `gh` CLI**，所以仓库在网页上建。

## 第 1 步：网页建空仓库

打开 <https://github.com/new>：

- **Repository name**：`dsh-qq-bridge`
- **Visibility**：**Public**
- **不要**勾选 "Add a README file" / .gitignore / license（本地已有，避免冲突）
- 点 **Create repository**

## 第 2 步：本地初始化并提交（PowerShell）

```powershell
cd D:\DSH\plugin\dsh-qq-bridge

git init -b main
git add -A
git config user.name  "jcleener"          # 若全局已配可跳过
git config user.email "你的邮箱"           # 若全局已配可跳过
git commit -m "feat: QQ ↔ DSH 单插件桥接 v0.7.9

- QQ 机器人 C2C 私聊 ↔ DSH 会话（单插件，无网关）
- 指令：/help /会话 /new /状态 /approve /deny /stop /跳过
- 原生排队与插话（DSH prompt mode: queue | steer）
- 审批与问答桥接到 QQ（可多题、多选、多行作答）
- 设置页分区：凭证、启停、插话方式、精简回复模式
- 版本：0.7.9"

git remote add origin https://github.com/jcleener/dsh-qq-bridge.git
git push -u origin main
```

## 第 3 步：核对

- 打开 <https://github.com/jcleener/dsh-qq-bridge> 应能看到 `lib/`、`README.md`、`LICENSE`、`cordis.patch.yml`、`package.json`、`.gitignore`；
- **不该出现**：`qq-bridge-state.json`、`_backup/`、任何 AppSecret/AppID（`.gitignore` 已挡住状态文件；插件本体经检查不含凭证）。

## 以后更新

```powershell
cd D:\DSH\plugin\dsh-qq-bridge
git add -A
git commit -m "fix: …"
git push
```
