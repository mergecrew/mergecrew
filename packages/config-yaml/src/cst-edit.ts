import YAML from 'yaml';
import { ValidationError } from '@mergecrew/domain';

// Surgical edits to mergecrew.yaml that preserve comments, key order, and
// human-authored formatting. Operators have edited mergecrew.yaml by hand for
// years — re-stringifying from the parsed config would discard all of that
// context. We mutate the AST nodes in place and call emit(doc) so only
// the touched values change.

export type GraphEdit =
  | { kind: 'rename_workflow'; from: string; to: string }
  | { kind: 'add_edge'; from: string; to: string }
  | { kind: 'remove_edge'; from: string; to: string }
  | { kind: 'add_agent'; workflow: string; agent: string }
  | { kind: 'remove_agent'; workflow: string; agent: string };

export interface EditResult {
  yaml: string;
  /** Human-readable summary of the change. Used as PR title / commit subject. */
  summary: string;
}

export function applyGraphEdit(source: string, edit: GraphEdit): EditResult {
  switch (edit.kind) {
    case 'rename_workflow':
      return renameWorkflow(source, edit.from, edit.to);
    case 'add_edge':
      return addWorkflowEdge(source, edit.from, edit.to);
    case 'remove_edge':
      return removeWorkflowEdge(source, edit.from, edit.to);
    case 'add_agent':
      return addWorkflowAgent(source, edit.workflow, edit.agent);
    case 'remove_agent':
      return removeWorkflowAgent(source, edit.workflow, edit.agent);
  }
}

export function applyGraphEdits(source: string, edits: GraphEdit[]): EditResult {
  if (edits.length === 0) throw new ValidationError('applyGraphEdits: at least one edit required');
  let current = source;
  const summaries: string[] = [];
  for (const edit of edits) {
    const r = applyGraphEdit(current, edit);
    current = r.yaml;
    summaries.push(r.summary);
  }
  return {
    yaml: current,
    summary: summaries.length === 1 ? summaries[0]! : `${summaries.length} lifecycle edits`,
  };
}

export function renameWorkflow(source: string, fromId: string, toId: string): EditResult {
  if (!fromId || !toId) throw new ValidationError('renameWorkflow: from and to required');
  if (fromId === toId) throw new ValidationError('renameWorkflow: from and to are identical');
  if (!isValidId(toId)) throw new ValidationError(`renameWorkflow: invalid id "${toId}"`);

  const doc = parseDoc(source);
  const workflows = getWorkflowsSeq(doc);
  const fromNode = findWorkflowById(workflows, fromId);
  if (!fromNode) throw new ValidationError(`renameWorkflow: workflow "${fromId}" not found`);
  if (findWorkflowById(workflows, toId)) {
    throw new ValidationError(`renameWorkflow: workflow "${toId}" already exists`);
  }

  setScalarField(fromNode, 'id', toId);
  // Rewrite incoming references from any other workflow's `out` and `transitions[].to`.
  for (const wf of workflows.items) {
    if (!YAML.isMap(wf)) continue;
    renameInScalarSeq(wf, 'out', fromId, toId);
    const transitions = wf.get('transitions', true);
    if (YAML.isSeq(transitions)) {
      for (const t of transitions.items) {
        if (!YAML.isMap(t)) continue;
        const toScalar = t.get('to', true);
        if (YAML.isScalar(toScalar) && toScalar.value === fromId) {
          toScalar.value = toId;
        }
      }
    }
  }

  return { yaml: emit(doc), summary: `rename workflow ${fromId} → ${toId}` };
}

export function addWorkflowEdge(source: string, from: string, to: string): EditResult {
  if (!from || !to) throw new ValidationError('addWorkflowEdge: from and to required');
  if (from === to) throw new ValidationError('addWorkflowEdge: self-edges not allowed');
  const doc = parseDoc(source);
  const workflows = getWorkflowsSeq(doc);
  const fromNode = findWorkflowById(workflows, from);
  if (!fromNode) throw new ValidationError(`addWorkflowEdge: workflow "${from}" not found`);
  if (!findWorkflowById(workflows, to)) {
    throw new ValidationError(`addWorkflowEdge: workflow "${to}" not found`);
  }

  const out = ensureScalarSeq(fromNode, 'out');
  if (scalarSeqHas(out, to)) {
    return { yaml: source, summary: `add edge ${from} → ${to} (no-op: already present)` };
  }
  out.add(to);
  return { yaml: emit(doc), summary: `add edge ${from} → ${to}` };
}

export function removeWorkflowEdge(source: string, from: string, to: string): EditResult {
  if (!from || !to) throw new ValidationError('removeWorkflowEdge: from and to required');
  const doc = parseDoc(source);
  const workflows = getWorkflowsSeq(doc);
  const fromNode = findWorkflowById(workflows, from);
  if (!fromNode) throw new ValidationError(`removeWorkflowEdge: workflow "${from}" not found`);

  const out = fromNode.get('out', true);
  if (!YAML.isSeq(out) || !scalarSeqHas(out, to)) {
    return { yaml: source, summary: `remove edge ${from} → ${to} (no-op: not present)` };
  }
  scalarSeqRemove(out, to);
  return { yaml: emit(doc), summary: `remove edge ${from} → ${to}` };
}

export function addWorkflowAgent(source: string, workflow: string, agent: string): EditResult {
  if (!workflow || !agent) throw new ValidationError('addWorkflowAgent: workflow and agent required');
  const doc = parseDoc(source);
  const workflows = getWorkflowsSeq(doc);
  const wfNode = findWorkflowById(workflows, workflow);
  if (!wfNode) throw new ValidationError(`addWorkflowAgent: workflow "${workflow}" not found`);

  const agents = ensureScalarSeq(wfNode, 'agents');
  if (scalarSeqHas(agents, agent)) {
    return { yaml: source, summary: `add agent ${agent} to ${workflow} (no-op: already present)` };
  }
  agents.add(agent);
  return { yaml: emit(doc), summary: `add agent ${agent} to ${workflow}` };
}

export function removeWorkflowAgent(source: string, workflow: string, agent: string): EditResult {
  if (!workflow || !agent) throw new ValidationError('removeWorkflowAgent: workflow and agent required');
  const doc = parseDoc(source);
  const workflows = getWorkflowsSeq(doc);
  const wfNode = findWorkflowById(workflows, workflow);
  if (!wfNode) throw new ValidationError(`removeWorkflowAgent: workflow "${workflow}" not found`);

  const agents = wfNode.get('agents', true);
  if (!YAML.isSeq(agents) || !scalarSeqHas(agents, agent)) {
    return { yaml: source, summary: `remove agent ${agent} from ${workflow} (no-op: not present)` };
  }
  scalarSeqRemove(agents, agent);
  return { yaml: emit(doc), summary: `remove agent ${agent} from ${workflow}` };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseDoc(source: string): YAML.Document.Parsed {
  let doc: YAML.Document.Parsed;
  try {
    doc = YAML.parseDocument(source);
  } catch (e: any) {
    throw new ValidationError(`mergecrew.yaml: invalid YAML: ${e?.message ?? e}`);
  }
  if (doc.errors.length > 0) {
    throw new ValidationError(`mergecrew.yaml: ${doc.errors[0]!.message}`);
  }
  return doc;
}

// yaml v2 defaults to padding flow collections (`[ a, b ]`). Our shipped
// mergecrew.yaml uses the tighter `[a, b]` style, and so do most projects in
// the wild. Default off to avoid silently reformatting every flow list on
// every edit.
function emit(doc: YAML.Document.Parsed): string {
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

function getWorkflowsSeq(doc: YAML.Document.Parsed): YAML.YAMLSeq {
  const seq = doc.getIn(['lifecycle', 'workflows'], true);
  if (!YAML.isSeq(seq)) {
    throw new ValidationError('mergecrew.yaml: lifecycle.workflows is missing or not a list');
  }
  return seq;
}

function findWorkflowById(workflows: YAML.YAMLSeq, id: string): YAML.YAMLMap | null {
  for (const wf of workflows.items) {
    if (!YAML.isMap(wf)) continue;
    const idNode = wf.get('id', true);
    if (YAML.isScalar(idNode) && idNode.value === id) return wf;
  }
  return null;
}

function setScalarField(map: YAML.YAMLMap, key: string, value: string): void {
  const node = map.get(key, true);
  if (YAML.isScalar(node)) {
    node.value = value;
  } else {
    map.set(key, value);
  }
}

function ensureScalarSeq(map: YAML.YAMLMap, key: string): YAML.YAMLSeq {
  const existing = map.get(key, true);
  if (YAML.isSeq(existing)) return existing;
  const seq = new YAML.YAMLSeq();
  map.set(key, seq);
  return seq;
}

function scalarSeqHas(seq: YAML.YAMLSeq, value: string): boolean {
  return seq.items.some((it) => YAML.isScalar(it) && it.value === value);
}

function scalarSeqRemove(seq: YAML.YAMLSeq, value: string): void {
  const idx = seq.items.findIndex((it) => YAML.isScalar(it) && it.value === value);
  if (idx >= 0) seq.delete(idx);
}

function renameInScalarSeq(map: YAML.YAMLMap, key: string, fromValue: string, toValue: string): void {
  const seq = map.get(key, true);
  if (!YAML.isSeq(seq)) return;
  for (const it of seq.items) {
    if (YAML.isScalar(it) && it.value === fromValue) it.value = toValue;
  }
}

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
function isValidId(id: string): boolean {
  return ID_PATTERN.test(id) && id.length <= 64;
}
