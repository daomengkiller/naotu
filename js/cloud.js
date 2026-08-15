/**
 * cloud.js - GitHub 私有仓库云存储模块（兼容 kityminder-editor）
 *
 * 功能：
 *  - 使用 GitHub Contents API 将脑图(.km JSON)保存到私有仓库 mindmaps/ 目录
 *  - 多设备同步：任一设备保存后，其他设备打开页面可读取最新版本
 *  - 自动保存（监听 contentchange 事件，防抖）
 *  - 新建 / 打开 / 保存 / 删除 云端脑图文件
 *
 * 注意：Token 仅保存在浏览器 localStorage，不要提交到公开仓库。
 */
(function(window, $) {
	'use strict';

	var STORAGE_KEY = 'km_cloud_config_v1';
	var CURRENT_FILE_KEY = 'km_cloud_current_file';

	var DEFAULT_DIR = 'mindmaps';
	var SAVE_DEBOUNCE_MS = 1500;

	var config = null;
	var minder = null;
	var editor = null;
	var currentFile = null;      // { name, sha }
	var saveTimer = null;
	var saving = false;
	var dirty = false;

	/* ---------------- 工具函数 ---------------- */

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

	function utf8ToBase64(str) {
		// btoa 不支持中文，先转 UTF-8 字节
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

	function apiBase() {
		return 'https://api.github.com';
	}

	function ghHeaders() {
		return {
			'Authorization': 'token ' + (config.token || ''),
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
				throw new Error('认证失败：请检查 Token 是否有效且拥有 repo 权限（HTTP ' + res.status + '）');
			}
			if (res.status === 404) {
				throw new Error('未找到仓库/文件：请检查仓库名是否正确（HTTP 404）');
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

	function repoPath(path) {
		return apiBase() + '/repos/' + config.repo + '/contents/' + encodeURIComponent(path);
	}

	function dirPath() {
		return (config.dir || DEFAULT_DIR).replace(/^\/+|\/+$/g, '');
	}

	/* ---------------- 云端文件操作 ---------------- */

	function listFiles() {
		var dir = dirPath();
		return ghRequest('GET', apiBase() + '/repos/' + config.repo + '/contents/' + encodeURIComponent(dir))
			.then(function(items) {
				if (!Array.isArray(items)) return [];
				return items
					.filter(function(it) { return it.type === 'file' && /\.km$/i.test(it.name); })
					.map(function(it) {
						return { name: it.name.replace(/\.km$/i, ''), path: it.path, sha: it.sha, size: it.size };
					})
					.sort(function(a, b) { return a.name.localeCompare(b.name, 'zh'); });
			})
			.catch(function(err) {
				// GitHub 不保留空目录：目录不存在(404)时视为空列表
				if (err && err.message && err.message.indexOf('HTTP 404') > -1) return [];
				throw err;
			});
	}

	function readFile(fileName) {
		var dir = dirPath();
		var path = dir ? dir + '/' + fileName + '.km' : fileName + '.km';
		return ghRequest('GET', repoPath(path)).then(function(data) {
			var json = base64ToUtf8(data.content);
			return { json: json, sha: data.sha };
		});
	}

	function writeFile(fileName, json, sha) {
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

	function deleteFile(fileName, sha) {
		var dir = dirPath();
		var path = dir ? dir + '/' + fileName + '.km' : fileName + '.km';
		return ghRequest('DELETE', repoPath(path), {
			message: 'delete ' + fileName + '.km via km-cloud',
			sha: sha
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
		// 参考 kityminder 默认数据结构
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

	/* ---------------- 保存逻辑 ---------------- */

	function doSave() {
		if (!config.token || !config.repo) {
			setStatus('未配置云端', 'error');
			toast('请先点击右上角"设置"，填入 GitHub Token 和仓库名');
			return Promise.reject(new Error('not configured'));
		}
		if (!currentFile) {
			toast('请先新建或打开一个脑图文件');
			return Promise.reject(new Error('no file'));
		}
		var json = getMinderJson();
		if (!json) return Promise.reject(new Error('export failed'));

		saving = true;
		setStatus('保存中…', 'syncing');
		return writeFile(currentFile.name, json, currentFile.sha)
			.then(function(sha) {
				if (sha) currentFile.sha = sha;
				dirty = false;
				saving = false;
				var t = new Date();
				setStatus('已保存 ' + t.getHours() + ':' + ('0' + t.getMinutes()).slice(-2), 'online');
			})
			.catch(function(err) {
				saving = false;
				setStatus('保存失败', 'error');
				toast('保存失败：' + err.message);
				throw err;
			});
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

	/* ---------------- UI 事件 ---------------- */

	function openSettingsModal() {
		$('#settingToken').val(config.token || '');
		$('#settingRepo').val(config.repo || '');
		$('#settingDir').val(config.dir || DEFAULT_DIR);
		$('#settingAutoSave').val(config.autoSave === undefined ? '1' : (config.autoSave ? '1' : '0'));
		$('#settingsModal').modal('show');
	}

	function saveSettings() {
		config.token = $('#settingToken').val().trim();
		config.repo = $('#settingRepo').val().trim();
		config.dir = $('#settingDir').val().trim() || DEFAULT_DIR;
		config.autoSave = $('#settingAutoSave').val() === '1';
		saveConfig();
		$('#settingsModal').modal('hide');
		if (config.token && config.repo) {
			setStatus('已配置云端', 'online');
			toast('设置已保存');
		} else {
			setStatus('未配置云端', 'error');
			toast('请填写 Token 和仓库名');
		}
	}

	function refreshFileList() {
		var $list = $('#fileList');
		$list.empty();
		if (!config.token || !config.repo) {
			$list.append('<li class="list-group-item help-text">尚未配置云端，请先点击右上角"设置"。</li>');
			return;
		}
		$list.append('<li class="list-group-item help-text">加载中…</li>');
		listFiles().then(function(files) {
			$list.empty();
			if (!files.length) {
				$list.append('<li class="list-group-item help-text">云端还没有脑图文件，点击"新建"创建第一个吧。</li>');
				return;
			}
			files.forEach(function(f) {
				var $li = $('<li class="list-group-item file-list-item" data-name="' + f.name.replace(/"/g, '&quot;') + '">')
					.append(
						$('<div>').append(
							$('<span class="glyphicon glyphicon-tree-deciduous" style="margin-right:8px;color:#4A90E2;">'),
							$('<strong>').text(f.name),
							$('<span class="file-meta" style="margin-left:10px;">').text(f.size + ' B')
						),
						$('<span class="del-btn pull-right" style="color:#EB5757;" title="删除">删除</span>')
					);
				$li.on('click', function(e) {
					if ($(e.target).hasClass('del-btn')) return;
					openCloudFile(f.name);
				});
				$li.find('.del-btn').on('click', function(e) {
					e.stopPropagation();
					if (!window.confirm('确定删除「' + f.name + '」吗？删除后无法恢复！')) return;
					deleteFile(f.name, f.sha).then(function() {
						toast('已删除「' + f.name + '」');
						refreshFileList();
					}).catch(function(err) {
						toast('删除失败：' + err.message);
					});
				});
				$list.append($li);
			});
		}).catch(function(err) {
			$list.empty();
			$list.append('<li class="list-group-item help-text">加载失败：' + err.message + '</li>');
		});
	}

	function openCloudFile(name) {
		$('#openModal').modal('hide');
		setStatus('加载中…', 'syncing');
		readFile(name).then(function(res) {
			importJson(res.json);
			currentFile = { name: name, sha: res.sha };
			updateFileName();
			dirty = false;
			setStatus('已打开 ' + name, 'online');
			toast('已打开「' + name + '」');
			if (config.autoSave) scheduleSave();
		}).catch(function(err) {
			setStatus('加载失败', 'error');
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
			// 有未保存修改，先保存当前文件
			doSave().catch(function() {});
		}
		createNewMindMap(name);
		currentFile = { name: name, sha: null };
		updateFileName();
		dirty = false;
		setStatus('未保存（新文件）', 'syncing');
		toast('已新建「' + name + '」，点击"保存"上传到云端');
	}

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
	}

	/* ---------------- 初始化 ---------------- */

	function init(editorInstance, minderInstance) {
		editor = editorInstance;
		minder = minderInstance;
		loadConfig();
		initUi();

		// 恢复上次打开的云端文件
		var lastFile = null;
		try { lastFile = JSON.parse(window.localStorage.getItem(CURRENT_FILE_KEY)); } catch (e) {}
		if (lastFile && lastFile.name) {
			currentFile = { name: lastFile.name, sha: lastFile.sha };
			updateFileName();
			if (config.token && config.repo) {
				setStatus('加载上次文件…', 'syncing');
				readFile(lastFile.name).then(function(res) {
					importJson(res.json);
					currentFile.sha = res.sha;
					updateFileName();
					setStatus('已打开 ' + lastFile.name, 'online');
				}).catch(function() {
					currentFile = null;
					updateFileName();
					setStatus('未连接云端', 'error');
				});
			}
		} else if (config.token && config.repo) {
			setStatus('已配置云端', 'online');
		} else {
			setStatus('未配置云端（点"设置"开始）', 'error');
		}

		// 监听编辑变化 -> 自动保存
		minder.on('contentchange', scheduleSave);
		// 保存当前文件名，方便下次打开
		setInterval(function() {
			if (currentFile) {
				window.localStorage.setItem(CURRENT_FILE_KEY, JSON.stringify(currentFile));
			}
		}, 2000);
	}

	window.CloudSync = {
		init: init,
		getConfig: function() { return config; }
	};
})(window, jQuery);
