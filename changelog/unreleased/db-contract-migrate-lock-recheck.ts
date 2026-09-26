import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  kind: "fixed",
  summary:
    "`db contract-migrate` re-reads the ledger after taking its lock, so a deploy that waited on another no longer re-applies a contract file the first one already applied",
};
