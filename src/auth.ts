import NextAuth from "next-auth";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import {
  type AuthUser,
  getAuthUserById,
  isGoogleEnabled,
  resolveGoogleUser,
  verifyCredentials,
} from "@/lib/auth-helpers";

const THIRTY_DAYS_IN_SECONDS = 30 * 24 * 60 * 60;

function applyUser(token: JWT, user: AuthUser): JWT {
  token.sub = user.id;
  token.id = user.id;
  token.username = user.username;
  token.displayName = user.displayName;
  token.onboarded = user.onboarded;
  token.name = user.displayName;
  token.picture = user.imageUrl;
  return token;
}

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  // JWT sessions only: no database adapter. AUTH_SECRET is read from the env.
  session: { strategy: "jwt", maxAge: THIRTY_DAYS_IN_SECONDS },
  pages: { signIn: "/login", error: "/login" },
  providers: [
    Credentials({
      credentials: {
        identifier: { label: "Username, email or phone" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const user = await verifyCredentials(
          credentials?.identifier,
          credentials?.password,
        );
        if (!user) return null;
        return {
          id: user.id,
          name: user.displayName,
          image: user.imageUrl,
          username: user.username,
          displayName: user.displayName,
          onboarded: user.onboarded,
        };
      },
    }),
    // Google is only registered when both variables are set.
    ...(isGoogleEnabled() ? [Google] : []),
  ],
  callbacks: {
    async jwt({ token, user, account, profile, trigger }) {
      if (account?.provider === "google") {
        // Map the Google identity to our own user row (link or create).
        const dbUser = await resolveGoogleUser({
          sub: account.providerAccountId,
          email: profile?.email,
          emailVerified: profile?.email_verified === true,
          name: profile?.name,
          picture: typeof profile?.picture === "string" ? profile.picture : null,
        });
        return applyUser(token, dbUser);
      }

      if (account?.provider === "credentials" && user?.id) {
        return applyUser(token, {
          id: user.id,
          username: user.username ?? "",
          displayName: user.displayName ?? "",
          onboarded: user.onboarded ?? true,
          imageUrl: user.image ?? null,
        });
      }

      // unstable_update(): re-read from the database, never trust the caller.
      if (trigger === "update" && token.id) {
        const fresh = await getAuthUserById(token.id);
        if (fresh) return applyUser(token, fresh);
      }

      return token;
    },
    session({ session, token }) {
      session.user.id = token.id ?? "";
      session.user.username = token.username ?? "";
      session.user.displayName = token.displayName ?? "";
      session.user.onboarded = token.onboarded ?? false;
      return session;
    },
  },
});
