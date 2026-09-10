"use client";

import { createContext, useContext, type ReactNode } from "react";

const EmailCacheScopeContext = createContext<string | null>(null);

export function EmailCacheScopeProvider({
  scope,
  children,
}: {
  scope: string;
  children: ReactNode;
}) {
  return (
    <EmailCacheScopeContext.Provider value={scope}>
      {children}
    </EmailCacheScopeContext.Provider>
  );
}

export function useEmailCacheScope(): string {
  const scope = useContext(EmailCacheScopeContext);
  if (!scope) {
    throw new Error("Email cache scope is unavailable.");
  }
  return scope;
}
