import { App, PluginSettingTab, Setting } from 'obsidian';
import type EinkPageTurnerPlugin from './main';

export interface EinkPageTurnerSettings {
	enablePlugin: boolean;
	leftZonePercentage: number;
	rightZonePercentage: number;
	maxClickDistance: number;
	maxClickDuration: number;
	overlapPixels: number;
	enableInEditMode: boolean;
}

export const DEFAULT_SETTINGS: EinkPageTurnerSettings = {
	enablePlugin: false,
	leftZonePercentage: 0.25,
	rightZonePercentage: 0.25,
	maxClickDistance: 20,
	maxClickDuration: 300,
	overlapPixels: 50,
	enableInEditMode: false,
};

export class EinkPageTurnerSettingTab extends PluginSettingTab {
	plugin: EinkPageTurnerPlugin;

	constructor(app: App, plugin: EinkPageTurnerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: '墨水屏翻页设置' });

		new Setting(containerEl)
			.setName('启用插件')
			.setDesc('开启后，在 Markdown 阅读模式下点击屏幕左右侧可翻页')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enablePlugin)
				.onChange(async (value) => {
					this.plugin.settings.enablePlugin = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('左侧点击区域比例')
			.setDesc('点击此比例的屏幕左侧区域将向上翻页')
			.addSlider(slider => slider
				.setLimits(0.1, 0.4, 0.05)
				.setValue(this.plugin.settings.leftZonePercentage)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.leftZonePercentage = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('右侧点击区域比例')
			.setDesc('点击此比例的屏幕右侧区域将向下翻页')
			.addSlider(slider => slider
				.setLimits(0.1, 0.4, 0.05)
				.setValue(this.plugin.settings.rightZonePercentage)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.rightZonePercentage = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('翻页重叠像素')
			.setDesc('翻页时保留的上一页内容像素，避免内容断裂')
			.addSlider(slider => slider
				.setLimits(0, 100, 10)
				.setValue(this.plugin.settings.overlapPixels)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.overlapPixels = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('编辑模式也启用翻页')
			.setDesc('默认只在阅读模式生效，开启后编辑模式也可点击翻页')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableInEditMode)
				.onChange(async (value) => {
					this.plugin.settings.enableInEditMode = value;
					await this.plugin.saveSettings();
				}));
	}
}
