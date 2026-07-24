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
    icons: [
      {
        src: "/Sloth_no_bg2.png",
        sizes: "563x443",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
