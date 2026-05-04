"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { useConnectorInstallGuide } from "@/lib/connector/installGuide";
import { getConnectorInstallGuide } from "@/lib/connector/catalog";
import {
  ArrowRight,
  CreditCard,
  Download,
  Globe,
  Github,
  Users,
  Workflow,
  ClipboardCheck,
  Puzzle,
  Command,
  Gauge,
  GitBranch,
  Handshake,
  FolderOpen,
  BookMarked,
  BarChart3,
  Mic,
  Brain,
  Shield,
  Zap,
  Check,
  ChevronDown,
  Menu,
  Terminal,
  Sparkles,
  MessageCircle,
  Laptop,
  Server,
  FileSpreadsheet,
  Calendar,
  Code2,
  Database,
  Settings,
  KeyRound,
  Lock,
  Music,
  FileText,
  Flame,
  Target,
  Bot,
  Heart,
  Mail,
  Send,
  X,
  type LucideIcon,
} from "lucide-react";

// Agent tiles for hero visualization
const agents = [
  {
    id: "browser",
    name: "Browser",
    icon: Globe,
    color: "cyan",
    description: "Browse, scrape, automate",
    demo: "Navigated to google.com",
  },
  {
    id: "files",
    name: "Files",
    icon: FolderOpen,
    color: "amber",
    description: "Read, write, organize",
    demo: "Created report.md",
  },
  {
    id: "obsidian",
    name: "Obsidian",
    icon: BookMarked,
    color: "violet",
    description: "Search, create notes",
    demo: "Found 12 related notes",
  },
  {
    id: "data",
    name: "Data",
    icon: BarChart3,
    color: "emerald",
    description: "Analytics & insights",
    demo: "Spend up 23% this week",
  },
];

// Integrations
const integrations: { name: string; icon: LucideIcon; badge?: string }[] = [
  { name: "Google Calendar", icon: Calendar, badge: "Beta" },
  { name: "WhatsApp", icon: MessageCircle },
  { name: "Telegram", icon: Send },
  { name: "Upready", icon: Heart, badge: "iOS" },
  { name: "Claude", icon: Bot },
  { name: "Google Ads", icon: BarChart3 },
  { name: "TikTok", icon: Music },
  { name: "Facebook", icon: Globe },
  { name: "LinkedIn", icon: Target },
  { name: "Obsidian", icon: BookMarked },
  { name: "Excel", icon: FileSpreadsheet },
  { name: "PDF", icon: FileText },
  { name: "Firecrawl", icon: Flame },
];

const UPREADY_APP_STORE_URL =
  "https://apps.apple.com/us/app/upready-ai-performance-tracker/id6738921753";

const pricingCards = [
  {
    icon: KeyRound,
    eyebrow: "Groovy Personal",
    title: "For personal projects",
    price: "$49.99",
    unit: "per year",
    tone: "cyan",
    details: [
      "One individual, personal non-commercial use.",
      "Two activated devices.",
      "Current downloads, updates, and source snapshots while active.",
    ],
  },
  {
    icon: Server,
    eyebrow: "Groovy Enterprise",
    title: "For companies",
    price: "Contact sales",
    unit: "annual license",
    tone: "emerald",
    details: [
      "Commercial use, self-hosting, and internal modification rights.",
      "Source access, support, security, and contract terms.",
      "Fallback rights to the last paid version if you do not renew.",
    ],
  },
  {
    icon: Shield,
    eyebrow: "Default billing",
    title: "No token tax",
    price: "$0",
    unit: "Groovy token markup",
    tone: "amber",
    details: [
      "Connect your own OpenAI, Anthropic, Google, Azure, Bedrock, Groq, or Mistral keys.",
      "You control provider usage and provider billing.",
      "Groovy usage analytics are separate from Groovy licensing.",
    ],
  },
  {
    icon: BarChart3,
    eyebrow: "Approved partners",
    title: "Reseller billing",
    price: "By agreement",
    unit: "authorized only",
    tone: "rose",
    details: [
      "Usage-based billing stays off unless the license explicitly enables it.",
      "Approved resellers can meter customer usage and export billing data.",
      "Normal personal and enterprise customers never see reseller controls.",
    ],
  },
];

const operatingModel = [
  {
    icon: Code2,
    title: "Source visible for trust",
    description:
      "Groovy keeps a delayed public mirror so developers can inspect the code, file issues, and contribute without turning GitHub into the licensing system.",
  },
  {
    icon: CreditCard,
    title: "Paid license for use",
    description:
      "Personal users buy a yearly license. Companies talk to sales and get commercial terms, source access, support, and fallback rights.",
  },
  {
    icon: KeyRound,
    title: "Your keys, your bill",
    description:
      "Groovy does not sit between you and your AI provider by default. You connect your own provider credentials and control usage directly.",
  },
  {
    icon: Database,
    title: "Memory and data are explicit",
    description:
      "Datagran powers Memory and Data Integrations when enabled. Teams choose when to connect it and which data integrations belong in their setup.",
  },
];

const pricingToneClasses: Record<string, { badge: string; icon: string; accent: string }> = {
  cyan: {
    badge: "text-cyan-300 bg-cyan-500/10 border-cyan-500/20",
    icon: "text-cyan-300 bg-cyan-500/10 border-cyan-500/20",
    accent: "border-cyan-500/30",
  },
  emerald: {
    badge: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20",
    icon: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20",
    accent: "border-emerald-500/30",
  },
  amber: {
    badge: "text-amber-300 bg-amber-500/10 border-amber-500/20",
    icon: "text-amber-300 bg-amber-500/10 border-amber-500/20",
    accent: "border-amber-500/30",
  },
  rose: {
    badge: "text-rose-300 bg-rose-500/10 border-rose-500/20",
    icon: "text-rose-300 bg-rose-500/10 border-rose-500/20",
    accent: "border-rose-500/30",
  },
};

export default function LandingPage() {
  const connectorGuide = useConnectorInstallGuide();
  const [mounted, setMounted] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [activeAgent, setActiveAgent] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    // Use requestAnimationFrame to avoid cascading render warning
    const frame = requestAnimationFrame(() => {
      setMounted(true);
    });
    document.body.style.overflow = "auto";
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = "";
    };
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      if (window.scrollY > 50) setHasScrolled(true);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Cycle through agents
  useEffect(() => {
    const interval = setInterval(() => {
      setActiveAgent((prev) => (prev + 1) % agents.length);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] relative overflow-x-hidden">
      {/* Noise overlay */}
      <div className="noise-overlay" />

      {/* Background effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] bg-cyan-500/10 rounded-full blur-[120px] animate-float" />
        <div
          className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-violet-500/10 rounded-full blur-[120px] animate-float"
          style={{ animationDelay: "-5s" }}
        />
      </div>

      {/* Grid background */}
      <div className="fixed inset-0 bg-grid opacity-30" />

      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-[var(--bg-primary)]/80 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 flex items-center justify-between gap-3">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={mounted ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.6 }}
          >
            <Image
              src="/Groovy_no_bg.png"
              alt="Groovy"
              width={400}
              height={112}
              className="h-20 sm:h-28 w-auto -my-3 sm:-my-4"
              unoptimized
              priority
            />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={mounted ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.6 }}
            className="hidden md:flex items-center gap-2 lg:gap-4"
          >
            <Link
              href="/integrations"
              className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors"
            >
              Integrations
            </Link>
            <a
              href="#pricing"
              className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors"
            >
              Pricing
            </a>
            <Link
              href="/setup"
              className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors"
            >
              Setup
            </Link>
            <Link
              href="/login"
              className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/dashboard"
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium text-sm shadow-lg shadow-cyan-500/25 hover:shadow-cyan-500/40 transition-all"
            >
              Get Started
            </Link>
          </motion.div>

          <div className="md:hidden flex items-center gap-2">
            <Link
              href="/dashboard"
              className="px-3 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium text-xs shadow-lg shadow-cyan-500/20"
            >
              Start
            </Link>
            <button
              type="button"
              onClick={() => setMobileMenuOpen((open) => !open)}
              aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileMenuOpen}
              className="w-10 h-10 rounded-lg border border-white/10 bg-white/[0.03] text-zinc-200 flex items-center justify-center"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.nav
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="md:hidden border-t border-white/5 bg-zinc-950/95 backdrop-blur-xl"
            >
              <div className="px-4 py-3 grid grid-cols-2 gap-2">
                {[
                  { label: "Integrations", href: "/integrations" },
                  { label: "Pricing", href: "#pricing" },
                  { label: "Setup", href: "/setup" },
                  { label: "Sign in", href: "/login" },
                ].map((item) => (
                  <a
                    key={item.label}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className="px-3 py-3 rounded-lg border border-white/10 bg-white/[0.03] text-sm font-medium text-zinc-200 hover:bg-white/[0.06] transition-colors"
                  >
                    {item.label}
                  </a>
                ))}
              </div>
            </motion.nav>
          )}
        </AnimatePresence>
      </header>

      {/* Hero Section */}
      <main className="relative z-10 min-h-screen flex flex-col items-center justify-center px-6 pt-36 pb-12">
        {/* Main headline */}
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={mounted ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="text-5xl sm:text-6xl md:text-7xl font-bold text-white leading-[0.95] mb-8 text-center"
        >
          The AI that
          <br />
          <span className="text-gradient">actually works.</span>
        </motion.h1>

        {/* Description */}
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={mounted ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="text-base text-zinc-400 mb-14 max-w-xl mx-auto text-center leading-relaxed"
        >
          Coordinate meetings, monitor social mentions, analyze reports.
          All from WhatsApp, Telegram, or our web app. Runs locally on your computer—your data stays yours.
        </motion.p>

        {/* Command Center Preview - Modern Dashboard Style */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={mounted ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.3 }}
          className="w-full max-w-4xl mb-14"
        >
          {/* Floating Agent Particles - Outside the chat container */}
          <div className="flex flex-wrap gap-3 justify-center mb-6">
            {/* Calendar pill - running */}
            <motion.div
              animate={{ 
                boxShadow: activeAgent === 0 ? "0 0 20px -3px rgba(16,185,129,0.5)" : "none",
                y: activeAgent === 0 ? -2 : 0
              }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 backdrop-blur-sm"
            >
              <Calendar className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-xs font-medium text-emerald-400">Calendar</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/30 text-emerald-300 animate-pulse">
                syncing
              </span>
            </motion.div>

            {/* Browser pill */}
            <motion.div 
              animate={{ y: activeAgent === 1 ? -2 : 0 }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-cyan-500/15 border border-cyan-500/30 backdrop-blur-sm"
            >
              <Globe className="w-3.5 h-3.5 text-cyan-400" />
              <span className="text-xs font-medium text-cyan-400">Browser</span>
            </motion.div>
            
            {/* Files pill */}
            <motion.div 
              animate={{ y: activeAgent === 2 ? -2 : 0 }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/30 backdrop-blur-sm"
            >
              <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-xs font-medium text-amber-400">Files</span>
            </motion.div>
            
            {/* Data pill */}
            <motion.div
              animate={{ 
                boxShadow: activeAgent === 3 ? "0 0 20px -3px rgba(139,92,246,0.5)" : "none",
                y: activeAgent === 3 ? -2 : 0
              }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-violet-500/15 border border-violet-500/30 backdrop-blur-sm"
            >
              <BarChart3 className="w-3.5 h-3.5 text-violet-400" />
              <span className="text-xs font-medium text-violet-400">Analytics</span>
            </motion.div>
            
            {/* Code pill */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-sky-500/15 border border-sky-500/30 backdrop-blur-sm">
              <Terminal className="w-3.5 h-3.5 text-sky-400" />
              <span className="text-xs font-medium text-sky-400">Code</span>
            </div>
            
            {/* Chat pills */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-rose-500/15 border border-rose-500/30 backdrop-blur-sm">
              <MessageCircle className="w-3.5 h-3.5 text-rose-400" />
              <span className="text-xs font-medium text-rose-400">WhatsApp</span>
            </div>

            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/15 border border-blue-500/30 backdrop-blur-sm">
              <Send className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-xs font-medium text-blue-400">Telegram</span>
            </div>
          </div>

          {/* 3-Panel Dashboard Container */}
          <div className="bg-zinc-900/60 border border-white/10 rounded-2xl overflow-hidden backdrop-blur-xl">
            {/* Mock header */}
            <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500/60" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
                <div className="w-3 h-3 rounded-full bg-green-500/60" />
              </div>
              <span className="text-xs text-zinc-600">
                Groovy Command Center
              </span>
              <div className="flex items-center gap-2 text-xs text-emerald-400">
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                Connected
              </div>
            </div>

            {/* 3-Panel Layout */}
            <div className="flex divide-x divide-white/5">
              {/* Left Panel - Team Calendars */}
              <div className="w-52 p-3 hidden sm:block">
                <div className="text-[10px] uppercase tracking-wider text-emerald-400 mb-2 flex items-center gap-1.5">
                  <Calendar className="w-3 h-3" />
                  Team Calendars
                </div>
                {/* Team availability visualization */}
                <div className="relative h-36 bg-black/30 rounded-lg overflow-hidden p-2 space-y-1.5">
                  {/* Team members */}
                  {[
                    { name: "Sarah", status: "available", time: "3-6pm" },
                    { name: "Mike", status: "busy", time: "1-4pm" },
                    { name: "Lisa", status: "available", time: "2-6pm" },
                    { name: "James", status: "available", time: "4-7pm" },
                  ].map((member) => (
                    <div key={member.name} className="flex items-center gap-2">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-medium ${
                        member.status === "available" 
                          ? "bg-emerald-500/30 text-emerald-300" 
                          : "bg-amber-500/30 text-amber-300"
                      }`}>
                        {member.name[0]}
                      </div>
                      <div className="flex-1">
                        <div className="text-[9px] text-zinc-300">{member.name}</div>
                        <div className={`text-[7px] ${
                          member.status === "available" ? "text-emerald-400" : "text-amber-400"
                        }`}>{member.time}</div>
                      </div>
                      <div className={`w-1.5 h-1.5 rounded-full ${
                        member.status === "available" ? "bg-emerald-400" : "bg-amber-400"
                      }`} />
                    </div>
                  ))}
                  {/* Optimal slot */}
                  <div className="mt-2 pt-2 border-t border-white/10">
                    <div className="text-[8px] text-zinc-500">Optimal slot found:</div>
                    <div className="text-[10px] text-cyan-400 font-medium">Friday 5:00 PM ✓</div>
                  </div>
                </div>
              </div>

              {/* Middle Panel - Chat */}
              <div className="flex-1 flex flex-col min-w-0">
                {/* Chat area */}
                <div className="px-3 py-3 space-y-2 flex-1">
                  {/* Assistant response - Team meeting */}
                  <div className="flex justify-start">
                    <div className="px-3 py-2 rounded-2xl bg-white/5 border border-white/10 max-w-[280px] space-y-1.5">
                      <div className="flex items-center gap-1.5 text-[10px] text-emerald-400">
                        <Calendar className="w-3 h-3" />
                        <span>Checked calendars</span>
                      </div>
                      <p className="text-xs text-zinc-300">Hey everyone, after checking each one of your calendars I propose the next team meeting for <span className="text-cyan-400">Friday at 5 p.m.</span></p>
                      <p className="text-[10px] text-zinc-400">Please hit confirm and I can set this up.</p>
                      <button className="mt-1 px-3 py-1 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-[10px] text-cyan-400 hover:bg-cyan-500/30 transition-colors">
                        ✓ Confirm
                      </button>
                    </div>
                  </div>
                  
                  {/* Assistant follow-up - Social mention */}
                  <div className="flex justify-start">
                    <div className="px-3 py-2 rounded-2xl bg-white/5 border border-white/10 max-w-[260px] space-y-1.5">
                      <div className="flex items-center gap-1.5 text-[10px] text-violet-400">
                        <Globe className="w-3 h-3" />
                        <span>Social monitoring</span>
                      </div>
                      <p className="text-xs text-zinc-300">By the way, just checked and on <span className="text-cyan-400">X</span> someone posted about our new launch. Check it out!</p>
                    </div>
                  </div>
                </div>

                {/* Input area */}
                <div className="px-3 pb-3">
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/40 border border-white/10">
                    <Mic className="w-4 h-4 text-zinc-600" />
                    <span className="text-xs text-zinc-500 flex-1">Ask anything...</span>
                    <Brain className="w-4 h-4 text-violet-500/50" />
                  </div>
                </div>
              </div>

              {/* Right Panel - Activity Feed */}
              <div className="w-44 p-3 hidden sm:block">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Activity</div>
                <div className="space-y-2">
                  <div className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 mt-1 rounded-full bg-emerald-400 animate-pulse" />
                    <div className="text-[10px] text-zinc-400">
                      <span className="text-emerald-400">Calendar</span> synced 4 users
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 mt-1 rounded-full bg-cyan-400" />
                    <div className="text-[10px] text-zinc-400">
                      <span className="text-cyan-400">Browser</span> found X post
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 mt-1 rounded-full bg-violet-400" />
                    <div className="text-[10px] text-zinc-400">
                      <span className="text-violet-400">Slack</span> ready to notify
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 mt-1 rounded-full bg-amber-400" />
                    <div className="text-[10px] text-zinc-400">
                      <span className="text-amber-400">Files</span> reports ready
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        {/* CTA Buttons */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={mounted ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6, delay: 0.5 }}
          className="flex flex-col sm:flex-row sm:flex-wrap items-center justify-center gap-4 mb-10"
        >
          <a
            href={getConnectorInstallGuide("macos").downloadUrl}
            className="group flex items-center gap-3 px-8 py-4 rounded-2xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-semibold text-lg shadow-xl shadow-cyan-500/30 hover:shadow-cyan-500/50 transition-all"
          >
            <Download className="w-5 h-5" />
            Download for macOS
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </a>
          <a
            href={getConnectorInstallGuide("windows").downloadUrl}
            className="group flex items-center gap-3 px-8 py-4 rounded-2xl glass border border-white/10 text-zinc-300 font-semibold text-lg hover:bg-white/5 hover:text-white transition-all"
          >
            <Download className="w-5 h-5" />
            Download for Windows
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/10 text-zinc-400 font-normal ml-1">Beta</span>
          </a>
          <a
            href={UPREADY_APP_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-center gap-3 px-8 py-4 rounded-2xl glass border border-white/10 text-zinc-300 font-semibold text-lg hover:bg-white/5 hover:text-white transition-all"
          >
            <Download className="w-5 h-5" />
            Download Upready (iOS)
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </a>
        </motion.div>

        {/* Trust indicators */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={mounted ? { opacity: 1 } : {}}
          transition={{ duration: 0.6, delay: 0.6 }}
          className="flex flex-wrap items-center justify-center gap-6 text-xs text-zinc-600"
        >
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-emerald-500" />
            <span>100% local — your data stays on your machine</span>
          </div>
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-500" />
            <span>Free to start</span>
          </div>
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-cyan-500" />
            <span>macOS + Windows deployment</span>
          </div>
        </motion.div>

        {/* Scroll indicator */}
        <AnimatePresence>
          {mounted && !hasScrolled && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute bottom-8"
            >
              <motion.div
                animate={{ y: [0, 8, 0] }}
                transition={{ duration: 1.5, repeat: Infinity }}
              >
                <ChevronDown className="w-6 h-6 text-zinc-600" />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* What It Does Section */}
      <section className="relative z-10 py-24 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <div className="flex items-center justify-center gap-2 mb-4">
              <Sparkles className="w-5 h-5 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">
                Capabilities
              </span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
              Your workflows, simplified.
            </h2>
            <p className="text-lg text-zinc-500 max-w-2xl mx-auto">
              Coordinate from WhatsApp, Telegram, or the web dashboard. Groovy runs locally and gets work done.
            </p>
          </motion.div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              {
                icon: Laptop,
                title: "Runs Locally",
                description: "Runs entirely on your machine. Your data never leaves. Full privacy.",
                color: "cyan",
              },
              {
                icon: Calendar,
                title: "Google Calendar",
                description: "Native integration for scheduling. Check availability, create events, coordinate meetings.",
                color: "emerald",
                badge: "Closed Beta",
              },
              {
                icon: MessageCircle,
                title: "WhatsApp & Telegram",
                description: "Coordinate from your phone. Chat with the orchestrator or invoke Claude Code directly—both platforms, same capabilities.",
                color: "rose",
              },
              {
                icon: Heart,
                title: "Upready Readiness",
                description:
                  "Connect Upready to bring your readiness score into Groovy heartbeats and ask questions about trends.",
                color: "red",
              },
              {
                icon: Globe,
                title: "Web Automation",
                description: "Navigate internal tools, fill forms, extract data. Uses authenticated sessions.",
                color: "violet",
              },
              {
                icon: FileSpreadsheet,
                title: "Document Analysis",
                description: "Process PDFs, Excel, PowerPoint at scale. Extract insights automatically.",
                color: "amber",
              },
              {
                icon: Code2,
                title: "Code Generation",
                description: "Claude Code integration. Build, fix, ship faster.",
                color: "pink",
              },
              {
                icon: Database,
                title: "Marketing Analytics",
                description: "Google Ads, TikTok, Facebook, LinkedIn. Query ad performance in natural language.",
                color: "blue",
              },
              {
                icon: BookMarked,
                title: "Knowledge Base",
                description: "Search Obsidian vaults. Build a personal memory you can query.",
                color: "purple",
              },
              {
                icon: Settings,
                title: "Flexible LLM Support",
                description: "Claude, GPT-4, or your preferred model. Bring your own API keys.",
                color: "teal",
              },
            ].map((feature, index) => {
              const Icon = feature.icon;
              return (
                <motion.div
                  key={feature.title}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: index * 0.05 }}
                  className="p-5 rounded-xl border border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04] transition-all group"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className={`w-10 h-10 rounded-lg bg-${feature.color}-500/10 border border-${feature.color}-500/20 flex items-center justify-center group-hover:scale-110 transition-transform`}>
                      <Icon className={`w-5 h-5 text-${feature.color}-400`} />
                    </div>
                    {"badge" in feature && feature.badge && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                        {feature.badge}
                      </span>
                    )}
                  </div>
                  <h3 className="text-base font-semibold text-white mb-1">
                    {feature.title}
                  </h3>
                  <p className="text-sm text-zinc-500">{feature.description}</p>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Works With Everything Section */}
      <section className="relative z-10 py-16 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-8"
          >
            <div className="flex items-center justify-center gap-2 mb-4">
              <Zap className="w-5 h-5 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">
                Integrations
              </span>
            </div>
            <h3 className="text-2xl font-bold text-white mb-2">Works with everything you use.</h3>
          </motion.div>
          <div className="flex flex-wrap justify-center gap-3">
            {integrations.map((integration, i) => (
              <motion.div
                key={integration.name}
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.03 }}
                className={`flex items-center gap-2 px-4 py-2 rounded-full border bg-white/[0.02] hover:border-white/20 transition-all ${
                  integration.badge ? "border-emerald-500/30" : "border-white/10"
                }`}
              >
                <integration.icon className={`w-4 h-4 ${integration.badge ? "text-emerald-400" : "text-cyan-400"}`} />
                <span className="text-sm text-zinc-300">{integration.name}</span>
                {integration.badge && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">
                    {integration.badge}
                  </span>
                )}
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Agent Coding Section */}
      <section className="relative z-10 py-24 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mb-12 max-w-3xl"
          >
            <div className="flex items-center gap-2 mb-4">
              <Code2 className="w-5 h-5 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">
                Coding In Groovy
              </span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
              A real command center for agentic coding.
            </h2>
            <p className="text-lg text-zinc-500">
              Groovy is built for people who work with more than one coding agent.
              You can see what each agent is doing, coordinate handoffs, consolidate
              plans, and attach the right skills or Markdown instructions to the right agent.
            </p>
          </motion.div>

          <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                {
                  icon: Bot,
                  title: "Multi-agent view",
                  text: "Watch your agents side by side instead of guessing which chat is holding the current plan, task, or blocker.",
                },
                {
                  icon: Handshake,
                  title: "Agent handshake",
                  text: "Agents can pass context, decisions, and next actions to each other so work does not restart from scratch.",
                },
                {
                  icon: ClipboardCheck,
                  title: "Consolidated plans",
                  text: "Groovy turns scattered agent notes into one readable plan you can approve, edit, or hand to the next agent.",
                },
                {
                  icon: Puzzle,
                  title: "Skills and .md instructions",
                  text: "Assign a skill, repo instruction file, or Markdown playbook to any agent so each one gets the context it needs.",
                },
              ].map((item, index) => {
                const Icon = item.icon;
                return (
                  <motion.div
                    key={item.title}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: index * 0.05 }}
                    className="rounded-lg border border-white/10 bg-white/[0.025] p-5"
                  >
                    <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 text-cyan-300">
                      <Icon className="h-5 w-5" />
                    </div>
                    <h3 className="text-base font-semibold text-white">{item.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-500">{item.text}</p>
                  </motion.div>
                );
              })}
            </div>

            <motion.div
              initial={{ opacity: 0, x: 24 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              className="overflow-hidden rounded-lg border border-white/10 bg-black/30"
            >
              <div className="flex items-center justify-between border-b border-white/10 p-5">
                <div>
                  <div className="text-sm font-semibold text-white">Agent handshake in Groovy</div>
                  <div className="mt-1 text-xs text-zinc-500">Codex, Claude Code, planner, reviewer</div>
                </div>
                <div className="flex gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                  <span className="h-2.5 w-2.5 rounded-full bg-cyan-400" />
                  <span className="h-2.5 w-2.5 rounded-full bg-violet-400" />
                </div>
              </div>

              <div className="relative m-4 h-[240px] overflow-hidden rounded-lg border border-white/10 bg-black/60 sm:h-[300px] lg:h-[340px]">
                <Image
                  src="/images/agent-handshake.png"
                  alt="Groovy multi-agent handshake view showing coding agents coordinating work"
                  fill
                  className="object-contain"
                  sizes="(min-width: 1024px) 520px, 100vw"
                />
              </div>

              <div className="m-4 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
                  <Terminal className="h-4 w-4" />
                  Code sub-agents are local CLIs
                </div>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                  Groovy&apos;s code sub-agents drive the user&apos;s own Codex and Claude Code
                  CLIs in the selected workspace. They run where the user&apos;s repo,
                  git state, terminal tools, and permissions already live.
                </p>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Enterprise Teams Section */}
      <section className="relative z-10 py-24 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-12"
          >
            <div className="flex items-center justify-center gap-2 mb-4">
              <Users className="w-5 h-5 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">
                Enterprise Teams
              </span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
              Give teams a place to run agents and measure work.
            </h2>
            <p className="text-lg text-zinc-500 max-w-3xl mx-auto">
              Groovy is not only a personal assistant. Teams can add members,
              organize people and agents into Cells, and track performance with
              clear KPIs so agent work becomes visible, accountable, and repeatable.
            </p>
          </motion.div>

          <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
            <motion.div
              initial={{ opacity: 0, x: -24 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              className="rounded-lg border border-white/10 bg-black/30 p-5"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-white">Growth Cell</div>
                  <div className="mt-1 text-xs text-zinc-500">One agent hub, one team, shared outcomes</div>
                </div>
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
                  On track
                </div>
              </div>

              <div className="relative mt-5 min-h-[340px] overflow-hidden rounded-lg border border-white/10 bg-white/[0.025] p-5">
                <div className="absolute inset-5 rounded-full border border-cyan-500/15" />
                <div className="absolute inset-14 rounded-full border border-emerald-500/15" />
                <div className="absolute left-1/2 top-1/2 z-10 flex h-28 w-28 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border border-cyan-400/40 bg-cyan-400/15 text-center shadow-2xl shadow-cyan-500/20">
                  <Bot className="h-7 w-7 text-cyan-200" />
                  <div className="mt-2 text-sm font-semibold text-white">Groovy</div>
                  <div className="text-[10px] uppercase tracking-widest text-cyan-200">Agent Hub</div>
                </div>

                {[
                  { name: "Sales", metric: "Pipeline", position: "left-5 top-9", tone: "text-emerald-200 border-emerald-500/25 bg-emerald-500/10" },
                  { name: "Ops", metric: "Throughput", position: "right-5 top-9", tone: "text-amber-200 border-amber-500/25 bg-amber-500/10" },
                  { name: "Product", metric: "Launches", position: "left-7 bottom-8", tone: "text-violet-200 border-violet-500/25 bg-violet-500/10" },
                  { name: "Support", metric: "Backlog", position: "right-7 bottom-8", tone: "text-rose-200 border-rose-500/25 bg-rose-500/10" },
                ].map((member) => (
                  <div
                    key={member.name}
                    className={`absolute ${member.position} w-28 rounded-lg border p-3 text-center ${member.tone}`}
                  >
                    <div className="text-sm font-semibold">{member.name}</div>
                    <div className="mt-1 text-[10px] uppercase tracking-widest opacity-70">{member.metric}</div>
                  </div>
                ))}

                <div className="absolute left-1/2 top-9 hidden h-px w-24 -translate-x-1/2 bg-cyan-400/30 sm:block" />
                <div className="absolute bottom-14 left-1/2 hidden h-px w-24 -translate-x-1/2 bg-cyan-400/30 sm:block" />
                <div className="absolute left-20 top-1/2 hidden h-24 w-px -translate-y-1/2 bg-cyan-400/30 sm:block" />
                <div className="absolute right-20 top-1/2 hidden h-24 w-px -translate-y-1/2 bg-cyan-400/30 sm:block" />

              </div>

              <div className="mt-3 grid grid-cols-3 gap-2">
                {[
                  ["Members", "8"],
                  ["Agents", "14"],
                  ["KPIs", "12"],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-white/10 bg-white/[0.03] p-2 text-center">
                    <div className="text-lg font-semibold text-white">{value}</div>
                    <div className="text-[10px] text-zinc-500">{label}</div>
                  </div>
                ))}
              </div>

              <p className="mt-4 text-sm leading-relaxed text-zinc-500">
                Each Cell keeps the people, agents, workflows, and KPIs together so teams
                can see who owns the work, what the agents are doing, and whether outcomes
                are improving.
              </p>
            </motion.div>

            <div className="grid gap-4 sm:grid-cols-2">
              {[
                {
                  icon: Users,
                  title: "Add the right people",
                  text: "Invite teammates, contractors, operators, and technical owners into a shared workspace with clear roles.",
                },
                {
                  icon: Workflow,
                  title: "Cells organize execution",
                  text: "A Cell gives a team a focused operating space for agents, objectives, workflows, and recurring work.",
                },
                {
                  icon: Gauge,
                  title: "Track KPIs where work happens",
                  text: "Connect agent activity to targets like response time, backlog cleared, launch progress, or operational throughput.",
                },
                {
                  icon: GitBranch,
                  title: "Turn agent work into process",
                  text: "Reusable skills, instructions, and plans help teams standardize how agents execute work across departments.",
                },
              ].map((item, index) => {
                const Icon = item.icon;
                return (
                  <motion.div
                    key={item.title}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: index * 0.05 }}
                    className="rounded-lg border border-white/10 bg-white/[0.025] p-5"
                  >
                    <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 text-cyan-300">
                      <Icon className="h-5 w-5" />
                    </div>
                    <h3 className="text-base font-semibold text-white">{item.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-500">{item.text}</p>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* CLI Integrations Section */}
      <section className="relative z-10 py-24 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mb-12 max-w-3xl"
          >
            <div className="flex items-center gap-2 mb-4">
              <Command className="w-5 h-5 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">
                CLI Integrations
              </span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
              Turn your product&apos;s CLI into Groovy tools.
            </h2>
            <p className="text-lg text-zinc-500">
              Companies can create Groovy integrations for the products they already
              operate. If your product has a command-line interface, an API, or both,
              you can expose focused actions to Groovy as an extension pack instead of
              asking customers to copy terminal commands by hand.
            </p>
          </motion.div>

          <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                {
                  icon: Puzzle,
                  title: "Extension packs",
                  text: "Describe your product as typed tools with names, descriptions, input schemas, output schemas, and guidance for when Groovy should use them.",
                },
                {
                  icon: Terminal,
                  title: "CLI actions",
                  text: "If your product already ships a CLI, declare safe argv templates. Groovy sends structured requests; the runner executes only the approved command shape.",
                },
                {
                  icon: Server,
                  title: "Customer runners",
                  text: "Run on-prem or private-network integrations through an HTTPS runner inside the customer environment, with bearer auth and health heartbeats.",
                },
                {
                  icon: Shield,
                  title: "Approvals and traces",
                  text: "Each tool carries a risk level and auth scope. Groovy handles approval states, encrypted secrets, audit events, usage metering, and runtime traces.",
                },
              ].map((item, index) => {
                const Icon = item.icon;
                return (
                  <motion.div
                    key={item.title}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: index * 0.05 }}
                    className="rounded-lg border border-white/10 bg-white/[0.025] p-5"
                  >
                    <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 text-cyan-300">
                      <Icon className="h-5 w-5" />
                    </div>
                    <h3 className="text-base font-semibold text-white">{item.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-500">{item.text}</p>
                  </motion.div>
                );
              })}
            </div>

            <motion.div
              initial={{ opacity: 0, x: 24 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              className="rounded-lg border border-white/10 bg-zinc-950 p-5 font-mono"
            >
              <div className="mb-4 flex items-center justify-between border-b border-white/10 pb-4">
                <div className="text-sm text-white">Extension manifest</div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">customer runner</div>
              </div>
              <div className="space-y-3 text-xs">
                {[
                  ["runtimeTarget", "customer_runner"],
                  ["action.kind", "cli_action"],
                  ["argvTemplate", "[\"acmectl\", \"incident\", \"create\", \"--json\"]"],
                  ["riskLevel", "write"],
                  ["authScope", "shared_org"],
                  ["runner", "https://runner.acme.internal/v1/execute"],
                ].map(([field, value]) => (
                  <div key={field} className="rounded-lg border border-white/10 bg-white/[0.025] p-3">
                    <div className="text-cyan-200">{field}</div>
                    <div className="mt-1 break-words text-zinc-600">{value}</div>
                  </div>
                ))}
              </div>
              <p className="mt-5 text-sm leading-relaxed text-zinc-500">
                The integration is a contract, not a free-form shell. Groovy routes the
                request, validates inputs, checks approvals, sends the runner a structured
                command, and records the trace for the customer.
              </p>
              <Link
                href="/integrations/docs"
                className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-cyan-300 transition-colors hover:text-cyan-200"
              >
                Read integration docs
                <ArrowRight className="h-4 w-4" />
              </Link>
            </motion.div>
          </div>
        </div>
      </section>


      {/* Operating Model Section */}
      <section className="relative z-10 py-20 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-12"
          >
            <div className="flex items-center justify-center gap-2 mb-4">
              <Shield className="w-5 h-5 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">
                How Groovy Works
              </span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
              Open enough to trust. Licensed enough to last.
            </h2>
            <p className="text-lg text-zinc-500 max-w-2xl mx-auto">
              The model is simple: public source for confidence, paid licenses for use,
              current downloads through the portal, and provider keys that stay under your control.
            </p>
          </motion.div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {operatingModel.map((item, index) => {
              const Icon = item.icon;
              return (
                <motion.div
                  key={item.title}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: index * 0.05 }}
                  className="rounded-lg border border-white/10 bg-white/[0.025] p-5"
                >
                  <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 text-cyan-300">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="text-base font-semibold text-white">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-500">{item.description}</p>
                </motion.div>
              );
            })}
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mt-6 rounded-lg border border-white/10 bg-black/25 p-4 sm:p-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex gap-3">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white">
                <Github className="h-5 w-5" />
              </div>
              <div>
                <div className="text-sm font-medium text-white">Public GitHub mirror</div>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-500">
                  Groovy keeps a delayed source-available public repo for review, issues, and
                  contributions. The license still controls personal, commercial, hosted, and
                  resale use.
                </p>
              </div>
            </div>
            <Link
              href="https://github.com/Charlesmendez/groovy-public"
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-white/15 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-white/10"
            >
              View GitHub
              <ArrowRight className="h-4 w-4" />
            </Link>
          </motion.div>
        </div>
      </section>

      {/* Quick Start Section */}
      <section className="relative z-10 py-24 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <div className="flex items-center justify-center gap-2 mb-4">
              <Terminal className="w-5 h-5 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">
                Get Started
              </span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
              What installing Groovy actually means.
            </h2>
            <p className="text-lg text-zinc-500 max-w-2xl mx-auto">
              You do not pay and then hunt through GitHub. You sign in to your Groovy
              account, download the current version, install the local connector, and
              connect the provider keys you control.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mb-12 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] p-5 sm:p-6"
          >
            <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
              <div className="flex gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 text-cyan-300">
                  <Bot className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-sm font-semibold uppercase tracking-widest text-cyan-300">
                    Developer and enterprise setup
                  </div>
                  <h3 className="mt-2 text-xl font-semibold text-white">
                    Use the AI CLI when you are self-hosting or working from source.
                  </h3>
                  <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
                    Personal users do not need their own Vercel, Supabase, or Fly.io account.
                    The CLI prompt is for developers and enterprise teams who want an AI
                    coding agent to configure source checkout, self-hosting, provider keys,
                    Datagran Memory, integrations, licensing, and connector startup.
                  </p>
                </div>
              </div>
              <div className="shrink-0 space-y-3">
                <div className="rounded-lg border border-white/10 bg-black/35 px-3 py-2 font-mono text-xs text-cyan-100">
                  npx @gogroovy/cli setup prompt
                </div>
                <Link
                  href="https://github.com/Charlesmendez/groovy-public/blob/main/docs/ai-agent-setup.md"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-400 px-4 py-3 text-sm font-semibold text-black transition-colors hover:bg-cyan-300"
                >
                  View AI Setup Doc
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mb-12 grid gap-4 md:grid-cols-2"
          >
            <div className="rounded-lg border border-white/10 bg-white/[0.025] p-5">
              <div className="text-sm font-semibold text-white">What Groovy hosts</div>
              <p className="mt-2 text-sm leading-relaxed text-zinc-500">
                The account portal, billing, license activation, device management,
                downloads, source-snapshot access, and hosted relay/API services when needed.
              </p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.025] p-5">
              <div className="text-sm font-semibold text-white">What you control</div>
              <p className="mt-2 text-sm leading-relaxed text-zinc-500">
                Your local connector, provider API keys, provider billing account, local
                files, and Datagran account if you enable Memory or Data Integrations.
              </p>
            </div>
          </motion.div>

          <div className="space-y-6">
            {[
              {
                step: "1",
                title: "Create your Groovy account",
                description:
                  "Personal users buy online. Enterprise customers get an account and license through sales.",
              },
              {
                step: "2",
                title: "Open the account portal",
                description:
                  "Your dashboard shows your license, downloads, devices, billing, and source snapshots you are entitled to access.",
              },
              {
                step: "3",
                title: "Download the current version",
                description:
                  "Download the connector, installers, checksums, release notes, and current source snapshot while your license is active.",
              },
              {
                step: "4",
                title: "Install the local connector",
                description:
                  "The connector runs on your computer so Groovy can use your browser, files, WhatsApp, terminal, and local tools with your permission.",
              },
              {
                step: "5",
                title: "Connect your keys and get updates",
                description:
                  "Add your model provider keys and Datagran account if you enable Memory or Data Integrations. Future updates appear in the portal and CLI.",
              },
            ].map((item, index) => (
              <motion.div
                key={item.step}
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className="flex gap-6 items-start"
              >
                <div className="w-12 h-12 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 font-bold text-lg shrink-0">
                  {item.step}
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-white mb-1">
                    {item.title}
                  </h3>
                  <p className="text-zinc-500">{item.description}</p>
                </div>
              </motion.div>
            ))}
          </div>

          {/* Install box — dual platform */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mt-12 p-6 rounded-2xl border border-white/10 bg-white/[0.02]"
          >
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-zinc-400">Install the local connector</span>
              <span className="text-xs px-2 py-1 rounded-full bg-emerald-500/20 text-emerald-400">
                Free
              </span>
            </div>
            {/* Primary (auto-detected) button */}
            <a
              href={connectorGuide.downloadUrl}
              className="flex items-center justify-center gap-3 w-full py-4 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-semibold text-lg hover:shadow-lg hover:shadow-cyan-500/30 transition-all"
            >
              <Download className="w-5 h-5" />
              {connectorGuide.ctaLabel}
            </a>
            <p className="mt-3 text-xs text-zinc-600 text-center">
              {connectorGuide.requirements}
            </p>
            <p className="mt-3 text-xs leading-relaxed text-zinc-500 text-center">
              The connector is the local runtime. Paid downloads, current source snapshots,
              license keys, devices, and updates live in your Groovy account portal.
            </p>
            {/* Secondary platform link */}
            {connectorGuide.platform !== "windows" && (
              <p className="mt-2 text-xs text-zinc-600 text-center">
                Looking for Windows?{" "}
                <a href={getConnectorInstallGuide("windows").downloadUrl} className="text-cyan-500 hover:text-cyan-400 underline underline-offset-2">
                  Download for Windows (Beta)
                </a>
              </p>
            )}
            {connectorGuide.platform === "windows" && (
              <p className="mt-2 text-xs text-zinc-600 text-center">
                Looking for macOS?{" "}
                <a href={getConnectorInstallGuide("macos").downloadUrl} className="text-cyan-500 hover:text-cyan-400 underline underline-offset-2">
                  Download for macOS
                </a>
              </p>
            )}
          </motion.div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="relative z-10 py-24 px-6 border-t border-white/5 scroll-mt-24">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-12"
          >
            <div className="flex items-center justify-center gap-2 mb-4">
              <CreditCard className="w-5 h-5 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">
                Pricing
              </span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
              A business model developers can respect.
            </h2>
            <p className="text-lg text-zinc-500 max-w-2xl mx-auto">
              Groovy makes money from yearly licenses, updates, downloads, source access,
              support, and enterprise agreements. Your token bill stays between you and your provider.
            </p>
          </motion.div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {pricingCards.map((item, index) => {
              const Icon = item.icon;
              const tone = pricingToneClasses[item.tone] || pricingToneClasses.cyan;
              return (
                <motion.div
                  key={item.title}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: index * 0.05 }}
                  className={`rounded-lg border border-white/10 bg-white/[0.025] p-5 flex flex-col min-h-[320px] ${tone.accent}`}
                >
                  <div className="flex items-start justify-between gap-3 mb-5">
                    <div className={`w-10 h-10 rounded-lg border flex items-center justify-center ${tone.icon}`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <span className={`text-[10px] px-2 py-1 rounded-full border font-medium ${tone.badge}`}>
                      {item.eyebrow}
                    </span>
                  </div>

                  <h3 className="text-base font-semibold text-white mb-3">{item.title}</h3>
                  <div className="mb-5">
                    <div className="flex items-end gap-2">
                      <span className="text-4xl font-bold text-white leading-none">{item.price}</span>
                      <span className="text-xs text-zinc-500 pb-1">{item.unit}</span>
                    </div>
                  </div>

                  <ul className="space-y-3 text-sm text-zinc-500">
                    {item.details.map((detail) => (
                      <li key={detail} className="flex gap-2">
                        <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                        <span>{detail}</span>
                      </li>
                    ))}
                  </ul>
                </motion.div>
              );
            })}
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mt-6 rounded-lg border border-white/10 bg-black/25 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
          >
            <div>
              <div className="text-sm font-medium text-white">Yearly licensing, provider keys you control</div>
              <p className="text-sm text-zinc-500 mt-1">
                Personal users buy online. Enterprise customers contact sales. Reseller
                token billing is only available with written authorization.
              </p>
            </div>
            <Link
              href="/pricing"
              className="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-cyan-500 text-black text-sm font-semibold hover:bg-cyan-400 transition-colors"
            >
              View Plans
              <ArrowRight className="w-4 h-4" />
            </Link>
          </motion.div>
        </div>
      </section>

      {/* Why Local Section */}
      <section className="relative z-10 py-16 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-8"
          >
            <div className="flex items-center justify-center gap-2 mb-4">
              <Lock className="w-5 h-5 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">
                Privacy First
              </span>
            </div>
            <h3 className="text-2xl font-bold text-white mb-2">Why local wins.</h3>
            <p className="text-sm text-zinc-500">Your machine. Your data. Complete control.</p>
          </motion.div>
          <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { title: "Data stays local", desc: "Never leaves your machine" },
              { title: "Access your accounts", desc: "Uses your logged-in sessions" },
              { title: "Real browser sessions", desc: "Authenticated access to your tools" },
              { title: "Predictable costs", desc: "Bring your own API keys" },
            ].map((item, i) => (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05 }}
                className="p-4 rounded-xl border border-white/5 bg-white/[0.02]"
              >
                <div className="text-sm text-white font-medium mb-1">{item.title}</div>
                <div className="text-xs text-zinc-500">{item.desc}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative z-10 py-32 px-6">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-4xl mx-auto text-center"
        >
          <h2 className="text-4xl sm:text-5xl font-bold text-white mb-6">
            Build with Groovy.
            <br />
            <span className="text-gradient">Keep control.</span>
          </h2>
          <p className="text-xl text-zinc-500 mb-10 max-w-2xl mx-auto">
            Buy a personal yearly license, or talk to sales for enterprise source access,
            self-hosting, support, and commercial rights.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/pricing"
              className="group flex items-center gap-3 px-10 py-5 rounded-2xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-semibold text-xl shadow-xl shadow-cyan-500/30 hover:shadow-cyan-500/50 transition-all"
            >
              <CreditCard className="w-6 h-6" />
              Buy Personal
            </Link>
            <Link
              href="/enterprise"
              className="group flex items-center gap-3 px-10 py-5 rounded-2xl border border-white/20 bg-white/[0.03] text-white font-semibold text-xl hover:bg-white/[0.06] hover:border-white/30 transition-all"
            >
              <Server className="w-6 h-6" />
              Contact Sales
            </Link>
          </div>
          <p className="mt-4 text-xs text-zinc-600">
            macOS 12+ (Apple Silicon only) · Windows 10+ (x64)
          </p>
        </motion.div>
      </section>

      {/* Contact Us */}
      <section className="relative z-10 pb-16 px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-md mx-auto text-center"
        >
          <button
            type="button"
            onClick={(e) => {
              const el = e.currentTarget.querySelector("[data-email]");
              if (el) el.classList.toggle("hidden");
            }}
            className="w-full p-6 rounded-2xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] transition-all cursor-pointer group"
          >
            <Mail className="w-6 h-6 text-cyan-400 mx-auto mb-3" />
            <h3 className="text-lg font-semibold text-white mb-1">Contact Us</h3>
            <p className="text-sm text-zinc-500 mb-3">
              Questions or feedback? We&apos;d love to hear from you.
            </p>
            <span
              data-email
              className="hidden text-cyan-400 text-sm font-medium select-all"
            >
              theshop@gmail.com
            </span>
          </button>
        </motion.div>
      </section>

      {/* Footer */}
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
    </div>
  );
}
