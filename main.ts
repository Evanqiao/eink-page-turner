import { Plugin, MarkdownView } from 'obsidian';
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

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				// Event listeners are always active; isInReadingMode() gates behavior
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
			if (!this.isInReadingMode()) return;

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

	// ── Mode detection ──────────────────────────────────────────────

	private isInReadingMode(): boolean {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return false;

		const isPreview = activeView.getMode() === 'preview';
		const isFullscreen = document.body.classList.contains('is-fullscreen');

		return isPreview || (this.settings.enableInEditMode && isFullscreen);
	}

	// ── Page turn logic ─────────────────────────────────────────────

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
			e.preventDefault();
			e.stopPropagation();
		} else if (clickX > screenWidth - rightZoneWidth) {
			this.turnPageDown();
			e.preventDefault();
			e.stopPropagation();
		}
	}

	private turnPageDown() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const contentEl = view.contentEl;
		const viewportHeight = contentEl.clientHeight;
		const scrollAmount = viewportHeight - this.settings.overlapPixels;

		contentEl.scrollTo({
			top: contentEl.scrollTop + scrollAmount,
			behavior: 'auto',
		});
	}

	private turnPageUp() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const contentEl = view.contentEl;
		const viewportHeight = contentEl.clientHeight;
		const scrollAmount = viewportHeight - this.settings.overlapPixels;

		contentEl.scrollTo({
			top: Math.max(0, contentEl.scrollTop - scrollAmount),
			behavior: 'auto',
		});
	}
}
