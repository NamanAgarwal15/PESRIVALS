import { Button } from "@/components/ui/button";
import { googleSignInAction } from "@/lib/auth-actions";

// Render this only when Google OAuth is configured (see isGoogleEnabled).
export function GoogleButton() {
  return (
    <form action={googleSignInAction}>
      <Button
        type="submit"
        variant="outline"
        size="lg"
        className="h-12 w-full text-base font-semibold"
      >
        Continue with Google
      </Button>
    </form>
  );
}
