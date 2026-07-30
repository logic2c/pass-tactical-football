# PASS Windows 单机版

单机版使用 Electron 封装现有游戏。游戏规则和 AI 与网页版共用源码。构建完成的可运行文件不需要账号、网络连接、Node.js 或 GitHub 配置。

## 玩家使用

收到 `PASS-0.1.0-Windows.exe` 后直接双击。Windows 首次运行若显示来源提示，选择“更多信息”后再选择“仍要运行”。按 `F1` 可查看内置文字教程。

## Windows 构建与打包

构建电脑需要 Windows 10/11、Git、Node.js 22.13 或更高版本以及 pnpm。进入项目文件夹后运行：

```text
corepack enable
corepack prepare pnpm@latest --activate
pnpm install
pnpm desktop:dist
```

生成文件位于 `release/`。该目录不会提交到 GitHub；需要将生成的 `.exe` 单独发送给测试玩家。
