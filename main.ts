import { Plugin, MarkdownView, Notice } from 'obsidian';
import {
	EinkPageTurnerSettingTab,
	DEFAULT_SETTINGS,
	type EinkPageTurnerSettings,
} from './settings';

export default class EinkPageTurnerPlugin extends Plugin {
	settings: EinkPageTurnerSettings;
	private touchStartX = 0;
	private touchStartY = 0;
	private touchStartTime = 0;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new EinkPageTurnerSettingTab(this.app, this));

		this.registerTouchEvents();

		new Notice('E-Ink Page Turner 已加载');

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) {
					console.log('[E-Ink] view type:', view.getViewType(), 'mode:', view.getMode());
				}
			})
		);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ── Touch event handling ────────────────────────────────────────

	private registerTouchEvents() {
		this.registerDomEvent(document, 'touchstart', (e: TouchEvent) => {
			if (!this.isInReadingMode()) return;

			const touch = e.changedTouches[0];
			this.touchStartX = touch.clientX;
			this.touchStartY = touch.clientY;
			this.touchStartTime = Date.now();
		}, { passive: true });

		this.registerDomEvent(document, 'touchend', (e: TouchEvent) => {
			const inReading = this.isInReadingMode();

			if (!inReading) {
				console.log('[E-Ink] touchend but NOT in reading mode');
				return;
			}

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
				new Notice(`[E-Ink] 点击检测 ✓ x:${Math.round(touchEndX)} y:${Math.round(touchEndY)}`);
				this.handlePageTurn(touchEndX, e);
			} else {
				new Notice(`[E-Ink] 滑动忽略 dX:${Math.round(deltaX)} dY:${Math.round(deltaY)} t:${deltaTime}ms`);
			}
		}, { passive: false });
	}

	// ── Mode detection ──────────────────────────────────────────────

	private isInReadingMode(): boolean {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return false;

		const isPreview = activeView.getMode() === 'preview';
		const isFullscreen = document.body.classList.contains('is-fullscreen');

		return isPreview || (this.settings.enableInEditMode && isFullscreen);
	}

	// ── Page turn logic ─────────────────────────────────────────────

	private getScrollContainer(view: MarkdownView): HTMLElement {
		// Try multiple selectors that could be the scrollable element.
		// Different themes (e.g. Minimal) may restructure the DOM.
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
		// Fallback: use containerEl
		return view.containerEl;
	}

	private showScrollDiagnostics(scroller: HTMLElement) {
		const style = window.getComputedStyle(scroller);
		new Notice(
			`scroller: .${scroller.className.split(' ')[0] || '(none)'}\n` +
			`overflow-y: ${style.overflowY}  scrollH: ${scroller.scrollHeight}  clientH: ${scroller.clientHeight}`,
			5000
		);
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
			console.log('[E-Ink] skip interactive element:', target.tagName);
			return;
		}

		const screenWidth = window.innerWidth;
		const leftZoneWidth = screenWidth * this.settings.leftZonePercentage;
		const rightZoneWidth = screenWidth * this.settings.rightZonePercentage;

		console.log('[E-Ink] clickX:', clickX,
			'screenWidth:', screenWidth,
			'leftZone:', leftZoneWidth,
			'rightZone:', rightZoneWidth);

		if (clickX < leftZoneWidth) {
			new Notice('向上翻页');
			this.turnPageUp();
			e.preventDefault();
			e.stopPropagation();
		} else if (clickX > screenWidth - rightZoneWidth) {
			new Notice('向下翻页');
			this.turnPageDown();
			e.preventDefault();
			e.stopPropagation();
		} else {
			console.log('[E-Ink] middle zone, no action');
		}
	}

	private turnPageDown() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const scroller = this.getScrollContainer(view);
		const viewportHeight = scroller.clientHeight;
		const scrollAmount = viewportHeight - this.settings.overlapPixels;

		this.showScrollDiagnostics(scroller);

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

		this.showScrollDiagnostics(scroller);

		scroller.scrollTo({
			top: Math.max(0, scroller.scrollTop - scrollAmount),
			behavior: 'auto',
		});
	}
}
