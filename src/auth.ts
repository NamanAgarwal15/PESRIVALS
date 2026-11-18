import NextAuth from "next-auth";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import {
  type AuthUser,
  getAuthUserById,
  isGoogleEnabled,
  isGoogleIdentitySuspended,
  refreshSessionUser,
  resolveGoogleUser,
  verifyCredentials,
} from "@/lib/auth-helpers";
import { verifyOtp } from "@/lib/otp";

const THIRTY_DAYS_IN_SECONDS = 30 * 24 * 60 * 60;

function applyUser(token: JWT, user: AuthUser): JWT {
  token.sub = user.id;
  token.id = user.id;
  token.username = user.username;
  token.displayName = user.displayName;
  token.onboarded = user.onboarded;
  token.name = user.displayName;
  token.picture = user.imageUrl;
  token.role = user.role;
  token.suspended = user.suspended;
  token.publicLeaderboard = user.publicLeaderboard;
  return token;
}

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  // JWT sessions only: no database adapter. AUTH_SECRET is read from the env.
  session: { strategy: "jwt", maxAge: THIRTY_DAYS_IN_SECONDS },
  pages: { signIn: "/login", error: "/login" },
  providers: [
    Credentials({
      credentials: {
        identifier: { label: "Username or email" },
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
    // 6-digit one-time-code login (hashed in the otp_codes table).
    Credentials({
      id: "otp",
      credentials: {
        identifier: { label: "Email" },
        code: { label: "6-digit code", type: "text" },
      },
      async authorize(credentials) {
        if (
          typeof credentials?.identifier !== "string" ||
          typeof credentials?.code !== "string"
        ) {
          return null;
        }
        const result = await verifyOtp(credentials.identifier, credentials.code);
        if (!result.ok) return null;
        const user = await getAuthUserById(result.userId);
        if (!user || user.suspended) return null;
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
    // Suspended accounts can never start a Google sign-in.
    async signIn({ account, profile }) {
      if (account?.provider !== "google") return true;
      return !(await isGoogleIdentitySuspended({
        sub: account.providerAccountId,
        email: profile?.email,
        emailVerified: profile?.email_verified === true,
      }));
    },
    async jwt({ token, user, account, profile }) {
      if (account?.provider === "google") {
        // Map the Google identity to our own user row (link or create).
        const dbUser = await resolveGoogleUser({
          sub: account.providerAccountId,
          email: profile?.email,
          emailVerified: profile?.email_verified === true,
          name: profile?.name,
          picture: typeof profile?.picture === "string" ? profile.picture : null,
        });
        if (dbUser.suspended) return null;
        return applyUser(token, dbUser);
      }

      if (
        (account?.provider === "credentials" || account?.provider === "otp") &&
        user?.id
      ) {
        // Role/suspension come from the database, never from the sign-in payload.
        const fresh = await getAuthUserById(user.id);
        if (fresh?.suspended) return null;
        if (fresh) return applyUser(token, fresh);
        return applyUser(token, {
          id: user.id,
          username: user.username ?? "",
          displayName: user.displayName ?? "",
          onboarded: user.onboarded ?? true,
          imageUrl: user.image ?? null,
          role: "user",
          suspended: false,
          publicLeaderboard: true,
        });
      }

      // Every later request (and unstable_update): re-read the account from the
      // database. A deleted or suspended user gets no session (null), so an
      // admin suspension locks the user out on their next request.
      if (token.id) {
        const fresh = await refreshSessionUser(token.id);
        return fresh ? applyUser(token, fresh) : null;
      }

      return token;
    },
    session({ session, token }) {
      session.user.id = token.id ?? "";
      session.user.username = token.username ?? "";
      session.user.displayName = token.displayName ?? "";
      session.user.onboarded = token.onboarded ?? false;
      session.user.role = token.role === "admin" ? "admin" : "user";
      return session;
    },
  },
});
