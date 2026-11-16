import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, Inter } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const barlowCondensed = Barlow_Condensed({
  variable: "--font-barlow-condensed",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "PESRIVALS",
  description: "Track your eFootball rivalries, match by match.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${barlowCondensed.variable} dark h-full antialiased`}
    >
      <body className="flex min-h-dvh flex-col">
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 pt-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] sm:px-6 lg:px-8">
          {children}
        </div>
        <Toaster />
      </body>
    </html>
  );
}
