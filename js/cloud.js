/**
 * cloud.js v2 - 密码保护 + GitHub 云存储 + 本地优先存储（兼容 kityminder-editor）
 *
 * 功能：
 *  1. 页面密码保护：首次设置访问密码，之后每次打开页面需输入密码才能进入编辑器
 *  2. Token 简化：GitHub Token 用密码派生的密钥 AES-GCM 加密保存在浏览器，
 *     解锁后自动使用，无需每次输入长 Token
 *  3. 本地优先保存：无 Token/离线时脑图保存到浏览器 localStorage；
 *     配置 Token 后自动保存到 GitHub 私有仓库（本地 + 云端双写）
 *  4. 文件列表：列出本地 + 云端全部脑图，点击选择打开
 *
 * 安全说明：纯前端保护，防止未授权使用浏览器；密码不存储明文，
 *  Token 加密存储，解锁密钥由密码派生（PBKDF2）。
 */
(function(window, $) {
	'use strict';

	/* ---------------- 常量 ---------------- */

	var LOCK_KEY = 'km_lock_v1';           // { salt, verifier }
	var STORAGE_KEY = 'km_cloud_config_v1'; // { repo, dir, autoSave, tokenEnc:{iv,data} }
	var CURRENT_FILE_KEY = 'km_cloud_current_file';
	var LOCAL_PREFIX = 'km_local_';        // localStorage 前缀：km_local_<name> = {json, updatedAt}

	var DEFAULT_DIR = 'mindmaps';
	var SAVE_DEBOUNCE_MS = 1500;
	var VERIFY_TEXT = 'km-lock-verify';
	var PBKDF2_ITERATIONS = 150000;

	/* ---------------- 状态 ---------------- */

	var config = null;
	var minder = null;
	var editor = null;
	var currentFile = null;      // { name, sha, source: 'local'|'cloud' }
	var saveTimer = null;
	var saving = false;
	var dirty = false;
	var unlocked = false;
	var unlockKey = null;        // CryptoKey，由密码派生

	/* ---------------- 工具函数 ---------------- */

	function bufToB64(buf) {
		var bytes = new Uint8Array(buf);
		var bin = '';
		bytes.forEach(function(b) { bin += String.fromCharCode(b); });
		return window.btoa(bin);
	}

	function b64ToBuf(b64) {
		var bin = window.atob(b64);
		var bytes = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return bytes;
	}

	function utf8ToBase64(str) {
		var bytes = new TextEncoder().encode(str);
		var bin = '';
		bytes.forEach(function(b) { bin += String.fromCharCode(b); });
		return window.btoa(bin);
	}

	function base64ToUtf8(b64) {
		var bin = window.atob(b64);
		var bytes = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return new TextDecoder().decode(bytes);
	}

	function getCrypto() {
		return window.crypto || window.msCrypto;
	}

	function getSubtle() {
		var c = getCrypto();
		return c.subtle || c.webkitSubtle;
	}

	/* ---------------- 密码派生与加解密 (Web Crypto) ---------------- */

	function deriveKey(password, saltBuf) {
		var enc = new TextEncoder();
		return getSubtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
			.then(function(baseKey) {
				return getSubtle().deriveKey(
					{
						name: 'PBKDF2',
						salt: saltBuf,
						iterations: PBKDF2_ITERATIONS,
						hash: 'SHA-256'
					},
					baseKey,
					{ name: 'AES-GCM', length: 256 },
					false,
					['encrypt', 'decrypt']
				);
			});
	}

	function aesEncrypt(key, text) {
		var iv = getCrypto().getRandomValues(new Uint8Array(12));
		var enc = new TextEncoder();
		return getSubtle().encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(text))
			.then(function(cipher) {
				return { iv: bufToB64(iv), data: bufToB64(cipher) };
			});
	}

	function aesDecrypt(key, ivB64, dataB64) {
		var dec = new TextDecoder();
		return getSubtle().decrypt(
			{ name: 'AES-GCM', iv: b64ToBuf(ivB64) },
			key,
			b64ToBuf(dataB64)
		).then(function(plain) {
			return dec.decode(plain);
		});
	}

	/* ---------------- 密码锁 ---------------- */

	function hasLock() {
		try { return !!window.localStorage.getItem(LOCK_KEY); } catch (e) { return false; }
	}

	function setupPassword(password) {
		var salt = getCrypto().getRandomValues(new Uint8Array(16));
		return deriveKey(password, salt).then(function(key) {
			return aesEncrypt(key, VERIFY_TEXT).then(function(enc) {
				window.localStorage.setItem(LOCK_KEY, JSON.stringify({
					salt: bufToB64(salt),
					verifier: enc
				}));
				return key;
			});
		});
	}

	function tryUnlock(password) {
		var lock;
		try { lock = JSON.parse(window.localStorage.getItem(LOCK_KEY)); } catch (e) {}
		if (!lock || !lock.salt || !lock.verifier) return Promise.resolve(null);
		return deriveKey(password, b64ToBuf(lock.salt)).then(function(key) {
			return aesDecrypt(key, lock.verifier.iv, lock.verifier.data).then(function(text) {
				return text === VERIFY_TEXT ? key : null;
			}).catch(function() {
				return null; // 密码错误 -> 解密失败
			});
		});
	}

	function changePassword(oldPassword, newPassword) {
		return tryUnlock(oldPassword).then(function(key) {
			if (!key) return Promise.reject(new Error('旧密码不正确'));
			// 迁移 Token 加密：用新密码重新加密
			return getToken(key).then(function(oldToken) {
				return setupPassword(newPassword).then(function(newKey) {
					if (oldToken) {
						return setToken(newKey, oldToken);
					}
					return null;
				});
			});
		});
	}

	/* ---------------- 配置（Token 加密存储） ---------------- */

	function loadConfig() {
		try {
			config = JSON.parse(window.localStorage.getItem(STORAGE_KEY)) || {};
		} catch (e) {
			config = {};
		}
		if (config.dir === undefined) config.dir = DEFAULT_DIR;
		return config;
	}

	function saveConfig() {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
	}

	function getToken(key) {
		// 兼容旧版明文 token
		if (config.token) return Promise.resolve(config.token);
		if (config.tokenEnc && key) {
			return aesDecrypt(key, config.tokenEnc.iv, config.tokenEnc.data);
		}
		return Promise.resolve(null);
	}

	function setToken(key, token) {
		config.token = undefined; // 清除明文
		if (!token) {
			config.tokenEnc = undefined;
		} else {
			return aesEncrypt(key, token).then(function(enc) {
				config.tokenEnc = enc;
				saveConfig();
				return enc;
			});
		}
		saveConfig();
		return Promise.resolve(null);
	}

	function hasCloudConfig() {
		return !!(config && config.repo && (config.token || config.tokenEnc));
	}

	/* ---------------- 本地存储 ---------------- */

	function localSave(name, json) {
		try {
			window.localStorage.setItem(LOCAL_PREFIX + name, JSON.stringify({
				json: json,
				updatedAt: new Date().toISOString()
			}));
			return true;
		} catch (e) {
			return false;
		}
	}

	function localRead(name) {
		try {
			var raw = window.localStorage.getItem(LOCAL_PREFIX + name);
			return raw ? JSON.parse(raw) : null;
		} catch (e) {
			return null;
		}
	}

	function localDelete(name) {
		window.localStorage.removeItem(LOCAL_PREFIX + name);
	}

	function localList() {
		var list = [];
		for (var i = 0; i < window.localStorage.length; i++) {
			var key = window.localStorage.key(i);
			if (key && key.indexOf(LOCAL_PREFIX) === 0) {
				var name = key.substring(LOCAL_PREFIX.length);
				var rec = localRead(name);
				if (rec) {
					list.push({
						name: name,
						size: rec.json ? rec.json.length : 0,
						updatedAt: rec.updatedAt,
						source: 'local'
					});
				}
			}
		}
		list.sort(function(a, b) {
			return (b.updatedAt || '').localeCompare(a.updatedAt || '');
		});
		return list;
	}

	/* ---------------- GitHub API ---------------- */

	function ghHeaders() {
		return {
			'Authorization': 'token ' + (config._token || ''),
			'Accept': 'application/vnd.github.v3+json',
			'User-Agent': 'km-cloud-sync'
		};
	}

	function ghRequest(method, url, body) {
		var opts = {
			method: method,
			headers: ghHeaders()
		};
		if (body !== undefined) {
			opts.headers['Content-Type'] = 'application/json';
			opts.body = JSON.stringify(body);
		}
		return fetch(url, opts).then(function(res) {
			if (res.status === 401 || res.status === 403) {
				throw new Error('认证失败：Token 无效或权限不足（HTTP ' + res.status + '）');
			}
			if (res.status === 404) {
				throw new Error('未找到仓库/文件（HTTP 404）');
			}
			if (!res.ok) {
				return res.json().then(function(j) {
					throw new Error((j.message || '请求失败') + '（HTTP ' + res.status + '）');
				}).catch(function(e) {
					if (e instanceof Error && e.message.indexOf('HTTP') > -1) throw e;
					throw new Error('请求失败（HTTP ' + res.status + '）');
				});
			}
			if (res.status === 204) return null;
			return res.json();
		});
	}

	function apiBase() {
		return 'https://api.github.com';
	}

	function dirPath() {
		return (config.dir || DEFAULT_DIR).replace(/^\/+|\/+$/g, '');
	}

	function repoPath(path) {
		return apiBase() + '/repos/' + config.repo + '/contents/' + encodeURIComponent(path);
	}

	function cloudListFiles() {
		var dir = dirPath();
		return ghRequest('GET', apiBase() + '/repos/' + config.repo + '/contents/' + encodeURIComponent(dir))
			.then(function(items) {
				if (!Array.isArray(items)) return [];
				return items
					.filter(function(it) { return it.type === 'file' && /\.km$/i.test(it.name); })
					.map(function(it) {
						return {
							name: it.name.replace(/\.km$/i, ''),
							path: it.path,
							sha: it.sha,
							size: it.size,
							updatedAt: it.name ? undefined : undefined,
							source: 'cloud'
						};
					})
					.sort(function(a, b) { return a.name.localeCompare(b.name, 'zh'); });
			})
			.catch(function(err) {
				// GitHub 不保留空目录：404 视为空列表
				if (err && err.message && err.message.indexOf('HTTP 404') > -1) return [];
				throw err;
			});
	}

	function cloudReadFile(fileName) {
		var dir = dirPath();
		var path = dir ? dir + '/' + fileName + '.km' : fileName + '.km';
		return ghRequest('GET', repoPath(path)).then(function(data) {
			return {
				json: base64ToUtf8(data.content),
				sha: data.sha
			};
		});
	}

	function cloudWriteFile(fileName, json, sha) {
		var dir = dirPath();
		var path = dir ? dir + '/' + fileName + '.km' : fileName + '.km';
		var body = {
			message: 'save ' + fileName + '.km via km-cloud',
			content: utf8ToBase64(json)
		};
		if (sha) body.sha = sha;
		return ghRequest('PUT', repoPath(path), body).then(function(data) {
			return data && data.content ? data.content.sha : null;
		});
	}

	function cloudDeleteFile(fileName, sha) {
		var dir = dirPath();
		var path = dir ? dir + '/' + fileName + '.km' : fileName + '.km';
		return ghRequest('DELETE', repoPath(path), {
			message: 'delete ' + fileName + '.km via km-cloud',
			sha: sha
		});
	}

	/* ---------------- 合并文件列表 ---------------- */

	function buildFileList() {
		var local = localList();
		if (!hasCloudConfig()) {
			return Promise.resolve({ files: local, cloud: false });
		}
		return cloudListFiles().then(function(cloud) {
			// 合并：同名文件显示两条（本地 + 云端），各自带来源标记
			var files = local.concat(cloud);
			files.sort(function(a, b) {
				return a.name.localeCompare(b.name, 'zh') ||
					(a.source === b.source ? 0 : (a.source === 'cloud' ? -1 : 1));
			});
			return { files: files, cloud: true };
		}).catch(function() {
			// 云端失败时退回本地列表
			return { files: local, cloud: false, cloudError: true };
		});
	}

	/* ---------------- 编辑器对接 ---------------- */

	function getMinderJson() {
		if (!minder) return null;
		try {
			return JSON.stringify(minder.exportJson());
		} catch (e) {
			return null;
		}
	}

	function importJson(json) {
		if (!minder) return;
		try {
			minder.importJson(JSON.parse(json));
			minder.execCommand('camera');
		} catch (e) {
			throw new Error('文件内容不是有效的脑图数据');
		}
	}

	function createNewMindMap(title) {
		var data = {
			root: {
				data: { text: title || '中心主题' },
				children: []
			},
			template: 'default',
			theme: 'fresh-blue'
		};
		importJson(JSON.stringify(data));
	}

	/* ---------------- 保存逻辑（本地优先 + 云端） ---------------- */

	function doSave() {
		if (!currentFile) {
			toast('请先新建或打开一个脑图文件');
			return Promise.reject(new Error('no file'));
		}
		var json = getMinderJson();
		if (!json) return Promise.reject(new Error('export failed'));

		// 1. 总是先写本地
		localSave(currentFile.name, json);

		// 2. 配置了云端则同步
		if (hasCloudConfig()) {
			saving = true;
			setStatus('保存中…', 'syncing');
			return cloudWriteFile(currentFile.name, json, currentFile.sha)
				.then(function(sha) {
					if (sha) currentFile.sha = sha;
					currentFile.source = 'cloud';
					dirty = false;
					saving = false;
					var t = new Date();
					setStatus('已保存云端 ' + t.getHours() + ':' + ('0' + t.getMinutes()).slice(-2), 'online');
				})
				.catch(function(err) {
					saving = false;
					setStatus('云端保存失败（已存本地）', 'error');
					toast('云端保存失败（已保存到本地）：' + err.message);
					throw err;
				});
		}

		// 3. 无云端：仅本地
		dirty = false;
		var t2 = new Date();
		setStatus('已保存本地 ' + t2.getHours() + ':' + ('0' + t2.getMinutes()).slice(-2), 'online');
		toast('已保存到本地（未配置云端）');
		return Promise.resolve();
	}

	function scheduleSave() {
		if (!config.autoSave) return;
		if (!currentFile) return;
		dirty = true;
		clearTimeout(saveTimer);
		setStatus('有修改，待保存…', 'syncing');
		saveTimer = setTimeout(function() {
			if (!saving) doSave().catch(function() {});
		}, SAVE_DEBOUNCE_MS);
	}

	/* ---------------- 打开 / 新建 / 删除 ---------------- */

	function openFileEntry(entry) {
		setStatus('加载中…', 'syncing');
		var readPromise = entry.source === 'cloud'
			? cloudReadFile(entry.name).then(function(res) {
				// 云端读取后缓存到本地
				localSave(entry.name, res.json);
				return res;
			})
			: Promise.resolve().then(function() {
				var rec = localRead(entry.name);
				if (!rec) throw new Error('本地文件不存在');
				return { json: rec.json, sha: entry.sha };
			});

		return readPromise.then(function(res) {
			importJson(res.json);
			currentFile = { name: entry.name, sha: res.sha, source: entry.source };
			updateFileName();
			dirty = false;
			setStatus('已打开 ' + entry.name, 'online');
			toast('已打开「' + entry.name + '」');
			if (config.autoSave) scheduleSave();
		}).catch(function(err) {
			setStatus('打开失败', 'error');
			toast('打开失败：' + err.message);
		});
	}

	function promptNewFile() {
		$('#newFileName').val('');
		$('#newModalTitle').text('新建脑图');
		$('#newModal').modal('show');
		setTimeout(function() { $('#newFileName').focus(); }, 300);
	}

	function confirmNewFile() {
		var name = $('#newFileName').val().trim();
		if (!name) {
			toast('请输入文件名');
			return;
		}
		$('#newModal').modal('hide');
		if (dirty && currentFile) {
			doSave().catch(function() {});
		}
		createNewMindMap(name);
		currentFile = { name: name, sha: null, source: 'local' };
		updateFileName();
		dirty = false;
		localSave(name, getMinderJson());
		setStatus('未保存（新文件）', 'syncing');
		toast('已新建「' + name + '」并保存到本地');
	}

	function deleteFileEntry(entry) {
		if (!window.confirm('确定删除「' + entry.name + '」吗？删除后无法恢复！')) return;
		var ops = [];
		if (entry.source === 'cloud' || entry.sha) {
			ops.push(cloudDeleteFile(entry.name, entry.sha).catch(function(err) {
				toast('云端删除失败：' + err.message);
			}));
		}
		localDelete(entry.name);
		Promise.all(ops).then(function() {
			toast('已删除「' + entry.name + '」');
			refreshFileList();
		});
	}

	/* ---------------- UI ---------------- */

	function setStatus(text, state) {
		var el = $('#cloudStatus');
		el.text(text);
		el.removeClass('online syncing error');
		if (state) el.addClass(state);
	}

	function toast(msg, timeout) {
		var el = $('#toastMsg');
		el.text(msg).fadeIn(150);
		clearTimeout(toast._t);
		toast._t = setTimeout(function() { el.fadeOut(300); }, timeout || 2500);
	}

	function updateFileName() {
		$('#currentFileName').text(currentFile ? currentFile.name + '.km' : '');
	}

	function refreshFileList() {
		var $list = $('#fileList');
		$list.empty();
		$list.append('<li class="list-group-item help-text">加载中…</li>');
		buildFileList().then(function(result) {
			$list.empty();
			if (result.cloudError) {
				$list.append('<li class="list-group-item help-text" style="color:#EB5757;">云端连接失败，仅显示本地文件（检查网络/Token）</li>');
			}
			if (!result.files.length) {
				$list.append('<li class="list-group-item help-text">还没有脑图文件，点击"新建"创建第一个吧。</li>');
				return;
			}
			result.files.forEach(function(f) {
				var badge = f.source === 'cloud'
					? '<span class="label label-primary" style="margin-left:8px;">云端</span>'
					: '<span class="label label-default" style="margin-left:8px;">本地</span>';
				var time = f.updatedAt ? ' · ' + f.updatedAt.replace('T', ' ').substring(0, 16) : '';
				var $li = $('<li class="list-group-item file-list-item">')
					.append(
						$('<div>').append(
							$('<span class="glyphicon glyphicon-tree-deciduous" style="margin-right:8px;color:#4A90E2;">'),
							$('<strong>').text(f.name),
							$(badge),
							$('<span class="file-meta" style="margin-left:10px;">').text((f.size || 0) + ' B' + time)
						),
						$('<span class="del-btn pull-right" style="color:#EB5757;" title="删除">删除</span>')
					);
				$li.on('click', function(e) {
					if ($(e.target).hasClass('del-btn')) return;
					$('#openModal').modal('hide');
					openFileEntry(f);
				});
				$li.find('.del-btn').on('click', function(e) {
					e.stopPropagation();
					deleteFileEntry(f);
				});
				$list.append($li);
			});
		}).catch(function(err) {
			$list.empty();
			$list.append('<li class="list-group-item help-text">加载失败：' + err.message + '</li>');
		});
	}

	/* ---------------- 锁屏 UI ---------------- */

	function showLockScreen(firstTime) {
		$('#lockScreen').show();
		$('#editorArea').hide();
		if (firstTime) {
			$('#lockTitle').text('首次使用：设置访问密码');
			$('#lockSub').text('设置后每次打开本页面都需输入密码（密码不会上传，仅保存在本浏览器）');
			$('#lockPw2').show();
			$('#lockBtn').text('设置并进入');
			$('#lockHint').text('');
		} else {
			$('#lockTitle').text('输入访问密码');
			$('#lockSub').text('解锁后即可使用（Token 已加密保存，无需重复输入）');
			$('#lockPw2').hide();
			$('#lockBtn').text('解锁');
			$('#lockHint').text('');
		}
		$('#lockPw1').val('');
		$('#lockPw2').val('');
		setTimeout(function() { $('#lockPw1').focus(); }, 200);
	}

	function hideLockScreen() {
		$('#lockScreen').hide();
		$('#editorArea').show();
	}

	function handleLockSubmit() {
		var pw1 = $('#lockPw1').val();
		if (!hasLock()) {
			// 首次设置
			var pw2 = $('#lockPw2').val();
			if (pw1.length < 4) {
				$('#lockHint').text('密码至少 4 位').css('color', '#EB5757');
				return;
			}
			if (pw1 !== pw2) {
				$('#lockHint').text('两次输入的密码不一致').css('color', '#EB5757');
				return;
			}
			setupPassword(pw1).then(function(key) {
				unlockKey = key;
				unlocked = true;
				// 迁移旧明文 token（如果有）
				if (config.token) {
					return setToken(key, config.token);
				}
				return null;
			}).then(function() {
				hideLockScreen();
				onUnlocked();
			}).catch(function(err) {
				$('#lockHint').text('设置失败：' + err.message).css('color', '#EB5757');
			});
			return;
		}
		// 解锁
		tryUnlock(pw1).then(function(key) {
			if (!key) {
				$('#lockHint').text('密码错误，请重试').css('color', '#EB5757');
				return;
			}
			unlockKey = key;
			unlocked = true;
			// 解密 Token 到内存供请求使用
			return getToken(key).then(function(token) {
				config._token = token;
				// 迁移旧明文 token
				if (config.token) {
					return setToken(key, token);
				}
				return null;
			});
		}).then(function() {
			hideLockScreen();
			onUnlocked();
		}).catch(function(err) {
			$('#lockHint').text('解锁失败：' + err.message).css('color', '#EB5757');
		});
	}

	/* ---------------- 解锁后的初始化 ---------------- */

	function onUnlocked() {
		if (!config.token && !config.tokenEnc && !config.repo) {
			setStatus('未配置云端（点"设置"开始）', 'error');
		} else if (hasCloudConfig()) {
			setStatus('已配置云端', 'online');
		} else {
			setStatus('本地模式（未配置云端）', 'online');
		}

		// 恢复上次打开的文件（本地优先）
		var lastFile = null;
		try { lastFile = JSON.parse(window.localStorage.getItem(CURRENT_FILE_KEY)); } catch (e) {}
		if (lastFile && lastFile.name) {
			var rec = localRead(lastFile.name);
			currentFile = { name: lastFile.name, sha: lastFile.sha || null, source: rec ? 'local' : 'cloud' };
			updateFileName();
			if (rec) {
				try {
					importJson(rec.json);
					setStatus('已打开 ' + lastFile.name + '（本地）', 'online');
				} catch (e) {}
			}
		}
	}

	/* ---------------- 设置面板 ---------------- */

	function openSettingsModal() {
		$('#settingToken').val('');
		$('#settingToken').attr('placeholder', hasCloudConfig() ? '已加密保存（留空保持不变，输入新值可替换）' : 'ghp_xxx 或 github_pat_xxx');
		$('#settingRepo').val(config.repo || '');
		$('#settingDir').val(config.dir || DEFAULT_DIR);
		$('#settingAutoSave').val(config.autoSave === undefined ? '1' : (config.autoSave ? '1' : '0'));
		$('#settingsModal').modal('show');
	}

	function saveSettings() {
		var token = $('#settingToken').val().trim();
		var repo = $('#settingRepo').val().trim();
		var dir = $('#settingDir').val().trim() || DEFAULT_DIR;
		var autoSave = $('#settingAutoSave').val() === '1';

		var p;
		if (token) {
			// 新 Token：用解锁密钥加密保存
			p = setToken(unlockKey, token).then(function() {
				config._token = token;
			});
		} else {
			p = Promise.resolve();
		}
		p.then(function() {
			config.repo = repo;
			config.dir = dir;
			config.autoSave = autoSave;
			saveConfig();
			$('#settingsModal').modal('hide');
			if (hasCloudConfig()) {
				setStatus('已配置云端', 'online');
				toast('设置已保存（Token 已加密存储）');
			} else {
				setStatus('本地模式', 'online');
				toast('已保存为本地模式（未填 Token/仓库）');
			}
		});
	}

	/* ---------------- 修改密码 ---------------- */

	function promptChangePassword() {
		$('#oldPw').val('');
		$('#newPw').val('');
		$('#newPw2').val('');
		$('#pwHint').text('');
		$('#pwModal').modal('show');
	}

	function confirmChangePassword() {
		var oldPw = $('#oldPw').val();
		var newPw = $('#newPw').val();
		var newPw2 = $('#newPw2').val();
		if (newPw.length < 4) {
			$('#pwHint').text('新密码至少 4 位').css('color', '#EB5757');
			return;
		}
		if (newPw !== newPw2) {
			$('#pwHint').text('两次输入的新密码不一致').css('color', '#EB5757');
			return;
		}
		changePassword(oldPw, newPw).then(function() {
			$('#pwModal').modal('hide');
			// 更新内存密钥
			return setupPassword(newPw).then(function(key) { unlockKey = key; });
		}).then(function() {
			toast('密码已修改');
		}).catch(function(err) {
			$('#pwHint').text(err.message).css('color', '#EB5757');
		});
	}

	/* ---------------- UI 事件绑定 ---------------- */

	function initUi() {
		$('#btnSettings').on('click', openSettingsModal);
		$('#btnSaveSettings').on('click', saveSettings);
		$('#btnNew').on('click', promptNewFile);
		$('#btnConfirmNew').on('click', confirmNewFile);
		$('#btnOpen').on('click', function() {
			$('#openModal').modal('show');
			refreshFileList();
		});
		$('#btnSave').on('click', function() {
			if (!currentFile) {
				promptNewFile();
				return;
			}
			doSave().catch(function() {});
		});
		$('#btnChangePw').on('click', promptChangePassword);
		$('#btnConfirmPw').on('click', confirmChangePassword);
		$('#lockBtn').on('click', handleLockSubmit);
		$('#lockPw1').on('keydown', function(e) {
			if (e.keyCode === 13) {
				if (!hasLock() && $('#lockPw2').is(':visible')) {
					$('#lockPw2').focus();
				} else {
					handleLockSubmit();
				}
			}
		});
		$('#lockPw2').on('keydown', function(e) {
			if (e.keyCode === 13) handleLockSubmit();
		});
		// 定时记录当前文件，供下次打开恢复
		setInterval(function() {
			if (currentFile) {
				window.localStorage.setItem(CURRENT_FILE_KEY, JSON.stringify(currentFile));
			}
		}, 2000);
	}

	/* ---------------- 初始化入口 ---------------- */

	function init(editorInstance, minderInstance) {
		editor = editorInstance;
		minder = minderInstance;
		loadConfig();
		initUi();

		// 编辑器监听（在锁屏下也监听，但保存逻辑会检查解锁状态）
		minder.on('contentchange', function() {
			if (!unlocked) return;
			scheduleSave();
		});

		if (!hasLock()) {
			// 首次使用：设置密码
			showLockScreen(true);
		} else {
			showLockScreen(false);
		}
	}

	window.CloudSync = {
		init: init,
		getConfig: function() { return config; },
		isUnlocked: function() { return unlocked; }
	};
})(window, jQuery);
