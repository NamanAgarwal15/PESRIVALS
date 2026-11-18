import Link from "next/link";
import {
  cancelRivalryRequestAction,
  respondToRivalryRequestAction,
  sendRivalryRequestAction,
} from "@/lib/rivalry-actions";
import type { RivalryRelation } from "@/lib/rivalry-helpers";
import { RivalryActionForm } from "./action-form";

/** The request button/status on a leaderboard row, by relation to the viewer. */
export function LeaderboardAction({
  targetUserId,
  relation,
  rivalryId,
}: {
  targetUserId: string;
  relation: RivalryRelation;
  rivalryId?: string;
}) {
  if (relation === "active" && rivalryId) {
    return (
      <Link href={`/rivalry/${rivalryId}`} className="text-sm text-primary underline-offset-4 hover:underline">
        Rivals ›
      </Link>
    );
  }
  if (relation === "pending_sent" && rivalryId) {
    return (
      <RivalryActionForm action={cancelRivalryRequestAction} fields={{ rivalryId }} label="Sent · Cancel" variant="outline" />
    );
  }
  if (relation === "pending_received" && rivalryId) {
    return (
      <RivalryActionForm action={respondToRivalryRequestAction} fields={{ rivalryId, decision: "accept" }} label="Accept" />
    );
  }
  if (relation === "blocked") return null;
  return (
    <RivalryActionForm action={sendRivalryRequestAction} fields={{ targetUserId }} label="Challenge" pendingLabel="Sending…" variant="outline" />
  );
}
