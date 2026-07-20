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
    title: "PASS — 足球卡牌策略原型",
    description: "在 8×8 球场上，用 Rock、Bishop 与 Knight 行动牌完成移动、抢断和传球。",
    openGraph: {
      title: "PASS — Tactical Football Card Game",
      description: "六人本地规则测试版：布阵、暗牌、拦截与三球决胜。",
      images: [{ url: socialImage, width: 1731, height: 909, alt: "PASS 足球卡牌策略游戏" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "PASS — Tactical Football Card Game",
      description: "六人本地规则测试版：布阵、暗牌、拦截与三球决胜。",
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
