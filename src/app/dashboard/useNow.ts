// Split out of dashboardUi.ts: the one hook in that shared helper set,
// kept in its own module because it imports React — a Server Component
// (page.tsx) imports plain functions from dashboardUi.ts directly, and a
// module containing hooks can't be bundled safely for both a Server
// Component's own graph and the client at once (confirmed via a real
// Next.js build error before this split). This file is only ever
// imported by the "use client" list components, never by page.tsx.

import { useEffect, useState } from "react";

/**
 * The current time, but ONLY ever read client-side, after mount — never
 * during the initial render. A relative-time label computed directly
 * from `Date.now()` at render time would differ between a "use client"
 * component's server-rendered HTML (built at the moment the server
 * responded) and its first client render (built whenever hydration
 * actually runs, however many seconds later) — a genuine hydration text
 * mismatch (React error #418), confirmed live in this exact dashboard
 * before this fix. Returning `null` until the effect fires makes the
 * server render and the client's FIRST render agree (both render
 * nothing time-dependent); the real value then appears a frame later
 * and keeps itself honest every `intervalMs` without a page reload.
 */
export function useNow(intervalMs = 30000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // The first tick is deferred via setTimeout(…, 0) rather than a
    // direct setNow() call here, purely to keep every setState call
    // inside a callback rather than the effect body itself (see
    // react-hooks/set-state-in-effect) — it still lands on the very
    // next tick of the event loop, imperceptible to the user.
    const tick = () => setNow(Date.now());
    const initial = setTimeout(tick, 0);
    const id = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}
