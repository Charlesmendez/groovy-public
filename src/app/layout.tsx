import type { Metadata, Viewport } from "next";
import { Outfit, Orbitron, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-outfit",
});

const orbitron = Orbitron({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  variable: "--font-orbitron",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains",
});

const siteUrl = (() => {
  const fallback = "https://gogroovy.ai";
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL || fallback);
  } catch {
    return new URL(fallback);
  }
})();

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: "GROOVY | Command Center",
  description: "AI Agent Command Center - Get into your groove",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    title: "GROOVY | Command Center",
    description: "AI Agent Command Center - Get into your groove",
    url: "/",
    siteName: "Groovy",
  },
  twitter: {
    card: "summary_large_image",
    title: "GROOVY | Command Center",
    description: "AI Agent Command Center - Get into your groove",
  },
  icons: {
    icon: "/Sloth_no_bg2.png",
    apple: "/Sloth_no_bg2.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Groovy",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover", // Enables safe-area-inset on iOS
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${outfit.variable} ${orbitron.variable} ${jetbrainsMono.variable}`}>
      <body className="antialiased">
        <div className="noise-overlay" />
        {children}
        {/* Datagran Web Pixel - Analytics */}
        <Script
          src="https://www.datagran.io/pixel.js"
          data-site-id="55236bf6-9cdb-476f-9c47-df1dea438972"
          data-write-key="wpx_live_c57ec40067736af63d7f5a9fb6ca94d462279e0bf7b7d1a2"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
