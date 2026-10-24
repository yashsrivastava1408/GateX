import { SEVERITY_ORDER, type Finding } from '@ddd/shared';

export interface FindingGroup {
  /** The most serious of the merged findings, which is the one shown. */
  main: Finding;
  /** The others that say the same thing, in different words. */
  also: Finding[];
  /** Every examiner who raised any of them. */
  reportedBy: string[];
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'for', 'in', 'is', 'not', 'no', 'with', 'by', 'missing', 'lack', 'lacks', 'explicit', 'explicitly']);
const words = (text: string) => new Set(text.toLowerCase().replace(/[^a-z0-9- ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

function similar(a: Finding, b: Finding): boolean {
  if (a.dimensionId !== b.dimensionId || a.source !== b.source) return false;
  if (a.location?.sheet !== b.location?.sheet) return false;
  const x = words(`${a.title} ${a.fix}`);
  const y = words(`${b.title} ${b.fix}`);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.max(1, Math.min(x.size, y.size)) >= 0.6;
}

/** Examiners often report one problem several times in different words. Show it once, with the repeats folded under it. */
export function mergeFindings(findings: Finding[]): FindingGroup[] {
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
  const groups: FindingGroup[] = [];
  for (const f of sorted) {
    const home = groups.find((g) => similar(g.main, f));
    if (home) {
      home.also.push(f);
      home.reportedBy = [...new Set([...home.reportedBy, ...f.reportedBy])].sort();
    } else {
      groups.push({ main: f, also: [], reportedBy: [...f.reportedBy].sort() });
    }
  }
  return groups;
}
