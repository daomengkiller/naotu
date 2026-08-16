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
	// 数据加密：固定盐保证相同密码在任何设备派生相同数据密钥（跨设备可解密）
	var DATA_SALT = 'km-data-v1-fixed-salt';
	var ENC_PREFIX = 'KMENC1:';

	/* ---------------- 内置 Gitee 应用（密文，免配置） ----------------
	 *
	 * 由 tools/gen-config.js 生成：用你指定的"唯一密码"加密 Client ID / Secret。
	 * 任何浏览器打开网站 → 输入这个唯一密码 → 自动解密出凭据 → 点「使用 Gitee 登录」即可。
	 * 凭据不以明文出现，只有知道密码的人才能解开。
	 *
	 * 若留空（未配置），则回退到「设置」里每浏览器手动填写 Client ID/Secret 的方式。
	 */
	var BUILTIN_GITEE_APP = {
		salt: 'tzMP/9OKJfTHm7nzv+iWEA==',
		clientIdEnc: 'DK8NFpUj9pfgvrd/.gRU/sIbNZHRWMK5EtBdN13+pGmMG27QYrXVWmoLA2+6jY6K6/Bh45R7vizdQRhjaaVLi7HYL5sTHXhT1LjYyct+O+0tH9JUdqEnsYrzpRF0=',
		clientSecretEnc: 'Hk23yXvs40xUzeRa.eD+3KtTlfhU6lJ1v4BIbZnbBWfWCNlfwoqXZZkh7Z0ggSUO1fAlqj6p/Y3NdlB2R6bPmRsZWFumAMdcIYqgkPUNPAOa3aJFo2dqzSaOG/GE=',
		verifierEnc: 'u1oc/lP5zCj4e/aY.oxLdi9Bp74tWPFYBjRKILUGvxAs6lux9VQb+YhV7OsGjfBY='
	};
	var MASTER_VERIFY_TEXT = 'km-master-verify-v1';

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
	var dataKey = null;          // CryptoKey，数据加密密钥（固定盐 + 密码派生，跨设备一致）
	var masterClientId = null;   // 全局密码解锁后解密出的内置 Client ID（仅内存）
	var masterClientSecret = null; // 全局密码解锁后解密出的内置 Client Secret（仅内存）
	var pendingOAuth = null;     // { code, state } 待处理的 Gitee OAuth 回调
	var oauthRefreshing = false; // 防止并发刷新 token

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

	/* ---------------- 数据加密（内容级保护） ---------------- */

	/**
	 * 数据密钥：固定盐 + 访问密码派生（跨设备一致）。
	 * 相同密码在任何设备派生相同密钥 -> 换设备设置相同密码即可解密云端数据。
	 * 云端存储密文（KMENC1: 前缀），本地存储明文（浏览器内兜底缓存）。
	 */
	function deriveDataKey(password) {
		return deriveKey(password, new TextEncoder().encode(DATA_SALT));
	}

	function dataEncryptEnabled() {
		return config.dataEncrypt !== false && !!dataKey;
	}

	function encryptData(plainText) {
		if (!dataEncryptEnabled()) return Promise.resolve(plainText);
		var iv = getCrypto().getRandomValues(new Uint8Array(12));
		var enc = new TextEncoder();
		return getSubtle().encrypt({ name: 'AES-GCM', iv: iv }, dataKey, enc.encode(plainText))
			.then(function(cipher) {
				return ENC_PREFIX + bufToB64(iv) + '.' + bufToB64(cipher);
			});
	}

	function decryptData(text) {
		if (!dataKey || !text || text.indexOf(ENC_PREFIX) !== 0) return Promise.resolve(text);
		var rest = text.substring(ENC_PREFIX.length);
		var dotIdx = rest.indexOf('.');
		if (dotIdx < 0) return Promise.reject(new Error('加密数据格式错误'));
		var ivB64 = rest.substring(0, dotIdx);
		var dataB64 = rest.substring(dotIdx + 1);
		return aesDecrypt(dataKey, ivB64, dataB64).catch(function() {
			throw new Error('数据解密失败：密码不正确或数据损坏');
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

	/* ---------------- 全局唯一密码（Master Password） ---------------- */

	function hasBuiltinApp() {
		return !!(BUILTIN_GITEE_APP && BUILTIN_GITEE_APP.salt && BUILTIN_GITEE_APP.clientIdEnc && BUILTIN_GITEE_APP.clientSecretEnc && BUILTIN_GITEE_APP.verifierEnc);
	}

	/**
	 * 用输入的全局密码派生密钥并校验：
	 *  - 校验通过：返回 { key, clientId, clientSecret }（解密内置密文）
	 *  - 校验失败：返回 null
	 */
	function tryMasterUnlock(password) {
		if (!hasBuiltinApp()) return Promise.resolve(null);
		return deriveKey(password, b64ToBuf(BUILTIN_GITEE_APP.salt)).then(function(key) {
			// 验证文本解密成功 = 密码正确
			return aesDecrypt(key, BUILTIN_GITEE_APP.verifierEnc.split('.')[0], BUILTIN_GITEE_APP.verifierEnc.split('.').slice(1).join('.')).then(function(text) {
				if (text !== MASTER_VERIFY_TEXT) return null;
				// 解密应用凭据
				return aesDecrypt(key, BUILTIN_GITEE_APP.clientIdEnc.split('.')[0], BUILTIN_GITEE_APP.clientIdEnc.split('.').slice(1).join('.')).then(function(clientId) {
					return aesDecrypt(key, BUILTIN_GITEE_APP.clientSecretEnc.split('.')[0], BUILTIN_GITEE_APP.clientSecretEnc.split('.').slice(1).join('.')).then(function(clientSecret) {
						return { key: key, clientId: clientId, clientSecret: clientSecret };
					});
				});
			}).catch(function() {
				return null; // 密码错误 -> 解密失败
			});
		});
	}

	/** 全局密码模式下，用同一密码派生数据加密密钥（固定盐，跨设备一致） */
	function deriveMasterDataKey(password) {
		return deriveKey(password, new TextEncoder().encode(DATA_SALT));
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
		if (!config || !config.repo) return false;
		if (currentBackend() === 'gitee') {
			// Gitee 后端：OAuth token 或手动令牌均可
			return !!(config.giteeTokens || config.token || config.tokenEnc);
		}
		return !!(config.token || config.tokenEnc);
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

	/* ---------------- Gitee OAuth 登录 ---------------- */

	/**
	 * 使用 Gitee OAuth 授权码模式（纯前端）：
	 * 1. 用户在 Gitee 创建第三方应用，获得 client_id / client_secret（设置里填一次，加密保存）
	 * 2. 点击「使用 Gitee 登录」→ 跳转 Gitee 授权页
	 * 3. 授权后回跳到本页 ?code=xxx&state=yyy
	 * 4. 前端用 code + client_secret 换取 access_token（含 refresh_token）
	 * 5. access_token 加密保存，过期后自动用 refresh_token 刷新，无需再手动输入
	 */

	function giteeOAuthApp() {
		// 优先：浏览器本地配置的自己的应用（可覆盖内置）
		if (config.giteeApp && config.giteeApp.clientId && config.giteeApp.clientSecretEnc) {
			return config.giteeApp;
		}
		// 其次：内置应用（密文，需全局密码解锁后才有明文；解锁后 masterClientId 在内存）
		if (masterClientId && masterClientSecret) {
			return { clientId: masterClientId, clientSecretEnc: null, builtin: true };
		}
		return null;
	}

	function getRedirectUri() {
		// 回调地址 = 当前页面地址（去掉 query/hash），如 https://xxx.github.io/naotu/
		return window.location.origin + window.location.pathname;
	}

	function startGiteeLogin() {
		var app = giteeOAuthApp();
		if (!app || !app.clientId) {
			toast('请先在设置中填写 Gitee 应用的 Client ID 和 Client Secret');
			return;
		}
		if (!unlockKey) {
			toast('请先解锁页面');
			return;
		}
		// 解密 client_secret（内置应用已在解锁时解密到内存）
		var secretPromise = app.builtin
			? Promise.resolve(masterClientSecret)
			: aesDecrypt(unlockKey, app.clientSecretEnc.iv, app.clientSecretEnc.data);
		secretPromise.then(function(secret) {
			var state = Math.random().toString(36).slice(2) + Date.now().toString(36);
			window.sessionStorage.setItem('km_gitee_oauth_state', state);
			var params = [
				'client_id=' + encodeURIComponent(app.clientId),
				'redirect_uri=' + encodeURIComponent(getRedirectUri()),
				'response_type=code',
				'scope=projects%20user_info',
				'state=' + encodeURIComponent(state)
			];
			window.location.href = 'https://gitee.com/oauth/authorize?' + params.join('&');
		}).catch(function() {
			toast('解密失败，请重新填写 Client Secret');
		});
	}

	function parseOAuthCallback() {
		// 从 URL query 解析 code/state（OAuth 回调）
		var qs = window.location.search.substring(1);
		if (!qs) return;
		var params = {};
		qs.split('&').forEach(function(pair) {
			var kv = pair.split('=');
			params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
		});
		if (params.code) {
			pendingOAuth = { code: params.code, state: params.state || '' };
		}
	}

	function processOAuthCallback() {
		if (!pendingOAuth) return Promise.resolve(false);
		var savedState = window.sessionStorage.getItem('km_gitee_oauth_state');
		window.sessionStorage.removeItem('km_gitee_oauth_state');
		if (savedState && pendingOAuth.state !== savedState) {
			toast('Gitee 登录失败：state 校验不通过（可能被篡改）');
			pendingOAuth = null;
			return Promise.resolve(false);
		}
		var app = giteeOAuthApp();
		if (!app || !app.clientId) {
			toast('请先在设置中填写 Gitee 应用信息后重试登录');
			pendingOAuth = null;
			return Promise.resolve(false);
		}
		var code = pendingOAuth.code;
		pendingOAuth = null;
		var secretPromise = app.builtin
			? Promise.resolve(masterClientSecret)
			: aesDecrypt(unlockKey, app.clientSecretEnc.iv, app.clientSecretEnc.data);
		return secretPromise.then(function(secret) {
			var body = 'grant_type=authorization_code' +
				'&code=' + encodeURIComponent(code) +
				'&client_id=' + encodeURIComponent(app.clientId) +
				'&client_secret=' + encodeURIComponent(secret) +
				'&redirect_uri=' + encodeURIComponent(getRedirectUri());
			return fetch('https://gitee.com/oauth/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: body
			}).then(function(res) {
				return res.json().then(function(j) {
					if (!res.ok || !j.access_token) {
						throw new Error(j.error_description || j.error || ('HTTP ' + res.status));
					}
					return j;
				});
			});
		}).then(function(tokens) {
			// 加密保存 access_token / refresh_token
			return aesEncrypt(unlockKey, tokens.access_token).then(function(encAT) {
				return aesEncrypt(unlockKey, tokens.refresh_token || '').then(function(encRT) {
					config.giteeTokens = {
						accessTokenEnc: encAT,
						refreshTokenEnc: encRT,
						expiresAt: Date.now() + (tokens.expires_in || 86400) * 1000
					};
					config.backend = 'gitee';
					config._token = tokens.access_token;
					saveConfig();
					// 自动获取 Gitee 用户名，若未配置仓库名则自动填充
					if (!config.repo) {
						return fetch('https://gitee.com/api/v5/user?access_token=' + encodeURIComponent(tokens.access_token))
							.then(function(res) { return res.json(); })
							.then(function(user) {
								if (user && user.login) {
									config.repo = user.login + '/naotu-data';
									saveConfig();
									return user.login;
								}
								return null;
							}).catch(function() { return null; });
					}
					return null;
				});
			}).then(function(login) {
				setStatus('Gitee 已登录', 'online');
				if (login) {
					toast('Gitee 登录成功！已自动配置仓库 ' + config.repo + '（如该仓库不存在请先在 Gitee 创建）');
				} else if (config.repo) {
					toast('Gitee 登录成功！当前仓库：' + config.repo);
				} else {
					toast('Gitee 登录成功！请在设置中填写仓库名');
				}
				// 清理 URL 中的 OAuth code 参数，避免刷新后重复处理
				try {
					if (window.history && window.history.replaceState) {
						window.history.replaceState(null, '', window.location.pathname + window.location.hash);
					}
				} catch (e) {}
				return true;
			});
		}).catch(function(err) {
			setStatus('Gitee 登录失败', 'error');
			toast('Gitee 登录失败：' + err.message);
			return false;
		});
	}

	function refreshGiteeToken() {
		if (oauthRefreshing) return Promise.resolve(config._token || null);
		var tokens = config.giteeTokens;
		if (!tokens || !tokens.refreshTokenEnc || !tokens.refreshTokenEnc.data) return Promise.resolve(null);
		oauthRefreshing = true;
		return aesDecrypt(unlockKey, tokens.refreshTokenEnc.iv, tokens.refreshTokenEnc.data).then(function(refreshToken) {
			if (!refreshToken) return null;
			// 带上 client_id/client_secret 提高刷新成功率（Gitee 部分场景要求客户端认证）
			var app = giteeOAuthApp();
			var params = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refreshToken);
			if (app && app.clientId) {
				params += '&client_id=' + encodeURIComponent(app.clientId);
				if (app.builtin) {
					params += '&client_secret=' + encodeURIComponent(masterClientSecret);
				} else if (app.clientSecretEnc) {
					return aesDecrypt(unlockKey, app.clientSecretEnc.iv, app.clientSecretEnc.data).then(function(sec) {
						return doRefresh(params + '&client_secret=' + encodeURIComponent(sec));
					});
				}
			}
			return doRefresh(params);
		}).catch(function() {
			// refresh 失败：token 可能彻底失效，下次用 OAuth 重新登录
			return null;
		}).then(function(result) {
			oauthRefreshing = false;
			return result;
		});

		function doRefresh(params) {
			return fetch('https://gitee.com/oauth/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: params
			}).then(function(res) {
				return res.json().then(function(j) {
					if (!res.ok || !j.access_token) {
						throw new Error(j.error_description || j.error || ('HTTP ' + res.status));
					}
					return j;
				});
			}).then(function(tokens2) {
				return aesEncrypt(unlockKey, tokens2.access_token).then(function(encAT) {
					return aesEncrypt(unlockKey, tokens2.refresh_token || refreshToken).then(function(encRT) {
						config.giteeTokens = {
							accessTokenEnc: encAT,
							refreshTokenEnc: encRT,
							expiresAt: Date.now() + (tokens2.expires_in || 86400) * 1000
						};
						saveConfig();
						config._token = tokens2.access_token;
						return config._token;
					});
				});
			});
		}
	}

	function ensureGiteeToken() {
		// 保证 config._token 是有效的 Gitee access_token（必要时刷新）
		if (currentBackend() !== 'gitee') return Promise.resolve(config._token || null);
		if (!config.giteeTokens) {
			// 没有 OAuth token：手动令牌模式直接用 config.token/tokenEnc
			return getToken(unlockKey).then(function(t) {
				if (t) config._token = t;
				return config._token || null;
			}).catch(function() { return null; });
		}
		// OAuth 模式：检查过期时间
		if (config.giteeTokens.expiresAt && Date.now() < config.giteeTokens.expiresAt - 60000) {
			// 未过期：解密 access token（不信任 config._token，防止串用）
			return aesDecrypt(unlockKey, config.giteeTokens.accessTokenEnc.iv, config.giteeTokens.accessTokenEnc.data)
				.then(function(t) {
					config._token = t;
					return t;
				}).catch(function() { return null; });
		}
		// 过期或接近过期：刷新
		return refreshGiteeToken();
	}

	/* ---------------- 云端 API（GitHub / Gitee 双后端） ---------------- */

	function currentBackend() {
		return config.backend === 'gitee' ? 'gitee' : 'github';
	}

	function backendName() {
		return currentBackend() === 'gitee' ? 'Gitee' : 'GitHub';
	}

	function ghHeaders() {
		var h = {
			'Accept': 'application/json',
			'User-Agent': 'km-cloud-sync'
		};
		if (currentBackend() === 'github') {
			h['Authorization'] = 'token ' + (config._token || '');
			h['Accept'] = 'application/vnd.github.v3+json';
		}
		return h;
	}

	function ghRequest(method, url, body) {
		// Gitee：先确保 access_token 有效（必要时自动刷新）
		var prepare = currentBackend() === 'gitee'
			? ensureGiteeToken()
			: Promise.resolve(config._token || null);

		return prepare.then(function() {
			var opts = {
				method: method,
				headers: ghHeaders()
			};
			// Gitee 的 access_token 放在 URL query 中
			if (currentBackend() === 'gitee' && config._token) {
				url += (url.indexOf('?') > -1 ? '&' : '?') + 'access_token=' + encodeURIComponent(config._token);
			}
			if (body !== undefined) {
				opts.headers['Content-Type'] = 'application/json';
				opts.body = JSON.stringify(body);
			}
			return fetch(url, opts).then(function(res) {
				if (res.status === 401 || res.status === 403) {
					throw new Error('认证失败：' + backendName() + ' Token 无效或权限不足（HTTP ' + res.status + '）');
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
		});
	}

	function apiBase() {
		return currentBackend() === 'gitee'
			? 'https://gitee.com/api/v5'
			: 'https://api.github.com';
	}

	function dirPath() {
		return (config.dir || DEFAULT_DIR).replace(/^\/+|\/+$/g, '');
	}

	function repoPath(path) {
		return apiBase() + '/repos/' + config.repo + '/contents/' + encodeURIComponent(path);
	}

	function cleanBase64(b64) {
		// Gitee 返回的 content 可能带换行/空格
		return String(b64).replace(/\s+/g, '');
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
				// 云端不保留空目录：404 视为空列表
				if (err && err.message && err.message.indexOf('HTTP 404') > -1) return [];
				throw err;
			});
	}

	function cloudReadFile(fileName) {
		var dir = dirPath();
		var path = dir ? dir + '/' + fileName + '.km' : fileName + '.km';
		return ghRequest('GET', repoPath(path)).then(function(data) {
			var sha = data.sha;
			var content = data.content;
			// Gitee 大文件可能走 download_url，content 为空时降级
			if (!content && data.download_url && currentBackend() === 'gitee') {
				return fetch(data.download_url).then(function(r) { return r.text(); }).then(function(text) {
					return { text: text, sha: sha };
				});
			}
			return {
				text: base64ToUtf8(cleanBase64(content)),
				sha: sha
			};
		}).then(function(res) {
			// 解密（兼容旧明文数据：无前缀则原样返回）
			return decryptData(res.text).then(function(json) {
				return { json: json, sha: res.sha };
			});
		});
	}

	function cloudWriteFile(fileName, json, sha) {
		var dir = dirPath();
		var path = dir ? dir + '/' + fileName + '.km' : fileName + '.km';
		// 内容加密后再上传（密文存云端）
		return encryptData(json).then(function(encJson) {
			var body = {
				message: 'save ' + fileName + '.km via km-cloud',
				content: utf8ToBase64(encJson)
			};
			if (sha) body.sha = sha;
			// Gitee 创建文件用 POST，更新用 PUT；GitHub 都用 PUT
			var method = currentBackend() === 'gitee' ? (sha ? 'PUT' : 'POST') : 'PUT';
			return ghRequest(method, repoPath(path), body).then(function(data) {
				if (!data) return null;
				// GitHub: data.content.sha；Gitee: data.content.sha 或 data.sha
				return (data.content && data.content.sha) || data.sha || null;
			});
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
		if (hasBuiltinApp()) {
			// 内置密文凭据：全局唯一密码模式（任何浏览器同一密码）
			$('#lockTitle').text('输入访问密码');
			$('#lockSub').text('输入你的唯一密码解锁（密码同时解密内置的 Gitee 应用凭据，任何设备通用）');
			$('#lockPw2').hide();
			$('#lockBtn').text('解锁');
			$('#lockHint').text('');
		} else if (firstTime) {
			$('#lockTitle').text('首次使用：设置访问密码');
			$('#lockSub').text('此密码同时用于加密云端脑图数据，请牢记！多设备请设置同一密码');
			$('#lockPw2').show();
			$('#lockBtn').text('设置并进入');
			$('#lockHint').text('');
		} else {
			$('#lockTitle').text('输入访问密码');
			$('#lockSub').text('解锁后即可使用（密码即数据加密钥匙，多设备请保持一致）');
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
		if (hasBuiltinApp()) {
			// 全局密码模式：直接走解锁逻辑
			doUnlockWithPassword(pw1);
			return;
		}
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
				// 派生数据加密密钥（固定盐，跨设备一致）
				return deriveDataKey(pw1).then(function(dk) {
					dataKey = dk;
					return null;
				}).then(function() {
					// 迁移旧明文 token（如果有）
					if (config.token) {
						return setToken(key, config.token);
					}
					return null;
				});
			}).then(function() {
				hideLockScreen();
				return onUnlocked();
			}).then(function() {
				if (pendingOAuth) {
					return processOAuthCallback();
				}
				return null;
			}).catch(function(err) {
				$('#lockHint').text('设置失败：' + err.message).css('color', '#EB5757');
			});
			return;
		}
		// 无内置应用：设备本地密码锁解锁
		doUnlockWithPassword(pw1);
	}

	function doUnlockWithPassword(pw1) {
		// 解锁（分两种模式）
		var unlockPromise;
		if (hasBuiltinApp()) {
			// 模式A：内置密文凭据 —— 用全局唯一密码解锁，并解密出应用凭据
			unlockPromise = tryMasterUnlock(pw1).then(function(master) {
				if (!master) {
					$('#lockHint').text('密码错误，请重试').css('color', '#EB5757');
					return Promise.reject(new Error('__wrong_password__'));
				}
				unlockKey = master.key;
				unlocked = true;
				masterClientId = master.clientId;
				masterClientSecret = master.clientSecret;
				// 数据密钥：同一密码派生（固定盐，跨设备一致）
				return deriveMasterDataKey(pw1).then(function(dk) {
					dataKey = dk;
					// 尝试解密本地保存的 Token（若有）；后端为 Gitee 时不提前设置，
					// 由 ensureGiteeToken 统一处理，避免与 OAuth token 串用
					if (currentBackend() === 'gitee') return null;
					return getToken(master.key).then(function(token) {
						config._token = token;
						return null;
					});
				});
			});
		} else {
			// 模式B：无内置 —— 设备本地密码锁
			unlockPromise = tryUnlock(pw1).then(function(key) {
				if (!key) {
					$('#lockHint').text('密码错误，请重试').css('color', '#EB5757');
					return Promise.reject(new Error('__wrong_password__'));
				}
				unlockKey = key;
				unlocked = true;
				// 派生数据加密密钥（固定盐，跨设备一致）
				return deriveDataKey(pw1).then(function(dk) {
					dataKey = dk;
					// 解密 Token 到内存供请求使用
					return getToken(key).then(function(token) {
						config._token = token;
						// 迁移旧明文 token
						if (config.token) {
							return setToken(key, token);
						}
						return null;
					});
				});
			});
		}
		unlockPromise.then(function() {
			hideLockScreen();
			return onUnlocked();
		}).then(function() {
			// OAuth 回调处理（可能从 Gitee 授权页跳回）
			if (pendingOAuth) {
				return processOAuthCallback();
			}
			return null;
		}).catch(function(err) {
			if (err && err.message === '__wrong_password__') return; // 已提示密码错误
			$('#lockHint').text('解锁失败：' + err.message).css('color', '#EB5757');
		});
	}

	/* ---------------- 解锁后的初始化 ---------------- */

	function onUnlocked() {
		var p = Promise.resolve();
		if (currentBackend() === 'gitee') {
			// Gitee 后端：统一恢复/刷新 token（OAuth 或手动令牌）
			p = ensureGiteeToken().then(function(t) {
				if (t) {
					setStatus(config.giteeTokens ? 'Gitee 已登录' : '已配置云端（Gitee）', 'online');
				} else {
					setStatus('Gitee 登录失效（设置中重新登录）', 'error');
				}
				return null;
			});
		} else if (!config.token && !config.tokenEnc && !config.repo) {
			setStatus('未配置云端（点"设置"开始）', 'error');
		} else if (hasCloudConfig()) {
			setStatus('已配置云端（' + backendName() + '）', 'online');
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
					if (currentBackend() !== 'gitee') {
						setStatus('已打开 ' + lastFile.name + '（本地）', 'online');
					}
				} catch (e) {}
			}
		}
		return p;
	}

	/* ---------------- 设置面板 ---------------- */

	function openSettingsModal() {
		$('#settingToken').val('');
		var ph = hasCloudConfig()
			? '已加密保存（留空保持不变，输入新值可替换）'
			: (currentBackend() === 'gitee' ? 'Gitee 私人令牌，如 xxxxxxxxxxxx' : 'ghp_xxx 或 github_pat_xxx');
		$('#settingToken').attr('placeholder', ph);
		$('#settingBackend').val(config.backend === 'gitee' ? 'gitee' : 'github');
		$('#settingRepo').val(config.repo || '');
		$('#settingDir').val(config.dir || DEFAULT_DIR);
		$('#settingAutoSave').val(config.autoSave === undefined ? '1' : (config.autoSave ? '1' : '0'));
		$('#settingEncrypt').val(config.dataEncrypt === false ? '0' : '1');
		// Gitee OAuth 应用配置回填
		var app = giteeOAuthApp();
		var hasBuiltin = hasBuiltinApp();
		$('#oauthClientId').val((!app || app.builtin) ? '' : app.clientId);
		$('#oauthClientSecret').val('');
		if (config.giteeTokens) {
			$('#oauthStatus').text('已通过 OAuth 登录（Token 自动刷新）');
		} else if (hasBuiltin) {
			$('#oauthStatus').text('网站已内置加密的应用凭据（解锁时自动解密），直接点「使用 Gitee 登录」即可');
		} else if (app) {
			$('#oauthStatus').text('应用已配置，点击下方按钮登录');
		} else {
			$('#oauthStatus').text('未配置');
		}
		updateBackendHint();
		updateOAuthSection();
		$('#settingsModal').modal('show');
	}

	function updateBackendHint() {
		var be = $('#settingBackend').val();
		if (be === 'gitee') {
			$('#backendHint').text('Gitee（码云）：国内访问快。推荐用「Gitee 一键登录」（下方），也可用私人令牌：头像 → 设置 → 私人令牌（勾选 projects 权限），仓库填 用户名/仓库名');
		} else if (be === 'local') {
			$('#backendHint').text('本地模式：不连云端，脑图仅保存在本浏览器，适合离线/临时使用');
		} else {
			$('#backendHint').text('GitHub：在 GitHub → Settings → Developer settings → Personal access tokens 生成，勾选 repo 权限；仓库填 用户名/仓库名');
		}
		updateOAuthSection();
	}

	function updateOAuthSection() {
		// 只有 Gitee 后端显示 OAuth 区
		var show = $('#settingBackend').val() === 'gitee';
		$('#oauthSection').toggle(show);
	}

	function saveOAuthApp() {
		var clientId = $('#oauthClientId').val().trim();
		var clientSecret = $('#oauthClientSecret').val().trim();
		if (!clientId || !clientSecret) {
			toast('请填写完整的 Client ID 和 Client Secret');
			return;
		}
		aesEncrypt(unlockKey, clientSecret).then(function(enc) {
			config.giteeApp = { clientId: clientId, clientSecretEnc: enc };
			config.backend = 'gitee';
			saveConfig();
			$('#oauthStatus').text('应用已配置，点击下方按钮登录');
			toast('Gitee 应用信息已保存（加密存储）');
		});
	}

	function saveSettings() {
		var token = $('#settingToken').val().trim();
		var repo = $('#settingRepo').val().trim();
		var dir = $('#settingDir').val().trim() || DEFAULT_DIR;
		var autoSave = $('#settingAutoSave').val() === '1';
		var backend = $('#settingBackend').val();
		var dataEncrypt = $('#settingEncrypt').val() !== '0';

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
			config.backend = backend;
			config.dataEncrypt = dataEncrypt;
			saveConfig();
			$('#settingsModal').modal('hide');
			if (backend === 'local' || !hasCloudConfig()) {
				setStatus('本地模式', 'online');
				toast('已保存为本地模式（未配置云端）');
			} else {
				setStatus('已配置云端（' + backendName() + '）', 'online');
				toast(dataEncrypt ? '设置已保存（云端数据将加密存储）' : '设置已保存（数据加密已关闭）');
			}
		});
	}

	/* ---------------- 修改密码 ---------------- */

	function promptChangePassword() {
		if (hasBuiltinApp()) {
			toast('当前使用全局唯一密码（内置密文），修改密码需重新生成密文：运行 tools/gen-config.js 后替换代码');
			return;
		}
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
			// 更新内存密钥 + 重新派生数据加密密钥
			return setupPassword(newPw).then(function(key) {
				unlockKey = key;
				return deriveDataKey(newPw);
			}).then(function(dk) {
				dataKey = dk;
				// 当前打开的文件用新密钥立即重新加密保存（内存中是明文，直接重存）
				if (currentFile && hasCloudConfig()) {
					return doSave().catch(function() {});
				}
				return null;
			}).then(function() {
				if (config.dataEncrypt !== false) {
					toast('密码已修改！注意：云端其他已加密的脑图需要用旧密码重新保存后，才能用新密码打开（本地副本不受影响）', 6000);
				} else {
					toast('密码已修改');
				}
			});
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
		$('#settingBackend').on('change', updateBackendHint);
		$('#btnSaveOAuth').on('click', saveOAuthApp);
		$('#btnGiteeLogin').on('click', startGiteeLogin);
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
		// 解析可能的 Gitee OAuth 回调（?code=xxx&state=yyy）
		parseOAuthCallback();

		// 编辑器监听（在锁屏下也监听，但保存逻辑会检查解锁状态）
		minder.on('contentchange', function() {
			if (!unlocked) return;
			scheduleSave();
		});

		if (hasBuiltinApp() || hasLock()) {
			// 内置密文凭据（全局密码）或已有设备密码：直接解锁
			showLockScreen(false);
		} else {
			// 首次使用：设置密码
			showLockScreen(true);
		}
	}

	window.CloudSync = {
		init: init,
		getConfig: function() { return config; },
		isUnlocked: function() { return unlocked; }
	};
})(window, jQuery);
