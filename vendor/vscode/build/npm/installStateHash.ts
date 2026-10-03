/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import path from 'path';
import { dirs } from './dirs.ts';

export const root = fs.realpathSync.native(path.dirname(path.dirname(import.meta.dirname)));
export const stateFile = path.join(root, 'node_modules', '.postinstall-state');
export const stateContentsFile = path.join(root, 'node_modules', '.postinstall-state-contents');
export const forceInstallMessage = 'Run \x1b[36mnode build/npm/fast-install.ts --force\x1b[0m to force a full install.';

export function collectInputFiles(): string[] {
	const files: string[] = [];

	for (const dir of dirs) {
		const base = dir === '' ? root : path.join(root, dir);
		for (const file of ['package.json', 'package-lock.json', '.npmrc']) {
			const filePath = path.join(base, file);
			if (fs.existsSync(filePath)) {
				files.push(filePath);
			}
		}
	}

	files.push(path.join(root, '.nvmrc'));
	// Changes to installation logic must invalidate an older successful install.
	for (const file of ['postinstall.ts', 'preinstall.ts', 'dirs.ts', 'installStateHash.ts']) {
		files.push(path.join(root, 'build', 'npm', file));
	}

	return files;
}

export interface PostinstallState {
	readonly nodeVersion: string;
	readonly platform: string;
	readonly arch: string;
	readonly fileHashes: Record<string, string>;
}

const packageJsonRelevantKeys = new Set([
	'name',
	'dependencies',
	'devDependencies',
	'optionalDependencies',
	'peerDependencies',
	'peerDependenciesMeta',
	'overrides',
	'engines',
	'workspaces',
	'bundledDependencies',
	'bundleDependencies',
]);

const packageLockJsonIgnoredKeys = new Set(['version']);

function normalizeFileContent(filePath: string): string {
	const raw = fs.readFileSync(filePath, 'utf8');
	const basename = path.basename(filePath);
	if (basename === 'package.json') {
		const json = JSON.parse(raw);
		const filtered: Record<string, unknown> = {};
		for (const key of packageJsonRelevantKeys) {
			// eslint-disable-next-line local/code-no-in-operator
			if (key in json) {
				filtered[key] = json[key];
			}
		}
		return JSON.stringify(filtered, null, '\t') + '\n';
	}
	if (basename === 'package-lock.json') {
		const json = JSON.parse(raw);
		for (const key of packageLockJsonIgnoredKeys) {
			delete json[key];
		}
		if (json.packages?.['']) {
			for (const key of packageLockJsonIgnoredKeys) {
				delete json.packages[''][key];
			}
		}
		return JSON.stringify(json, null, '\t') + '\n';
	}
	return raw;
}

function hashContent(content: string): string {
	const hash = crypto.createHash('sha256');
	hash.update(content);
	return hash.digest('hex');
}

export function computeState(options?: { ignoreNodeVersion?: boolean }): PostinstallState {
	const fileHashes: Record<string, string> = {};
	for (const filePath of collectInputFiles()) {
		const key = path.relative(root, filePath);
		try {
			fileHashes[key] = hashContent(normalizeFileContent(filePath));
		} catch {
			// file may not be readable
		}
	}
	return { nodeVersion: options?.ignoreNodeVersion ? '' : process.versions.node, platform: process.platform, arch: process.arch, fileHashes };
}

export function computeContents(): Record<string, string> {
	const fileContents: Record<string, string> = {};
	for (const filePath of collectInputFiles()) {
		try {
			fileContents[path.relative(root, filePath)] = normalizeFileContent(filePath);
		} catch {
			// file may not be readable
		}
	}
	return fileContents;
}

export function readSavedState(): PostinstallState | undefined {
	try {
		const { nodeVersion, platform, arch, fileHashes } = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
		return { nodeVersion, platform, arch, fileHashes };
	} catch {
		return undefined;
	}
}

export function isUpToDate(): boolean {
	const saved = readSavedState();
	if (!saved) {
		return false;
	}
	if (saved.nodeVersion !== process.versions.node || saved.platform !== process.platform || saved.arch !== process.arch) {
		return false;
	}
	// A matching input hash does not prove that dependencies survived cleanup.
	for (const dir of dirs) {
		try {
			const manifest = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
			const hasDependencies = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
				.some(key => Object.keys(manifest[key] ?? {}).length > 0);
			if (!hasDependencies) {
				continue;
			}
			if (!fs.statSync(path.join(root, dir, 'node_modules')).isDirectory()) {
				return false;
			}
			// npm may hoist required packages into an ancestor node_modules directory.
			const required = { ...manifest.dependencies, ...manifest.devDependencies };
			for (const name of Object.keys(required)) {
				if (Object.hasOwn(manifest.optionalDependencies ?? {}, name)) {
					continue;
				}
				let base = path.join(root, dir);
				let found = false;
				while (true) {
					try {
						if (fs.statSync(path.join(base, 'node_modules', name, 'package.json')).isFile()) {
						found = true;
						break;
						}
					} catch { /* Try the next ancestor inside the source checkout. */ }
					if (base === root) {
						break;
					}
					base = path.dirname(base);
				}
				if (!found) {
					return false;
				}
			}
		} catch {
			return false;
		}
	}
	const current = computeState();
	return saved.nodeVersion === current.nodeVersion
		&& JSON.stringify(saved.fileHashes) === JSON.stringify(current.fileHashes);
}

export function readSavedContents(): Record<string, string> | undefined {
	try {
		return JSON.parse(fs.readFileSync(stateContentsFile, 'utf8'));
	} catch {
		return undefined;
	}
}

// When run directly, output state as JSON for tooling (e.g. the vscode-extras extension).
if (import.meta.filename === process.argv[1]) {
	const args = new Set(process.argv.slice(2));

	if (args.has('--normalize-file')) {
		const filePath = process.argv[process.argv.indexOf('--normalize-file') + 1];
		if (!filePath) {
			process.exit(1);
		}
		process.stdout.write(normalizeFileContent(filePath));
	} else {
		const ignoreNodeVersion = args.has('--ignore-node-version');
		const current = computeState({ ignoreNodeVersion });
		const saved = readSavedState();
		console.log(JSON.stringify({
			root,
			stateContentsFile,
			current,
			saved: saved && ignoreNodeVersion ? { ...saved, nodeVersion: '' } : saved,
			files: [...collectInputFiles(), stateFile],
		}));
	}
}
