"use client";

// Site-wide top navigation — mounted once in layout.tsx so every route
// (landing, buyer negotiation, merchant console) gets the same, minimal
// nav. Purely presentational: it links to the two real routes that
// already exist and never adds a page of its own.

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINKS = [
  { href: "/negotiate", label: "Negotiate", shortLabel: "Negotiate" },
  { href: "/dashboard", label: "Merchant Console", shortLabel: "Console" },
] as const;

export function TopNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-md">
      {/* A true 3-column grid (not flex justify-between) so the center
          nav is genuinely centered regardless of how wide the logo and
          the Test Mode pill each are — a flex sandwich only looks
          centered when both ends happen to match in width. */}
      <div className="mx-auto grid h-16 w-full max-w-6xl grid-cols-[1fr_auto_1fr] items-center px-4 sm:px-6">
        <Link href="/" className="flex w-fit items-center gap-2 justify-self-start">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          <span className="text-base font-semibold tracking-tight text-foreground">PACT</span>
        </Link>

        <nav className="flex items-center gap-0.5 justify-self-center sm:gap-1">
          {NAV_LINKS.map((link) => {
            const active = pathname === link.href || pathname?.startsWith(`${link.href}/`);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-full px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors sm:px-3.5 sm:text-sm ${
                  active ? "text-foreground" : "text-muted hover:text-foreground"
                }`}
              >
                <span className="sm:hidden">{link.shortLabel}</span>
                <span className="hidden sm:inline">{link.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="flex w-fit items-center gap-1.5 justify-self-end rounded-full border border-border px-2 py-1 text-xs font-medium text-muted sm:px-3">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
          <span className="hidden sm:inline">Test Mode</span>
        </div>
      </div>
    </header>
  );
}
