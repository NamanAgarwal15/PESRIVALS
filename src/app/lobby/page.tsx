import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { LobbyChat } from "@/components/chat/lobby-chat";
import { BackLink } from "@/components/nav/back-link";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Lobby | PESRIVALS" };

export default function LobbyPage() {
  return (
    <main className="flex flex-1 flex-col gap-6">
      <BackLink href="/leaderboard">← Back to Leaderboard</BackLink>
      <h1 className="text-3xl font-bold tracking-wide">Lobby</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <LobbyGate />
      </Suspense>
    </main>
  );
}

async function LobbyGate() {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.onboarded) redirect("/onboarding");
  return <LobbyChat />;
}
