/**
 * Minimal 5-field cron expression support for @dsh-plugins/scheduled-tasks.
 *
 * Pure, dependency-free, and local-time based (the harness host's zone):
 *
 *     minute hour day-of-month month day-of-week
 *
 * Each field accepts `*`, single values, ranges `a-b`, steps `*\/n` /
 * `a-b\/n`, and comma-separated lists; month and weekday names (`jan`,
 * `mon`) are accepted too. Classic vixie semantics for the day pair: when
 * BOTH day-of-month and day-of-week are restricted, a day matches when
 * EITHER side matches. `@hourly`, `@daily`, `@midnight`, `@weekly`,
 * `@monthly`, `@yearly` and `@annually` aliases are supported.
 */

export const CRON_ALIASES = {
	"@hourly": "0 * * * *",
	"@daily": "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@weekly": "0 0 * * 0",
	"@monthly": "0 0 1 * *",
	"@yearly": "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Field descriptors: [min, max, names?]. */
const FIELDS = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day-of-month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12, names: MONTH_NAMES },
	{ name: "day-of-week", min: 0, max: 7, names: WEEKDAY_NAMES },
];

function namedValue(token, field) {
	const raw = token.toLowerCase();
	if (!field.names) return undefined;
	const index = field.names.indexOf(raw.slice(0, 3));
	if (index < 0) return undefined;
	return field.min + index;
}

function parseTerm(term, field) {
	let valuePart = term;
	let step = 1;
	const slash = term.indexOf("/");
	if (slash >= 0) {
		valuePart = term.slice(0, slash);
		const stepText = term.slice(slash + 1);
		if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
			throw new Error(`cron field '${field.name}': invalid step '${stepText}'`);
		}
		step = Number(stepText);
	}
	let low;
	let high;
	if (valuePart === "*") {
		low = field.min;
		high = field.max;
	} else if (/^\d+$/.test(valuePart)) {
		low = parseValue(valuePart, field);
		high = slash >= 0 ? field.max : low;
	} else if (/^[a-z]+$/i.test(valuePart)) {
		low = parseValue(valuePart, field);
		high = slash >= 0 ? field.max : low;
	} else if (/^[\w-]+$/.test(valuePart)) {
		const parts = valuePart.split("-");
		if (parts.length !== 2) {
			throw new Error(`cron field '${field.name}': cannot read term '${term}'`);
		}
		low = parseValue(parts[0], field);
		high = parseValue(parts[1], field);
	} else {
		throw new Error(`cron field '${field.name}': cannot read term '${term}'`);
	}
	if (!Number.isInteger(low) || !Number.isInteger(high)) {
		throw new Error(`cron field '${field.name}': cannot read term '${term}'`);
	}
	if (low < field.min || high > field.max || low > high) {
		throw new Error(
			`cron field '${field.name}': term '${term}' out of range ${field.min}-${field.max}`,
		);
	}
	const values = new Set();
	for (let value = low; value <= high; value += step) values.add(value === 7 && field.max === 7 ? 0 : value);
	return values;
}

function parseValue(text, field) {
	if (/^\d+$/.test(text)) {
		const value = Number(text);
		if (value < field.min || value > field.max) {
			throw new Error(
				`cron field '${field.name}': value ${text} out of range ${field.min}-${field.max}`,
			);
		}
		return value === 7 && field.name === "day-of-week" ? 0 : value;
	}
	const named = namedValue(text, field);
	if (named === undefined) {
		throw new Error(`cron field '${field.name}': unknown value '${text}'`);
	}
	return named;
}

/**
 * Parse one cron expression into sorted match sets.
 * @returns {{ minutes: number[], hours: number[], daysOfMonth: number[]|null,
 *   months: number[], daysOfWeek: number[]|null }}
 */
export function parseCron(expression) {
	const text = String(expression ?? "").trim();
	if (!text) throw new Error("cron expression is empty");
	const expanded = CRON_ALIASES[text.toLowerCase()] ?? text;
	const parts = expanded.split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(
			`cron expression must have exactly 5 fields (minute hour dom month dow), got ${parts.length}: '${text}'`,
		);
	}
	const sets = parts.map((part, index) => {
		const field = FIELDS[index];
		const values = new Set();
		for (const term of part.split(",")) {
			if (term === "") throw new Error(`cron field '${field.name}': empty list item`);
			for (const value of parseTerm(term, field)) values.add(value);
		}
		return [...values].sort((a, b) => a - b);
	});
	const daysOfMonth = parts[2] === "*" ? null : sets[2];
	const daysOfWeek = parts[4] === "*" ? null : sets[4];
	return {
		minutes: sets[0],
		hours: sets[1],
		daysOfMonth,
		months: sets[3],
		daysOfWeek,
	};
}

function dayMatches(cron, date) {
	const dom = cron.daysOfMonth;
	const dow = cron.daysOfWeek;
	if (dom === null && dow === null) return true;
	const domHit = dom !== null && dom.includes(date.getDate());
	const dowHit = dow !== null && dow.includes(date.getDay());
	if (dom !== null && dow !== null) return domHit || dowHit;
	return dom !== null ? domHit : dowHit;
}

/**
 * First matching time strictly after `fromMs` (local time), or undefined.
 *
 * Minute-stepping loop pruned by month/day/hour: a non-matching month,
 * day, or hour advances the whole calendar block in ONE iteration, so even
 * rare schedules (`0 0 29 2 *`) resolve in a few thousand cheap steps.
 * @param {ReturnType<typeof parseCron>} cron
 */
export function nextCronRun(cron, fromMs) {
	const minuteSet = new Set(cron.minutes);
	const hourSet = new Set(cron.hours);
	const monthSet = new Set(cron.months);
	// Start at the next full local minute STRICTLY after `fromMs`.
	let cursorMs = new Date(Math.floor(Number(fromMs) / 60_000) * 60_000 + 60_000).getTime();
	// Horizon: ~10 years of minute steps; unreachable in practice thanks to
	// the block pruning above.
	for (let guard = 0; guard < 5_265_600; guard += 1) {
		const probe = new Date(cursorMs);
		if (!monthSet.has(probe.getMonth() + 1)) {
			cursorMs = new Date(probe.getFullYear(), probe.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
			continue;
		}
		if (!dayMatches(cron, probe)) {
			cursorMs = new Date(probe.getFullYear(), probe.getMonth(), probe.getDate() + 1, 0, 0, 0, 0).getTime();
			continue;
		}
		if (!hourSet.has(probe.getHours())) {
			cursorMs = new Date(probe.getFullYear(), probe.getMonth(), probe.getDate(), probe.getHours() + 1, 0, 0, 0).getTime();
			continue;
		}
		if (minuteSet.has(probe.getMinutes())) return cursorMs;
		cursorMs += 60_000;
	}
	return undefined;
}

/**
 * Parse + compute the first run strictly after `fromMs`.
 * @returns {number} epoch ms of the next occurrence.
 * @throws when the expression is invalid.
 */
export function nextRunAfter(expression, fromMs) {
	const candidate = nextCronRun(parseCron(expression), fromMs ?? Date.now());
	if (candidate === undefined) {
		throw new Error(`no occurrence of '${expression}' within the search horizon`);
	}
	return candidate;
}

/** Next `count` occurrences after `fromMs`; invalid expressions throw. */
export function nextRunsAfter(expression, fromMs, count = 3) {
	const cron = parseCron(expression);
	const runs = [];
	let cursor = fromMs ?? Date.now();
	for (let index = 0; index < count; index += 1) {
		const next = nextCronRun(cron, cursor);
		if (next === undefined) break;
		runs.push(next);
		cursor = next;
	}
	return runs;
}

/**
 * Short French description of a cron expression for list rendering
 * (best-effort; falls back to the raw expression).
 */
export function describeCron(expression) {
	try {
		const cron = parseCron(expression);
		const every = (values, size) => values.length === size;
		if (every(cron.minutes, 1) && every(cron.hours, 24) && !cron.daysOfMonth && !cron.daysOfWeek && every(cron.months, 12)) {
			return `toutes les heures à :${String(cron.minutes[0]).padStart(2, "0")}`;
		}
		if (cron.minutes.length === 1 && cron.hours.length === 1) {
			const time = `${String(cron.hours[0]).padStart(2, "0")}:${String(cron.minutes[0]).padStart(2, "0")}`;
			if (cron.daysOfMonth?.length === 1) return `le ${cron.daysOfMonth[0]} du mois à ${time}`;
			if (cron.daysOfWeek) {
				const names = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
				return cron.daysOfWeek.map((d) => names[d]).join(", ") + ` à ${time}`;
			}
			return `tous les jours à ${time}`;
		}
		if (every(cron.hours, 24)) {
			const step = cron.minutes.length > 1 ? cron.minutes[1] - cron.minutes[0] : 60 / Math.max(cron.minutes.length, 1);
			if ([5, 10, 15, 20, 30].includes(step) && cron.minutes.length === 60 / step && cron.minutes[0] === 0) {
				return `toutes les ${step} minutes`;
			}
		}
	} catch {
		/* fall through */
	}
	return String(expression ?? "");
}
