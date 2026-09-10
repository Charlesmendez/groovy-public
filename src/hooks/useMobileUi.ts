"use client";

import { useEffect, useState } from "react";

const MOBILE_VIEWPORT_QUERY = "(max-width: 767px)";
const COARSE_POINTER_QUERY = "(hover: none) and (pointer: coarse)";

export function useMobileUi() {
  const [mobileUi, setMobileUi] = useState(false);

  useEffect(() => {
    const viewport = window.matchMedia(MOBILE_VIEWPORT_QUERY);
    const pointer = window.matchMedia(COARSE_POINTER_QUERY);
    const sync = () => setMobileUi(viewport.matches || pointer.matches);

    sync();
    viewport.addEventListener("change", sync);
    pointer.addEventListener("change", sync);
    return () => {
      viewport.removeEventListener("change", sync);
      pointer.removeEventListener("change", sync);
    };
  }, []);

  return mobileUi;
}
