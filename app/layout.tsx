import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Sophy",
  description: "Sophy — central AI gateway proxy: own API keys, UI-driven routing, prompts, quota.",
};

// Render every page/route next to the database (Supabase ap-south-1 / Mumbai),
// the same region the /v1 proxy routes pin. Cross-region DB round-trips were the
// dominant cost of admin page loads (each page makes several queries). Inherited
// by all routes; individual routes may still override.
export const preferredRegion = "bom1";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
