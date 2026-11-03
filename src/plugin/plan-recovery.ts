import { createHash, randomBytes } from "node:crypto";

import {
  actionGraphForPlan,
  planExecutionProofHash,
  validState,
  type PlanDependency,
  type PlanStateV5,
} from "../cli/core/planning";
import type { PlanningAuthority } from "../cli/core/planning-authority";

export const PLAN_EXECUTION_SCHEMA = 1 as const;
export const PLAN_EXECUTION_KIND = "malahor.plan-execution" as const;

export type ActionExecutionState =
  | "ready"
  | "waiting"
  | "in-flight"
  | "succeeded"
  | "failed"
  | "blocked"
  | "removed";

export type PlanBlockerClass =
  | "host-ask"
  | "host-deny"
  | "loop-guard"
  | "technical-failure"
  | "undeclared-action"
  | "critical-control"
  | "dependency";

export interface PlanRecoveryStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove?: (key: string) => Promise<void>;
}

export interface PlanRecoveryRef {
  planID: string;
  revision: string;
  digest: string;
  proofHash: string;
  phase: "running" | "paused" | "blocked";
}

export interface PlanRecoveryGraphNode {
  key: string;
  actionID: string;
  dependsOn: string[];
}

export interface ActionExecutionNodeV1 {
  key: string;
  actionID: string;
  state: ActionExecutionState;
  dependsOn: string[];
  blockerID?: string;
  attemptOrdinal?: number;
  lastFailureSignature?: string;
  /** Secuencia firmada de éxito; los gates nunca heredan evidencia entre revisiones. */
  lastSuccessSequence?: number;
  verificationInputHash?: string;
}

export interface PlanBlockerV1 {
  blockerID: string;
  code: string;
  class: PlanBlockerClass;
  scope: "local" | "common";
  actionID?: string;
  descendants: string[];
  boundary?: string;
  control?: "authority" | "storage" | "policy" | "integrity";
  sessionID?: string;
  messageID?: string;
  callID?: string;
  policyHash?: string;
  resourceHash?: string;
  correlationHash?: string;
  createdAt: number;
}

export interface PlanExecutionIncidentV1 {
  code: string;
  actionID?: string;
  optional?: boolean;
  outcome?: string;
  recordedAt: number;
}

export interface ToolCallReservationV1 {
  reservationID: string;
  sessionID: string;
  messageID: string;
  callID: string;
  planID: string;
  revision: string;
  actionID: string;
  policyHash: string;
  resourceHash: string;
  createdAt: number;
}

export interface PlanExecutionCheckpointV1 {
  schema: typeof PLAN_EXECUTION_SCHEMA;
  kind: typeof PLAN_EXECUTION_KIND;
  plan: Omit<PlanRecoveryRef, "phase">;
  sequence: number;
  graphHash: string;
  nodes: Record<string, ActionExecutionNodeV1>;
  blockers: Record<string, PlanBlockerV1>;
  incidents: PlanExecutionIncidentV1[];
  reservations: Record<string, ToolCallReservationV1>;
  commonBlocker?: string;
  updatedAt: number;
  proof: string;
}

export interface RecoveryCorrelation {
  sessionID: string;
  messageID: string;
  callID: string;
  planID: string;
  revision: string;
  actionID: string;
  policyHash: string;
  resourceHash: string;
}

export interface PlanRecoveryDecision {
  decision: "continue" | "retry" | "block" | "ignore" | "discard";
  code: string;
  retryAllowed?: boolean;
  requiresPlanRevision?: boolean;
  reservationID?: string;
}

export interface PlanRecovery {
  recordPermissionDecision(input: RecoveryCorrelation & {
    effect: "allow" | "ask" | "deny";
    boundary: "permission.evaluate" | "tool.execute.before";
  }): Promise<PlanRecoveryDecision>;
  recordAttempt(input: {
    actionID: string;
    outcome: "success" | "failure";
    canonicalInputHash: string;
    errorHash?: string;
    resourceDigests: { before: string[]; after: string[] };
  }): Promise<PlanRecoveryDecision>;
  recordConversation(input: {
    kind: "question" | "answer";
    messageRef: string;
    text: string;
  }): Promise<PlanRecoveryDecision>;
  recordUndeclaredAction(input: {
    actionID: string;
    optional: boolean;
    source: "diagnostic" | "agent" | "tool";
  }): Promise<PlanRecoveryDecision>;
  setCommonBlocker(input: {
    code: "CRITICAL_CONTROL_UNAVAILABLE";
    class: "critical-control";
    control: "authority" | "storage" | "policy" | "integrity";
    boundary: string;
  }): Promise<PlanRecoveryDecision>;
  evaluateAction(actionID: string): Promise<{ effect: "allow" | "deny"; code: string }>;
  reserveToolCall(input: RecoveryCorrelation): Promise<PlanRecoveryDecision>;
  completeToolCall(input: RecoveryCorrelation & {
    reservationID: string;
    status: "success" | "failure";
    verificationInputHash?: string;
  }): Promise<PlanRecoveryDecision>;
  recoverInterruptedReservations(): Promise<PlanRecoveryDecision>;
  snapshot(): Promise<PlanExecutionCheckpointV1>;
}

export interface PlanRevisionDeltaV1 {
  preserved: string[];
  changed: string[];
  added: string[];
  removed: string[];
  planChanged?: boolean;
}

export interface PlanRevisionCandidateV1 {
  schema: 1;
  kind: "malahor.plan-revision-candidate";
  planID: string;
  parent: { revision: string; digest: string; proofHash: string };
  candidate: PlanStateV5;
  delta: PlanRevisionDeltaV1;
  checkpointRef: string;
  phase: "presented" | "reviewed" | "stale";
  proof: string;
}

export interface PlanRevisionLineageV1 {
  schema: 1;
  kind: "malahor.plan-revision-lineage";
  planID: string;
  parentActive: PlanStateV5;
  parentSuperseded: PlanStateV5;
  child: PlanStateV5;
  delta: PlanRevisionDeltaV1;
  parentCheckpointRef: string;
  childCheckpointRef: string;
  activatedAt: number;
  proof: string;
}

export interface PlanRevisionRecoverySnapshot {
  active: PlanStateV5;
  checkpoint: PlanExecutionCheckpointV1;
  candidate?: PlanRevisionCandidateV1;
  history: PlanStateV5[];
}

export interface PlanRevisionRecovery {
  presentCandidate(candidate: PlanStateV5): Promise<PlanRevisionCandidateV1>;
  activateCandidate(revision: string, blockedBy?: PlanDependency[]): Promise<PlanRevisionRecoverySnapshot>;
  rejectCandidate(revision: string): Promise<PlanRevisionRecoverySnapshot>;
  markCandidateStale(revision: string): Promise<PlanRevisionRecoverySnapshot>;
  recoverTransition(): Promise<PlanRevisionRecoverySnapshot>;
  snapshot(): Promise<PlanRevisionRecoverySnapshot>;
}

interface CreatePlanRecoveryInput {
  plan: PlanRecoveryRef;
  graph: PlanRecoveryGraphNode[];
  authority: PlanningAuthority;
  storage: PlanRecoveryStorage;
  now?: () => number;
}

interface CreatePlanRevisionRecoveryInput {
  parent: PlanStateV5;
  checkpoint: PlanExecutionCheckpointV1;
  storage: PlanRecoveryStorage;
  authority: PlanningAuthority;
  now?: () => number;
}

interface PlanRevisionTransitionV1 {
  schema: 1;
  kind: "malahor.plan-revision-transition";
  planID: string;
  parent: PlanStateV5;
  parentCheckpointProof: string;
  child: PlanStateV5;
  childCheckpoint: PlanExecutionCheckpointV1;
  supersededParent: PlanStateV5;
  delta: PlanRevisionDeltaV1;
  candidateProof: string;
  createdAt: number;
  proof: string;
}

interface Mutation<T> {
  result: T;
  changed: boolean;
}

const MAX_INCIDENTS = 256;
const transitions = new Map<string, Promise<void>>();
const revisionTransitions = new Map<string, Promise<void>>();

export function planExecutionKey(planID: string, revision: string): string {
  assertHex(planID, 32, "ID de plan");
  assertHex(revision, 32, "revisión");
  return `planning/v5/execution/${planID}/${revision}`;
}

export function planRevisionCandidateKey(planID: string): string {
  assertHex(planID, 32, "ID de plan");
  return `planning/v5/plans/${planID}/candidate`;
}

export function planRevisionTransitionKey(planID: string): string {
  assertHex(planID, 32, "ID de plan");
  return `planning/v5/plans/${planID}/transition`;
}

export function planRevisionLineageKey(planID: string, childRevision: string): string {
  assertHex(planID, 32, "ID de plan");
  assertHex(childRevision, 32, "revisión hija");
  return `planning/v5/plans/${planID}/lineage/${childRevision}`;
}

export function createPlanRecovery(input: CreatePlanRecoveryInput): PlanRecovery {
  const plan = normalizePlanRef(input.plan);
  const graph = normalizeGraph(input.graph);
  const graphHash = hashCanonical(graph);
  const storage = requireStorage(input.storage);
  const authority = input.authority;
  const now = typeof input.now === "function" ? input.now : Date.now;
  const key = planExecutionKey(plan.planID, plan.revision);

  const withCheckpoint = <T>(operation: (checkpoint: PlanExecutionCheckpointV1) => Mutation<T> | Promise<Mutation<T>>): Promise<T> =>
    serialize(key, async () => {
      const checkpoint = await loadOrCreateCheckpoint(storage, key, plan, graph, graphHash, authority, now);
      const beforeProof = checkpoint.proof;
      const beforeSequence = checkpoint.sequence;
      const mutation = await operation(checkpoint);
      if (!mutation.changed) return mutation.result;
      checkpoint.sequence = beforeSequence + 1;
      checkpoint.updatedAt = safeNow(now);
      checkpoint.proof = signCheckpoint(checkpoint, authority);
      await saveCheckpoint(storage, key, checkpoint, beforeProof, authority);
      return mutation.result;
    });

  return {
    recordPermissionDecision: (decision) => withCheckpoint((checkpoint) =>
      recordPermission(checkpoint, plan, decision, now)),
    recordAttempt: (attempt) => withCheckpoint((checkpoint) => recordAttempt(checkpoint, attempt, now)),
    recordConversation: async () => ({ decision: "ignore", code: "CONVERSATION_NOT_AUTHORITY" }),
    recordUndeclaredAction: (incident) => withCheckpoint((checkpoint) =>
      recordUndeclared(checkpoint, incident, now)),
    setCommonBlocker: (blocker) => withCheckpoint((checkpoint) =>
      setCommonBlocker(checkpoint, blocker, now)),
    evaluateAction: (actionID) => withCheckpoint((checkpoint) => ({
      result: evaluateNode(checkpoint, actionID),
      changed: false,
    })),
    reserveToolCall: (correlation) => withCheckpoint((checkpoint) =>
      reserveCall(checkpoint, plan, correlation, now)),
    completeToolCall: (completion) => withCheckpoint((checkpoint) =>
      completeCall(checkpoint, plan, completion)),
    recoverInterruptedReservations: () => withCheckpoint((checkpoint) =>
      recoverInterrupted(checkpoint, now)),
    snapshot: () => withCheckpoint((checkpoint) => ({
      result: structuredClone(checkpoint),
      changed: false,
    })),
  };
}

/**
 * Gestiona una revisión candidata sin sustituir la revisión activa hasta que
 * la aprobación normal ya fue concedida por el adaptador de Planning.
 */
export function createPlanRevisionRecovery(
  input: CreatePlanRevisionRecoveryInput,
): PlanRevisionRecovery {
  const authority = input.authority;
  const storage = requireStorage(input.storage);
  const now = typeof input.now === "function" ? input.now : Date.now;
  const parent = structuredClone(input.parent);
  const parentGraph = actionGraphForPlan(parent);
  const checkpoint = structuredClone(input.checkpoint);
  if (!validState(parent, authority) || parent.version !== 5
    || (parent.phase !== "running" && parent.phase !== "paused")) {
    throw new Error("La revisión padre debe ser un PlanState V5 iniciado y verificable.");
  }
  if (!validPlanExecutionCheckpoint(checkpoint, recoveryRef(parent), parentGraph, authority)) {
    throw new Error("El checkpoint de la revisión padre no es verificable.");
  }
  const lockKey = `${parent.planID}:${parent.sessionID}`;

  const serialized = <T>(operation: () => Promise<T>): Promise<T> =>
    serializeWith(revisionTransitions, lockKey, operation);

  const api: PlanRevisionRecovery = {
    presentCandidate: (candidate) => serialized(async () => {
      await ensureParentCheckpoint(storage, parent, checkpoint, authority);
      const normalized = createCandidateRecord(parent, candidate, checkpoint, authority);
      const key = planRevisionCandidateKey(parent.planID);
      if (typeof storage.remove === "function") await storage.remove(key);
      await writeAndVerify(storage, key, normalized, (value) =>
        validRevisionCandidate(value, parent, authority)
          && value.proof === normalized.proof);
      return structuredClone(normalized);
    }),
    activateCandidate: (revision, blockedBy = []) => serialized(async () => {
      assertRevisionID(revision);
      const pendingDependencies = normalizePendingDependencies(blockedBy);
      const marker = await loadTransition(storage, parent.planID, authority);
      if (marker) return recoverStoredTransition(storage, marker, parent, checkpoint, authority);
      const candidate = await loadCandidate(storage, parent, authority);
      if (!candidate || candidate.candidate.revision !== revision) {
        throw new Error("No hay una revisión candidata vigente para activar.");
      }
      if (candidate.phase === "stale") {
        throw new Error("La revisión candidata está stale o fue rechazada y ya no está vigente.");
      }
      const active = await readExactState(storage, activePlanKey(parent.sessionID), authority);
      if (!samePlanRevision(active, parent)) {
        throw new Error("La revisión padre dejó de estar vigente antes de activar el candidato.");
      }
      await ensureParentCheckpoint(storage, parent, checkpoint, authority);
      const timestamp = safeNow(now);
      const child = startCandidate(candidate.candidate, timestamp, authority, pendingDependencies);
      const supersededParent = supersedePlan(parent, timestamp, authority);
      const childCheckpoint = carryCheckpointForward(
        checkpoint,
        parentGraph,
        child,
        actionGraphForPlan(child),
        candidate.delta,
        timestamp,
        authority,
      );
      const transition = sealTransition({
        schema: 1,
        kind: "malahor.plan-revision-transition",
        planID: parent.planID,
        parent,
        parentCheckpointProof: checkpoint.proof,
        child,
        childCheckpoint,
        supersededParent,
        delta: candidate.delta,
        candidateProof: candidate.proof,
        createdAt: timestamp,
        proof: "",
      }, authority);

      await writeAndVerify(
        storage,
        planRevisionTransitionKey(parent.planID),
        transition,
        (value) => validTransition(value, authority) && value.proof === transition.proof,
      );
      await writeAndVerify(
        storage,
        planExecutionKey(child.planID, child.revision),
        childCheckpoint,
        (value) => validPlanExecutionCheckpoint(value, recoveryRef(child), actionGraphForPlan(child), authority)
          && value.proof === childCheckpoint.proof,
      );
      await writeAndVerify(
        storage,
        activePlanKey(child.sessionID),
        child,
        (value) => samePlanRevision(value, child, authority),
      );
      return finalizeTransition(storage, transition, authority);
    }),
    rejectCandidate: (revision) => serialized(async () => {
      await markStoredCandidateStale(storage, parent, revision, authority);
      return snapshotRevisionRecovery(storage, parent, checkpoint, authority);
    }),
    markCandidateStale: (revision) => serialized(async () => {
      await markStoredCandidateStale(storage, parent, revision, authority);
      return snapshotRevisionRecovery(storage, parent, checkpoint, authority);
    }),
    recoverTransition: () => serialized(async () => {
      const marker = await loadTransition(storage, parent.planID, authority);
      return marker
        ? recoverStoredTransition(storage, marker, parent, checkpoint, authority)
        : snapshotRevisionRecovery(storage, parent, checkpoint, authority);
    }),
    snapshot: () => serialized(async () => snapshotRevisionRecovery(
      storage,
      parent,
      checkpoint,
      authority,
    )),
  };
  return api;
}

export async function loadPlanRevisionCandidate(
  storage: PlanRecoveryStorage,
  parent: PlanStateV5,
  authority: PlanningAuthority,
): Promise<PlanRevisionCandidateV1 | undefined> {
  if (!validState(parent, authority) || parent.version !== 5) return undefined;
  return loadCandidate(requireStorage(storage), parent, authority);
}

export async function loadPlanRevisionLineage(
  storage: PlanRecoveryStorage,
  planID: string,
  childRevision: string,
  authority: PlanningAuthority,
): Promise<PlanRevisionLineageV1 | undefined> {
  const key = planRevisionLineageKey(planID, childRevision);
  const raw = await requireStorage(storage).get(key);
  if (raw === undefined) return undefined;
  if (!validRevisionLineage(raw, planID, childRevision, authority)) {
    throw new Error("El lineage de la revisión activada no es verificable.");
  }
  return structuredClone(raw);
}

export function validPlanExecutionCheckpoint(
  value: unknown,
  plan: PlanRecoveryRef,
  graph: PlanRecoveryGraphNode[],
  authority: PlanningAuthority,
): value is PlanExecutionCheckpointV1 {
  if (!isRecord(value) || value.schema !== PLAN_EXECUTION_SCHEMA || value.kind !== PLAN_EXECUTION_KIND
    || !isRecord(value.plan) || value.plan.planID !== plan.planID || value.plan.revision !== plan.revision
    || value.plan.digest !== plan.digest || value.plan.proofHash !== plan.proofHash
    || !integer(value.sequence) || (value.sequence as number) < 0
    || value.graphHash !== hashCanonical(normalizeGraph(graph))
    || !isRecord(value.nodes) || !isRecord(value.blockers) || !Array.isArray(value.incidents)
    || !isRecord(value.reservations) || !finiteNonNegative(value.updatedAt)
    || typeof value.proof !== "string") return false;
  const checkpoint = value as unknown as PlanExecutionCheckpointV1;
  if (!authority.verify(checkpointPayload(checkpoint), checkpoint.proof)) return false;
  const normalizedGraph = normalizeGraph(graph);
  if (Object.keys(checkpoint.nodes).length !== normalizedGraph.length) return false;
  if (!normalizedGraph.every((node) => validNode(checkpoint.nodes[node.actionID], node))) return false;
  if (!Object.values(checkpoint.blockers).every(validBlocker)) return false;
  if (!checkpoint.incidents.every(validIncident) || checkpoint.incidents.length > MAX_INCIDENTS) return false;
  if (!Object.values(checkpoint.reservations).every((reservation) => validReservation(reservation, plan))) return false;
  if (checkpoint.commonBlocker !== undefined) {
    const common = checkpoint.blockers[checkpoint.commonBlocker];
    if (!common || common.scope !== "common") return false;
  }
  return Object.values(checkpoint.nodes).every((node) => node.blockerID === undefined
    || checkpoint.blockers[node.blockerID]?.actionID === node.actionID);
}

function createCandidateRecord(
  parent: PlanStateV5,
  candidate: PlanStateV5,
  checkpoint: PlanExecutionCheckpointV1,
  authority: PlanningAuthority,
): PlanRevisionCandidateV1 {
  if (!validState(candidate, authority) || candidate.version !== 5
    || (candidate.phase !== "presented" && candidate.phase !== "reviewed")) {
    throw new Error("La revisión candidata no es un PlanState V5 presentado verificable.");
  }
  if (candidate.planID !== parent.planID || candidate.revision === parent.revision
    || candidate.sessionID !== parent.sessionID || candidate.project !== parent.project
    || candidate.mode !== parent.mode || candidate.policyRevision !== parent.policyRevision) {
    throw new Error("La revisión candidata no conserva la identidad y scope de la revisión padre.");
  }
  const delta = revisionDeltaForPlans(parent, candidate);
  const planChanged = delta.planChanged === true;
  if ([...delta.changed, ...delta.added, ...delta.removed].length === 0
    && !planChanged) {
    throw new Error("La revisión candidata no contiene un cambio material verificable.");
  }
  const unsigned: PlanRevisionCandidateV1 = {
    schema: 1,
    kind: "malahor.plan-revision-candidate",
    planID: parent.planID,
    parent: {
      revision: parent.revision,
      digest: parent.digest,
      proofHash: proofHash(parent),
    },
    candidate: structuredClone(candidate),
    delta,
    checkpointRef: planExecutionKey(parent.planID, checkpoint.plan.revision),
    phase: candidate.phase,
    proof: "",
  };
  return sealCandidate(unsigned, authority);
}

function revisionDeltaForPlans(
  parent: PlanStateV5,
  candidate: PlanStateV5,
): PlanRevisionDeltaV1 {
  const delta = revisionDelta(actionGraphForPlan(parent), actionGraphForPlan(candidate));
  if (!sameRevisionContent(parent, candidate)) delta.planChanged = true;
  return delta;
}

function sameRevisionContent(parent: PlanStateV5, candidate: PlanStateV5): boolean {
  return canonical({
    plan: parent.plan,
    actionIntents: parent.actionIntents,
    actionGraph: actionGraphForPlan(parent),
    specRef: parent.specRef,
    specHash: parent.specHash,
  }) === canonical({
    plan: candidate.plan,
    actionIntents: candidate.actionIntents,
    actionGraph: actionGraphForPlan(candidate),
    specRef: candidate.specRef,
    specHash: candidate.specHash,
  });
}

function revisionDelta(
  parentGraph: PlanRecoveryGraphNode[],
  candidateGraph: PlanRecoveryGraphNode[],
): PlanRevisionDeltaV1 {
  const parentByKey = new Map(parentGraph.map((node) => [node.key, node]));
  const candidateByKey = new Map(candidateGraph.map((node) => [node.key, node]));
  const delta: PlanRevisionDeltaV1 = { preserved: [], changed: [], added: [], removed: [] };
  for (const parent of parentGraph) {
    const candidate = candidateByKey.get(parent.key);
    if (!candidate) {
      delta.removed.push(parent.actionID);
      continue;
    }
    if (candidate.actionID === parent.actionID && sameSet(candidate.dependsOn, parent.dependsOn)) {
      delta.preserved.push(parent.actionID);
    } else {
      delta.changed.push(parent.actionID);
    }
  }
  for (const candidate of candidateGraph) {
    if (!parentByKey.has(candidate.key)) delta.added.push(candidate.actionID);
  }
  for (const values of Object.values(delta)) values.sort(compareText);
  return delta;
}

function carryCheckpointForward(
  parentCheckpoint: PlanExecutionCheckpointV1,
  parentGraphInput: PlanRecoveryGraphNode[],
  child: PlanStateV5,
  childGraphInput: PlanRecoveryGraphNode[],
  delta: PlanRevisionDeltaV1,
  now: number,
  authority: PlanningAuthority,
): PlanExecutionCheckpointV1 {
  const parentGraph = normalizeGraph(parentGraphInput);
  const childGraph = normalizeGraph(childGraphInput);
  const parentByID = new Map(parentGraph.map((node) => [node.actionID, node]));
  const preserved = new Set(delta.preserved);
  const nodes: Record<string, ActionExecutionNodeV1> = {};
  for (const node of childGraph) {
    const parentNode = parentCheckpoint.nodes[node.actionID];
    const parentDefinition = parentByID.get(node.actionID);
    const canCarrySuccess = !node.key.startsWith("quality-") && preserved.has(node.actionID)
      && parentNode?.state === "succeeded"
      && parentDefinition
      && sameSet(parentDefinition.dependsOn, node.dependsOn);
    nodes[node.actionID] = {
      key: node.key,
      actionID: node.actionID,
      state: canCarrySuccess ? "succeeded" : "waiting",
      dependsOn: [...node.dependsOn],
      ...(canCarrySuccess && parentNode.attemptOrdinal !== undefined
        ? { attemptOrdinal: parentNode.attemptOrdinal }
        : {}),
    };
  }
  const checkpoint: PlanExecutionCheckpointV1 = {
    schema: PLAN_EXECUTION_SCHEMA,
    kind: PLAN_EXECUTION_KIND,
    plan: {
      planID: child.planID,
      revision: child.revision,
      digest: child.digest,
      proofHash: proofHash(child),
    },
    sequence: 0,
    graphHash: hashCanonical(childGraph),
    nodes,
    blockers: {},
    incidents: [],
    reservations: {},
    updatedAt: now,
    proof: "",
  };
  refreshWaitingNodes(checkpoint);
  checkpoint.proof = signCheckpoint(checkpoint, authority);
  if (!validPlanExecutionCheckpoint(checkpoint, recoveryRef(child), childGraph, authority)) {
    throw new Error("El checkpoint hijo no pudo verificarse después del carry-forward.");
  }
  return checkpoint;
}

async function recoverStoredTransition(
  storage: PlanRecoveryStorage,
  transition: PlanRevisionTransitionV1,
  expectedParent: PlanStateV5,
  expectedCheckpoint: PlanExecutionCheckpointV1,
  authority: PlanningAuthority,
): Promise<PlanRevisionRecoverySnapshot> {
  if (!samePlanRevision(transition.parent, expectedParent)
    || transition.parentCheckpointProof !== expectedCheckpoint.proof) {
    throw new Error("La transición pendiente no pertenece a la revisión padre vigente.");
  }
  const active = await readExactState(storage, activePlanKey(expectedParent.sessionID), authority);
  const storedChildCheckpoint = await storage.get(planExecutionKey(
    transition.child.planID,
    transition.child.revision,
  ));
  const childVerifiable = samePlanRevision(active, transition.child)
    && validPlanExecutionCheckpoint(
      storedChildCheckpoint,
      recoveryRef(transition.child),
      actionGraphForPlan(transition.child),
      authority,
    )
    && storedChildCheckpoint.proof === transition.childCheckpoint.proof;
  if (childVerifiable) return finalizeTransition(storage, transition, authority);

  await writeAndVerify(
    storage,
    activePlanKey(expectedParent.sessionID),
    expectedParent,
    (value) => samePlanRevision(value, expectedParent, authority),
  );
  await writeAndVerify(
    storage,
    planRecordStorageKey(expectedParent.planID),
    expectedParent,
    (value) => samePlanRevision(value, expectedParent, authority),
  );
  await writeAndVerify(
    storage,
    planRevisionStorageKey(expectedParent.planID, expectedParent.revision),
    expectedParent,
    (value) => samePlanRevision(value, expectedParent, authority),
  );
  if (typeof storage.remove === "function") {
    await storage.remove(planExecutionKey(transition.child.planID, transition.child.revision));
    await storage.remove(planRevisionTransitionKey(expectedParent.planID));
  } else {
    throw new Error("No se puede retirar una transición incompleta sin soporte remove.");
  }
  return snapshotRevisionRecovery(storage, expectedParent, expectedCheckpoint, authority);
}

async function finalizeTransition(
  storage: PlanRecoveryStorage,
  transition: PlanRevisionTransitionV1,
  authority: PlanningAuthority,
): Promise<PlanRevisionRecoverySnapshot> {
  const child = transition.child;
  await writeAndVerify(
    storage,
    planRecordStorageKey(child.planID),
    child,
    (value) => samePlanRevision(value, child, authority),
  );
  await writeAndVerify(
    storage,
    planRevisionStorageKey(child.planID, child.revision),
    child,
    (value) => samePlanRevision(value, child, authority),
  );
  await writeAndVerify(
    storage,
    planRevisionStorageKey(transition.supersededParent.planID, transition.supersededParent.revision),
    transition.supersededParent,
    (value) => samePlanRevision(value, transition.supersededParent, authority),
  );
  const lineage = sealRevisionLineage({
    schema: 1,
    kind: "malahor.plan-revision-lineage",
    planID: child.planID,
    parentActive: transition.parent,
    parentSuperseded: transition.supersededParent,
    child,
    delta: transition.delta,
    parentCheckpointRef: planExecutionKey(transition.parent.planID, transition.parent.revision),
    childCheckpointRef: planExecutionKey(child.planID, child.revision),
    activatedAt: transition.createdAt,
    proof: "",
  }, authority);
  await writeAndVerify(
    storage,
    planRevisionLineageKey(child.planID, child.revision),
    lineage,
    (value) => validRevisionLineage(value, child.planID, child.revision, authority)
      && value.proof === lineage.proof,
  );
  const active = await readExactState(storage, activePlanKey(child.sessionID), authority);
  const checkpoint = await storage.get(planExecutionKey(child.planID, child.revision));
  if (!samePlanRevision(active, child)
    || !validPlanExecutionCheckpoint(checkpoint, recoveryRef(child), actionGraphForPlan(child), authority)) {
    throw new Error("La activación no quedó verificable; la transición se conserva para recuperación.");
  }
  if (typeof storage.remove !== "function") {
    throw new Error("La activación no puede cerrarse sin soporte remove para el marcador.");
  }
  await storage.remove(planRevisionTransitionKey(child.planID));
  await storage.remove(planRevisionCandidateKey(child.planID));
  return {
    active: structuredClone(child),
    checkpoint: structuredClone(checkpoint),
    history: [structuredClone(transition.supersededParent)],
  };
}

async function snapshotRevisionRecovery(
  storage: PlanRecoveryStorage,
  originalParent: PlanStateV5,
  originalCheckpoint: PlanExecutionCheckpointV1,
  authority: PlanningAuthority,
): Promise<PlanRevisionRecoverySnapshot> {
  const marker = await loadTransition(storage, originalParent.planID, authority);
  if (marker) return recoverStoredTransition(storage, marker, originalParent, originalCheckpoint, authority);
  const active = await readExactState(storage, activePlanKey(originalParent.sessionID), authority);
  if (!active || active.planID !== originalParent.planID || active.sessionID !== originalParent.sessionID) {
    throw new Error("La revisión activa dejó de ser verificable.");
  }
  const rawCheckpoint = await storage.get(planExecutionKey(active.planID, active.revision));
  if (!validPlanExecutionCheckpoint(rawCheckpoint, recoveryRef(active), actionGraphForPlan(active), authority)) {
    throw new Error("El checkpoint activo dejó de ser verificable.");
  }
  const candidate = await loadCandidate(storage, originalParent, authority);
  const rawParentHistory = await storage.get(planRevisionStorageKey(
    originalParent.planID,
    originalParent.revision,
  ));
  const history = validState(rawParentHistory, authority) && rawParentHistory.version === 5
    && rawParentHistory.phase === "superseded"
    ? [structuredClone(rawParentHistory)]
    : [];
  return {
    active: structuredClone(active),
    checkpoint: structuredClone(rawCheckpoint),
    ...(candidate ? { candidate: structuredClone(candidate) } : {}),
    history,
  };
}

async function markStoredCandidateStale(
  storage: PlanRecoveryStorage,
  parent: PlanStateV5,
  revision: string,
  authority: PlanningAuthority,
): Promise<void> {
  assertRevisionID(revision);
  const candidate = await loadCandidate(storage, parent, authority);
  if (!candidate || candidate.candidate.revision !== revision) {
    throw new Error("No hay una revisión candidata vigente para rechazar o marcar stale.");
  }
  if (candidate.phase === "stale") return;
  const stale = sealCandidate({ ...candidate, phase: "stale", proof: "" }, authority);
  await writeAndVerify(storage, planRevisionCandidateKey(parent.planID), stale, (value) =>
    validRevisionCandidate(value, parent, authority)
      && value.phase === "stale" && value.proof === stale.proof);
}

async function ensureParentCheckpoint(
  storage: PlanRecoveryStorage,
  parent: PlanStateV5,
  checkpoint: PlanExecutionCheckpointV1,
  authority: PlanningAuthority,
): Promise<void> {
  const active = await readExactState(storage, activePlanKey(parent.sessionID), authority);
  if (!samePlanRevision(active, parent)) {
    throw new Error("La revisión padre ya no está vigente.");
  }
  const stored = await storage.get(planExecutionKey(parent.planID, parent.revision));
  if (!validPlanExecutionCheckpoint(stored, recoveryRef(parent), actionGraphForPlan(parent), authority)
    || stored.proof !== checkpoint.proof || stored.sequence !== checkpoint.sequence) {
    throw new Error("El checkpoint de la revisión padre cambió o dejó de ser verificable.");
  }
}

async function loadCandidate(
  storage: PlanRecoveryStorage,
  parent: PlanStateV5,
  authority: PlanningAuthority,
): Promise<PlanRevisionCandidateV1 | undefined> {
  const raw = await storage.get(planRevisionCandidateKey(parent.planID));
  if (raw === undefined) return undefined;
  if (!validRevisionCandidate(raw, parent, authority)) {
    throw new Error("La revisión candidata persistida no es verificable.");
  }
  return structuredClone(raw);
}

function validRevisionCandidate(
  value: unknown,
  parent: PlanStateV5,
  authority: PlanningAuthority,
): value is PlanRevisionCandidateV1 {
  if (!isRecord(value) || value.schema !== 1 || value.kind !== "malahor.plan-revision-candidate"
    || value.planID !== parent.planID || !isRecord(value.parent)
    || value.parent.revision !== parent.revision || value.parent.digest !== parent.digest
    || value.parent.proofHash !== proofHash(parent)
    || !validState(value.candidate, authority) || value.candidate.version !== 5
    || value.candidate.planID !== parent.planID || value.candidate.revision === parent.revision
    || !validDelta(value.delta) || value.checkpointRef !== planExecutionKey(parent.planID, parent.revision)
    || !["presented", "reviewed", "stale"].includes(String(value.phase))
    || typeof value.proof !== "string") return false;
  const candidate = value as unknown as PlanRevisionCandidateV1;
  const expectedDelta = revisionDeltaForPlans(parent, candidate.candidate);
  return sameRevisionDelta(candidate.delta, expectedDelta)
    && ([...expectedDelta.changed, ...expectedDelta.added, ...expectedDelta.removed].length > 0
      || expectedDelta.planChanged === true)
    && authority.verify(candidatePayload(candidate), value.proof);
}

function validDelta(value: unknown): value is PlanRevisionDeltaV1 {
  if (!isRecord(value)) return false;
  const groups = [value.preserved, value.changed, value.added, value.removed];
  if (groups.some((group) => !Array.isArray(group)
    || group.some((actionID) => !validHex(actionID, 64))
    || new Set(group).size !== group.length)) return false;
  const all = groups.flat() as string[];
  return new Set(all).size === all.length
    && (value.planChanged === undefined || typeof value.planChanged === "boolean");
}

function sameRevisionDelta(left: PlanRevisionDeltaV1, right: PlanRevisionDeltaV1): boolean {
  return sameStrings(left.preserved, right.preserved)
    && sameStrings(left.changed, right.changed)
    && sameStrings(left.added, right.added)
    && sameStrings(left.removed, right.removed)
    && (left.planChanged === true) === (right.planChanged === true);
}

function sealCandidate(
  candidate: PlanRevisionCandidateV1,
  authority: PlanningAuthority,
): PlanRevisionCandidateV1 {
  const unsigned = { ...candidate, proof: "" };
  return { ...unsigned, proof: authority.sign(candidatePayload(unsigned)) };
}

function candidatePayload(candidate: PlanRevisionCandidateV1): string {
  const { proof: _proof, ...payload } = candidate;
  return canonical(payload);
}

async function loadTransition(
  storage: PlanRecoveryStorage,
  planID: string,
  authority: PlanningAuthority,
): Promise<PlanRevisionTransitionV1 | undefined> {
  const raw = await storage.get(planRevisionTransitionKey(planID));
  if (raw === undefined) return undefined;
  if (!validTransition(raw, authority) || raw.planID !== planID) {
    throw new Error("El marcador de transición no es verificable.");
  }
  return structuredClone(raw);
}

function validTransition(value: unknown, authority: PlanningAuthority): value is PlanRevisionTransitionV1 {
  if (!isRecord(value) || value.schema !== 1 || value.kind !== "malahor.plan-revision-transition"
    || !validHex(value.planID, 32) || !validState(value.parent, authority) || value.parent.version !== 5
    || !validState(value.child, authority) || value.child.version !== 5
    || !validState(value.supersededParent, authority) || value.supersededParent.version !== 5
    || value.parent.planID !== value.planID || value.child.planID !== value.planID
    || value.supersededParent.planID !== value.planID
    || (value.parent.phase !== "running" && value.parent.phase !== "paused")
    || (value.child.phase !== "running" && value.child.phase !== "blocked")
    || value.supersededParent.phase !== "superseded"
    || value.supersededParent.revision !== value.parent.revision
    || !validDelta(value.delta)
    || !validHex(value.parentCheckpointProof, 64) || !validHex(value.candidateProof, 64)
    || !finiteNonNegative(value.createdAt) || typeof value.proof !== "string") return false;
  const transition = value as unknown as PlanRevisionTransitionV1;
  const child = transition.child;
  if (!validPlanExecutionCheckpoint(
    transition.childCheckpoint,
    recoveryRef(child),
    actionGraphForPlan(child),
    authority,
  )) return false;
  return sameRevisionDelta(transition.delta, revisionDeltaForPlans(transition.parent, child))
    && authority.verify(transitionPayload(transition), transition.proof);
}

function sealTransition(
  transition: PlanRevisionTransitionV1,
  authority: PlanningAuthority,
): PlanRevisionTransitionV1 {
  const unsigned = { ...transition, proof: "" };
  return { ...unsigned, proof: authority.sign(transitionPayload(unsigned)) };
}

function transitionPayload(transition: PlanRevisionTransitionV1): string {
  const { proof: _proof, ...payload } = transition;
  return canonical(payload);
}

function sealRevisionLineage(
  lineage: PlanRevisionLineageV1,
  authority: PlanningAuthority,
): PlanRevisionLineageV1 {
  const unsigned = { ...lineage, proof: "" };
  return { ...unsigned, proof: authority.sign(revisionLineagePayload(unsigned)) };
}

function validRevisionLineage(
  value: unknown,
  planID: string,
  childRevision: string,
  authority: PlanningAuthority,
): value is PlanRevisionLineageV1 {
  if (!isRecord(value) || value.schema !== 1 || value.kind !== "malahor.plan-revision-lineage"
    || value.planID !== planID || !validState(value.parentActive, authority)
    || value.parentActive.version !== 5 || !validState(value.parentSuperseded, authority)
    || value.parentSuperseded.version !== 5 || !validState(value.child, authority)
    || value.child.version !== 5 || value.parentActive.planID !== planID
    || value.parentSuperseded.planID !== planID || value.child.planID !== planID
    || value.parentActive.revision === childRevision
    || value.parentSuperseded.revision !== value.parentActive.revision
    || value.child.revision !== childRevision
    || (value.parentActive.phase !== "running" && value.parentActive.phase !== "paused")
    || value.parentSuperseded.phase !== "superseded"
    || (value.child.phase !== "running" && value.child.phase !== "blocked")
    || !validDelta(value.delta)
    || value.parentCheckpointRef !== planExecutionKey(planID, value.parentActive.revision)
    || value.childCheckpointRef !== planExecutionKey(planID, childRevision)
    || !finiteNonNegative(value.activatedAt) || typeof value.proof !== "string") return false;
  const lineage = value as unknown as PlanRevisionLineageV1;
  return sameRevisionDelta(lineage.delta, revisionDeltaForPlans(lineage.parentActive, lineage.child))
    && authority.verify(revisionLineagePayload(lineage), lineage.proof);
}

function revisionLineagePayload(lineage: PlanRevisionLineageV1): string {
  const { proof: _proof, ...payload } = lineage;
  return canonical(payload);
}

function startCandidate(
  candidate: PlanStateV5,
  now: number,
  authority: PlanningAuthority,
  blockedBy: PlanDependency[] = [],
): PlanStateV5 {
  const blocked = blockedBy.length > 0;
  return sealPlanState({
    ...candidate,
    phase: blocked ? "blocked" : "running",
    authorizedAt: now,
    ...(blocked
      ? { blockedAt: now, blockedBy }
      : { startedAt: now, blockedAt: undefined, blockedBy: undefined }),
    updatedAt: now,
  }, authority);
}

function normalizePendingDependencies(value: PlanDependency[]): PlanDependency[] {
  if (!Array.isArray(value) || value.length > 30 || value.some((dependency) => !dependency
    || !validHex(dependency.planID, 32) || !validHex(dependency.revision, 32))) {
    throw new Error("Dependencias pendientes no evaluables para activar la revisión.");
  }
  const unique = new Map(value.map((dependency) => [
    `${dependency.planID}\0${dependency.revision}`,
    { planID: dependency.planID, revision: dependency.revision },
  ]));
  return [...unique.values()].sort((left, right) => compareText(
    `${left.planID}\0${left.revision}`,
    `${right.planID}\0${right.revision}`,
  ));
}

function supersedePlan(
  parent: PlanStateV5,
  now: number,
  authority: PlanningAuthority,
): PlanStateV5 {
  return sealPlanState({
    ...parent,
    phase: "superseded",
    supersededAt: now,
    updatedAt: now,
  }, authority);
}

function sealPlanState(state: PlanStateV5, authority: PlanningAuthority): PlanStateV5 {
  const unsigned = { ...state, proof: "" };
  const { proof: _proof, ...payload } = unsigned;
  const sealed = { ...unsigned, proof: authority.sign(canonical(payload)) };
  if (!validState(sealed, authority) || sealed.version !== 5) {
    throw new Error("La transición produjo un estado de plan no verificable.");
  }
  return sealed;
}

function recoveryRef(state: PlanStateV5): PlanRecoveryRef {
  return {
    planID: state.planID,
    revision: state.revision,
    digest: state.digest,
    proofHash: planExecutionProofHash(state),
    phase: state.phase === "paused" || state.phase === "blocked" ? state.phase : "running",
  };
}

function proofHash(state: PlanStateV5): string {
  return createHash("sha256").update(state.proof).digest("hex");
}

async function readExactState(
  storage: PlanRecoveryStorage,
  key: string,
  authority: PlanningAuthority,
): Promise<PlanStateV5 | undefined> {
  const raw = await storage.get(key);
  return validState(raw, authority) && raw.version === 5 ? structuredClone(raw) : undefined;
}

async function writeAndVerify<T>(
  storage: PlanRecoveryStorage,
  key: string,
  value: T,
  valid: (read: unknown) => boolean,
): Promise<void> {
  await storage.set(key, structuredClone(value));
  const persisted = await storage.get(key);
  if (!valid(persisted)) throw new Error(`La escritura durable no quedó verificable: ${key}. Completa, pausa o revoca el plan antes de reintentar.`);
}

function samePlanRevision(
  value: unknown,
  expected: PlanStateV5,
  authority?: PlanningAuthority,
): value is PlanStateV5 {
  return (!authority || validState(value, authority)) && isRecord(value)
    && value.version === 5 && value.planID === expected.planID
    && value.revision === expected.revision && value.digest === expected.digest
    && value.proof === expected.proof && value.phase === expected.phase;
}

function activePlanKey(sessionID: string): string {
  if (!/^ses[A-Za-z0-9_-]{1,128}$/.test(sessionID)) throw new Error("ID de sesión no evaluable.");
  return `planning/v5/sessions/${sessionID}`;
}

function planRecordStorageKey(planID: string): string {
  assertHex(planID, 32, "ID de plan");
  return `planning/v5/plans/${planID}`;
}

function planRevisionStorageKey(planID: string, revision: string): string {
  assertHex(revision, 32, "revisión");
  return `${planRecordStorageKey(planID)}/revisions/${revision}`;
}

function assertRevisionID(revision: string): void {
  assertHex(revision, 32, "revisión candidata");
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(compareText);
  const sortedRight = [...right].sort(compareText);
  return sortedLeft.every((item, index) => item === sortedRight[index]);
}

function recordPermission(
  checkpoint: PlanExecutionCheckpointV1,
  plan: PlanRecoveryRef,
  input: RecoveryCorrelation & {
    effect: "allow" | "ask" | "deny";
    boundary: "permission.evaluate" | "tool.execute.before";
  },
  now: () => number,
): Mutation<PlanRecoveryDecision> {
  const correlation = normalizeCorrelation(input, plan);
  if (!correlation) return unchanged(block("PLAN_CORRELATION_MISMATCH"));
  const node = checkpoint.nodes[correlation.actionID];
  if (!node) return unchanged(block("ACTION_NOT_DECLARED", true));

  if (input.effect === "allow") {
    if (!node.blockerID) {
      const evaluated = evaluateNode(checkpoint, node.actionID);
      return unchanged(evaluated.effect === "allow"
        ? { decision: "continue", code: "AUTHORIZED" }
        : block(evaluated.code));
    }
    const blocker = checkpoint.blockers[node.blockerID];
    if (!blocker || !revalidationMatches(blocker, correlation, input.boundary)) {
      return unchanged(block(blocker?.code ?? "PLAN_CHECKPOINT_INVALID"));
    }
    delete checkpoint.blockers[node.blockerID];
    delete node.blockerID;
    node.state = dependenciesSucceeded(checkpoint, node) ? "ready" : "waiting";
    refreshWaitingNodes(checkpoint);
    return changed({ decision: "continue", code: "BLOCKER_REVALIDATED" });
  }

  const code = input.effect === "ask" ? "HOST_ASK" : "HOST_DENY";
  const blockerClass = input.effect === "ask" ? "host-ask" : "host-deny";
  setLocalBlocker(checkpoint, node.actionID, {
    code,
    class: blockerClass,
    boundary: input.boundary,
    sessionID: correlation.sessionID,
    messageID: correlation.messageID,
    callID: correlation.callID,
    policyHash: correlation.policyHash,
    resourceHash: correlation.resourceHash,
    correlationHash: hashCanonical(correlation),
  }, now);
  return changed(block(code));
}

function recordAttempt(
  checkpoint: PlanExecutionCheckpointV1,
  input: {
    actionID: string;
    outcome: "success" | "failure";
    canonicalInputHash: string;
    errorHash?: string;
    resourceDigests: { before: string[]; after: string[] };
  },
  now: () => number,
): Mutation<PlanRecoveryDecision> {
  const node = checkpoint.nodes[input.actionID];
  if (!node) return unchanged(block("ACTION_NOT_DECLARED", true));
  const evaluated = evaluateNode(checkpoint, node.actionID);
  if (evaluated.effect === "deny" && node.state !== "failed") return unchanged(block(evaluated.code));
  const signature = failureSignature(input);
  node.attemptOrdinal = (node.attemptOrdinal ?? 0) + 1;

  if (input.outcome === "success") {
    node.state = "succeeded";
    node.lastSuccessSequence = checkpoint.sequence + 1;
    delete node.verificationInputHash;
    delete node.lastFailureSignature;
    refreshWaitingNodes(checkpoint);
    return changed({ decision: "continue", code: "AUTHORIZED", retryAllowed: false });
  }

  if (node.lastFailureSignature === signature) {
    setLocalBlocker(checkpoint, node.actionID, {
      code: "LOOP_GUARD_STALLED",
      class: "loop-guard",
    }, now);
    return changed(block("LOOP_GUARD_STALLED"));
  }
  node.state = "failed";
  node.lastFailureSignature = signature;
  return changed({ decision: "retry", code: "TECHNICAL_RETRY", retryAllowed: true });
}

function recordUndeclared(
  checkpoint: PlanExecutionCheckpointV1,
  input: { actionID: string; optional: boolean; source: "diagnostic" | "agent" | "tool" },
  now: () => number,
): Mutation<PlanRecoveryDecision> {
  const actionID = validHex(input.actionID, 64) ? input.actionID : undefined;
  appendIncident(checkpoint, {
    code: "ACTION_NOT_DECLARED",
    ...(actionID ? { actionID } : {}),
    optional: input.optional === true,
    outcome: input.optional === true ? "discarded" : "revision-required",
    recordedAt: safeNow(now),
  });
  return changed(input.optional === true
    ? { decision: "discard", code: "ACTION_NOT_DECLARED", retryAllowed: false, requiresPlanRevision: false }
    : block("ACTION_NOT_DECLARED", true));
}

function setCommonBlocker(
  checkpoint: PlanExecutionCheckpointV1,
  input: {
    code: "CRITICAL_CONTROL_UNAVAILABLE";
    class: "critical-control";
    control: "authority" | "storage" | "policy" | "integrity";
    boundary: string;
  },
  now: () => number,
): Mutation<PlanRecoveryDecision> {
  if (checkpoint.commonBlocker) return unchanged(block("CRITICAL_CONTROL_UNAVAILABLE"));
  const blockerID = createBlockerID(checkpoint, input.code);
  checkpoint.blockers[blockerID] = {
    blockerID,
    code: input.code,
    class: input.class,
    scope: "common",
    descendants: [],
    control: input.control,
    boundary: safeLabel(input.boundary, "unknown"),
    createdAt: safeNow(now),
  };
  checkpoint.commonBlocker = blockerID;
  return changed(block(input.code));
}

function reserveCall(
  checkpoint: PlanExecutionCheckpointV1,
  plan: PlanRecoveryRef,
  input: RecoveryCorrelation,
  now: () => number,
): Mutation<PlanRecoveryDecision> {
  const correlation = normalizeCorrelation(input, plan);
  if (!correlation) return unchanged(block("PLAN_CORRELATION_MISMATCH"));
  const evaluated = evaluateNode(checkpoint, correlation.actionID);
  const node = checkpoint.nodes[correlation.actionID]!;
  if (evaluated.effect === "deny"
    && !(evaluated.code === "DEPENDENCY_BLOCKED" && dependenciesReservedByCall(checkpoint, node, correlation))) {
    return unchanged(block(evaluated.code));
  }
  if (node.state === "succeeded") return unchanged(block("ACTION_ALREADY_COMPLETED"));
  if (Object.values(checkpoint.reservations).some((reservation) => reservation.actionID === node.actionID)) {
    return unchanged(block("ACTION_IN_FLIGHT"));
  }
  const reservationID = `res_${createHash("sha256").update(canonical({
    correlation,
    sequence: checkpoint.sequence,
    nonce: randomBytes(8).toString("hex"),
  })).digest("hex").slice(0, 24)}`;
  checkpoint.reservations[reservationID] = {
    reservationID,
    ...correlation,
    createdAt: safeNow(now),
  };
  node.state = "in-flight";
  return changed({ decision: "continue", code: "CALL_RESERVED", reservationID });
}

function dependenciesReservedByCall(
  checkpoint: PlanExecutionCheckpointV1,
  node: ActionExecutionNodeV1,
  correlation: RecoveryCorrelation,
): boolean {
  return node.dependsOn.every((dependency) => {
    if (checkpoint.nodes[dependency]?.state === "succeeded") return true;
    return Object.values(checkpoint.reservations).some((reservation) => reservation.actionID === dependency
      && reservation.sessionID === correlation.sessionID && reservation.messageID === correlation.messageID
      && reservation.callID === correlation.callID && reservation.policyHash === correlation.policyHash
      && reservation.resourceHash === correlation.resourceHash);
  });
}

function completeCall(
  checkpoint: PlanExecutionCheckpointV1,
  plan: PlanRecoveryRef,
  input: RecoveryCorrelation & {
    reservationID: string;
    status: "success" | "failure";
    verificationInputHash?: string;
  },
): Mutation<PlanRecoveryDecision> {
  const correlation = normalizeCorrelation(input, plan);
  const reservation = checkpoint.reservations[input.reservationID];
  if (!correlation || !reservation) return unchanged({ decision: "ignore", code: "RESERVATION_NOT_FOUND" });
  if (!sameCorrelation(reservation, correlation)) {
    return unchanged({ decision: "ignore", code: "RESERVATION_MISMATCH" });
  }
  const node = checkpoint.nodes[correlation.actionID];
  if (!node || node.state !== "in-flight") {
    return unchanged({ decision: "ignore", code: "RESERVATION_STALE" });
  }
  delete checkpoint.reservations[input.reservationID];
  if (input.status === "success") {
    node.state = "succeeded";
    node.lastSuccessSequence = checkpoint.sequence + 1;
    if (input.verificationInputHash) node.verificationInputHash = input.verificationInputHash;
    else delete node.verificationInputHash;
    delete node.lastFailureSignature;
    refreshWaitingNodes(checkpoint);
    return changed({ decision: "continue", code: "ACTION_SUCCEEDED", retryAllowed: false });
  }
  node.state = "failed";
  delete node.verificationInputHash;
  return changed({ decision: "retry", code: "TECHNICAL_RETRY", retryAllowed: true });
}

function recoverInterrupted(
  checkpoint: PlanExecutionCheckpointV1,
  now: () => number,
): Mutation<PlanRecoveryDecision> {
  const reservations = Object.values(checkpoint.reservations);
  if (reservations.length === 0) return unchanged({ decision: "continue", code: "NO_INTERRUPTED_CALLS" });
  for (const reservation of reservations) {
    const node = checkpoint.nodes[reservation.actionID];
    if (node?.state === "in-flight") node.state = "failed";
    appendIncident(checkpoint, {
      code: "TOOL_CALL_INTERRUPTED",
      actionID: reservation.actionID,
      outcome: "retry-required",
      recordedAt: safeNow(now),
    });
  }
  checkpoint.reservations = {};
  return changed({ decision: "retry", code: "INTERRUPTED_CALLS_RECOVERED", retryAllowed: true });
}

function evaluateNode(
  checkpoint: PlanExecutionCheckpointV1,
  actionID: string,
): { effect: "allow" | "deny"; code: string } {
  if (checkpoint.commonBlocker) {
    return { effect: "deny", code: checkpoint.blockers[checkpoint.commonBlocker]?.code ?? "CRITICAL_CONTROL_UNAVAILABLE" };
  }
  const node = checkpoint.nodes[actionID];
  if (!node) return { effect: "deny", code: "ACTION_NOT_DECLARED" };
  if (node.blockerID) return { effect: "deny", code: checkpoint.blockers[node.blockerID]?.code ?? "PLAN_CHECKPOINT_INVALID" };
  if (!dependenciesSucceeded(checkpoint, node)) return { effect: "deny", code: "DEPENDENCY_BLOCKED" };
  if (node.state === "in-flight") return { effect: "deny", code: "ACTION_IN_FLIGHT" };
  if (node.state === "removed") return { effect: "deny", code: "ACTION_REMOVED" };
  return { effect: "allow", code: "AUTHORIZED" };
}

function setLocalBlocker(
  checkpoint: PlanExecutionCheckpointV1,
  actionID: string,
  input: Omit<PlanBlockerV1, "blockerID" | "scope" | "actionID" | "descendants" | "createdAt">,
  now: () => number,
): void {
  const node = checkpoint.nodes[actionID];
  if (!node) throw new Error("ACTION_NOT_DECLARED");
  if (node.blockerID) delete checkpoint.blockers[node.blockerID];
  const descendants = descendantIDs(checkpoint, actionID);
  const blockerID = createBlockerID(checkpoint, input.code);
  checkpoint.blockers[blockerID] = {
    blockerID,
    ...input,
    scope: "local",
    actionID,
    descendants,
    createdAt: safeNow(now),
  };
  node.blockerID = blockerID;
  node.state = "blocked";
  for (const descendant of descendants) {
    const dependent = checkpoint.nodes[descendant];
    if (dependent && dependent.state !== "succeeded" && dependent.state !== "removed") dependent.state = "waiting";
  }
}

function refreshWaitingNodes(checkpoint: PlanExecutionCheckpointV1): void {
  for (const node of Object.values(checkpoint.nodes)) {
    if (node.state === "succeeded" || node.state === "removed" || node.state === "blocked" || node.state === "in-flight") continue;
    node.state = dependenciesSucceeded(checkpoint, node) ? (node.state === "failed" ? "failed" : "ready") : "waiting";
  }
}

function dependenciesSucceeded(checkpoint: PlanExecutionCheckpointV1, node: ActionExecutionNodeV1): boolean {
  return node.dependsOn.every((dependency) => checkpoint.nodes[dependency]?.state === "succeeded");
}

function descendantIDs(checkpoint: PlanExecutionCheckpointV1, actionID: string): string[] {
  const descendants = new Set<string>();
  const pending = [actionID];
  while (pending.length > 0) {
    const parent = pending.shift()!;
    for (const node of Object.values(checkpoint.nodes)) {
      if (!descendants.has(node.actionID) && node.dependsOn.includes(parent)) {
        descendants.add(node.actionID);
        pending.push(node.actionID);
      }
    }
  }
  return [...descendants].sort(compareText);
}

function revalidationMatches(blocker: PlanBlockerV1, correlation: RecoveryCorrelation, boundary: string): boolean {
  if (blocker.scope !== "local" || blocker.actionID !== correlation.actionID || blocker.boundary !== boundary
    || blocker.sessionID !== correlation.sessionID || blocker.policyHash !== correlation.policyHash) return false;
  if (blocker.class === "host-ask") return blocker.correlationHash === hashCanonical(correlation);
  return blocker.class === "host-deny";
}

async function loadOrCreateCheckpoint(
  storage: PlanRecoveryStorage,
  key: string,
  plan: PlanRecoveryRef,
  graph: PlanRecoveryGraphNode[],
  graphHash: string,
  authority: PlanningAuthority,
  now: () => number,
): Promise<PlanExecutionCheckpointV1> {
  const existing = await storage.get(key);
  if (existing !== undefined) {
    if (!validPlanExecutionCheckpoint(existing, plan, graph, authority)) {
      throw new Error("RECOVERY_CHECKPOINT_INVALID: el checkpoint persistido no es verificable.");
    }
    return structuredClone(existing);
  }
  const nodes = Object.fromEntries(graph.map((node) => [node.actionID, {
    key: node.key,
    actionID: node.actionID,
    state: node.dependsOn.length === 0 ? "ready" : "waiting",
    dependsOn: [...node.dependsOn],
  } satisfies ActionExecutionNodeV1]));
  const checkpoint: PlanExecutionCheckpointV1 = {
    schema: PLAN_EXECUTION_SCHEMA,
    kind: PLAN_EXECUTION_KIND,
    plan: { planID: plan.planID, revision: plan.revision, digest: plan.digest, proofHash: plan.proofHash },
    sequence: 0,
    graphHash,
    nodes,
    blockers: {},
    incidents: [],
    reservations: {},
    updatedAt: safeNow(now),
    proof: "",
  };
  checkpoint.proof = signCheckpoint(checkpoint, authority);
  await storage.set(key, structuredClone(checkpoint));
  const verified = await storage.get(key);
  if (!validPlanExecutionCheckpoint(verified, plan, graph, authority)
    || verified.sequence !== 0 || verified.proof !== checkpoint.proof) {
    throw new Error("RECOVERY_CHECKPOINT_UNAVAILABLE: no se pudo verificar el checkpoint inicial.");
  }
  return structuredClone(verified);
}

async function saveCheckpoint(
  storage: PlanRecoveryStorage,
  key: string,
  checkpoint: PlanExecutionCheckpointV1,
  expectedPreviousProof: string,
  authority: PlanningAuthority,
): Promise<void> {
  const current = await storage.get(key);
  if (!isRecord(current) || current.proof !== expectedPreviousProof
    || current.sequence !== checkpoint.sequence - 1) {
    throw new Error("RECOVERY_SEQUENCE_CONFLICT: el checkpoint cambió antes de persistir.");
  }
  await storage.set(key, structuredClone(checkpoint));
  const verified = await storage.get(key);
  if (!isRecord(verified) || verified.proof !== checkpoint.proof || verified.sequence !== checkpoint.sequence
    || !authority.verify(checkpointPayload(verified as unknown as PlanExecutionCheckpointV1), verified.proof)) {
    throw new Error("RECOVERY_CHECKPOINT_UNAVAILABLE: la escritura no quedó verificable.");
  }
}

function normalizePlanRef(value: PlanRecoveryRef): PlanRecoveryRef {
  if (!isRecord(value)) throw new Error("Referencia de plan no evaluable.");
  assertHex(value.planID, 32, "ID de plan");
  assertHex(value.revision, 32, "revisión");
  assertHex(value.digest, 64, "digest");
  assertHex(value.proofHash, 64, "huella de prueba");
  if (value.phase !== "running" && value.phase !== "paused" && value.phase !== "blocked") {
    throw new Error("El checkpoint requiere un plan iniciado.");
  }
  return { ...value };
}

function normalizeGraph(value: PlanRecoveryGraphNode[]): PlanRecoveryGraphNode[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 240) {
    throw new Error("Grafo de acciones vacío o demasiado extenso.");
  }
  const graph = value.map((node) => {
    if (!isRecord(node) || typeof node.key !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(node.key)
      || !validHex(node.actionID, 64) || !Array.isArray(node.dependsOn)
      || node.dependsOn.some((dependency) => !validHex(dependency, 64))) {
      throw new Error("Nodo del grafo no evaluable.");
    }
    return { key: node.key, actionID: node.actionID, dependsOn: [...new Set(node.dependsOn)].sort(compareText) };
  }).sort((left, right) => compareText(left.actionID, right.actionID));
  if (new Set(graph.map((node) => node.key)).size !== graph.length
    || new Set(graph.map((node) => node.actionID)).size !== graph.length) {
    throw new Error("El grafo contiene claves o acciones duplicadas.");
  }
  const actionIDs = new Set(graph.map((node) => node.actionID));
  if (graph.some((node) => node.dependsOn.includes(node.actionID)
    || node.dependsOn.some((dependency) => !actionIDs.has(dependency)))) {
    throw new Error("El grafo contiene una dependencia inexistente.");
  }
  assertAcyclic(graph);
  return graph;
}

function assertAcyclic(graph: PlanRecoveryGraphNode[]): void {
  const byID = new Map(graph.map((node) => [node.actionID, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (actionID: string): void => {
    if (visited.has(actionID)) return;
    if (visiting.has(actionID)) throw new Error("Ciclo en el grafo de acciones.");
    visiting.add(actionID);
    for (const dependency of byID.get(actionID)?.dependsOn ?? []) visit(dependency);
    visiting.delete(actionID);
    visited.add(actionID);
  };
  for (const node of graph) visit(node.actionID);
}

function normalizeCorrelation(value: RecoveryCorrelation, plan: PlanRecoveryRef): RecoveryCorrelation | undefined {
  if (!isRecord(value) || value.planID !== plan.planID || value.revision !== plan.revision
    || !safeIdentifier(value.sessionID, 160) || !safeIdentifier(value.messageID, 256)
    || !safeIdentifier(value.callID, 256) || !validHex(value.actionID, 64)
    || !safeHashRef(value.policyHash) || !safeHashRef(value.resourceHash)) return undefined;
  return {
    sessionID: value.sessionID,
    messageID: value.messageID,
    callID: value.callID,
    planID: value.planID,
    revision: value.revision,
    actionID: value.actionID,
    policyHash: value.policyHash,
    resourceHash: value.resourceHash,
  };
}

function validNode(value: ActionExecutionNodeV1 | undefined, graph: PlanRecoveryGraphNode): boolean {
  return Boolean(value) && value!.key === graph.key && value!.actionID === graph.actionID
    && sameStrings(value!.dependsOn, graph.dependsOn)
    && ["ready", "waiting", "in-flight", "succeeded", "failed", "blocked", "removed"].includes(value!.state)
    && (value!.blockerID === undefined || safeIdentifier(value!.blockerID, 80))
    && (value!.attemptOrdinal === undefined || (integer(value!.attemptOrdinal) && value!.attemptOrdinal! >= 0))
    && (value!.lastSuccessSequence === undefined
      || (integer(value!.lastSuccessSequence) && value!.lastSuccessSequence! > 0))
    && (value!.verificationInputHash === undefined || validHex(value!.verificationInputHash, 64))
    && (value!.lastFailureSignature === undefined || validHex(value!.lastFailureSignature, 64));
}

function validBlocker(value: PlanBlockerV1): boolean {
  return isRecord(value) && safeIdentifier(value.blockerID, 80) && safeLabel(value.code, "") === value.code
    && ["host-ask", "host-deny", "loop-guard", "technical-failure", "undeclared-action", "critical-control", "dependency"].includes(value.class)
    && (value.scope === "local" || value.scope === "common") && Array.isArray(value.descendants)
    && value.descendants.every((item) => validHex(item, 64)) && finiteNonNegative(value.createdAt);
}

function validIncident(value: PlanExecutionIncidentV1): boolean {
  return isRecord(value) && safeLabel(value.code, "") === value.code
    && (value.actionID === undefined || validHex(value.actionID, 64))
    && (value.optional === undefined || typeof value.optional === "boolean")
    && finiteNonNegative(value.recordedAt);
}

function validReservation(value: ToolCallReservationV1, plan: PlanRecoveryRef): boolean {
  return isRecord(value) && safeIdentifier(value.reservationID, 80)
    && normalizeCorrelation(value, plan) !== undefined && finiteNonNegative(value.createdAt);
}

function appendIncident(checkpoint: PlanExecutionCheckpointV1, incident: PlanExecutionIncidentV1): void {
  checkpoint.incidents.push(incident);
  if (checkpoint.incidents.length > MAX_INCIDENTS) checkpoint.incidents.splice(0, checkpoint.incidents.length - MAX_INCIDENTS);
}

function createBlockerID(checkpoint: PlanExecutionCheckpointV1, code: string): string {
  return `blk_${createHash("sha256").update(canonical({
    plan: checkpoint.plan,
    sequence: checkpoint.sequence,
    code,
    nonce: randomBytes(8).toString("hex"),
  })).digest("hex").slice(0, 24)}`;
}

function failureSignature(input: {
  actionID: string;
  canonicalInputHash: string;
  errorHash?: string;
  resourceDigests: { before: string[]; after: string[] };
}): string {
  return hashCanonical({
    actionID: input.actionID,
    canonicalInputHash: safeHashRef(input.canonicalInputHash) ? input.canonicalInputHash : "sha256:unavailable",
    errorHash: safeHashRef(input.errorHash) ? input.errorHash : undefined,
    resourceDigests: {
      before: safeHashList(input.resourceDigests?.before),
      after: safeHashList(input.resourceDigests?.after),
    },
  });
}

function sameCorrelation(left: RecoveryCorrelation, right: RecoveryCorrelation): boolean {
  return left.sessionID === right.sessionID && left.messageID === right.messageID && left.callID === right.callID
    && left.planID === right.planID && left.revision === right.revision && left.actionID === right.actionID
    && left.policyHash === right.policyHash && left.resourceHash === right.resourceHash;
}

function checkpointPayload(checkpoint: PlanExecutionCheckpointV1): string {
  const { proof: _proof, ...payload } = checkpoint;
  return canonical(payload);
}

function signCheckpoint(checkpoint: PlanExecutionCheckpointV1, authority: PlanningAuthority): string {
  return authority.sign(checkpointPayload(checkpoint));
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  return serializeWith(transitions, key, operation);
}

async function serializeWith<T>(
  registry: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = registry.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.then(() => gate);
  registry.set(key, current);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (registry.get(key) === current) registry.delete(key);
  }
}

function requireStorage(value: PlanRecoveryStorage): PlanRecoveryStorage {
  if (!isRecord(value) || typeof value.get !== "function" || typeof value.set !== "function") {
    throw new Error("Storage de recuperación no disponible.");
  }
  return value;
}

function block(code: string, requiresPlanRevision = false): PlanRecoveryDecision {
  return { decision: "block", code, retryAllowed: false, ...(requiresPlanRevision ? { requiresPlanRevision: true } : {}) };
}

function changed<T>(result: T): Mutation<T> {
  return { result, changed: true };
}

function unchanged<T>(result: T): Mutation<T> {
  return { result, changed: false };
}

function safeNow(now: () => number): number {
  const candidate = now();
  return finiteNonNegative(candidate) ? candidate : Date.now();
}

function safeHashList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => safeHashRef(item)).slice(0, 64) : [];
}

function safeHashRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000\r\n]/u.test(value);
}

function safeIdentifier(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : fallback;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function assertHex(value: unknown, length: number, label: string): asserts value is string {
  if (!validHex(value, length)) throw new Error(`${label} no evaluable.`);
}

function validHex(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
