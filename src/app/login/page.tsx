"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { identifyUser, trackEvent } from "@/lib/datagran/pixel";
import { motion } from "framer-motion";
import { Eye, EyeOff } from "lucide-react";
import Image from "next/image";

function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Authentication failed";
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => {
    try {
      return getSupabaseBrowserClient();
    } catch {
      return null;
    }
  }, []);

  const [mode, setMode] = useState<"sign-in" | "sign-up" | "forgot-password">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const nextParam = searchParams.get("next");
  const nextPath =
    typeof nextParam === "string" &&
    nextParam.startsWith("/") &&
    !nextParam.startsWith("//") &&
    !nextParam.toLowerCase().startsWith("/\\")
      ? nextParam
      : null;

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) router.replace(nextPath || "/dashboard");
    });
  }, [router, supabase, nextPath]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      if (!supabase) throw new Error("Supabase not configured");
      
      if (mode === "forgot-password") {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/login`,
        });
        if (resetError) throw resetError;
        setSuccess("Check your email for a password reset link.");
        return;
      }
      
      if (mode === "sign-up") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
        });
        if (signUpError) throw signUpError;
        // Identify user to Datagran pixel
        if (data.user) {
          identifyUser(data.user.id, email);
          trackEvent("sign_up");
        }
      } else {
        const { data, error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw signInError;
        // Identify user to Datagran pixel
        if (data.user) {
          identifyUser(data.user.id, data.user.email || email);
          trackEvent("sign_in");
        }
      }
      router.replace(nextPath || "/dashboard");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  if (!supabase) {
    return (
      <div className="min-h-screen bg-grid flex items-center justify-center p-6">
        <div className="glass rounded-2xl border border-white/10 p-6 max-w-md w-full">
          <h1 className="text-lg font-semibold text-white mb-2">
            Supabase not configured
          </h1>
          <p className="text-sm text-zinc-400">
            Set <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
            <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in{" "}
            <code className="font-mono">.env.local</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-grid relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/10 via-transparent to-purple-500/10" />
      <div className="absolute -top-40 -left-40 w-80 h-80 bg-cyan-500/10 rounded-full blur-3xl" />
      <div className="absolute -bottom-40 -right-40 w-80 h-80 bg-purple-500/10 rounded-full blur-3xl" />

      <div className="relative z-10 flex items-center justify-center min-h-screen p-6">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md glass rounded-3xl border border-white/10 p-8"
        >
          <div className="flex items-center justify-center mb-8">
            <Image
              src="/Groovy_no_bg.png"
              alt="Groovy"
              width={400}
              height={120}
              className="h-32 w-auto"
              priority
            />
          </div>

          {mode === "forgot-password" ? (
            <>
              <div className="text-center mb-6">
                <h2 className="text-lg font-semibold text-white mb-1">Reset your password</h2>
                <p className="text-sm text-zinc-400">
                  Enter your email and we&apos;ll send you a reset link
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                    Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-500 outline-none focus:border-cyan-500/50 transition-colors"
                    placeholder="you@company.com"
                    required
                    autoComplete="email"
                  />
                </div>

                {error && (
                  <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                    {error}
                  </div>
                )}

                {success && (
                  <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
                    {success}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || !!success}
                  className="w-full px-4 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium hover:shadow-lg hover:shadow-cyan-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {loading ? "Sending..." : "Send reset link"}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMode("sign-in");
                    setError(null);
                    setSuccess(null);
                  }}
                  className="w-full text-sm text-zinc-400 hover:text-white transition-colors"
                >
                  Back to sign in
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-6">
                <button
                  type="button"
                  onClick={() => { setMode("sign-in"); setError(null); setSuccess(null); }}
                  className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                    mode === "sign-in"
                      ? "bg-white/10 text-white"
                      : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  onClick={() => { setMode("sign-up"); setError(null); setSuccess(null); }}
                  className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                    mode === "sign-up"
                      ? "bg-white/10 text-white"
                      : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  Sign up
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                    Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-500 outline-none focus:border-cyan-500/50 transition-colors"
                    placeholder="you@company.com"
                    required
                    autoComplete="email"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                      Password
                    </label>
                    {mode === "sign-in" && (
                      <button
                        type="button"
                        onClick={() => {
                          setMode("forgot-password");
                          setError(null);
                          setSuccess(null);
                        }}
                        className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full px-4 py-3 pr-12 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-500 outline-none focus:border-cyan-500/50 transition-colors"
                      placeholder="••••••••"
                      required
                      minLength={6}
                      autoComplete={
                        mode === "sign-up" ? "new-password" : "current-password"
                      }
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      {showPassword ? (
                        <EyeOff className="w-5 h-5" />
                      ) : (
                        <Eye className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                    {error}
                  </div>
                )}

                {success && (
                  <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
                    {success}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full px-4 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium hover:shadow-lg hover:shadow-cyan-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {loading
                    ? "Working..."
                    : mode === "sign-up"
                      ? "Create account"
                      : "Sign in"}
                </button>
              </form>
            </>
          )}

        </motion.div>
      </div>
    </div>
  );
}

