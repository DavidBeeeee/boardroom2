import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Boardroom MVP",
  description: "Private hosted AI Boardroom with documents, advisors, Decision Briefs, and Advisor Work Cards."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
