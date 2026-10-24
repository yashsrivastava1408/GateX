import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/**
 * Edits cells of an existing workbook by rewriting its sheet XML, so defects can be
 * planted into the real Talentra file. A value of null empties the cell.
 */
export async function patchCells(
  source: Buffer,
  sheetName: string,
  edits: Record<string, string | number | null>,
): Promise<Buffer> {
  const files = unzipSync(source);
  const workbookXml = strFromU8(files['xl/workbook.xml']!);
  const sheetTag = [...workbookXml.matchAll(/<sheet\b[^>]*>/g)].map((m) => m[0]).find((tag) => tag.includes(`name="${sheetName}"`));
  if (!sheetTag) throw new Error(`no sheet ${sheetName}`);
  const rid = /r:id="([^"]+)"/.exec(sheetTag)![1]!;
  const rels = strFromU8(files['xl/_rels/workbook.xml.rels']!);
  const relTag = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((tag) => tag.includes(`Id="${rid}"`))!;
  const target = /Target="([^"]+)"/.exec(relTag)![1]!;
  const file = target.startsWith('/') ? target.slice(1) : `xl/${target}`;

  let xml = strFromU8(files[file]!);
  for (const [address, value] of Object.entries(edits)) {
    const pattern = new RegExp(`<c r="${address}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
    if (!pattern.test(xml)) throw new Error(`cell ${address} not found in ${sheetName}`);
    const replacement =
      value === null
        ? `<c r="${address}"/>`
        : typeof value === 'number'
          ? `<c r="${address}"><v>${value}</v></c>`
          : `<c r="${address}" t="inlineStr"><is><t>${String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`;
    xml = xml.replace(pattern, replacement);
  }
  files[file] = strToU8(xml);
  return Buffer.from(zipSync(files));
}
