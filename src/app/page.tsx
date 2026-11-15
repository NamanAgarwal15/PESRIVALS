import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="text-6xl font-bold tracking-wide uppercase">
          PESRIVALS
        </h1>
        <p className="text-muted-foreground">
          Track your eFootball rivalries, match by match.
        </p>
      </div>
      <Button disabled size="lg" className="h-12 w-full text-base font-semibold disabled:opacity-70">
        Coming soon
      </Button>
    </main>
  );
}
