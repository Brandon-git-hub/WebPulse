// UI language: English (the source text) and Traditional Chinese (Taiwan).
//
// tr('English text', { name: … }) returns the text in the current language,
// with {name} placeholders filled in. A missing translation falls back to the
// English text. The page's fixed text is marked in index.html: data-i18n
// (the element's text) and data-i18n-attr="title,aria-label,…".
//
// Decoder modules (names, options), the capture state pill (idle, done, …)
// and messages from the server stay in English.

const KEY = 'webpulse.lang';

/** [code, name in its own language] */
export const LANGUAGES = [['en', 'English'], ['zh-TW', '繁體中文']];

const ZH_TW = {
  // toolbar
  'File': '檔案',
  'Channels': '通道',
  'Decoders': '解碼器',
  'Help': '說明',
  'Open, save and export (Ctrl+O, Ctrl+S)': '開啟、儲存與匯出（Ctrl+O、Ctrl+S）',
  'Choose which channels are shown, triggered on and exported': '選擇要顯示、觸發與匯出的通道',
  'Show the list of protocol decoders (UART, SPI, I²C, …) to add one': '開啟協定解碼器清單（UART、SPI、I²C…）以加入解碼器',
  'Rate': '取樣率',
  'Samples': '取樣點數',
  'Pre-trigger': '預觸發',
  'Timeout': '逾時',
  'Number of samples, e.g. 500k, 2.5M, 30M': '取樣點數，例如 500k、2.5M、30M',
  'Sample count presets': '取樣點數預設值',
  'Trigger wait timeout in seconds, 0 = wait forever': '等待觸發的逾時秒數，0 = 一直等待',
  'Capture and view': '擷取與檢視',
  'Run': '執行',
  'Stop': '停止',
  'Start capture (R)': '開始擷取（R）',
  'Stop capture (S)': '停止擷取（S）',
  'Zoom in': '放大',
  'Zoom out': '縮小',
  'Zoom in (+, double-click)': '放大（+、按兩下）',
  'Zoom out (-, right double-click)': '縮小（-、右鍵按兩下）',
  'Fit': '全覽',
  'Show the whole capture (F)': '顯示完整擷取資料（F）',
  'Cursor to previous edge': '游標移至上一個邊緣',
  'Cursor to next edge': '游標移至下一個邊緣',
  'Cursor A to the previous edge of the highlighted channel ([; Shift: cursor B)':
    '游標 A 移至目前通道的上一個邊緣（[；按住 Shift：游標 B）',
  'Cursor A to the next edge of the highlighted channel (]; Shift: cursor B)':
    '游標 A 移至目前通道的下一個邊緣（]；按住 Shift：游標 B）',
  'Zoom to the span between cursors A and B (Z)': '放大至游標 A 與 B 之間（Z）',
  'Theme': '主題',
  'Theme: follow the system': '主題：跟隨系統',
  'Theme: light': '主題：淺色',
  'Theme: dark': '主題：深色',
  ' (click to change)': '（點選切換）',
  'Auto': '自動',
  'Light': '淺色',
  'Dark': '深色',

  // File menu
  'Open…': '開啟…',
  'A sigrok / PulseView session file (.sr). You can also drop one on the window.':
    'sigrok / PulseView 工作階段檔（.sr），也可以直接拖放至視窗',
  'Save session': '儲存工作階段',
  'Export': '匯出',
  'PNG image': 'PNG 圖片',
  'No capture yet': '尚未擷取',
  'Only the shown channels: {list}': '只包含顯示中的通道：{list}',
  'Could not create the image': '無法產生圖片',
  'Opening {name}…': '正在開啟 {name}…',
  'Cannot open {name}: {error}': '無法開啟 {name}：{error}',

  // Help menu
  'Keyboard shortcuts': '鍵盤快捷鍵',
  'Language': '語言',
  'About WebPulse': '關於 WebPulse',

  // status (the state pill itself — idle, done, … — stays in English)
  'reconnecting…': '重新連線中…',
  '{s} s · trigger {trig}': '{s} 秒 · 觸發 {trig}',
  'Capture failed': '擷取失敗',
  'Waiting for trigger…': '等待觸發…',
  'Capturing…': '擷取中…',
  'Simulator': '模擬器',
  'FX2 not connected': 'FX2 未連接',
  'Simulated signals (webpulse -b sim)': '模擬訊號（webpulse -b sim）',
  'Connected: {model}': '已連接：{model}',
  'No FX2 board found. It is looked for again when a capture starts.': '找不到 FX2 裝置，開始擷取時會再次尋找',
  'Cannot reach the WebPulse server: {error}': '無法連線至 WebPulse 伺服器：{error}',
  'invalid': '無效',
  ' (max {n})': '（上限 {n}）',
  'Invalid sample count (examples: 1M, 10M, 50000)': '取樣點數無效（例如：1M、10M、50000）',

  // channel list and picker
  'Channel': '通道',
  'Trig': '觸發',
  'Trigger condition': '觸發條件',
  "don't care": '不限',
  'low': '低電位',
  'high': '高電位',
  'rising edge': '上升緣',
  'falling edge': '下降緣',
  'either edge': '任一邊緣',
  'Enable': '啟用',
  'Disable': '停用',
  'All': '全部',
  'Changing': '有變化',
  'Non-changing': '無變化',
  'Named': '已命名',
  'Unnamed': '未命名',
  'Hidden channels are ignored by the trigger and left out of exports. All 8 are still captured. Drag a channel by its ⠿ grip to reorder.':
    '隱藏的通道不參與觸發，也不會匯出，但 8 個通道仍會全部擷取。拖曳通道的 ⠿ 可調整順序。',
  'Reset order': '重設順序',
  'Show the channels as CH0 … CH7 again': '恢復為 CH0 … CH7 的順序',
  ' · changing': ' · 有變化',
  ' · no change': ' · 無變化',
  'Needs a completed capture': '需要已完成的擷取資料',
  'At least one channel must stay enabled': '至少需保留一個啟用的通道',
  'No later edge on {ch}': '{ch} 之後沒有邊緣',
  'No earlier edge on {ch}': '{ch} 之前沒有邊緣',

  // waveform area and status bar
  'Set the trigger per channel, then press': '設定各通道的觸發條件，然後按下',
  'Mouse': '滑鼠',
  'view {span} · {zoom}': '檢視 {span} · {zoom}',
  'constant high': '持續高電位',
  'constant low': '持續低電位',
  'High': '高',
  'Low': '低',
  'Period': '週期',
  'Freq': '頻率',
  'Duty': '責任週期',

  // decoder list
  'Add a protocol decoder': '加入協定解碼器',
  'Add decoder': '加入解碼器',
  'Close': '關閉',
  'Close (Esc)': '關閉（Esc）',
  'Search decoders': '搜尋解碼器',
  'Built-in': '內建',
  'Your decoders': '自訂解碼器',
  'Double-click to add': '按兩下加入',
  'cannot load: {error}': '無法載入：{error}',
  'No decoder matches.': '沒有符合的解碼器',
  'Loading…': '載入中…',
  'Your own decoders: {dir}': '自訂解碼器：{dir}',
  'Select a decoder to see what it needs. Double-click or press Enter to add it.':
    '選取解碼器以查看所需的通道與選項，按兩下或按 Enter 即可加入',
  'This decoder cannot be loaded: {error}': '無法載入此解碼器：{error}',
  'Options': '選項',
  '* required': '* 為必要設定',
  'Add {name}': '加入 {name}',
  'Reload': '重新載入',
  'Load your decoders from the decoders folder again': '從 decoders 資料夾重新載入自訂解碼器',
  'Decoders reloaded ({n} available)': '已重新載入解碼器（共 {n} 個）',
  'Cannot list your decoders: {error}': '無法列出自訂解碼器：{error}',

  // decoder rows and settings
  'Decoder settings': '解碼器設定',
  '{name} (click for settings)': '{name}（點選開啟設定）',
  'Name': '名稱',
  'Colour': '顏色',
  'Other colour': '其他顏色',
  ' (hidden)': '（已隱藏）',
  '* Required channels': '* 為必要設定',
  'Remove decoder': '移除解碼器',
  'Decoding…': '解碼中…',
  'Decodes after the next capture.': '下次擷取後開始解碼',
  'This decoder is not available (any more).': '此解碼器已無法使用',
  'decoder {key} is not available': '無法使用解碼器 {key}',
  'assign {names}': '請指派 {names}',
  'decoding… {pct} %': '解碼中… {pct} %',
  'unavailable': '無法使用',

  // shortcut list
  'Capture': '擷取',
  'View': '檢視',
  'Cursors': '游標',
  'Zoom in / out ×2': '放大 / 縮小 2 倍',
  'Double-click': '按兩下',
  'Right double-click': '右鍵按兩下',
  'Zoom in / out ×2 at the pointer (Ctrl: ×8)': '以滑鼠位置為中心放大 / 縮小 2 倍（Ctrl：8 倍）',
  'Wheel': '滾輪',
  'Zoom at the pointer': '以滑鼠位置為中心縮放',
  'Drag': '拖曳',
  'Shift+Wheel': 'Shift+滾輪',
  'Pan': '平移',
  'Fit the whole capture': '顯示完整擷取資料',
  'Zoom to cursors A–B': '放大至游標 A–B',
  'Go to the trigger': '跳至觸發點',
  'Shift+Click': 'Shift+點選',
  'Shift+Right-click': 'Shift+右鍵',
  'Place cursor A / B (hold to drag)': '放置游標 A / B（按住可拖曳）',
  'Place cursor A / B at the pointer': '在滑鼠位置放置游標 A / B',
  'Hold while placing: do not snap to an edge': '放置時按住：不吸附至邊緣',
  'Cursor A to the previous / next edge': '游標 A 移至上一個 / 下一個邊緣',
  'Cursor B to the previous / next edge': '游標 B 移至上一個 / 下一個邊緣',
  'Clear the cursors': '清除游標',
  'Open a session file': '開啟工作階段檔',
  'Save the session': '儲存工作階段',
  'This list': '顯示此清單',

  // About
  'Version': '版本',
  'Build date': '建置日期',
  'OS': '作業系統',
  'Browser': '瀏覽器',
  'Device': '裝置',
  'Dependencies': '相依套件',
  'Developer': '開發者',
  'License': '授權',
};

const DICTS = { 'zh-TW': ZH_TW };

let lang = initialLang();

function initialLang() {
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGUAGES.some(([c]) => c === saved)) return saved;
  } catch { /* storage unavailable */ }
  return 'en';                        // until chosen in Help ▸ Language
}

export function getLang() {
  return lang;
}

export function setLang(code) {
  if (!LANGUAGES.some(([c]) => c === code)) return;
  lang = code;
  try {
    localStorage.setItem(KEY, code);
  } catch { /* storage unavailable */ }
}

/** The text in the current language, with {name} placeholders filled in. */
export function tr(text, vars) {
  const dict = DICTS[lang];
  let s = (dict && dict[text]) || text;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

// The English of each marked element and attribute, kept from the first pass.
const source = new WeakMap();

/** Translate the page's fixed text (data-i18n, data-i18n-attr). */
export function applyI18n(root) {
  if (root.documentElement) root.documentElement.lang = lang;
  if (!root.querySelectorAll) return;
  for (const el of root.querySelectorAll('[data-i18n], [data-i18n-attr]')) {
    let src = source.get(el);
    if (!src) {
      src = { attrs: {} };
      if (el.hasAttribute('data-i18n')) src.text = el.textContent.replace(/\s+/g, ' ').trim();
      for (const a of (el.dataset.i18nAttr || '').split(',').filter(Boolean)) src.attrs[a] = el.getAttribute(a);
      source.set(el, src);
    }
    if (src.text != null) el.textContent = tr(src.text);
    for (const [a, v] of Object.entries(src.attrs)) if (v != null) el.setAttribute(a, tr(v));
  }
}
