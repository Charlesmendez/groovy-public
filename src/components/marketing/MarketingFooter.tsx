import Image from "next/image";

export function MarketingFooter() {
  return (
    <footer className="relative z-10 py-12 px-6 border-t border-white/5">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <Image
          src="/Groovy_no_bg.png"
          alt="Groovy"
          width={240}
          height={70}
          className="h-16 w-auto opacity-60"
          unoptimized
        />
        <p className="text-sm text-zinc-600">
          © {new Date().getFullYear()} Groovy. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
