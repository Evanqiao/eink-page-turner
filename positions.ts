import { App, TFile, normalizePath } from 'obsidian';

/**
 * 默认的阅读位置文件。
 *
 * 必须放在库内的普通路径下：Obsidian Sync 不会同步以 `.` 开头的隐藏文件夹，
 * 放在库内的普通 JSON 文件则可以跟随 Obsidian Sync / Syncthing / iCloud 等方案同步。
 */
export const DEFAULT_POSITION_FILE = 'EinkPageTurner/positions.json';

const FILE_VERSION = 1;
const ANCHOR_MAX_LENGTH = 80;

/** 文本锚点过短时容易匹配到错误位置，短于该长度则不使用锚点，退回比例恢复。 */
export const MIN_ANCHOR_LENGTH = 12;

export interface PositionEntry {
	/** 阅读进度比例（0~1）。跨设备字体/屏幕不同时用它兜底。 */
	r: number;
	/** 可视区顶部文本块的文本锚点（截断）。 */
	a?: string;
	/** 位置在锚点块内部的偏移比例（0~1）。 */
	o?: number;
	/** 最后更新时间（毫秒时间戳），多端合并时取较新的一条。 */
	t: number;
}

interface PositionsFile {
	version?: number;
	positions?: Record<string, unknown>;
}

/** 归一化用于比对的文本：去掉零宽字符、合并空白并截断。 */
export function normalizeAnchor(text: string): string {
	return text
		.replace(/[\u200b\u200c\u200d\ufeff]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, ANCHOR_MAX_LENGTH);
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function sanitizeEntry(raw: unknown): PositionEntry | null {
	if (!raw || typeof raw !== 'object') return null;
	const data = raw as Record<string, unknown>;

	if (typeof data.r !== 'number' || !Number.isFinite(data.r)) return null;

	const entry: PositionEntry = {
		r: clamp01(data.r),
		t: typeof data.t === 'number' && Number.isFinite(data.t) ? data.t : 0,
	};

	if (typeof data.a === 'string') {
		const anchor = normalizeAnchor(data.a);
		if (anchor.length >= MIN_ANCHOR_LENGTH) {
			entry.a = anchor;
			entry.o =
				typeof data.o === 'number' && Number.isFinite(data.o) ? clamp01(data.o) : 0;
		}
	}

	return entry;
}

/**
 * 阅读位置存储。
 *
 * 数据保存在库内一个 JSON 文件中，格式：
 * `{ "version": 1, "positions": { "笔记路径.md": { "r": 0.42, "a": "...", "o": 0.3, "t": 1710000000000 } } }`
 *
 * 多端同步的关键：每次写盘前都重新读取文件、按每个条目的时间戳合并，而不是直接覆盖整份文件。
 * 这样两台设备先后记录的笔记位置不会互相冲掉（同一篇笔记同时阅读时仍以较新的为准）。
 */
export class PositionStore {
	private entries = new Map<string, PositionEntry>();
	private dirty = new Set<string>();
	private removed = new Set<string>();

	private loaded = false;
	private lastReadAt = 0;

	private filePath: string;
	private flushTimer: number | null = null;
	private flushChain: Promise<void> = Promise.resolve();

	constructor(private app: App, filePath: string) {
		this.filePath = normalizePath(filePath || DEFAULT_POSITION_FILE);
	}

	get path(): string {
		return this.filePath;
	}

	/** 切换位置文件。已有记录会迁移到新文件（新文件中同路径的较新记录优先保留）。 */
	async setPath(filePath: string): Promise<void> {
		const next = normalizePath(filePath || DEFAULT_POSITION_FILE);
		if (next === this.filePath) return;

		await this.flush();

		this.filePath = next;
		this.loaded = false;
		this.lastReadAt = 0;
		this.dirty.clear();
		this.removed.clear();

		// 把内存中的记录全部标记为待写入，下次落盘时写入新文件。
		for (const key of this.entries.keys()) this.dirty.add(key);
		if (this.entries.size > 0) this.scheduleFlush();
	}

	/** 读取某篇笔记的位置；会按需刷新磁盘内容，以拿到其他端同步过来的更新。 */
	async get(path: string): Promise<PositionEntry | null> {
		await this.load(Date.now() - this.lastReadAt > 1000);
		return this.entries.get(path) ?? null;
	}

	remember(path: string, entry: PositionEntry): void {
		this.entries.set(path, entry);
		this.removed.delete(path);
		this.dirty.add(path);
		this.scheduleFlush();
	}

	/** 文件或文件夹重命名时，把对应记录迁移到新路径。 */
	async rename(oldPath: string, newPath: string): Promise<void> {
		if (oldPath === newPath) return;

		await this.load(true);

		const prefix = oldPath + '/';
		const moves: Array<[string, string, PositionEntry]> = [];
		for (const [key, entry] of this.entries) {
			if (key === oldPath) {
				moves.push([key, newPath, entry]);
			} else if (key.startsWith(prefix)) {
				moves.push([key, newPath + key.slice(oldPath.length), entry]);
			}
		}

		for (const [oldKey, newKey, entry] of moves) {
			this.entries.delete(oldKey);
			this.entries.set(newKey, entry);
			this.removed.add(oldKey);
			this.dirty.add(newKey);
		}
		if (moves.length > 0) this.scheduleFlush();
	}

	/** 文件或文件夹删除时，一并清掉对应记录。 */
	async forget(path: string): Promise<void> {
		await this.load(true);

		const prefix = path + '/';
		let changed = false;
		for (const key of Array.from(this.entries.keys())) {
			if (key === path || key.startsWith(prefix)) {
				this.entries.delete(key);
				this.removed.add(key);
				changed = true;
			}
		}
		if (changed) this.scheduleFlush();
	}

	/** 立即把待写入的改动合并落盘。 */
	async flush(): Promise<void> {
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}

		const run = async (): Promise<void> => {
			if (this.dirty.size === 0 && this.removed.size === 0) return;

			const dirty = new Set(this.dirty);
			const removed = new Set(this.removed);
			this.dirty.clear();
			this.removed.clear();

			try {
				const disk = await this.readFile();
				if (disk === null) {
					// 文件存在但不是合法格式：宁可跳过本次写入，也不覆盖用户数据。
					this.restorePending(dirty, removed);
					console.error(
						'[eink-page-turner] 阅读位置文件格式无法解析，已跳过本次写入：',
						this.filePath,
					);
					return;
				}

				const merged = new Map(disk);
				for (const key of removed) merged.delete(key);

				for (const [key, entry] of this.entries) {
					if (removed.has(key)) continue;
					const existing = merged.get(key);
					if (!existing || entry.t >= existing.t) merged.set(key, entry);
				}

				await this.writeFile(merged);
				// 写盘是异步的，期间可能又有新的滚动记录（remember）或重命名/删除。
				// 因此把磁盘合并结果并回内存，而不是直接用旧快照覆盖内存。
				for (const [key, entry] of merged) {
					if (this.removed.has(key)) continue;
					const local = this.entries.get(key);
					if (!local || entry.t > local.t) this.entries.set(key, entry);
				}
				this.loaded = true;
				this.lastReadAt = Date.now();
			} catch (error) {
				this.restorePending(dirty, removed);
				console.error('[eink-page-turner] 保存阅读位置失败：', error);
			}
		};

		const next = this.flushChain.then(run, run);
		this.flushChain = next.catch(() => undefined);
		return next;
	}

	private restorePending(dirty: Set<string>, removed: Set<string>): void {
		for (const key of dirty) this.dirty.add(key);
		for (const key of removed) this.removed.add(key);
	}

	private scheduleFlush(delay = 800): void {
		// 连续滚动时不断延后，等停下来再写盘，避免频繁写文件和多端同步风暴。
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, delay);
	}

	private async load(force: boolean): Promise<void> {
		if (this.loaded && !force) return;

		const disk = await this.readFile();
		if (disk) {
			for (const [key, entry] of disk) {
				// 本地已删除/移动的条目不要从磁盘复活，除非磁盘上是更新的记录。
				if (this.removed.has(key)) continue;
				const local = this.entries.get(key);
				if (!local || entry.t >= local.t) this.entries.set(key, entry);
			}
		}

		this.loaded = true;
		this.lastReadAt = Date.now();
	}

	/** 返回 null 表示文件存在但内容无法解析（调用方不应覆盖它）。 */
	private async readFile(): Promise<Map<string, PositionEntry> | null> {
		try {
			if (!(await this.app.vault.adapter.exists(this.filePath))) return new Map();

			const raw = await this.app.vault.adapter.read(this.filePath);
			if (!raw.trim()) return new Map();

			const parsed = JSON.parse(raw) as PositionsFile | null;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return null;
			}

			const positions = parsed.positions;
			if (positions === undefined) return new Map();
			if (typeof positions !== 'object' || positions === null || Array.isArray(positions)) {
				return null;
			}

			const map = new Map<string, PositionEntry>();
			for (const [key, value] of Object.entries(positions)) {
				const entry = sanitizeEntry(value);
				if (entry) map.set(key, entry);
			}
			return map;
		} catch (error) {
			console.warn('[eink-page-turner] 读取阅读位置文件失败：', this.filePath, error);
			return null;
		}
	}

	private async writeFile(entries: Map<string, PositionEntry>): Promise<void> {
		await this.ensureParentFolder();

		const positions: Record<string, PositionEntry> = {};
		for (const key of Array.from(entries.keys()).sort()) {
			const entry = entries.get(key);
			if (entry) positions[key] = entry;
		}

		const payload: PositionsFile = { version: FILE_VERSION, positions };
		const content = JSON.stringify(payload, null, '\t') + '\n';

		// 优先通过 Vault API 写入：这样会触发库的 create/modify 事件，
		// Obsidian Sync 等同步插件才能及时感知到这个文件的变化。
		const existing = this.app.vault.getAbstractFileByPath(this.filePath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
			return;
		}

		try {
			await this.app.vault.create(this.filePath, content);
		} catch (error) {
			// 文件可能已在磁盘上但还没进入 Vault 索引，用 adapter 兜底写入。
			try {
				await this.app.vault.adapter.write(this.filePath, content);
			} catch {
				throw error;
			}
			console.warn(
				'[eink-page-turner] 位置文件未通过 Vault API 写入，已直接写入磁盘：',
				error,
			);
		}
	}

	private async ensureParentFolder(): Promise<void> {
		const folder = this.filePath.split('/').slice(0, -1).join('/');
		if (!folder) return;

		let current = '';
		for (const segment of folder.split('/')) {
			current = current ? `${current}/${segment}` : segment;
			if (await this.app.vault.adapter.exists(current)) continue;
			try {
				await this.app.vault.createFolder(current);
			} catch (error) {
				// 并发创建时可能已经存在，确认后忽略。
				if (!(await this.app.vault.adapter.exists(current))) throw error;
			}
		}
	}
}
