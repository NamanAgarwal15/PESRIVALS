import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      username: string;
      displayName: string;
      onboarded: boolean;
      role: "user" | "admin";
    } & DefaultSession["user"];
  }

  // Set by the Credentials provider's authorize(); absent on OAuth profiles.
  interface User {
    username?: string;
    displayName?: string;
    onboarded?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    username?: string;
    displayName?: string;
    onboarded?: boolean;
    role?: "user" | "admin";
    suspended?: boolean;
    publicLeaderboard?: boolean;
    /** Epoch ms of the last database re-check of suspended/role. */
    lastCheckedAt?: number;
  }
}
