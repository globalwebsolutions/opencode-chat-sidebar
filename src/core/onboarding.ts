// First-run onboarding: derives what the sidebar should ask the user to do next
// from the connection, folder, account and catalog state. Pure, so it is tested
// without VS Code or a server. It never claims the user is signed out unless
// OpenCode's integration list proves there is no connection.

import type {
  AccountStatus,
  CheckState,
  ConnectionStatus,
  ModelOption,
  OnboardingStage,
  OnboardingView,
  SignInState,
} from "../shared/model";

export interface OnboardingInput {
  connection: ConnectionStatus;
  hasFolder: boolean;
  /** The catalog for the current folder has been loaded at least once. */
  catalogLoaded: boolean;
  catalogLoading: boolean;
  /** null = could not be loaded. */
  models: ModelOption[] | null;
  /** null = not checked or the check failed (unknown). */
  account: AccountStatus | null;
  signIn: SignInState;
  /** The user hid the optional sign-in note. */
  hintDismissed: boolean;
}

/** Official OpenCode pages linked from the onboarding (all linked from opencode.ai/docs). */
export const OPENCODE_LINKS = {
  install: "https://opencode.ai/docs#install",
  account: "https://opencode.ai/auth",
  providers: "https://opencode.ai/docs/providers/",
  go: "https://opencode.ai/docs/go/",
  setupGuide: "https://github.com/globalwebsolutions/opencode-chat-sidebar#getting-started",
} as const;

export function deriveOnboarding(input: OnboardingInput): OnboardingView {
  const { connection, account } = input;
  const view = (
    stage: OnboardingStage,
    checklist: Partial<OnboardingView["checklist"]>,
    hint: OnboardingView["hint"] = null,
  ): OnboardingView => ({
    stage,
    checklist: {
      installed: "unknown",
      connected: "unknown",
      account: "unknown",
      models: "unknown",
      ...checklist,
    },
    hint,
    signIn: input.signIn,
  });

  switch (connection.kind) {
    case "connecting":
      return view("connecting", {});
    case "cli-not-found":
      return view("not-installed", { installed: "todo", connected: "todo" });
    case "not-running":
      return view("stopped", { installed: "done", connected: "todo" });
    case "error":
      return view("error", { connected: "todo" });
    case "connected":
      break;
  }

  const accountCheck = accountState(account, input.models);
  const base = { installed: "done", connected: "done", account: accountCheck } as const;
  if (!input.hasFolder) return view("no-folder", base);
  if (!input.catalogLoaded) return view("loading", base);

  const models = input.models;
  if (models === null) return view("catalog-error", { ...base, models: "unknown" });
  if (models.length === 0) {
    if (account?.opencode === "needs-auth") return view("sign-in-expired", { ...base, models: "todo" });
    // Signed out only when proven: OpenCode lists no connection for any provider.
    if (account && account.opencode === "none" && !account.otherProviders)
      return view("sign-in", { ...base, account: "todo", models: "todo" });
    return view("no-models", { ...base, models: "todo" });
  }

  let hint: OnboardingView["hint"] = null;
  if (account?.opencode === "needs-auth") hint = "sign-in-expired";
  else if (account?.opencode === "none" && !account.otherProviders && !input.hintDismissed)
    hint = "sign-in-optional";
  return view("ready", { ...base, models: "done" }, hint);
}

function accountState(account: AccountStatus | null, models: ModelOption[] | null): CheckState {
  if (!account) return "unknown";
  if (account.opencode === "connected") return "done";
  if (account.opencode === "needs-auth") return "expired";
  // No OpenCode account: optional while models are usable (free models or another provider).
  if (account.otherProviders || (models && models.length > 0)) return "optional";
  return "todo";
}

/** Whether the chat can be used: the composer is enabled only then. */
export function isChatReady(stage: OnboardingStage): boolean {
  return stage === "ready";
}

/** Status Bar text; never includes URLs, versions or account details. */
export function statusBarText(stage: OnboardingStage | null): string {
  switch (stage) {
    case "ready":
      return "OpenCode: Connected";
    case "sign-in":
    case "sign-in-expired":
      return "OpenCode: Sign in required";
    case "stopped":
      return "OpenCode: Stopped";
    case "not-installed":
      return "OpenCode: Not installed";
    case "no-models":
    case "catalog-error":
      return "OpenCode: No models";
    case "error":
      return "OpenCode: Not connected";
    default:
      return "OpenCode Chat";
  }
}
