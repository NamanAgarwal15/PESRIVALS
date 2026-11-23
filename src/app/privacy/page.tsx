import type { Metadata } from "next";
import { AuthAwareBack } from "@/components/nav/back-link";

export const metadata: Metadata = { title: "Privacy Policy | PESRIVALS" };

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 text-sm leading-relaxed">
      <AuthAwareBack />
      <h1 className="text-3xl font-bold tracking-wide uppercase">Privacy Policy</h1>
      <p className="text-muted-foreground">Last updated: 23 November 2026</p>
      <h2 className="text-lg font-semibold">What we store</h2>
      <p>Your username, display name, hashed password, email address, and the matches you log with your rivals. Passwords, login codes and reset tokens are stored only as hashes.</p>
      <h2 className="text-lg font-semibold">What is public</h2>
      <p>Every active player appears on the global leaderboard with their username, display name and aggregated career stats across all rivalries (matches, W-D-L, win %, goals, goal difference, average possession, pass accuracy, clean sheets and recent form). Individual rivalry scores, head-to-head results, emails are never shown on the leaderboard.</p>
      <h2 className="text-lg font-semibold">Rivalry &amp; profile visibility</h2>
      <p>You control whether other players may inspect your profile and individual rivalry details; this is on by default and can be switched off in Profile &amp; Security on your home page. Even when private, your rivalry details always remain visible to your rival (the other participant) and to site administrators, who need access to moderate abuse and help with account recovery.</p>
      <h2 className="text-lg font-semibold">Rivalry Coach chats</h2>
      <p>When you ask the Rivalry Coach a question, we keep your message and the coach&apos;s reply (with angle brackets and control characters removed) together with the time, whether it was answered by AI or by the built-in rule-based coach, and a flag if it looked like an attempt to misuse the coach. We keep them for anti-abuse moderation, safety oversight and to improve the quality of the service. Site administrators can read them. The coach only ever sees your own confirmed matches, and AI answers are generated with Google Gemini, so your question and a numeric summary of your match stats are sent to Google for that purpose.</p>
      <p>Coach chats are deleted automatically after 30 days (a rolling window), and immediately when you delete your account in Profile &amp; Security. Do not put personal information in questions to the coach.</p>
      <h2 className="text-lg font-semibold">Your choices</h2>
      <p>You can change your password and email from Profile &amp; Security. Changes are confirmed with a one-time code sent to your email. Your email is used only for login codes and account recovery.</p>
      <h2 className="text-lg font-semibold">Contact</h2>
      <p>To request correction or deletion of your data, contact the site administrator.</p>
    </main>
  );
}
