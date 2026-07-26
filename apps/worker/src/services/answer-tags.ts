/**
 * Map form answers to tags.
 *
 * Forms already collect structured facts — "which do you drink", "where do you
 * live" — and save them to friend metadata. Without this the same facts have to
 * be re-entered by hand as tags before they can be used for segmenting, which
 * in practice means they never are.
 *
 * The mapping lives in the `FORM_ANSWER_TAGS` binding rather than in code so
 * tag ids stay out of the repo and the shop can re-point them without a deploy:
 *
 *   {
 *     "<field name>": {
 *       "<answer>": "<tag id>",
 *       "<answer>": ["<tag id>", "<tag id>"]
 *     }
 *   }
 *
 * Answers are matched exactly against the stored option strings.
 */
export type AnswerTagMap = Record<string, Record<string, string | string[]>>;

/** Parse the binding, tolerating absence and malformed JSON (feature simply stays off). */
export function parseAnswerTagMap(raw: string | undefined): AnswerTagMap {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: AnswerTagMap = {};
    for (const [field, answers] of Object.entries(parsed as Record<string, unknown>)) {
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) continue;
      const byAnswer: Record<string, string | string[]> = {};
      for (const [answer, tag] of Object.entries(answers as Record<string, unknown>)) {
        if (typeof tag === 'string' && tag.trim()) byAnswer[answer] = tag.trim();
        else if (Array.isArray(tag)) {
          const ids = tag.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
          if (ids.length) byAnswer[answer] = ids.map((t) => t.trim());
        }
      }
      if (Object.keys(byAnswer).length) out[field] = byAnswer;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Tag ids earned by a submission. De-duplicated, since two answers can point at
 * the same tag ("どちらも" mapping to both interest tags, for example).
 */
export function resolveAnswerTags(
  map: AnswerTagMap,
  submission: Record<string, unknown>,
): string[] {
  const ids = new Set<string>();
  for (const [field, byAnswer] of Object.entries(map)) {
    const answer = submission[field];
    if (typeof answer !== 'string') continue;
    const tag = byAnswer[answer];
    if (!tag) continue;
    for (const id of Array.isArray(tag) ? tag : [tag]) ids.add(id);
  }
  return [...ids];
}
