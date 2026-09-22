'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { homedir } = require('node:os');
const defaultDirectory = path.join(homedir(), '.ubovm', 'skills');
const bundled = {
  'browser-bridge': '通过浏览器工具执行有状态的网页操作、检查与验证。',
  'ceye-dnslog': '通过 ceye.io 的 DNS / HTTP 回连记录辅助带外安全验证。'
};
const expand = directory => path.resolve(directory.replace(/^~(?=[\\/]|$)/, homedir()));
async function regularDirectory(directory) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('技能目录不能是文件或链接：' + directory);
}
async function installBundledSkills(source, destination = defaultDirectory) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await regularDirectory(path.dirname(destination));
  await fs.mkdir(destination, { recursive: true });
  await regularDirectory(destination);
  for (const name of Object.keys(bundled)) {
    const target = path.join(destination, name);
    try { await fs.lstat(target); continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Copy into a staging directory so an interrupted installation is never
    // discovered as a complete skill. Existing user packages are preserved.
    const stage = await fs.mkdtemp(path.join(destination, '.install-'));
    try {
      const packagePath = path.join(stage, name);
      await fs.cp(path.join(source, name), packagePath, { recursive: true, errorOnExist: true, force: false });
      await fs.rename(packagePath, target);
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
}
async function readSkillsCatalog(destination = defaultDirectory) {
  const items = [], errors = [];
  let remainingBytes = 4 * 1024 * 1024;
  const roots = [expand(destination)];
  for (const root of roots) {
    try {
      await regularDirectory(root);
      for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const file = path.join(root, entry.name, 'SKILL.md');
        try {
          const info = await fs.lstat(file);
          if (!info.isFile() || info.isSymbolicLink()) continue;
          const item = { name: entry.name, builtin: root === expand(destination) && Object.hasOwn(bundled, entry.name), description: bundled[entry.name] || '运行时按需加载的技能指令' };
          const limit = Math.min(256 * 1024, remainingBytes);
          if (info.size > limit) item.contentError = '技能内容超出预览大小限制。';
          else {
            const handle = await fs.open(file, 'r');
            try {
              const buffer = Buffer.alloc(limit + 1);
              let bytesRead = 0;
              while (bytesRead < buffer.length) {
                const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
                if (!chunk.bytesRead) break;
                bytesRead += chunk.bytesRead;
              }
              if (bytesRead > limit) item.contentError = '技能内容超出预览大小限制。';
              else { item.content = buffer.subarray(0, bytesRead).toString('utf8'); remainingBytes -= bytesRead; }
            } finally { await handle.close(); }
          }
          items.push(item);
        } catch (error) { if (error.code !== 'ENOENT') errors.push(entry.name + '：无法读取技能内容，请稍后重新载入。'); }
      }
    } catch (error) { errors.push(error.code === 'ENOENT' ? '技能尚未安装，请重启应用后重新载入。' : '无法读取技能列表，请稍后重新载入。'); }
  }
  return { directory: destination, items, errors };
}
module.exports = { defaultDirectory, installBundledSkills, readSkillsCatalog };
