// Minimal UI strings for the v0.2 controls. English is the default; Arabic is
// used when VS Code's display language is Arabic. Untranslated keys fall back
// to English.

const EN = {
  copy: "Copy",
  copied: "✓ Copied",
  copyFailed: "Copy failed",
  copyMessage: "Copy message",
  copyCode: "Copy code",
  steer: "Steer",
  queue: "Queue",
  steerHint: "Steer: delivered to the agent at its next step",
  queueHint: "Queue: sent after the current task finishes",
  queued: "Queued",
  steering: "Steering",
  edit: "Edit",
  remove: "Remove",
  budget: "Budget",
  continueOnce: "Continue once",
  increaseBudget: "Increase budget",
  newSession: "Start new session",
  submit: "Submit",
  cancel: "Cancel",
  agentChanges: "Agent changes",
  viewAgentChanges: "View Agent Changes",
  workspaceChanges: "Workspace changes",
  agentDiffUnavailable: "Agent-only diff unavailable",
  changeModel: "Change model",
  retry: "Retry",
};

const AR: Partial<typeof EN> = {
  copy: "نسخ",
  copied: "✓ تم النسخ",
  copyFailed: "تعذّر النسخ",
  copyMessage: "نسخ الرسالة",
  copyCode: "نسخ الكود",
  steer: "توجيه",
  queue: "انتظار",
  queued: "في الانتظار",
  steering: "توجيه",
  edit: "تعديل",
  remove: "حذف",
  budget: "الميزانية",
  continueOnce: "متابعة لمرة واحدة",
  increaseBudget: "رفع الميزانية",
  newSession: "بدء جلسة جديدة",
  submit: "إرسال",
  cancel: "إلغاء",
  changeModel: "تغيير النموذج",
  retry: "إعادة المحاولة",
};

export type StringKey = keyof typeof EN;

export function translate(locale: "en" | "ar", key: StringKey): string {
  return (locale === "ar" ? AR[key] : undefined) ?? EN[key];
}
