import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_PATH = fileURLToPath(new URL('../data/config.json', import.meta.url));

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`${CONFIG_PATH} 不是合法 JSON(${e.message})。`
      + '常见原因:整个文件只能有一个最外层 {…},新增段落要并进同一个对象里,不能贴在后面。');
  }
}

export function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
