# PASS Windows 单机版

单机版使用 Electron 封装现有 React 游戏。游戏规则、AI 与网页版共用源码，不需要账号、网络连接、Node.js 或 GitHub 配置。

## 玩家使用

下载 `PASS-0.1.0-Windows.exe` 后直接双击。Windows 首次运行若显示来源提示，选择“更多信息”后再选择“仍要运行”。按 `F1` 可查看内置文字教程。

## 开发与打包

```text
pnpm install
pnpm desktop:dist
```

生成文件位于 `release/`。

## 联机扩展边界

桌面界面与规则代码保持分离。`desktop/src/session-transport.ts` 定义了命令发送、状态快照订阅和关闭连接三个能力；当前可使用本地实现，未来可新增 WebSocket 实现，让服务器成为权威状态源，并在命令中加入玩家身份、房间号和状态版本，而无需重写桌面窗口与打包层。
