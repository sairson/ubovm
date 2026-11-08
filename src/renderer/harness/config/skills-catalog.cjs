'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { homedir } = require('node:os');
const defaultDirectory = path.join(homedir(), '.ubovm', 'skills');
const bundled = {
  'self-learning': '从任务执行证据提炼方法，跨会话检索并验证可复用能力。',
  'browser-bridge': '在 IDE 内嵌浏览器（可见共享标签）与独立 Obscura/Chromium（后台隐藏）之间适配：先读状态、模式和动作白名单，使用快照 ref 驱动 UI、网络、Cookie/存储；IDE 模式下登录/MFA 前可用 yield_control 交还控制，用户完成后下一次动作自动重新接管，不静默切换模式或劫持用户标签。',
  'ceye-dnslog': '通过 ceye.io 的 DNS / HTTP 回连记录辅助带外安全验证。',
  'code-audit': 'Authorized source-code security audit: map entrypoints and trust boundaries, trace source-to-sink flows, verify controls, and confirm a finding only after executing a runnable reproduction with its observed result. Static-only observations stay suspected/blocked and are recorded separately, never as confirmed vulnerabilities.',
  'pentest': '授权渗透测试手册：先记录授权范围与 RoE，用 domain_inventory 维护攻击面覆盖，按侦察/发现/验证/最小化利用/报告推进；确认发现必须有实际请求响应或命令输出并复现，扫描器结果只能算 candidate。含 flag/目标台账与渗透报告衔接。',
  'attack-surface': '探索与协助模式通用的关联域名发现与台账：子域名、同证书、DNS、跳转，用覆盖状态保证安全测试不漏测。',
  'pentest-report': 'Record confirmed pentest vulnerabilities as one Markdown file per finding: name, raw request/response packets, remediation, repro script, and a maintained index.',
  'swarm': 'Swarm 协作流程：分片与验收、写权限、优先级与抢占、等待与集成。内置，不可删除。',
  'team': 'Agent Teams 流程：成员、共享任务板、消息等待、审批边界与汇报。内置，不可删除。'
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
    try {
      const existing = await fs.lstat(target);
      if (!existing.isDirectory() || existing.isSymbolicLink()) continue;
      // The attack-surface playbook used to explicitly refuse assist mode. That
      // old bundled text would leave installed users on the exploration-only
      // instructions, so migrate exactly that known revision; user-edited
      // packages with other content stay untouched.
      if (name === 'attack-surface') {
        const previous = await fs.readFile(path.join(target, 'SKILL.md'), 'utf8').catch(() => '');
        if (!/Exploration mode only|Assist mode has no/.test(previous)) continue;
        await fs.rm(target, { recursive: true, force: true });
      } else continue;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Copy into a staging directory so an interrupted installation is never
    // discovered as a complete skill. Existing user packages are preserved.
    const stage = await fs.mkdtemp(path.join(destination, '.install-'));
    try {
      const packagePath = path.join(stage, name);
      await fs.cp(path.join(source, name), packagePath, { recursive: true, errorOnExist: true, force: false });
      try { await fs.rename(packagePath, target); }
      catch (error) {
        // Another extension host may have published the complete package
        // after our initial absence check. Preserve its directory and discard
        // only our own staging copy; genuine permission failures still fail.
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
        const winner = await fs.lstat(target).catch(() => null);
        if (!winner?.isDirectory() || winner.isSymbolicLink()) throw error;
      }
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
        if (entry.name.startsWith('.')) continue;
        if (entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'skill.md') {
          const file = path.join(root, entry.name);
          try {
            const info = await fs.lstat(file);
            if (!info.isFile() || info.isSymbolicLink()) continue;
            const item = { name: entry.name.slice(0, -3), builtin: false, description: '运行时按需加载的技能指令' };
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
          continue;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
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
module.exports = { defaultDirectory, installBundledSkills, readSkillsCatalog, bundledSkills: Object.freeze({ ...bundled }), protectedBundledSkills: Object.freeze(['swarm', 'team']) };
