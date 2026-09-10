"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

export function CommunicationLoginRedirect() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const nextPath = `${pathname}${window.location.search}`;
    router.replace(`/login?next=${encodeURIComponent(nextPath)}`);
  }, [pathname, router]);

  return null;
}
