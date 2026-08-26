import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 dark:bg-black">
      <div className="flex max-w-xl flex-col items-center gap-6 text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-black dark:text-zinc-50">
          PACT
        </h1>
        <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          A merchant-side agentic commerce system. An AI buyer agent
          negotiates with a merchant agent inside explicit business rules,
          reaches a bounded agreement, and settles it through Razorpay.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href="/negotiate"
            className="flex h-12 items-center justify-center rounded-full bg-foreground px-6 text-base font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
          >
            Try the negotiation demo
          </Link>
          <Link
            href="/dashboard"
            className="flex h-12 items-center justify-center rounded-full border border-black/[.15] px-6 text-base font-medium text-zinc-900 transition-colors hover:bg-black/[.04] dark:border-white/[.2] dark:text-zinc-100 dark:hover:bg-white/[.06]"
          >
            Open merchant dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
