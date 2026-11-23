import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { DmChat } from "@/components/chat/dm-chat";
import { BackLink } from "@/components/nav/back-link";
import { getThread } from "@/lib/dm-chat";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Chat | PESRIVALS" };

export default function ChatPage({ params }: PageProps<"/chat/[username]">) {
  return (
    <main className="flex flex-1 flex-col gap-6">
      <BackLink href="/leaderboard">← Back to Leaderboard</BackLink>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <ChatContent params={params} />
      </Suspense>
    </main>
  );
}

async function ChatContent({ params }: Pick<PageProps<"/chat/[username]">, "params">) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.onboarded) redirect("/onboarding");
  const { username } = await params;
  // Same authorization as the API: only the signed-in user's own thread with an existing, active player.
  const res = await getThread(session.user.id, decodeURIComponent(username));
  if (!res.ok) notFound();
  const { peer } = res.thread;
  return (
    <>
      <h1 className="truncate text-3xl font-bold tracking-wide">{peer.displayName}</h1>
      <p className="-mt-4 text-muted-foreground">@{peer.username}</p>
      <DmChat username={peer.username} displayName={peer.displayName} />
    </>
  );
}
