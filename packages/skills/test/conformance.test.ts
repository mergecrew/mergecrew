import { describe, it, expect } from 'vitest';
import { stockSkills } from '../src/catalog.js';
import type { AnySkill } from '../src/types.js';

const ALLOWED_SIDE_EFFECTS = new Set(['read', 'write_workspace', 'write_external', 'irreversible']);
const ALLOWED_CAPABILITIES = new Set([
  'fs.read', 'fs.write',
  'git.read', 'git.write', 'git.commit',
  'net.outbound',
  'process.spawn',
  'deploy.trigger', 'deploy.read',
  'tracker.read', 'tracker.write',
  'comms.write',
  'memory.read', 'memory.write',
  'llm.chat',
  'changeset.write',
]);

/**
 * Conformance: rules every stock skill must satisfy. These run on the live
 * `stockSkills` array so adding a new skill that violates a rule fails CI.
 */
describe('stock skills conformance', () => {
  it('every skill has the required surface', () => {
    for (const s of stockSkills) {
      expect(s.name, 'name').toBeTypeOf('string');
      expect(s.name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(s.description, `${s.name}.description`).toBeTypeOf('string');
      expect(s.description.length, `${s.name}.description must be non-empty`).toBeGreaterThan(0);
      expect(s.execute, `${s.name}.execute`).toBeTypeOf('function');
    }
  });

  it('every skill name is unique', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const s of stockSkills) {
      if (seen.has(s.name)) dupes.push(s.name);
      seen.add(s.name);
    }
    expect(dupes).toEqual([]);
  });

  it('inputSchema is a plausibly-shaped JSON Schema object', () => {
    for (const s of stockSkills) {
      expect(s.inputSchema, `${s.name}.inputSchema`).toBeTypeOf('object');
      const schema = s.inputSchema as Record<string, unknown>;
      // We expect every stock skill to be an object schema. Permissive on
      // properties (some take no input, some take many).
      expect(schema.type, `${s.name}.inputSchema.type`).toBe('object');
    }
  });

  it('sideEffectClass is in the allowed enum', () => {
    for (const s of stockSkills) {
      expect(ALLOWED_SIDE_EFFECTS.has(s.sideEffectClass), `${s.name}.sideEffectClass=${s.sideEffectClass}`).toBe(true);
    }
  });

  it('capabilities is a non-empty array of recognized capabilities', () => {
    for (const s of stockSkills) {
      expect(Array.isArray(s.capabilities), `${s.name}.capabilities`).toBe(true);
      expect(s.capabilities.length, `${s.name}.capabilities must be non-empty`).toBeGreaterThan(0);
      for (const c of s.capabilities) {
        expect(ALLOWED_CAPABILITIES.has(c), `${s.name}.capabilities[]=${c}`).toBe(true);
      }
    }
  });

  it('side-effect class is consistent with declared capabilities', () => {
    for (const s of stockSkills) {
      const writes = hasWriteCapability(s);
      if (s.sideEffectClass === 'read') {
        expect(writes, `${s.name} declares sideEffectClass="read" but has write capabilities ${JSON.stringify(s.capabilities)}`).toBe(false);
      }
    }
  });

  it('timeoutMs (when set) is a positive integer', () => {
    for (const s of stockSkills) {
      if (s.timeoutMs !== undefined) {
        expect(Number.isInteger(s.timeoutMs), `${s.name}.timeoutMs must be integer`).toBe(true);
        expect(s.timeoutMs, `${s.name}.timeoutMs`).toBeGreaterThan(0);
      }
    }
  });
});

function hasWriteCapability(s: AnySkill): boolean {
  return s.capabilities.some(
    (c) =>
      c === 'fs.write' ||
      c === 'git.write' ||
      c === 'git.commit' ||
      c === 'tracker.write' ||
      c === 'comms.write' ||
      c === 'deploy.trigger' ||
      c === 'memory.write',
  );
}
