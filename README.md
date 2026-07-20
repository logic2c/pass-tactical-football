# PASS 网页原型

这是足球卡牌策略游戏 **PASS** 的第一版可玩网页原型。

- 一名测试者控制红蓝两队共 6 名球员。
- 8×8 棋盘，e1 与 e8 为单格球门。
- 60 张行动牌，Rock、Bishop、Knight 各 20 张。
- 已实现布阵、移动、抽牌、抢断、Pass 响应、路线拦截、攻防转换、越位、手牌上限与三球胜负。

规则原稿与后续确认内容保存在上一级目录的 `Pass.md`。

## 本地运行

需要 Node.js 22.13 或更高版本以及 pnpm。

```text
pnpm install
pnpm dev
```

## 验证

```text
pnpm test
```
