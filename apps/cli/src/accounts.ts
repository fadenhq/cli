/** Account lookups shared by `faden accounts …` commands. */

export interface AccountRow {
  id: string;
  handle: string | null;
  platform: string;
  status: string;
}

/** Find an account by its id or its workspace-unique handle. */
export function findAccount<T extends AccountRow>(accounts: T[], ref: string): T | undefined {
  return accounts.find((a) => a.id === ref) ?? accounts.find((a) => a.handle === ref);
}

/** What `faden accounts disconnect --dry-run` reports: the account and the request it would send. */
export function disconnectPlan(account: AccountRow) {
  return {
    dryRun: true as const,
    account,
    wouldDisconnect: account.status !== "disconnected",
    request: { method: "DELETE" as const, path: `/v1/accounts/${account.id}` },
  };
}
