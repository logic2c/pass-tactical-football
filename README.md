# PASS

PASS 是一款在 8×10 棋盘上进行的足球卡牌策略游戏，当前提供网页联机测试版和 Windows 单机人机版。

## 网页联机版

[点击进入 PASS 网页联机版](https://89-125-103-199.sslip.io/)

打开网页后输入昵称，创建或加入房间即可开始游戏。使用网页版不需要安装游戏、配置服务器或下载本仓库。

## Windows 单机版

Windows 单机版由玩家控制一整支球队，对方球队由 AI 控制。构建完成后的 `.exe` 可以直接发给朋友，对方无需安装 Node.js、pnpm 或配置 GitHub。

### 构建环境

- Windows 10 或 Windows 11（64 位）
- Git
- Node.js 22.13 或更高版本
- pnpm

当前 GitHub Releases 尚未提供预先打包的安装文件，需要先在 Windows 电脑上自行构建一次。

### 下载并配置项目

在 PowerShell 中进入准备存放游戏的磁盘和文件夹，然后执行：

```powershell
git clone https://github.com/logic2c/pass-tactical-football.git
Set-Location pass-tactical-football
corepack enable
corepack prepare pnpm@latest --activate
pnpm install
```

如果项目已经下载，只需进入项目文件夹并执行 `pnpm install`。

### 生成 Windows 单机版

```powershell
pnpm desktop:dist
```

完成后，可运行文件位于项目的 `release` 文件夹中，文件名类似：

```text
PASS-0.1.0-Windows.exe
```

双击即可启动。首次运行时，如果 Windows 显示来源保护提示，选择“更多信息”，再选择“仍要运行”。游戏中按 `F1` 可以打开内置文字教程。

### 更新后重新构建

```powershell
git pull
pnpm install
pnpm desktop:dist
```

新的可运行文件仍会生成在 `release` 文件夹中。

更详细的桌面版说明见 [DESKTOP.md](./DESKTOP.md)。
