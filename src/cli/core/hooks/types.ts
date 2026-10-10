export type HookDecision = "allow" | "warn" | "ask" | "deny";

export type HookProfile = "off" | "light" | "standard" | "strict" | "release";

export type HookEvent =
  | "project.resolve.before"
  | "context.recover.before"
  | "context.save.before"
  | "memory.write.before"
  | "memory.delete.preview"
  | "memory.delete.apply"
  | "memory.move.preview"
  | "memory.move.apply"
  | "memory.restore.preview"
  | "memory.restore.apply"
  | "obsidian.write.before"
  | "graphify.generate.before"
  | "install.preflight"
  | "install.beforePolicy"
  | "update.preflight"
  | "uninstall.beforeRemove"
  | "git.commit.before"
  | "git.push.before"
  | "git.reset.before"
  | "git.checkout.before"
  | "git.rebase.before"
  | "file.stage.before"
  | "dependency.add.before"
  | "api.change.before"
  | "database.change.before"
  | "quality.check.before";

export interface HookContext {
  event: HookEvent;
  harness: "cli" | "mcp" | "opencode" | "unknown";
  profile: HookProfile;
  cwd: string;
  projectRoot: string;
  malahorHome: string;
  project?: string;
  command?: string;
  targetPaths?: string[];
  memoryScope?: string;
  confirmation?: string;
  dryRun?: boolean;
  destructive?: boolean;
  metadata?: Record<string, unknown>;
}

export interface HookViolation {
  id: string;
  decision: HookDecision;
  message: string;
  fix: string;
}

export interface HookResult {
  event: HookEvent;
  profile: HookProfile;
  decision: HookDecision;
  violations: HookViolation[];
}

export interface HookRule {
  id: string;
  run: (context: HookContext) => HookViolation[];
}
