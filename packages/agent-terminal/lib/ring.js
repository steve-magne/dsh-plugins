/**
 * Scrollback ring buffer for the agent-terminal plugin.
 *
 * Terminals run for a long time and can emit megabytes; the host half keeps a
 * bounded tail per terminal and serves offset-based deltas to any number of
 * independent browser readers (the same non-consuming contract as the harness
 * collect-mode readers: `readFrom(offset)` → `{text, nextOffset, lossy}`).
 *
 * Offsets are CHARACTER counts of the logical stream (input is pre-decoded
 * UTF-8 text, so chunk boundaries never split a code point). Once the tail
 * has been trimmed past a reader's offset the answer is flagged `lossy` and
 * served from the oldest retained character — the client is expected to
 * replace its scrollback instead of appending.
 */

const MAX_CHUNK_BYTES = 1024 * 1024;

export class ScrollbackRing {
	/**
	 * @param {number} maxBytes - retained-tail budget in UTF-8 bytes (approximated
	 *   by counting characters conservatively; see {@link append}).
	 */
	constructor(maxBytes) {
		const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 256 * 1024;
		this.maxBytes = limit;
		this.chunks = [];
		this.byteLength = 0;
		this.baseOffset = 0;
		this.length = 0;
	}

	/**
	 * Append decoded text. Oversized appends are admitted by first trimming the
	 * ring down to its budget so one giant paste cannot balloon memory.
	 * @param {string} text - UTF-8-safe text (already decoded upstream).
	 */
	append(text) {
		if (typeof text !== "string" || text.length === 0) return;
		if (text.length > MAX_CHUNK_BYTES) {
			this.trimTo(this.maxBytes);
			this._push(text.slice(-Math.min(text.length, this.maxBytes)));
			return;
		}
		this._push(text);
		this.trimTo(this.maxBytes);
	}

	_push(text) {
		this.chunks.push(text);
		this.length += text.length;
		this.byteLength += Buffer.byteLength(text, "utf8");
	}

	_dropOldest() {
		const dropped = this.chunks.shift();
		if (dropped === undefined) return;
		this.baseOffset += dropped.length;
		this.length -= dropped.length;
		this.byteLength -= Buffer.byteLength(dropped, "utf8");
	}

	trimTo(maxBytes) {
		while (this.byteLength > maxBytes && this.chunks.length > 1) {
			this._dropOldest();
		}
	}

	/** Absolute offset of the first retained character. */
	get start() {
		return this.baseOffset;
	}

	/** Absolute offset just past the last retained character (= next read). */
	get end() {
		return this.baseOffset + this.length;
	}

	text() {
		return this.chunks.join("");
	}

	/**
	 * Non-consuming delta read.
	 * @param {number} offset - previously returned `nextOffset` (0 = from start).
	 */
	readFrom(offset) {
		const wanted = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
		if (wanted >= this.end) return { text: "", nextOffset: this.end, lossy: false };
		if (wanted <= this.baseOffset) {
			return {
				text: this.text(),
				nextOffset: this.end,
				lossy: this.baseOffset > 0 || wanted < this.baseOffset,
			};
		}
		const relative = wanted - this.baseOffset;
		let remaining = relative;
		let index = 0;
		while (index < this.chunks.length && remaining >= this.chunks[index].length) {
			remaining -= this.chunks[index].length;
			index += 1;
		}
		let out = "";
		for (let cursor = index; cursor < this.chunks.length; cursor += 1) {
			const chunk = this.chunks[cursor];
			out += remaining > 0 ? chunk.slice(remaining) : chunk;
			remaining = 0;
		}
		return { text: out, nextOffset: this.end, lossy: false };
	}
}
