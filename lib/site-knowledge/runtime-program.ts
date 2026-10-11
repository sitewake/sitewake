import {
  uid,
  type CapabilityDefinition,
  type CapabilityProgram,
  type ExecutionScope,
  type ExecutionSlice,
  type OperationDefinition,
  type PageProgramStep,
  type ProgramCursor,
  type SiteAgentReleaseV2,
  type TransitionContract,
} from "./protocol";

export function exactOriginScope(siteAgentId: string, origin: string): ExecutionScope {
  return { kind: "site", siteAgentId, allowedOrigins: [new URL(origin).origin], knowledgeNamespaceIds: [siteAgentId] };
}

export function capabilityProgramFromDefinition(capability: CapabilityDefinition, scope: ExecutionScope, revisionId = `release:${capability.updatedAt}`): CapabilityProgram {
  const selected = capability.plans[0];
  if (!selected) throw new Error("capability_plan_not_found");
  return {
    id: `program:${capability.id}:${revisionId}`,
    capabilityRevisionId: revisionId,
    capabilityId: capability.id,
    scope,
    inputs: capability.inputs,
    outputs: capability.outputs,
    plan: selected.steps.map((step) => ({ operationId: step.operationId, siteAgentId: scope.siteAgentId, inputBindings: step.bindings, outputBindings: {} })),
    createdAt: capability.updatedAt,
  };
}

function inferredTransition(operation: OperationDefinition, origin: string): TransitionContract | undefined {
  if (!operation.toSceneId) return undefined;
  return { kind: "document", expectedSceneIds: [operation.toSceneId], expectedOrigin: new URL(origin).origin };
}

/**
 * Compile only the executable part of the current document. A transition step
 * always terminates the slice; the destination BrowserPort receives the next
 * cursor and can never continue against a destroyed DOM.
 */
export function executionSliceForCursor(input: {
  runId: string;
  toolCallId: string;
  release: SiteAgentReleaseV2;
  capability: CapabilityDefinition;
  scope: ExecutionScope;
  cursor: ProgramCursor;
  origin: string;
}): ExecutionSlice {
  const program = capabilityProgramFromDefinition(input.capability, input.scope);
  const planStep = program.plan[input.cursor.operationIndex];
  if (!planStep) throw new Error("capability_program_complete");
  if (planStep.siteAgentId !== input.scope.siteAgentId) throw new Error("capability_program_scope_rejected");
  const operation = input.release.operations.find((item) => item.id === planStep.operationId);
  if (!operation) throw new Error(`operation_not_found:${planStep.operationId}`);
  const implementation = [...operation.implementations].sort((left, right) => (right.successes - right.failures) - (left.successes - left.failures))[0];
  if (!implementation) throw new Error(`operation_implementation_not_found:${operation.id}`);
  const source = implementation.program.steps.slice(input.cursor.programStepIndex);
  const steps: PageProgramStep[] = [];
  let expectedTransition: TransitionContract | undefined;
  for (const sourceStep of source) {
    const lastOperationStep = input.cursor.programStepIndex + steps.length === implementation.program.steps.length - 1;
    const transition = ("transition" in sourceStep ? sourceStep.transition : undefined) || (lastOperationStep && (sourceStep.op === "click" || sourceStep.op === "navigate") ? inferredTransition(operation, input.origin) : undefined);
    const step = transition ? { ...sourceStep, transition } : sourceStep;
    steps.push(step);
    if (step.op === "navigate" || transition) { expectedTransition = transition || inferredTransition(operation, input.origin); break; }
  }
  if (!steps.length) throw new Error("execution_slice_empty");
  return {
    id: uid("slice"), runId: input.runId, toolCallId: input.toolCallId,
    capabilityRevisionId: program.capabilityRevisionId, operationId: operation.id, implementationId: implementation.id,
    requiredSiteAgentId: input.scope.siteAgentId,
    requiredSceneIds: operation.applicability?.sceneIds || (operation.fromSceneId === "*" ? [] : [operation.fromSceneId]),
    steps, expectedTransition, expectedOutputs: operation.outputs, programCursor: input.cursor,
  };
}
