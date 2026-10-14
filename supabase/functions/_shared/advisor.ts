/** Names are replaced before a question or a weekly note is sent to the model, then put back in the stored answer. */

export interface PersonLabel { name: string; pseudo: string }

const DROP = new Set([
  'employee_id', 'team_id', 'asked_by', 'annual_salary', 'annual_cost', 'monthly_cost',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces employee names in a manager's question, longest name first. */
export function scrubQuestion(question: string, people: PersonLabel[]): string {
  const ordered = [...people].filter((p) => p.name.trim()).sort((a, b) => b.name.length - a.name.length);
  let text = question;
  for (const person of ordered) {
    text = text.replace(new RegExp(escapeRegExp(person.name), 'gi'), person.pseudo);
  }
  return text;
}

/** Puts real names back. Person 10 is replaced before Person 1. */
export function restoreNames(text: string, people: PersonLabel[]): string {
  const ordered = [...people].sort((a, b) => {
    const na = Number(a.pseudo.replace(/\D/g, '')) || 0;
    const nb = Number(b.pseudo.replace(/\D/g, '')) || 0;
    return nb - na;
  });
  let out = text;
  for (const person of ordered) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(person.pseudo)}\\b`, 'g'), person.name);
  }
  return out;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** Drops identifiers and pay, and swaps a matching person name for their code. Seconds become hours. */
export function pseudonymize(value: unknown, people: PersonLabel[]): unknown {
  const byName = new Map(people.map((p) => [p.name.toLowerCase(), p.pseudo]));
  const walk = (current: unknown, depth: number): unknown => {
    if (depth > 6) return null;
    if (Array.isArray(current)) return current.slice(0, 40).map((item) => walk(item, depth + 1));
    if (!current || typeof current !== 'object') return current;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      if (DROP.has(key)) continue;
      if ((key === 'name' || key === 'employee_name') && typeof item === 'string' && byName.has(item.toLowerCase())) {
        out.person = byName.get(item.toLowerCase());
        continue;
      }
      if (key.endsWith('_seconds')) {
        const n = asNumber(item);
        if (n !== null) {
          out[key.replace(/_seconds$/, '_hours')] = Math.round(n / 360) / 10;
          continue;
        }
      }
      out[key] = walk(item, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}
