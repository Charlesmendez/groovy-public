"use client";

import { useEffect } from "react";

export function AllowBodyScroll() {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "auto";

    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return null;
}
