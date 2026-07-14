import { describe, it, expect } from 'vitest';
import {
  ROUTING_LEVELS,
  CONTENT_TYPES,
  LOAD_PATTERNS,
  IMPLIED_LOAD_PATTERN,
  WELL_FORMEDNESS_RULES,
  FAILURE_MODES,
  SEVERITIES,
  DEFAULT_THRESHOLDS,
  STAGE_CONTRACT_SECTIONS,
  STAGE_FOLDER_PATTERN,
  SPEC_VERSION,
  PROJECTION_RULES,
  PROJECTION_HOMES,
  PROJECTION_HOME_RULE,
} from '../src/model.js';

/**
 * These tests pin the rule model to the current SPEC version. They are a regression net for
 * the spec-driven discipline: a change here should mean a matching change in
 * SPEC.md landed in the same PR.
 */

describe('classification axes (SPEC §2.2 to §2.4)', () => {
  it('encodes the three routing levels', () => {
    expect(ROUTING_LEVELS).toEqual(['L0', 'L1', 'L2']);
  });

  it('encodes the four content types', () => {
    expect(CONTENT_TYPES).toEqual([
      'identity',
      'situational',
      'reference',
      'working',
    ]);
  });

  it('encodes the three load patterns', () => {
    expect(LOAD_PATTERNS).toEqual(['always', 'on_demand', 'per_item']);
  });

  it('maps each content type to its implied load pattern (§2.4)', () => {
    expect(IMPLIED_LOAD_PATTERN).toEqual({
      identity: 'always',
      situational: 'always',
      reference: 'on_demand',
      working: 'per_item',
    });
  });
});

describe('well-formedness rules (SPEC §3)', () => {
  it('encodes W1 to W7 with their codes', () => {
    expect(WELL_FORMEDNESS_RULES).toEqual({
      W1: 'ROOT_IDENTITY',
      W2: 'SINGLE_ROOT_IDENTITY',
      W3: 'CONTENT_SEGREGATION',
      W4: 'NESTED_INTEGRITY',
      W5: 'ROUTABLE_FILES',
      W6: 'ROUTING_DEPTH',
      W7: 'STAGE_CONTRACT_SHAPE',
    });
  });
});

describe('failure modes (SPEC §4)', () => {
  it('encodes F1 to F9 with their codes, contiguous in section order', () => {
    expect(FAILURE_MODES).toEqual({
      F1: 'MONOLITHIC_CONTEXT',
      F2: 'HIDDEN_CONTEXT',
      F3: 'STALE_CONTENT',
      F4: 'OVER_ROUTING',
      F5: 'LAYER_BLOAT',
      F6: 'MALFORMED_STAGE_CONTRACT',
      F7: 'KIT_BOILERPLATE',
      F8: 'DUPLICATION',
      F9: 'SUPERSEDED_BUT_LIVE',
    });
  });

  it('emits warning in v0.1, with error reserved (§4, §5)', () => {
    expect(SEVERITIES).toEqual(['warning', 'error']);
  });
});

describe('default thresholds (SPEC §4.1, §4.5, W6; §5 q3)', () => {
  it('matches the spec defaults', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      claudeMdMaxTokens: 4_000,
      fileMaxTokens: 8_000,
      layerBloatProseTokens: 500,
      maxRoutingDepth: 3,
      duplicationSimilarityFloor: 0.8,
      duplicationMinBlockTokens: 40,
      duplicationShingleSize: 5,
      supersededBannerScanLines: 15,
    });
  });
});

describe('stage contracts (SPEC §2.6, W7)', () => {
  it('lists the four required sections in spec order', () => {
    expect(STAGE_CONTRACT_SECTIONS).toEqual([
      'Input',
      'Process',
      'Output',
      'Completion',
    ]);
  });

  it('matches numbered stage folders, not arbitrary folders', () => {
    expect('01-discovery').toMatch(STAGE_FOLDER_PATTERN);
    expect('12-final-review').toMatch(STAGE_FOLDER_PATTERN);
    expect('references').not.toMatch(STAGE_FOLDER_PATTERN);
    expect('1-discovery').not.toMatch(STAGE_FOLDER_PATTERN);
    expect('01').not.toMatch(STAGE_FOLDER_PATTERN);
  });
});

describe('spec version (SPEC §6)', () => {
  it('tracks the SPEC.md document version', () => {
    expect(SPEC_VERSION).toBe('v1.4');
  });
});

describe('projection layer (SPEC §8.2)', () => {
  it('encodes the five projection rules', () => {
    expect(PROJECTION_RULES).toEqual([
      'pass_through',
      'shape_only',
      'redact_instance',
      'omit',
      'omit_assert_absence',
    ]);
  });

  it('encodes the projection homes in §8.2 first-match order (secret first)', () => {
    expect(PROJECTION_HOMES).toEqual([
      'secret',
      'router',
      'skill',
      'harness',
      'companion',
      'sync',
      'archive',
      'memory',
      'context',
      'voice',
      'reference',
      'instance_record',
    ]);
  });

  it('binds each home to the rule the §8.2 table assigns it', () => {
    expect(PROJECTION_HOME_RULE).toEqual({
      router: 'pass_through',
      skill: 'pass_through',
      harness: 'pass_through',
      companion: 'pass_through',
      sync: 'pass_through',
      secret: 'omit_assert_absence',
      archive: 'omit',
      memory: 'shape_only',
      context: 'shape_only',
      voice: 'shape_only',
      reference: 'pass_through',
      instance_record: 'redact_instance',
    });
  });

  it('maps every home to a known rule, and covers every home', () => {
    expect(Object.keys(PROJECTION_HOME_RULE).sort()).toEqual(
      [...PROJECTION_HOMES].sort(),
    );
    for (const rule of Object.values(PROJECTION_HOME_RULE)) {
      expect(PROJECTION_RULES).toContain(rule);
    }
  });
});
