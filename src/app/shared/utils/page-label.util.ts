/**
 * Read-side normalization for page label values that were persisted by older
 * builds with a misspelling.
 *
 * Why read-side: the corrected spelling only exists in `predefinedPageNames`
 * going forward, so pages saved before the fix still carry the old string in
 * the database. Rewriting them would require a bulk write across every edition;
 * instead the value is corrected wherever it is read, and a page permanently
 * picks up the corrected spelling the next time an admin saves it.
 *
 * The map is keyed on the exact legacy string (trimmed). Anything not listed —
 * including custom labels typed by an admin — is returned untouched.
 */
const LEGACY_PAGE_LABEL_FIXES: Readonly<Record<string, string>> = Object.freeze({
  // Misspelled Supplement label used by admin builds before Aug 2026.
  'বিষেশ সংখ্যা': 'বিশেষ সংখ্যা',
});

/**
 * Returns the canonical spelling for a stored page label.
 *
 * Non-string input (PHP can serialize an unset field as `[]`) yields `''`.
 * Values with no known correction are returned exactly as stored, whitespace
 * included, so this is a no-op for every label except the legacy ones above.
 */
export function normalizePageLabelValue(label: string | null | undefined): string {
  if (typeof label !== 'string') return '';
  return LEGACY_PAGE_LABEL_FIXES[label.trim()] ?? label;
}
