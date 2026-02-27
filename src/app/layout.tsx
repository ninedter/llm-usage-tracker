import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "LLM Usage Tracker",
  description:
    "Track your AI usage across Claude, OpenAI, and Google Gemini in one dashboard.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} min-h-screen bg-zinc-50 font-sans antialiased dark:bg-zinc-950`}
      >
        {/* Draggable titlebar region for Electron (traffic light space on macOS) */}
        <div className="titlebar-drag sticky top-0 z-50 h-8 w-full" />
        <div className="flex flex-1 flex-col" style={{ minHeight: "calc(100vh - 2rem)" }}>
          {children}
        </div>
      </body>
    </html>
  );
}
