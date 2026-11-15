import { MarkdownView, Plugin, TFile } from 'obsidian';
import {
	EinkPageTurnerSettingTab,
	DEFAULT_SETTINGS,
	type EinkPageTurnerSettings,
} from './settings';
import {
	MIN_ANCHOR_LENGTH,
	normalizeAnchor,
	PositionStore,
	type PositionEntry,
} from './positions';

const MAX_RESTORE_ATTEMPTS = 24;
const CONTENT_GATE_ATTEMPTS = 8;

interface ViewState {
	path: string;
	/** 本次打开是否已经尝试过恢复（恢复成功、失败或被用户打断都算）。 */
	restored: boolean;
	loading: boolean;
	/** 本次打开的时间，用来判断用户在打开之后是否已经操作过。 */
	openedAt: number;
}

interface RestoreSession {
	view: MarkdownView;
	file: TFile;
	entry: PositionEntry;
	/** 打开时从文件读到的内容，用来确认阅读视图已经切换到新笔记，而不是还显示上一篇。 */
	expectedContent: string | null;
	/** 打开瞬间阅读视图里的内容，用来识别内容是否已经切换过。 */
	initialPreviewText: string | null;
	attempts: number;
	lastHeight: number;
	stable: number;
	/** 第一次真正设置滚动位置的 attempt 序号，用来限制反复纠偏的次数。 */
	appliedAttempt: number | null;
	/** 上一次由本插件设置的 scrollTop，用来发现其他程序/用户改变过滚动位置。 */
	lastApplied: number | null;
	timer: number | null;
	detach: (() => void) | null;
}

export default class EinkPageTurnerPlugin extends Plugin {
	settings: EinkPageTurnerSettings;
	store: PositionStore;

	private touchStartX = 0;
	private touchStartY = 0;
	private touchStartTime = 0;

	private viewStates = new WeakMap<MarkdownView, ViewState>();
	private restoreSession: RestoreSession | null = null;
	private lastUserInputAt = 0;

	private anchorTimer: number | null = null;
	private anchorTarget: { view: MarkdownView; path: string } | null = null;
	private pathApplyTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		this.store = new PositionStore(this.app, this.settings.positionFilePath);
		this.addSettingTab(new EinkPageTurnerSettingTab(this.app, this));
		this.registerTouchEvents();
		this.registerPositionTracking();
	}

	onunload() {
		if (this.anchorTimer !== null) window.clearTimeout(this.anchorTimer);
		if (this.pathApplyTimer !== null) window.clearTimeout(this.pathApplyTimer);
		this.anchorTimer = null;
		this.pathApplyTimer = null;
		this.cancelRestore();
		void this.store?.flush();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** 设置面板修改位置文件路径后延迟生效，避免逐字输入时反复迁移。 */
	schedulePositionPathApply() {
		if (this.pathApplyTimer !== null) window.clearTimeout(this.pathApplyTimer);
		this.pathApplyTimer = window.setTimeout(() => {
			this.pathApplyTimer = null;
			void this.store.setPath(this.settings.positionFilePath);
		}, 800);
	}

	// ── Touch event handling ────────────────────────────────────────

	private registerTouchEvents() {
		this.registerDomEvent(document, 'touchstart', (e: TouchEvent) => {
			if (!this.isActive()) return;

			const touch = e.changedTouches[0];
			this.touchStartX = touch.clientX;
			this.touchStartY = touch.clientY;
			this.touchStartTime = Date.now();
		}, { passive: true });

		this.registerDomEvent(document, 'touchend', (e: TouchEvent) => {
			if (!this.isActive()) return;

			const touch = e.changedTouches[0];
			const touchEndX = touch.clientX;
			const touchEndY = touch.clientY;
			const touchEndTime = Date.now();

			const deltaX = Math.abs(touchEndX - this.touchStartX);
			const deltaY = Math.abs(touchEndY - this.touchStartY);
			const deltaTime = touchEndTime - this.touchStartTime;

			if (
				deltaX < this.settings.maxClickDistance &&
				deltaY < this.settings.maxClickDistance &&
				deltaTime < this.settings.maxClickDuration
			) {
				this.handlePageTurn(touchEndX, e);
			}
		}, { passive: true });
	}

	// ── Reading position tracking ───────────────────────────────────

	private registerPositionTracking() {
		this.registerEvent(this.app.workspace.on('file-open', () => {
			void this.store.flush();
			this.tryRestoreForActiveView();
		}));

		this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
			void this.store.flush();
			this.tryRestoreForActiveView();
		}));

		// 在阅读/源码模式之间切换时布局会变化，此时补一次恢复尝试。
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			this.tryRestoreForActiveView();
		}));

		this.registerDomEvent(document, 'scroll', (event) => {
			if (!this.settings.rememberReadingPosition) return;
			if (!(event.target instanceof HTMLElement)) return;

			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view || view.getMode() !== 'preview') return;
			if (event.target !== this.getScrollContainer(view)) return;
			if (this.isRestoring(view)) return;

			// 先立即记下比例（很轻量），稍后再补文本锚点，避免快速切走时丢失位置。
			this.recordPosition(view, false);
			this.scheduleAnchorCapture(view);
		}, { capture: true, passive: true });

		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.hidden) void this.store.flush();
		});
		// 移动端切后台/被系统回收前不一定触发 beforeunload，多听几个事件。
		this.registerDomEvent(window, 'pagehide', () => {
			void this.store.flush();
		});
		this.registerDomEvent(window, 'blur', () => {
			void this.store.flush();
		});
		this.registerDomEvent(window, 'beforeunload', () => {
			void this.store.flush();
		});

		// 用户操作时间戳：打开笔记后如果用户已经滚动/点击/按键，就不再强行恢复位置。
		const markUserInput = () => {
			this.lastUserInputAt = Date.now();
		};
		this.registerDomEvent(document, 'wheel', markUserInput, { capture: true, passive: true });
		this.registerDomEvent(document, 'touchstart', markUserInput, { capture: true, passive: true });
		this.registerDomEvent(document, 'mousedown', markUserInput, { capture: true, passive: true });
		this.registerDomEvent(document, 'keydown', markUserInput, { capture: true, passive: true });

		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (!this.settings.rememberReadingPosition) return;
			void this.store.rename(oldPath, file.path);
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (!this.settings.rememberReadingPosition) return;
			void this.store.forget(file.path);
		}));

		this.app.workspace.onLayoutReady(() => this.tryRestoreForActiveView());
	}

	private scheduleAnchorCapture(view: MarkdownView) {
		const file = view.file;
		if (!file) return;

		this.anchorTarget = { view, path: file.path };
		if (this.anchorTimer !== null) window.clearTimeout(this.anchorTimer);
		this.anchorTimer = window.setTimeout(() => {
			this.anchorTimer = null;
			const target = this.anchorTarget;
			this.anchorTarget = null;
			if (!target) return;
			if (target.view.file?.path !== target.path) return;
			if (target.view.getMode() !== 'preview') return;
			if (this.isRestoring(target.view)) return;
			this.recordPosition(target.view, true);
		}, 260);
	}

	private recordPosition(view: MarkdownView, withAnchor: boolean) {
		if (!this.settings.rememberReadingPosition) return;

		const file = view.file;
		if (!file || view.getMode() !== 'preview') return;

		const scroller = this.getScrollContainer(view);
		const max = scroller.scrollHeight - scroller.clientHeight;
		if (max <= 4) return;

		const scrollTop = scroller.scrollTop;
		const entry: PositionEntry = {
			r: Math.min(1, Math.max(0, scrollTop / max)),
			t: Date.now(),
		};

		if (withAnchor) {
			const anchor = this.readAnchor(scroller, scrollTop);
			if (anchor) {
				entry.a = anchor.text;
				entry.o = anchor.offset;
			}
		}

		this.store.remember(file.path, entry);
	}

	/** 取可视区顶部第一个非空文本块作为锚点，记录块内偏移。 */
	private readAnchor(
		scroller: HTMLElement,
		scrollTop: number,
	): { text: string; offset: number } | null {
		const blocks = this.getAnchorBlocks(scroller);
		if (blocks.length === 0) return null;

		const scrollerRect = scroller.getBoundingClientRect();

		for (const block of blocks) {
			const rect = block.getBoundingClientRect();
			if (rect.height <= 0) continue;
			if (rect.bottom <= scrollerRect.top + 1) continue;

			const text = normalizeAnchor(block.textContent ?? '');
			if (text.length < MIN_ANCHOR_LENGTH) return null;

			const blockTop = rect.top - scrollerRect.top + scrollTop;
			const offset = (scrollTop - blockTop) / rect.height;
			return {
				text,
				offset: Math.min(1, Math.max(0, offset)),
			};
		}

		return null;
	}

	private getAnchorBlocks(scroller: HTMLElement): HTMLElement[] {
		const sizer = scroller.querySelector<HTMLElement>('.markdown-preview-sizer');
		const root = sizer ?? scroller;

		const children = Array.from(root.children).filter(
			(el): el is HTMLElement => el instanceof HTMLElement,
		);
		if (children.length > 1) {
			return children.filter(
				(el) => !el.classList.contains('markdown-preview-pusher'),
			);
		}

		return Array.from(
			root.querySelectorAll<HTMLElement>(
				'p, li, blockquote, pre, table, h1, h2, h3, h4, h5, h6',
			),
		);
	}

	// ── Restoring reading position ──────────────────────────────────

	private tryRestoreForActiveView() {
		if (!this.settings.rememberReadingPosition) return;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		this.ensureViewState(view);
		this.tryRestore(view);
	}

	private ensureViewState(view: MarkdownView): ViewState {
		const path = view.file?.path ?? '';
		let state = this.viewStates.get(view);
		if (!state || state.path !== path) {
			state = { path, restored: false, loading: false, openedAt: Date.now() };
			this.viewStates.set(view, state);
		}
		return state;
	}

	private tryRestore(view: MarkdownView) {
		if (!this.settings.rememberReadingPosition) return;

		const file = view.file;
		if (!file || view.getMode() !== 'preview') return;

		const state = this.ensureViewState(view);
		if (state.restored || state.loading) return;

		const session = this.restoreSession;
		if (session && session.view === view && session.file.path === file.path) return;

		state.loading = true;
		// 同时读取位置记录和笔记内容：后者用于确认阅读视图已经切换到了新笔记。
		void Promise.all([
			this.store.get(file.path),
			this.app.vault.cachedRead(file).catch(() => null),
		]).then(([entry, content]) => {
			if (this.viewStates.get(view) !== state) return;

			if (!entry) {
				state.restored = true;
				return;
			}
			if (view.file?.path !== file.path || view.getMode() !== 'preview') return;
			if (!this.settings.rememberReadingPosition) return;
			if (this.lastUserInputAt > state.openedAt) {
				// 打开笔记后用户已经开始操作，不要把他拽回去。
				state.restored = true;
				return;
			}

			this.startRestore(view, file, entry, content);
		}).finally(() => {
			state.loading = false;
		});
	}

	private startRestore(
		view: MarkdownView,
		file: TFile,
		entry: PositionEntry,
		expectedContent: string | null,
	) {
		this.cancelRestore();

		const session: RestoreSession = {
			view,
			file,
			entry,
			expectedContent,
			initialPreviewText: this.getPreviewText(view),
			attempts: 0,
			lastHeight: -1,
			stable: 0,
			appliedAttempt: null,
			lastApplied: null,
			timer: null,
			detach: null,
		};
		this.restoreSession = session;

		this.attachRestoreCancel(session);
		this.scheduleRestoreAttempt(session, 0);
	}

	private getPreviewText(view: MarkdownView): string | null {
		try {
			return view.previewMode?.get() ?? null;
		} catch {
			return null;
		}
	}

	private isPreviewContentReady(
		session: RestoreSession,
		previewText: string | null,
	): boolean {
		if (session.expectedContent === null) return true;
		if (previewText === null) return false;
		if (previewText === session.expectedContent) return true;
		// 文件内容可能被 Obsidian 做过格式归一化，只要已经从打开时的旧内容变成别的内容，也认为切换完成。
		return (
			session.initialPreviewText !== null &&
			previewText !== session.initialPreviewText
		);
	}

	private restoreDelay(attempts: number): number {
		return Math.min(150 * attempts, 900);
	}

	private attachRestoreCancel(session: RestoreSession) {
		const cancel = () => this.finishRestore(session);
		const listener = cancel as EventListener;
		const types: Array<keyof WindowEventMap> = [
			'wheel',
			'touchstart',
			'mousedown',
			'keydown',
		];

		for (const type of types) {
			window.addEventListener(type, listener, { capture: true, passive: true });
		}
		session.detach = () => {
			for (const type of types) {
				window.removeEventListener(type, listener, { capture: true });
			}
		};
	}

	private scheduleRestoreAttempt(session: RestoreSession, delay: number) {
		session.timer = window.setTimeout(() => {
			session.timer = null;
			this.restoreAttempt(session);
		}, delay);
	}

	private restoreAttempt(session: RestoreSession) {
		if (session !== this.restoreSession) return;

		const view = session.view;
		if (view.file?.path !== session.file.path || view.getMode() !== 'preview') {
			this.finishRestore(session);
			return;
		}

		session.attempts++;
		if (session.attempts > MAX_RESTORE_ATTEMPTS) {
			this.finishRestore(session);
			return;
		}

		const delay = this.restoreDelay(session.attempts);
		const previewText = this.getPreviewText(view);

		// 先确认阅读视图已经换成新笔记的内容。切换文件时旧笔记的 DOM 还会存在一小段时间，
		// 如果这时就按旧内容计算滚动位置，会跳到错误的地方。
		if (
			session.attempts <= CONTENT_GATE_ATTEMPTS &&
			!this.isPreviewContentReady(session, previewText)
		) {
			this.scheduleRestoreAttempt(session, delay);
			return;
		}

		const scroller = this.getScrollContainer(view);
		const max = scroller.scrollHeight - scroller.clientHeight;

		if (session.lastApplied === null && scroller.scrollTop > 4) {
			// 新内容还没换上来（旧笔记的滚动位置还在），或者 Obsidian 已经跳到了
			// 某个明确位置（标题链接、标签页位置恢复）。先等，不要和它抢。
			this.scheduleRestoreAttempt(session, delay);
			return;
		}

		if (max <= 4) {
			// 可能内容还没渲染出高度，也可能本来就是短笔记。多等一段时间，
			// 避免长笔记在渲染完成前被误判成“不需要恢复”。
			this.scheduleRestoreAttempt(session, delay);
			return;
		}

		if (session.lastApplied !== null) {
			const drift = scroller.scrollTop - session.lastApplied;
			if (Math.abs(drift) > 8) {
				if (scroller.scrollTop > 4) {
					// 其他程序把滚动位置改到了非顶部（例如标题跳转），让位。
					this.finishRestore(session);
					return;
				}
				// 被重置回顶部（重新渲染/布局变化），继续纠偏。
				session.stable = 0;
			}
		}

		const target = this.resolveRestoreTarget(scroller, session.entry, max);
		const heightChanged = scroller.scrollHeight !== session.lastHeight;
		session.lastHeight = scroller.scrollHeight;

		if (Math.abs(scroller.scrollTop - target) > 8) {
			// 直接赋值 scrollTop 而不是 scrollTo，避免主题的 scroll-behavior 让墨水屏出现过渡动画。
			scroller.scrollTop = target;
			session.stable = 0;
		} else if (heightChanged) {
			// 高度刚变化（例如图片加载完成、渐进渲染补上高度），再多等几轮确认位置。
			session.stable = 1;
		} else {
			session.stable++;
		}
		session.lastApplied = scroller.scrollTop;
		if (session.appliedAttempt === null) session.appliedAttempt = session.attempts;

		if (
			session.stable >= 3 ||
			(session.appliedAttempt !== null &&
				session.attempts - session.appliedAttempt >= 6)
		) {
			this.finishRestore(session);
			return;
		}

		this.scheduleRestoreAttempt(session, delay);
	}

	private resolveRestoreTarget(
		scroller: HTMLElement,
		entry: PositionEntry,
		max: number,
	): number {
		const ratioTarget = Math.min(1, Math.max(0, entry.r)) * max;
		if (!entry.a) return ratioTarget;

		const blocks = this.getAnchorBlocks(scroller);
		if (blocks.length === 0) return ratioTarget;

		const scrollerRect = scroller.getBoundingClientRect();
		const matches: Array<{ top: number; height: number }> = [];

		for (const block of blocks) {
			const text = normalizeAnchor(block.textContent ?? '');
			if (text.length < entry.a.length || !text.startsWith(entry.a)) continue;

			const rect = block.getBoundingClientRect();
			matches.push({
				top: rect.top - scrollerRect.top + scroller.scrollTop,
				height: rect.height,
			});
		}

		if (matches.length === 0) return ratioTarget;

		// 同一段文本可能重复出现（如列表项），取离比例估算位置最近的那个。
		let best = matches[0];
		for (const match of matches) {
			if (Math.abs(match.top - ratioTarget) < Math.abs(best.top - ratioTarget)) {
				best = match;
			}
		}

		const offset = Math.min(1, Math.max(0, entry.o ?? 0));
		return Math.min(max, Math.max(0, best.top + offset * best.height));
	}

	private isRestoring(view: MarkdownView): boolean {
		return this.restoreSession !== null && this.restoreSession.view === view;
	}

	private cancelRestore() {
		if (this.restoreSession) this.finishRestore(this.restoreSession);
	}

	private finishRestore(session: RestoreSession) {
		if (session !== this.restoreSession) return;

		if (session.timer !== null) window.clearTimeout(session.timer);
		session.timer = null;
		if (session.detach) session.detach();
		session.detach = null;
		this.restoreSession = null;

		const state = this.viewStates.get(session.view);
		if (state && state.path === session.file.path) state.restored = true;
	}

	// ── Gating ──────────────────────────────────────────────────────

	private isActive(): boolean {
		if (!this.settings.enablePlugin) return false;

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return false;

		const isPreview = activeView.getMode() === 'preview';
		const isFullscreen = document.body.classList.contains('is-fullscreen');

		return isPreview || (this.settings.enableInEditMode && isFullscreen);
	}

	// ── Page turn logic ─────────────────────────────────────────────

	private getScrollContainer(view: MarkdownView): HTMLElement {
		const selectors = [
			'.markdown-reading-view',
			'.markdown-preview-view',
			'.cm-scroller',
			'.view-content',
		];
		for (const sel of selectors) {
			const el = view.containerEl.querySelector(sel) as HTMLElement | null;
			if (el && el.scrollHeight > el.clientHeight) {
				return el;
			}
		}
		return view.containerEl;
	}

	private handlePageTurn(clickX: number, e: TouchEvent) {
		const target = e.target as HTMLElement;
		const interactiveElements = ['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'IMG'];

		if (
			interactiveElements.includes(target.tagName) ||
			target.closest('a') ||
			target.closest('button') ||
			target.classList.contains('clickable-icon')
		) {
			return;
		}

		const screenWidth = window.innerWidth;
		const leftZoneWidth = screenWidth * this.settings.leftZonePercentage;
		const rightZoneWidth = screenWidth * this.settings.rightZonePercentage;

		if (clickX < leftZoneWidth) {
			this.turnPageUp();
		} else if (clickX > screenWidth - rightZoneWidth) {
			this.turnPageDown();
		}
	}

	private turnPageDown() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const scroller = this.getScrollContainer(view);
		const viewportHeight = scroller.clientHeight;
		const scrollAmount = viewportHeight - this.settings.overlapPixels;

		scroller.scrollTo({
			top: scroller.scrollTop + scrollAmount,
			behavior: 'auto',
		});
	}

	private turnPageUp() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const scroller = this.getScrollContainer(view);
		const viewportHeight = scroller.clientHeight;
		const scrollAmount = viewportHeight - this.settings.overlapPixels;

		scroller.scrollTo({
			top: Math.max(0, scroller.scrollTop - scrollAmount),
			behavior: 'auto',
		});
	}
}
