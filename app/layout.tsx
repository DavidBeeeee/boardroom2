import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Boardroom | Colorado Mastermind Studio",
  description: "A private AI advisory team inside Colorado Mastermind Studio."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400..700;1,400..700&family=Nunito:ital,wght@0,300..900;1,300..900&family=Oswald:wght@400..700&family=Space+Mono:ital,wght@0,400;0,700;1,400;1,700&display=swap"
          rel="stylesheet"
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('sis_theme_v1')==='dark'||(!localStorage.getItem('sis_theme_v1')&&window.matchMedia('(prefers-color-scheme:dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}`
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
