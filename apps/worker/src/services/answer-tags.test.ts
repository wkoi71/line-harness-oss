import { describe, it, expect } from 'vitest';
import { parseAnswerTagMap, resolveAnswerTags } from './answer-tags.js';

describe('answer-tags: parseAnswerTagMap', () => {
  it('stays off when the binding is missing or malformed', () => {
    for (const input of [undefined, '', 'not json', '[]', 'null', '123']) {
      expect(parseAnswerTagMap(input as string | undefined)).toEqual({});
    }
  });

  it('accepts a single tag or a list per answer', () => {
    const map = parseAnswerTagMap(
      JSON.stringify({ taste: { sake: 'tag-a', both: ['tag-a', 'tag-b'] } }),
    );
    expect(map).toEqual({ taste: { sake: 'tag-a', both: ['tag-a', 'tag-b'] } });
  });

  it('drops entries that cannot yield a usable tag id', () => {
    // A blank id would insert a dangling friend_tags row rather than fail loudly.
    const map = parseAnswerTagMap(
      JSON.stringify({
        taste: { sake: '  ', sweets: 42, both: [], ok: ' tag-a ' },
        broken: 'not an object',
      }),
    );
    expect(map).toEqual({ taste: { ok: 'tag-a' } });
  });
});

describe('answer-tags: resolveAnswerTags', () => {
  const map = {
    taste: { sake: 'tag-sake', sweets: 'tag-sweets', both: ['tag-sake', 'tag-sweets'] },
    area: { local: 'tag-local', visitor: 'tag-visitor' },
  };

  it('collects tags across fields', () => {
    expect(resolveAnswerTags(map, { taste: 'sake', area: 'local' }).sort()).toEqual([
      'tag-local',
      'tag-sake',
    ]);
  });

  it('de-duplicates when answers point at the same tag', () => {
    expect(resolveAnswerTags(map, { taste: 'both', area: 'visitor' }).sort()).toEqual([
      'tag-sake',
      'tag-sweets',
      'tag-visitor',
    ]);
  });

  it('ignores unmapped answers, absent fields and non-string values', () => {
    expect(resolveAnswerTags(map, { taste: 'unknown' })).toEqual([]);
    expect(resolveAnswerTags(map, {})).toEqual([]);
    expect(resolveAnswerTags(map, { taste: ['sake'] })).toEqual([]);
  });
});
