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
			console.log('[E-Ink] touchend, inReading:', inReading,
				'touchStartX:', this.touchStartX);

			if (!inReading) return;

			const touch = e.changedTouches[0];
			const touchEndX = touch.clientX;
			const touchEndY = touch.clientY;
			const touchEndTime = Date.now();

			const deltaX = Math.abs(touchEndX - this.touchStartX);
			const deltaY = Math.abs(touchEndY - this.touchStartY);
			const deltaTime = touchEndTime - this.touchStartTime;

			console.log('[E-Ink] deltaX:', deltaX, 'deltaY:', deltaY,
				'deltaTime:', deltaTime,
				'limits:', this.settings.maxClickDistance, this.settings.maxClickDuration);

			if (
				deltaX < this.settings.maxClickDistance &&
				deltaY < this.settings.maxClickDistance &&
				deltaTime < this.settings.maxClickDuration
			) {
				this.handlePageTurn(touchEndX, e);
			} else {
				console.log('[E-Ink] NOT a click (swipe/move)');
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
		// In reading mode, Obsidian puts overflow on .markdown-reading-view,
		// not on contentEl. contentEl.scrollTo() is a no-op.
		const readingView = view.containerEl.querySelector(
			'.markdown-reading-view'
		) as HTMLElement | null;
		if (readingView) return readingView;
		// Fallback: try the containerEl itself (mobile may differ)
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
		if (!view) { console.log('[E-Ink] turnPageDown: no view'); return; }

		const scroller = this.getScrollContainer(view);
		const viewportHeight = scroller.clientHeight;
		const scrollAmount = viewportHeight - this.settings.overlapPixels;

		console.log('[E-Ink] turnPageDown scroller:', scroller.className,
			'scrollHeight:', scroller.scrollHeight,
			'scrollTop before:', scroller.scrollTop,
			'viewport:', viewportHeight);

		scroller.scrollTo({
			top: scroller.scrollTop + scrollAmount,
			behavior: 'auto',
		});

		console.log('[E-Ink] scrollTop after:', scroller.scrollTop, 'target:', scroller.scrollTop + scrollAmount);
	}

	private turnPageUp() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) { console.log('[E-Ink] turnPageUp: no view'); return; }

		const scroller = this.getScrollContainer(view);
		const viewportHeight = scroller.clientHeight;
		const scrollAmount = viewportHeight - this.settings.overlapPixels;

		console.log('[E-Ink] turnPageUp scroller:', scroller.className,
			'scrollHeight:', scroller.scrollHeight,
			'scrollTop before:', scroller.scrollTop,
			'viewport:', viewportHeight);

		scroller.scrollTo({
			top: Math.max(0, scroller.scrollTop - scrollAmount),
			behavior: 'auto',
		});

		console.log('[E-Ink] scrollTop after:', scroller.scrollTop);
	}
}
