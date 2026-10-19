export interface ConfigLocation {
  opencodeDir: string;
  backupsDir?: string;
}

export interface ConfigSnapshot {
  path: string;
  text: string;
  hash: string;
  mode: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface ConfigConflict {
  path: string;
  reason: "value" | "security-review" | "semantic-alias" | "invalid-input";
}

export interface ConfigMerge {
  text: string;
  additions: string[];
  conflicts: ConfigConflict[];
}

export interface ConsolidationPlan {
  state: "missing" | "single" | "ready" | "blocked";
  directory: string;
  source?: ConfigSnapshot;
  target?: ConfigSnapshot;
  merge?: ConfigMerge;
  confirmation?: string;
  issue?: string;
  pending?: string[];
}

export type TransactionState = "prepared" | "applied" | "rolled-back" | "recovery-required";

export interface ConfigTransaction {
  version: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  directory: string;
  sourcePath: string;
  targetPath: string;
  disabledPath: string;
  sourceHash: string;
  targetHash: string;
  mergedHash: string;
  sourceMode: number;
  targetMode: number;
  state: TransactionState;
  note?: string;
}

export interface RollbackPlan {
  state: "missing" | "ready" | "blocked";
  directory: string;
  transaction?: ConfigTransaction;
  sourceBackup?: string;
  targetBackup?: string;
  confirmation?: string;
  issue?: string;
}

export interface ApplyResult {
  transaction: ConfigTransaction;
  backupsDir: string;
}
