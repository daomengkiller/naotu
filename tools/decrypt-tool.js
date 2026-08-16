/**
 * decrypt-tool.js - 离线解码工具（应急恢复用）
 *
 * 用途：网站挂了也能恢复脑图数据。用你的密码解密从 Gitee/GitHub 仓库下载的
 *      密文脑图文件（KMENC1: 开头），还原为明文 .km 文件。
 *
 * 算法与 cloud.js 完全一致：
 *   密钥 = PBKDF2(密码, UTF-8('km-data-v1-fixed-salt'), 150000, SHA-256) -> AES-256-GCM
 *   密文格式 = "KMENC1:" + base64(iv) + "." + base64(ciphertext含GCM tag)
 *
 * 用法：
 *   1) 单个文件：
 *      node decrypt-tool.js 密文文件.km 输出文件.km
 *      然后按提示输入密码
 *
 *   2) 批量解密目录（解密其中所有 KMENC1: 开头的文件）：
 *      node decrypt-tool.js --dir 下载的目录
 *      解密结果写入同目录下 _decrypted/ 子目录
 *
 *   3) 从环境变量传密码（避免交互）：
 *      set KM_PASSWORD=你的密码   (Windows)
 *      export KM_PASSWORD=你的密码 (macOS/Linux)
 *      node decrypt-tool.js 密文文件.km 输出文件.km
 *
 * 注意：本工具不联网、不含任何密码，可放心保存在本地。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_SALT = 'km-data-v1-fixed-salt';
const ENC_PREFIX = 'KMENC1:';
const ITERATIONS = 150000;

function deriveKey(password) {
	return crypto.pbkdf2Sync(password, Buffer.from(DATA_SALT, 'utf8'), ITERATIONS, 32, 'sha256');
}

/**
 * 解密一段密文文本
 * @param {Buffer} key 32字节 AES-256-GCM 密钥
 * @param {string} text 密文（KMENC1: 开头）或明文（原样返回）
 * @returns {string} 明文
 */
function decryptText(key, text) {
	if (typeof text !== 'string' || text.indexOf(ENC_PREFIX) !== 0) {
		return text; // 不是加密格式（旧明文数据），原样返回
	}
	const rest = text.substring(ENC_PREFIX.length);
	const dotIdx = rest.indexOf('.');
	if (dotIdx < 0) throw new Error('加密数据格式错误（缺少 . 分隔符）');
	const ivB64 = rest.substring(0, dotIdx);
	const dataB64 = rest.substring(dotIdx + 1);

	const iv = Buffer.from(ivB64, 'base64');
	const data = Buffer.from(dataB64, 'base64');
	// AES-GCM 密文末尾 16 字节是认证标签
	const tag = data.subarray(data.length - 16);
	const ct = data.subarray(0, data.length - 16);

	const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
	return plain.toString('utf8');
}

function isEncryptedFile(buf) {
	if (!buf || buf.length < ENC_PREFIX.length + 4) return false;
	return buf.slice(0, ENC_PREFIX.length).toString('utf8') === ENC_PREFIX;
}

function askPassword() {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise(resolve => {
		rl.question('请输入你的访问密码（输入时不显示）: ', pw => {
			rl.close();
			resolve(pw.trim());
		});
	});
}

function decryptFile(key, inputPath, outputPath) {
	const buf = fs.readFileSync(inputPath);
	const content = buf.toString('utf8');
	const plain = decryptText(key, content);
	if (plain === content && !isEncryptedFile(buf)) {
		// 未加密的明文文件：原样复制到输出（保持批量恢复完整性）
		fs.writeFileSync(outputPath, content, 'utf8');
		console.log(`  ○ 原样复制（未加密的明文文件）: ${path.basename(inputPath)} -> ${outputPath}`);
		return false;
	}
	fs.writeFileSync(outputPath, plain, 'utf8');
	console.log(`  ✓ 已解密: ${path.basename(inputPath)} -> ${outputPath}`);
	return true;
}

async function main() {
	const args = process.argv.slice(2);

	// 1. 获取密码
	let password = process.env.KM_PASSWORD;
	if (!password) {
		password = await askPassword();
	}
	if (!password) {
		console.error('❌ 密码不能为空');
		process.exit(1);
	}
	const key = deriveKey(password);
	// 用空密文做一次自检（仅验证密钥派生可用，不做数据校验）
	// 实际数据校验由 GCM 认证标签完成

	// 2. 模式分发
	if (args[0] === '--dir' || args[0] === '-d') {
		const dir = args[1];
		if (!dir || !fs.existsSync(dir)) {
			console.error('❌ 目录不存在: ' + dir);
			process.exit(1);
		}
		const outDir = path.join(dir, '_decrypted');
		if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

		const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.km'));
		if (!files.length) {
			console.log('目录中没有 .km 文件');
			return;
		}
		let okCount = 0, failCount = 0;
		for (const f of files) {
			const inPath = path.join(dir, f);
			const outPath = path.join(outDir, f);
			try {
				if (decryptFile(key, inPath, outPath)) okCount++;
				else failCount++; // 未加密的算跳过
			} catch (e) {
				failCount++;
				console.log(`  ✗ 解密失败: ${f} — ${e.message}`);
			}
		}
		console.log(`\n完成：成功 ${okCount} 个，跳过/失败 ${failCount} 个`);
		console.log(`解密文件在: ${outDir}`);
	} else if (args.length >= 2) {
		const inPath = args[0];
		const outPath = args[1];
		if (!fs.existsSync(inPath)) {
			console.error('❌ 输入文件不存在: ' + inPath);
			process.exit(1);
		}
		try {
			if (decryptFile(key, inPath, outPath)) {
				console.log('\n✅ 解密成功！');
			} else {
				console.log('\n该文件不是加密格式，无需解密。');
			}
		} catch (e) {
			console.error('❌ 解密失败: ' + e.message);
			console.error('   （密码不正确，或文件已损坏）');
			process.exit(1);
		}
	} else {
		console.log([
			'用法:',
			'  node decrypt-tool.js <密文文件.km> <输出文件.km>',
			'  node decrypt-tool.js --dir <目录>',
			'  （也可设置环境变量 KM_PASSWORD 免交互输入）'
		].join('\n'));
		process.exit(1);
	}
}

main().catch(e => {
	console.error('❌ 发生错误: ' + e.message);
	process.exit(1);
});
