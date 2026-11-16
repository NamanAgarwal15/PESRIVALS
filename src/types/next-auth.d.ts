import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      username: string;
      displayName: string;
      onboarded: boolean;
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
  }
}
