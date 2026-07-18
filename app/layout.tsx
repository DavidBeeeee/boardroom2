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
        <script dangerouslySetInnerHTML={{ __html: `try{if(localStorage.getItem('sis_theme_v1')==='dark'){document.documentElement.classList.add('dark')}}catch(e){}` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
