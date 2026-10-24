import type { Strength } from '@ddd/shared';
import { CellChip } from '../../components/Chip';

/** Grouped by area, with repeats removed, so ten lines about one thing read as one. */
export function StrengthsList({ strengths, names = {} }: { strengths: Strength[]; names?: Record<string, string> }) {
  if (strengths.length === 0) {
    return <p className="muted">No strengths were noted for this check.</p>;
  }
  const groups = new Map<string, Strength[]>();
  for (const s of strengths) {
    const list = groups.get(s.dimensionId) ?? [];
    if (!list.some((x) => x.text === s.text)) list.push(s);
    groups.set(s.dimensionId, list);
  }
  return (
    <div className="strength-groups">
      {[...groups].map(([id, list]) => (
        <section key={id} className="strength-group">
          <h3>
            {names[id] ?? 'This area'}
            {list.length > 1 && <span className="chip chip-accent chip-sm">{list.length} strengths</span>}
          </h3>
          <ul className="strengths">
            {list.map((s, i) => (
              <li key={i}>
                <span>{s.text}</span>
                {s.location && <CellChip sheet={s.location.sheet} cell={s.location.cell} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
