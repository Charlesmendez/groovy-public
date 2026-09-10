import type { MetadataRoute } from "next";
import { getBrandName } from "@/lib/config/appConfig";

export default function manifest(): MetadataRoute.Manifest {
  const brandName = getBrandName();
  return {
    id: "/",
    name: `${brandName} Workspace`,
    short_name: brandName,
    description: "Collaborate with your team, Minds, and agents.",
    start_url: "/chat",
    scope: "/",
    display: "standalone",
    background_color: "#08090b",
    theme_color: "#08090b",
    orientation: "any",
    categories: ["productivity", "business", "social"],
    shortcuts: [
      {
        name: "Open Team Chat",
        short_name: "Chat",
        description: "Return to your Groovy conversations.",
        url: "/chat",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
      {
        name: "Search messages",
        short_name: "Search",
        description: "Find a message across your workspace.",
        url: "/chat?search=1",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
    ],
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
