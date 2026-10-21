/**
 * Which option of a native <select> the model meant.
 *
 * Every dropdown has a label a reader sees and a value the form sends, and on
 * most sites they differ ("United States" / "US", "Large" / "L", "Dimmable" /
 * "yes"). The model sees both — values appear in the page description and in
 * addresses — and sometimes names an option by its value. The page tool only
 * accepts the exact label, so that turn failed and the visitor was shown an
 * error the agent fixed on its next turn.
 *
 * In order, and only when exactly one option qualifies: the exact label, the
 * label ignoring case and spacing, then the value ignoring case and spacing.
 * Two options that both qualify are a real ambiguity and are left to fail as
 * before rather than guessed between.
 */
export type SelectOptionChoice = { text: string; value: string };

function comparable(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

export function resolveSelectOptionLabel(options: SelectOptionChoice[], requested: string): string | undefined {
  const wanted = requested.trim();
  if (!wanted) return undefined;
  const exact = options.filter((option) => option.text.trim() === wanted);
  if (exact.length === 1) return exact[0].text.trim();
  const target = comparable(wanted);
  const byLabel = options.filter((option) => comparable(option.text) === target);
  if (byLabel.length === 1) return byLabel[0].text.trim();
  if (byLabel.length > 1) return undefined;
  const byValue = options.filter((option) => option.value.trim() !== "" && comparable(option.value) === target);
  return byValue.length === 1 ? byValue[0].text.trim() : undefined;
}
