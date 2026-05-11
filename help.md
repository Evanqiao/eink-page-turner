# Obsidian安卓墨水屏阅读翻页插件开发完整方案

这是一个专门为安卓墨水屏设备优化的Obsidian阅读翻页插件开发方案，核心功能是**阅读模式下点击屏幕左侧向上翻页、点击右侧向下翻页**，同时针对墨水屏特性进行了专门优化。

## 一、开发环境准备

### 1.1 基础环境搭建
```bash
# 1. 安装Node.js (推荐v18+)
# 2. 克隆官方插件模板
git clone https://github.com/obsidianmd/obsidian-sample-plugin.git eink-page-turner
cd eink-page-turner

# 3. 安装依赖
npm install

# 4. 修改package.json和manifest.json
# - name: "E-Ink Page Turner"
# - id: "eink-page-turner"
# - description: "专为安卓墨水屏设备优化的阅读翻页插件，点击屏幕左右侧翻页"
# - author: "你的名字"
# - isDesktopOnly: false (重要！必须支持移动端)
```


## 二、核心功能实现

### 2.1 插件主类结构 (main.ts)
```typescript
import { Plugin, WorkspaceLeaf, MarkdownView } from 'obsidian';
import { EinkPageTurnerSettingTab, DEFAULT_SETTINGS, EinkPageTurnerSettings } from './settings';

export default class EinkPageTurnerPlugin extends Plugin {
	settings: EinkPageTurnerSettings;
	private touchStartX: number = 0;
	private touchStartY: number = 0;
	private touchStartTime: number = 0;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new EinkPageTurnerSettingTab(this.app, this));

		// 注册触摸事件监听器
		this.registerTouchEvents();

		// 监听视图变化，确保只在阅读模式生效
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				this.updateEventListeners(leaf);
			})
		);
	}

	onunload() {
		// 所有通过registerDomEvent注册的事件会自动清理
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
```

### 2.2 触摸事件处理核心逻辑
```typescript
// 在main.ts中添加以下方法
private registerTouchEvents() {
	// 使用registerDomEvent确保插件卸载时自动移除监听器
	this.registerDomEvent(document, 'touchstart', (e: TouchEvent) => {
		if (!this.isInReadingMode()) return;
		
		// 记录触摸开始位置和时间
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

		// 计算触摸距离和时间，区分点击和滑动
		const deltaX = Math.abs(touchEndX - this.touchStartX);
		const deltaY = Math.abs(touchEndY - this.touchStartY);
		const deltaTime = touchEndTime - this.touchStartTime;

		// 只有短时间、小距离的触摸才视为点击
		if (deltaX < this.settings.maxClickDistance && 
			deltaY < this.settings.maxClickDistance && 
			deltaTime < this.settings.maxClickDuration) {
			
			this.handlePageTurn(touchEndX, e);
		}
	}, { passive: true });
}

private isInReadingMode(): boolean {
	const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
	if (!activeView) return false;
	return activeView.getMode() === 'preview';
}

private handlePageTurn(clickX: number, e: TouchEvent) {
	const screenWidth = window.innerWidth;
	const leftZoneWidth = screenWidth * this.settings.leftZonePercentage;
	const rightZoneWidth = screenWidth * this.settings.rightZonePercentage;

	// 点击左侧区域：向上翻页
	if (clickX < leftZoneWidth) {
		this.turnPageUp();
		e.preventDefault();
		e.stopPropagation();
	}
	// 点击右侧区域：向下翻页
	else if (clickX > screenWidth - rightZoneWidth) {
		this.turnPageDown();
		e.preventDefault();
		e.stopPropagation();
	}
	// 中间区域：不处理，保留默认行为（如点击链接、选中文本）
}
```

### 2.3 精确翻页实现（墨水屏优化版）
```typescript
private turnPageDown() {
	const view = this.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) return;

	const contentEl = view.contentEl;
	const viewportHeight = contentEl.clientHeight;
	
	// 墨水屏优化：精确翻页，减去一点重叠区域避免内容断裂
	const scrollAmount = viewportHeight - this.settings.overlapPixels;
	
	// 使用scrollTo而不是scrollBy，更精确
	contentEl.scrollTo({
		top: contentEl.scrollTop + scrollAmount,
		// 墨水屏关键优化：禁用平滑滚动，减少残影
		behavior: 'auto'
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
		behavior: 'auto'
	});
}
```

### 2.4 可配置设置项 (settings.ts)
```typescript
import { App, PluginSettingTab, Setting } from 'obsidian';
import EinkPageTurnerPlugin from './main';

export interface EinkPageTurnerSettings {
	leftZonePercentage: number;
	rightZonePercentage: number;
	maxClickDistance: number;
	maxClickDuration: number;
	overlapPixels: number;
	enableInEditMode: boolean;
}

export const DEFAULT_SETTINGS: EinkPageTurnerSettings = {
	leftZonePercentage: 0.25, // 左侧25%区域
	rightZonePercentage: 0.25, // 右侧25%区域
	maxClickDistance: 20, // 最大点击移动距离(像素)
	maxClickDuration: 300, // 最大点击持续时间(毫秒)
	overlapPixels: 50, // 翻页重叠像素，避免内容断裂
	enableInEditMode: false, // 默认只在阅读模式生效
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
```

## 三、安卓墨水屏设备专项优化

### 3.1 禁用所有动画效果
创建`styles.css`文件，添加以下内容：
```css
/* 墨水屏优化：禁用所有过渡动画 */
.markdown-preview-view {
	transition: none !important;
	animation: none !important;
}

.markdown-preview-view * {
	transition: none !important;
	animation: none !important;
}

/* 禁用滚动条 */
.markdown-preview-view::-webkit-scrollbar {
	display: none !important;
}

/* 提高对比度 */
.theme-light .markdown-preview-view {
	background-color: #ffffff !important;
	color: #000000 !important;
}

.theme-dark .markdown-preview-view {
	background-color: #000000 !important;
	color: #ffffff !important;
}
```

### 3.2 防止误触优化
```typescript
// 在handlePageTurn方法中添加以下检查
private handlePageTurn(clickX: number, e: TouchEvent) {
	// 检查点击的元素是否是可交互元素
	const target = e.target as HTMLElement;
	const interactiveElements = ['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'IMG'];
	
	if (interactiveElements.includes(target.tagName) || 
		target.closest('a') || 
		target.closest('button') ||
		target.classList.contains('clickable-icon')) {
		// 如果点击的是链接、按钮等可交互元素，不处理翻页
		return;
	}

	// 原有翻页逻辑...
}
```

### 3.3 全屏模式支持
```typescript
// 添加全屏模式检测
private isInReadingMode(): boolean {
	const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
	if (!activeView) return false;
	
	const isPreview = activeView.getMode() === 'preview';
	const isFullscreen = document.body.classList.contains('is-fullscreen');
	
	// 全屏模式下强制启用，非全屏模式根据设置
	return isPreview || (this.settings.enableInEditMode && isFullscreen);
}
```

## 四、完整的插件文件结构
```
eink-page-turner/
├── main.ts              # 主插件逻辑
├── settings.ts          # 设置界面
├── styles.css           # 墨水屏优化样式
├── manifest.json        # 插件清单
├── package.json         # 依赖配置
├── tsconfig.json        # TypeScript配置
└── versions.json        # 版本信息
```

## 五、关键注意事项

### 5.1 事件冲突处理
- 使用`e.stopPropagation()`和`e.preventDefault()`阻止事件冒泡
- 优先保留Obsidian原生功能（如点击链接、选中文本）
- 只在阅读模式下生效，避免影响编辑体验

### 5.2 性能优化
- 所有事件监听器使用`registerDomEvent`注册，确保卸载时自动清理
- 避免在触摸事件处理中执行复杂计算
- 使用`passive: true`选项提高触摸响应速度

### 5.3 兼容性测试
- 必须在安卓墨水屏设备上进行实际测试
- 测试不同屏幕尺寸和分辨率
- 测试与其他常用插件的兼容性（如Minimal主题、Style Settings）

## 六、测试与发布

### 6.1 本地测试
1. 运行`npm run build`编译插件
2. 将`main.js`、`manifest.json`、`styles.css`复制到手机插件目录
3. 在Obsidian中启用插件并测试功能

### 6.2 发布准备
1. 更新`manifest.json`中的版本号
2. 编写详细的README.md，说明功能和使用方法
3. 提交到GitHub仓库
4. 申请加入Obsidian社区插件库

## 七、扩展功能建议（可选）

1. **手势支持**：添加左右滑动翻页功能
2. **进度显示**：在屏幕底部显示当前阅读进度
3. **自动隐藏UI**：阅读时自动隐藏顶部和底部工具栏
4. **长按功能**：长按屏幕显示阅读控制菜单