/**
 * Schema ⇄ emitter drift guard.
 *
 * The three JSON schemas were previously documentation only: nothing imported
 * them, so they drifted from the types silently (SKILL.md Pitfalls 2026-08-13
 * records the debrief `errorSignature` case; `subagent-exit` forbidding
 * `recommendations`/`suggestions`, and `jobcard`'s 3-value `agentRole` enum,
 * were the same bug class surviving in the other two files).
 *
 * This test is the consumer: it asserts that payloads the RUNTIME actually
 * produces validate against the published schemas.
 */
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeDebriefHash } from './debrief.js';
import type { DebriefPayload } from './debrief.js';
import type { SubagentResult, AgentRole } from './orchestrator.js';

// __dirname, not import.meta.url: the skill type-checks under
// --module node16 without "type": "module", so it compiles to CJS and
// import.meta is a TS1470 error. tsx runs it the same way.
const load = (n: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, n), 'utf8')) as Record<string, unknown>;

const jobcardSchema = load('jobcard-schema.json');
const exitSchema = load('subagent-exit-schema.json');
const debriefSchema = load('debrief-schema.json');

function check(schema: Record<string, unknown>, data: unknown): string[] {
  const out: string[] = [];
  walk(schema, data, schema, '', out);
  return out;
}

/* Minimal draft-07 subset: type / required / enum / additionalProperties /
   items / pattern / min / max, with $ref resolution. Hand-rolled so the skill
   tree gains no npm dependency. */
function walk(
  schema: Record<string, unknown>,
  data: unknown,
  root: Record<string, unknown>,
  path: string,
  out: string[],
): void {
  let s = schema;
  if (typeof s.$ref === 'string') {
    const target = s.$ref
      .replace(/^#\//, '')
      .split('/')
      .reduce<Record<string, unknown>>((a, k) => a[k] as Record<string, unknown>, root);
    const rest = { ...s };
    delete (rest as { $ref?: string }).$ref;
    s = { ...target, ...rest };
  }
  const t = s.type as string | undefined;
  if (t === 'object') {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      out.push(`${path}: expected object`);
      return;
    }
    const obj = data as Record<string, unknown>;
    for (const r of (s.required as string[] | undefined) ?? []) {
      if (!(r in obj)) out.push(`${path}: missing required ${r}`);
    }
    const props = (s.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    if (s.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) out.push(`${path}: additional prop not allowed: ${k}`);
      }
    } else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      const sub = s.additionalProperties as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (!(k in props)) walk(sub, obj[k], root, `${path}.${k}`, out);
      }
    }
    for (const k of Object.keys(props)) {
      if (k in obj) walk(props[k], obj[k], root, `${path}.${k}`, out);
    }
    return;
  }
  if (t === 'array') {
    if (!Array.isArray(data)) {
      out.push(`${path}: expected array`);
      return;
    }
    if (s.items) {
      for (let i = 0; i < data.length; i++) {
        walk(s.items as Record<string, unknown>, data[i], root, `${path}[${i}]`, out);
      }
    }
    return;
  }
  if (t === 'string') {
    if (typeof data !== 'string') {
      out.push(`${path}: expected string`);
      return;
    }
    if (Array.isArray(s.enum) && !s.enum.includes(data)) {
      out.push(`${path}: enum violation ${JSON.stringify(data)}`);
    }
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(data)) {
      out.push(`${path}: pattern fail`);
    }
    return;
  }
  if (typeof data === 'number') {
    if (typeof s.minimum === 'number' && data < s.minimum) out.push(`${path}: < min`);
    if (typeof s.maximum === 'number' && data > s.maximum) out.push(`${path}: > max`);
  }
}

/* 1. The exit payload a subagent is TOLD to emit (references/subagent-prompt.md
      EXIT PROTOCOL) must validate. */
const promptPayload = {
  status: 'COMPLETED',
  files_modified: ['src/a.ts'],
  debrief: 'Did the thing.',
  self_audit: 'Yes, best available.',
};
assert.deepEqual(check(exitSchema, promptPayload), [], 'prompt-shaped payload must validate');

/* 2. The up-chain wire (SubagentResult.recommendations / .suggestions, added
      2026-08-13) must ALSO validate — the case the old schema rejected. */
assert.deepEqual(
  check(exitSchema, { ...promptPayload, recommendations: ['do x'], suggestions: ['try y'] }),
  [],
  'schema must not forbid the up-chain channel the skill documents',
);

/* 3. Every AgentRole the runtime can produce must be a legal enum value. */
const roles: AgentRole[] = ['WORKER','VERIFIER','TEST_FIXER','CODE_REVIEWER','FRONTEND_REVIEWER','BACKEND_REVIEWER','COMPOSER'];
const jobCard = {
  planId: 'BUILD-1',
  overallStatus: 'IN_PROGRESS',
  jobs: {
    'JOB-001': {
      id: 'JOB-001',
      parentFolder: 'src/a',
      status: 'VERIFIED',
      attempts: 2,
      debriefHistory: roles.map((agentRole, i) => ({ attempt: i + 1, agentRole, debrief: 'ok', hash: 'a'.repeat(64) })),
    },
  },
  completedHashes: [] as string[],
};
assert.deepEqual(check(jobcardSchema, jobCard), [], 'all 7 AgentRoles must be accepted');

/* 4. attempts is capped at MAX_REVISION_CYCLES (3) — the ledger must enforce it. */
const overCap = JSON.parse(JSON.stringify(jobCard)) as typeof jobCard;
(overCap.jobs['JOB-001'] as { attempts: number }).attempts = 4;
assert.ok(check(jobcardSchema, overCap).length > 0, 'attempts > 3 must be rejected');

/* 5. debrief hashing stays canonical, and errorSignature stays optional in the
      SCHEMA while remaining hash-relevant in the CODE — a FAILED job must not
      dedup-collide with a success that carries the same files. */
const okPayload: DebriefPayload = { directory: 'src/a', modifiedFiles: ['b.ts', 'a.ts'], diffHash: 'x' };
assert.equal(computeDebriefHash(okPayload).length, 64);
assert.equal(
  computeDebriefHash(okPayload),
  computeDebriefHash({ ...okPayload, errorSignature: '' }),
  'absent errorSignature must canonicalize to the empty string',
);
assert.notEqual(
  computeDebriefHash(okPayload),
  computeDebriefHash({ ...okPayload, errorSignature: 'E1' }),
  'a distinct failure signature must NOT collapse into the success hash',
);
assert.deepEqual(check(debriefSchema, okPayload), [], 'debrief payload without errorSignature must validate');

/* 6. SubagentResult (parsed, camelCase) is the in-process type, not the wire
      format; the schema documents the wire. Both must coexist. */
const parsed: SubagentResult = {
  status: 'COMPLETED', filesModified: [], debrief: 'ok', selfAudit: 'ok',
  recommendations: ['r'], suggestions: ['s'],
};
assert.equal(parsed.status, 'COMPLETED');

console.log('ALL SCHEMA DRIFT ASSERTIONS PASSED');
