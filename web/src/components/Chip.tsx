import type { Decision, Severity } from '@ddd/shared';
import { DECISION_LABEL, SEVERITY_LABEL } from '../format';
import { SEVERITY } from '../copy';
import type { ReactNode } from 'react';
import { Icon } from './Icons';

export function DecisionChip({ decision, size = 'md' }: { decision: Decision | null; size?: 'sm' | 'md' | 'lg' }) {
  if (!decision) return <span className="chip chip-muted">No verdict</span>;
  return (
    <span className={`chip chip-${decision} chip-${size}`}>
      {size === 'sm' ? <span className="chip-dot" /> : <Icon name={decision === 'green' ? 'check' : decision === 'amber' ? 'alert' : 'x'} size={size === 'lg' ? 15 : 13} strokeWidth={2.6} />}
      {DECISION_LABEL[decision]}
    </span>
  );
}

export function SeverityChip({ severity }: { severity: Severity }) {
  const tone = severity === 'HIGH' ? 'red' : severity === 'MEDIUM' ? 'amber' : 'muted';
  const title = SEVERITY[severity].help;
  return <span className={`chip chip-${tone} chip-sm`} title={title}>{SEVERITY_LABEL[severity]}</span>;
}

export function Chip({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'accent' | 'green' | 'amber' | 'red' | 'blue' }) {
  return <span className={`chip chip-${tone} chip-sm`}>{children}</span>;
}

/** Where to look in the file. In a PDF this is a line on a page (A42 = line 42), so say that in words. */
export function CellChip({ sheet, cell }: { sheet: string; cell: string }) {
  const line = /^Page \d+$/.test(sheet) ? /^A(\d+)$/.exec(cell)?.[1] : undefined;
  return (
    <span className="cell-chip mono" title={line ? `${sheet}, line ${line}` : `${sheet}, cell ${cell}`}>
      <span className="cell-chip-sheet">{sheet}</span>
      <span className="cell-chip-cell">{line ? `line ${line}` : cell}</span>
    </span>
  );
}
