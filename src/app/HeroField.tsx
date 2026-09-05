"use client";

// A minimal client island — owns only the scroll-progress tracking the
// hero's AgentField background reacts to. Deliberately kept separate
// from page.tsx (which stays a plain server component with zero JS
// dependency for its actual content) so the landing page's real,
// primary content never waits on hydration to paint — only this
// decorative background needs client-side JS at all.

import { useEffect, useState } from "react";
import { AgentField } from "@/components/AgentField";

export function HeroField() {
  const [scrollProgress, setScrollProgress] = useState(0);
  useEffect(() => {
    let raf = 0;
    function onScroll() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setScrollProgress(Math.min(1, window.scrollY / (window.innerHeight || 1)));
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return <AgentField phase="idle" scrollProgress={scrollProgress} />;
}
