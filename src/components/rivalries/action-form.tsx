"use client";

import { type ComponentProps, useActionState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { RivalryActionState } from "@/lib/rivalry-actions";

type RivalryAction = (
  prev: RivalryActionState,
  formData: FormData,
) => Promise<RivalryActionState>;

const initialState: RivalryActionState = {};

/**
 * A one-button form bound to a rivalry server action. `fields` become hidden
 * inputs. The result is shown as a toast; `onResult` lets the parent react
 * (e.g. a search row switching from "Challenge" to "Pending").
 */
export function RivalryActionForm({
  action,
  fields,
  label,
  pendingLabel,
  variant = "default",
  onResult,
}: {
  action: RivalryAction;
  fields: Record<string, string>;
  label: string;
  pendingLabel?: string;
  variant?: ComponentProps<typeof Button>["variant"];
  onResult?: (state: RivalryActionState) => void;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  useEffect(() => {
    if (state.error) toast.error(state.error);
    else if (state.message) toast.success(state.message);
    if (state.ok !== undefined) onResult?.(state);
    // Runs once per action result; onResult identity is irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={formAction} className="shrink-0">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button
        type="submit"
        variant={variant}
        size="lg"
        disabled={pending}
        className="h-10 px-4 font-semibold"
      >
        {pending ? (pendingLabel ?? label) : label}
      </Button>
    </form>
  );
}
