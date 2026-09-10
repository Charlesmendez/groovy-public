import type { Metadata, Viewport } from "next";
import { Outfit, Orbitron, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import "katex/dist/katex.min.css";
import { ChatNotificationBridge } from "@/components/notifications/ChatNotificationBridge";
import { ServiceWorkerBridge } from "@/components/notifications/ServiceWorkerBridge";
import { EmailFocusNotificationBridge } from "@/components/notifications/EmailFocusNotificationBridge";
import { DesktopUiUpdateBanner } from "@/components/desktop/DesktopUiUpdateBanner";
import { EmailBackgroundSyncBridge } from "@/components/email/EmailBackgroundSyncBridge";
import { EmailSendBridge } from "@/components/email/EmailSendBridge";
import { GlobalVoiceAssistant } from "@/components/voice/GlobalVoiceAssistant";
import { getAppUrl, getBrandName } from "@/lib/config/appConfig";

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
  try {
    return new URL(getAppUrl());
  } catch {
    return new URL("http://localhost:3000");
  }
})();
const brandName = getBrandName();

export const metadata: Metadata = {
  metadataBase: siteUrl,
  manifest: "/manifest.webmanifest",
  title: `${brandName} | Coding, chat, and email`,
  description: "An all-in-one AI harness for coding, chat, and email.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    title: `${brandName} | Coding, chat, and email`,
    description: "An all-in-one AI harness for coding, chat, and email.",
    url: "/",
    siteName: brandName,
  },
  twitter: {
    card: "summary_large_image",
    title: `${brandName} | Coding, chat, and email`,
    description: "An all-in-one AI harness for coding, chat, and email.",
  },
  icons: {
    icon: "/icon-192.png",
    apple: "/icon-192.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: brandName,
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
        <GlobalVoiceAssistant>
          <div className="noise-overlay" />
          {children}
          <ServiceWorkerBridge />
          <EmailSendBridge />
          <EmailBackgroundSyncBridge />
          <ChatNotificationBridge />
          <EmailFocusNotificationBridge />
          <DesktopUiUpdateBanner />
          {/* Datagran Web Pixel - Analytics */}
          <Script
            src="https://www.datagran.io/pixel.js"
            data-site-id="55236bf6-9cdb-476f-9c47-df1dea438972"
            data-write-key="wpx_live_c57ec40067736af63d7f5a9fb6ca94d462279e0bf7b7d1a2"
            strategy="afterInteractive"
          />
        </GlobalVoiceAssistant>
      </body>
    </html>
  );
}
