import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3000";
  const protocol = headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.png", base).toString();
  return {
    metadataBase: base,
    title: "PASS — 足球卡牌人机对战",
    description: "行动力、长传、扑救响应与落地球争夺：选择一名球员，与五名收益加权决策的 AI 对战。",
    openGraph: {
      title: "PASS — Tactical Football Card Game",
      description: "一名玩家与五名 AI：行动力卡牌、长传扑救、轨迹箭头与三球决胜。",
      images: [{ url: socialImage, width: 1731, height: 909, alt: "PASS 足球卡牌策略游戏" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "PASS — Tactical Football Card Game",
      description: "一名玩家与五名 AI：行动力卡牌、长传扑救、轨迹箭头与三球决胜。",
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
