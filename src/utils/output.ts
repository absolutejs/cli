/**
 * Output helpers — pretty tables for humans, raw JSON when `--json`.
 * No color escapes; CI logs render them as garbage.
 */

export type OutputMode = 'human' | 'json';

export const renderTable = (
	headers: string[],
	rows: ReadonlyArray<ReadonlyArray<string>>
): string => {
	if (rows.length === 0) {
		return `${headers.join('  ')}\n(no rows)\n`;
	}
	const widths = headers.map((header, columnIndex) => {
		const cells = rows.map((row) => row[columnIndex] ?? '');
		return Math.max(header.length, ...cells.map((cell) => cell.length));
	});
	const formatRow = (row: ReadonlyArray<string>): string =>
		row
			.map((cell, columnIndex) => (cell ?? '').padEnd(widths[columnIndex] ?? 0))
			.join('  ')
			.trimEnd();
	const lines = [formatRow(headers), formatRow(widths.map((w) => '-'.repeat(w)))];
	for (const row of rows) lines.push(formatRow(row));
	return `${lines.join('\n')}\n`;
};

export const writeOut = (text: string): void => {
	process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
};

export const writeJson = (value: unknown): void => {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

export const writeErr = (text: string): void => {
	process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
};

export const formatRelativeTime = (msAgo: number): string => {
	if (msAgo < 60_000) return `${Math.round(msAgo / 1000)}s ago`;
	if (msAgo < 3_600_000) return `${Math.round(msAgo / 60_000)}m ago`;
	if (msAgo < 86_400_000) return `${Math.round(msAgo / 3_600_000)}h ago`;
	return `${Math.round(msAgo / 86_400_000)}d ago`;
};
