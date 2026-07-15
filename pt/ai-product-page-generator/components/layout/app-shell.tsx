"use client";

import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Database,
  House,
  MessageSquareMore,
  Settings2,
  WandSparkles,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiUsageIndicator } from "@/components/layout/api-usage-indicator";
import { FloatingThemeToggle } from "@/components/layout/theme-toggle";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/projects/new", label: "主页面", icon: House },
  { href: "/listing/collection", label: "采集阶段", icon: Database },
  { href: "/listing/processing", label: "加工阶段", icon: WandSparkles },
  { href: "/relay-mvp", label: "消息中继测试", icon: MessageSquareMore },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    setSidebarCollapsed(
      window.localStorage.getItem("banana-mall-sidebar-collapsed") === "true",
    );
  }, []);

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(
        "banana-mall-sidebar-collapsed",
        String(next),
      );
      return next;
    });
  }

  return (
    <div className="min-h-screen text-slate-900 dark:text-slate-100">
      <div className="fixed bottom-4 left-4 z-[60]">
        <FloatingThemeToggle />
      </div>
      <div className="mx-auto min-h-screen max-w-[1600px] px-4 py-5 md:px-6">
        <aside
          className={cn(
            "scrollbar-hidden fixed top-5 z-40 hidden h-[calc(100vh-2.5rem)] overflow-visible rounded-[2rem] border border-white/70 bg-white/76 shadow-soft backdrop-blur-2xl transition-[width,padding] duration-300 ease-in-out dark:border-white/10 dark:bg-[#0b0b0c]/88 dark:shadow-[0_24px_60px_-38px_rgba(0,0,0,0.72)] md:flex md:flex-col",
            sidebarCollapsed ? "w-[5.5rem] p-3" : "w-72 p-5",
          )}
          style={{ left: "max(1.5rem, calc((100vw - 1600px) / 2 + 1.5rem))" }}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="absolute -right-3 top-7 z-10 h-8 w-8 rounded-xl border-slate-200 bg-white shadow-md hover:bg-slate-50 dark:border-white/15 dark:bg-[#171719] dark:hover:bg-[#202023]"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            {sidebarCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </Button>

          <Link
            href="/"
            className={cn(
              "flex items-center rounded-2xl border border-white/85 bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(245,245,245,0.82))] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] transition-all duration-300 dark:border-white/10 dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
              sidebarCollapsed
                ? "justify-center p-2"
                : "gap-3 p-4",
            )}
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-black/10 bg-white shadow-sm dark:border-white/10 dark:bg-white">
              <img src="/brand-icon.ico" alt="banana-mall" className="h-full w-full object-cover" />
            </div>
            {!sidebarCollapsed ? (
              <div className="min-w-0">
                <p className="text-lg font-semibold tracking-[-0.03em] text-slate-950 dark:text-white">banana-mall</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">AI 电商详情页生成与编辑工作台</p>
              </div>
            ) : null}
          </Link>

          <nav className="mt-6 space-y-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center rounded-2xl py-3 text-sm transition-all duration-200",
                    sidebarCollapsed
                      ? "justify-center px-3"
                      : "gap-3 px-4",
                    "text-slate-600 hover:bg-white/85 hover:text-slate-950 hover:shadow-sm",
                    "dark:text-slate-300 dark:hover:bg-white/8 dark:hover:text-white",
                    pathname === item.href &&
                      "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200 dark:bg-white/10 dark:text-white dark:ring-white/10",
                  )}
                  title={sidebarCollapsed ? item.label : undefined}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!sidebarCollapsed ? <span>{item.label}</span> : null}
                </Link>
              );
            })}
          </nav>

          <div className="mt-auto" />
        </aside>

        <main
          className={cn(
            "min-w-0 rounded-[2rem] border border-white/80 bg-white/74 p-5 shadow-soft backdrop-blur-2xl transition-[margin] duration-300 ease-in-out dark:border-white/10 dark:bg-[#0f0f10]/82 dark:shadow-[0_24px_60px_-38px_rgba(0,0,0,0.78)] md:p-8",
            sidebarCollapsed ? "md:ml-[7rem]" : "md:ml-[19.5rem]",
          )}
        >
          <nav className="mb-5 flex gap-2 overflow-x-auto md:hidden">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "shrink-0 gap-2",
                    pathname === item.href &&
                      "border-slate-900 bg-slate-900 text-white",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="mb-6 flex flex-wrap items-center justify-end gap-3">
            <Link
              href="/monitor/usage"
              className={cn(
                buttonVariants({ variant: "outline" }),
                "h-10 gap-2 rounded-2xl border-slate-200 bg-white px-3 shadow-sm hover:bg-white dark:border-white/10 dark:bg-black/30 dark:hover:border-white/20 dark:hover:bg-white/8",
              )}
            >
              <span className="text-sm font-medium">API 监控</span>
              <ApiUsageIndicator />
            </Link>
            <Link href="/settings/providers" className={cn(buttonVariants({ variant: "default" }))}>
              <Settings2 className="mr-2 h-4 w-4" />
              AI 配置
            </Link>
          </div>
          <div className="mx-auto w-full max-w-[1240px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
