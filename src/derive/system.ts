/** Product lines whose parts do not fit LEGO System studs. */
const LINES = 'Duplo|Quatro|Primo|Znap|Modulex|Belville|Scala|Fabuland|Clikits';
const LINE_WORD = new RegExp(`\\b(?:${LINES})\\b`);
/** A line named as the subject: at the start, after ", ", or after "[", as in "Storage, Duplo, Truck". */
const LINE_SUBJECT = new RegExp(`(?:^|, |\\[)(?:${LINES})\\b`);

/**
 * False for parts of a non-System product line, judged by category name, then by part name.
 * Only the name before " with " counts, so "Tile 2 x 2 with Fabuland Print" stays System.
 */
export function isSystemPart(name: string, categoryName: string): boolean {
  if (LINE_WORD.test(categoryName) || categoryName === 'Non-System Parts') return false;
  const subject = name.split(' with ')[0]!;
  return !(LINE_SUBJECT.test(subject) || /\bZnap\b/.test(subject));
}
